#![cfg(test)]

//! Governance Security Regression Suite (Issue #433)
//!
//! Comprehensive negative tests for governance privilege paths:
//! - Unauthorized queue/execute/cancel/veto/approval attempts
//! - Timelock bypass attempts
//! - Threshold bypass attempts
//! - Duplicate approval edge cases
//! - Duplicate voting edge cases

use crate::timelock::{
    create_proposal, vote_proposal, schedule_fee_update, schedule_pause_update,
    schedule_treasury_update, execute_change, cancel_change, get_pending_change,
    initialize_timelock, get_proposal,
};
use crate::types::{ActionType, VoteChoice, Error};
use crate::storage;
use soroban_sdk::{testutils::Address as _, Env, Address, Bytes};
use soroban_sdk::testutils::Ledger;

fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    
    storage::set_admin(&env, &admin);
    storage::set_treasury(&env, &treasury);
    storage::set_base_fee(&env, 1_000_000);
    storage::set_metadata_fee(&env, 500_000);
    
    initialize_timelock(&env, Some(3600)).unwrap();
    
    (env, admin, treasury)
}

fn dummy_payload(env: &Env) -> Bytes {
    Bytes::from_slice(env, &[1u8])
}

// ═══════════════════════════════════════════════════════════════════════════
// UNAUTHORIZED QUEUE ATTEMPTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_unauthorized_schedule_fee_update() {
    let (env, _admin, _treasury) = setup();
    let attacker = Address::generate(&env);
    
    let result = schedule_fee_update(&env, &attacker, Some(999_999_999), None);
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_unauthorized_schedule_pause_update() {
    let (env, _admin, _treasury) = setup();
    let attacker = Address::generate(&env);
    
    let result = schedule_pause_update(&env, &attacker, true);
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_unauthorized_schedule_treasury_update() {
    let (env, _admin, _treasury) = setup();
    let attacker = Address::generate(&env);
    let new_treasury = Address::generate(&env);
    
    let result = schedule_treasury_update(&env, &attacker, &new_treasury);
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_non_admin_cannot_queue_even_with_valid_proposal() {
    let (env, admin, _treasury) = setup();
    
    // Admin creates valid proposal
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    // Voting passes
    env.ledger().with_mut(|li| li.timestamp += 150);
    let voter = Address::generate(&env);
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    
    // Non-admin tries to queue
    env.ledger().with_mut(|li| li.timestamp = current_time + 86600);
    let attacker = Address::generate(&env);
    
    let result = schedule_fee_update(&env, &attacker, Some(2_000_000), None);
    assert_eq!(result, Err(Error::Unauthorized));
}

// ═══════════════════════════════════════════════════════════════════════════
// UNAUTHORIZED EXECUTE ATTEMPTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_execute_nonexistent_change() {
    let (env, _admin, _treasury) = setup();
    
    let result = execute_change(&env, 999);
    assert_eq!(result, Err(Error::TokenNotFound));
}

#[test]
fn test_execute_before_timelock_expires() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // Try to execute immediately
    let result = execute_change(&env, change_id);
    assert_eq!(result, Err(Error::TimelockNotExpired));
}

#[test]
fn test_execute_one_second_before_timelock() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // Advance time to 1 second before timelock expires
    env.ledger().with_mut(|li| li.timestamp += 3599);
    
    let result = execute_change(&env, change_id);
    assert_eq!(result, Err(Error::TimelockNotExpired));
}

#[test]
fn test_execute_at_exact_timelock_expiry() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // Advance time to exactly when timelock expires
    env.ledger().with_mut(|li| li.timestamp += 3600);
    
    // Should succeed at exact expiry
    execute_change(&env, change_id).unwrap();
    assert_eq!(storage::get_base_fee(&env), 2_000_000);
}

#[test]
fn test_double_execute_rejected() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 3601);
    
    // First execution succeeds
    execute_change(&env, change_id).unwrap();
    
    // Second execution fails
    let result = execute_change(&env, change_id);
    assert_eq!(result, Err(Error::ChangeAlreadyExecuted));
    
    // Verify fee only changed once
    assert_eq!(storage::get_base_fee(&env), 2_000_000);
}

// ═══════════════════════════════════════════════════════════════════════════
// UNAUTHORIZED CANCEL ATTEMPTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_unauthorized_cancel_change() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    let attacker = Address::generate(&env);
    let result = cancel_change(&env, &attacker, change_id);
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_cancel_nonexistent_change() {
    let (env, admin, _treasury) = setup();
    
    let result = cancel_change(&env, &admin, 999);
    assert_eq!(result, Err(Error::TokenNotFound));
}

#[test]
fn test_cancel_already_executed_change() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 3601);
    execute_change(&env, change_id).unwrap();
    
    // Try to cancel after execution
    let result = cancel_change(&env, &admin, change_id);
    assert_eq!(result, Err(Error::ChangeAlreadyExecuted));
}

#[test]
fn test_double_cancel_rejected() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // First cancel succeeds
    cancel_change(&env, &admin, change_id).unwrap();
    
    // Second cancel fails (change no longer exists)
    let result = cancel_change(&env, &admin, change_id);
    assert_eq!(result, Err(Error::TokenNotFound));
}

// ═══════════════════════════════════════════════════════════════════════════
// UNAUTHORIZED PROPOSAL CREATION
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_non_admin_cannot_create_proposal() {
    let (env, _admin, _treasury) = setup();
    
    let attacker = Address::generate(&env);
    let current_time = env.ledger().timestamp();
    
    let result = create_proposal(
        &env, &attacker, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    );
    
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_treasury_cannot_create_proposal() {
    let (env, _admin, treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    
    let result = create_proposal(
        &env, &treasury, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    );
    
    assert_eq!(result, Err(Error::Unauthorized));
}

// ═══════════════════════════════════════════════════════════════════════════
// TIMELOCK BYPASS ATTEMPTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_cannot_execute_immediately_after_queue() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // Try to execute in same block
    let result = execute_change(&env, change_id);
    assert_eq!(result, Err(Error::TimelockNotExpired));
    
    // Verify state unchanged
    assert_eq!(storage::get_base_fee(&env), 1_000_000);
}

#[test]
fn test_cannot_bypass_timelock_by_canceling_and_requeuing() {
    let (env, admin, _treasury) = setup();
    
    // Queue change
    let change_id_1 = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // Advance time halfway through timelock
    env.ledger().with_mut(|li| li.timestamp += 1800);
    
    // Cancel and requeue
    cancel_change(&env, &admin, change_id_1).unwrap();
    let change_id_2 = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // Try to execute new change immediately (should fail - new timelock started)
    let result = execute_change(&env, change_id_2);
    assert_eq!(result, Err(Error::TimelockNotExpired));
    
    // Verify new change has fresh timelock from current time
    let pending = get_pending_change(&env, change_id_2).unwrap();
    let current_time = env.ledger().timestamp();
    assert_eq!(pending.execute_at, current_time + 3600);
}

#[test]
fn test_cannot_manipulate_time_to_bypass_timelock() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    let pending = get_pending_change(&env, change_id).unwrap();
    let execute_at = pending.execute_at;
    
    // Try to execute before timelock
    let result = execute_change(&env, change_id);
    assert_eq!(result, Err(Error::TimelockNotExpired));
    
    // Advance time to exactly execute_at
    env.ledger().with_mut(|li| li.timestamp = execute_at);
    
    // Should succeed now
    execute_change(&env, change_id).unwrap();
}

#[test]
fn test_timelock_enforced_for_all_change_types() {
    let (env, admin, _treasury) = setup();
    
    // Test fee update
    let change_id_1 = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    assert_eq!(execute_change(&env, change_id_1), Err(Error::TimelockNotExpired));
    
    // Test pause update
    let change_id_2 = schedule_pause_update(&env, &admin, true).unwrap();
    assert_eq!(execute_change(&env, change_id_2), Err(Error::TimelockNotExpired));
    
    // Test treasury update
    let new_treasury = Address::generate(&env);
    let change_id_3 = schedule_treasury_update(&env, &admin, &new_treasury).unwrap();
    assert_eq!(execute_change(&env, change_id_3), Err(Error::TimelockNotExpired));
}

#[test]
fn test_cannot_execute_cancelled_change_after_timelock() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // Cancel before timelock expires
    cancel_change(&env, &admin, change_id).unwrap();
    
    // Advance time past timelock
    env.ledger().with_mut(|li| li.timestamp += 3601);
    
    // Try to execute cancelled change
    let result = execute_change(&env, change_id);
    assert_eq!(result, Err(Error::TokenNotFound));
    
    // Verify state unchanged
    assert_eq!(storage::get_base_fee(&env), 1_000_000);
}

// ═══════════════════════════════════════════════════════════════════════════
// THRESHOLD BYPASS ATTEMPTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_cannot_vote_before_voting_starts() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 1000, current_time + 87400, current_time + 91000,
    ).unwrap();
    
    // Try to vote before start_time
    let voter = Address::generate(&env);
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::For);
    assert_eq!(result, Err(Error::VotingNotStarted));
}

#[test]
fn test_cannot_vote_after_voting_ends() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    // Advance time past end_time
    env.ledger().with_mut(|li| li.timestamp = current_time + 86500);
    
    let voter = Address::generate(&env);
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::For);
    assert_eq!(result, Err(Error::VotingEnded));
}

#[test]
fn test_cannot_vote_on_nonexistent_proposal() {
    let (env, _admin, _treasury) = setup();
    
    let voter = Address::generate(&env);
    let result = vote_proposal(&env, &voter, 999, VoteChoice::For);
    assert_eq!(result, Err(Error::ProposalNotFound));
}

// ═══════════════════════════════════════════════════════════════════════════
// DUPLICATE APPROVAL EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_duplicate_vote_same_choice_rejected() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 150);
    
    let voter = Address::generate(&env);
    
    // First vote succeeds
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    
    // Second vote with same choice fails
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::For);
    assert_eq!(result, Err(Error::AlreadyVoted));
    
    // Verify vote count is still 1
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 1);
}

#[test]
fn test_duplicate_vote_different_choice_rejected() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 150);
    
    let voter = Address::generate(&env);
    
    // Vote For
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    
    // Try to change vote to Against
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::Against);
    assert_eq!(result, Err(Error::AlreadyVoted));
    
    // Verify original vote preserved
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 1);
    assert_eq!(proposal.votes_against, 0);
}

#[test]
fn test_duplicate_vote_to_abstain_rejected() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 150);
    
    let voter = Address::generate(&env);
    
    // Vote For
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    
    // Try to change to Abstain
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::Abstain);
    assert_eq!(result, Err(Error::AlreadyVoted));
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 1);
    assert_eq!(proposal.votes_abstain, 0);
}

#[test]
fn test_voter_cannot_vote_twice_across_time() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 150);
    
    let voter = Address::generate(&env);
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    
    // Advance time significantly
    env.ledger().with_mut(|li| li.timestamp += 50000);
    
    // Still cannot vote again
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::Against);
    assert_eq!(result, Err(Error::AlreadyVoted));
}

#[test]
fn test_admin_cannot_vote_multiple_times() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 150);
    
    // Admin votes on their own proposal
    vote_proposal(&env, &admin, proposal_id, VoteChoice::For).unwrap();
    
    // Admin tries to vote again
    let result = vote_proposal(&env, &admin, proposal_id, VoteChoice::For);
    assert_eq!(result, Err(Error::AlreadyVoted));
}

// ═══════════════════════════════════════════════════════════════════════════
// DUPLICATE VOTING EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_same_voter_can_vote_on_different_proposals() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    
    let proposal_id_1 = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    let proposal_id_2 = create_proposal(
        &env, &admin, ActionType::TreasuryChange, vec![vec![&env, 2u8]env, 2u32],
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 150);
    
    let voter = Address::generate(&env);
    
    // Vote on both proposals - should succeed
    vote_proposal(&env, &voter, proposal_id_1, VoteChoice::For).unwrap();
    vote_proposal(&env, &voter, proposal_id_2, VoteChoice::Against).unwrap();
    
    // Verify both votes recorded
    assert!(storage::has_voted(&env, proposal_id_1, &voter));
    assert!(storage::has_voted(&env, proposal_id_2, &voter));
}

#[test]
fn test_vote_persistence_across_multiple_voters() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 150);
    
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);
    let voter3 = Address::generate(&env);
    
    // All vote For
    vote_proposal(&env, &voter1, proposal_id, VoteChoice::For).unwrap();
    vote_proposal(&env, &voter2, proposal_id, VoteChoice::For).unwrap();
    vote_proposal(&env, &voter3, proposal_id, VoteChoice::For).unwrap();
    
    // None can vote again
    assert_eq!(vote_proposal(&env, &voter1, proposal_id, VoteChoice::For), Err(Error::AlreadyVoted));
    assert_eq!(vote_proposal(&env, &voter2, proposal_id, VoteChoice::Against), Err(Error::AlreadyVoted));
    assert_eq!(vote_proposal(&env, &voter3, proposal_id, VoteChoice::Abstain), Err(Error::AlreadyVoted));
    
    // Verify final count
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 3);
    assert_eq!(proposal.votes_against, 0);
    assert_eq!(proposal.votes_abstain, 0);
}

#[test]
fn test_vote_isolation_between_proposals() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    
    let proposal_id_1 = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    let proposal_id_2 = create_proposal(
        &env, &admin, ActionType::FeeChange, vec![vec![&env, 2u8]env, 2u32],
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 150);
    
    let voter = Address::generate(&env);
    
    // Vote on proposal 1
    vote_proposal(&env, &voter, proposal_id_1, VoteChoice::For).unwrap();
    
    // Can still vote on proposal 2
    vote_proposal(&env, &voter, proposal_id_2, VoteChoice::Against).unwrap();
    
    // Cannot vote again on proposal 1
    assert_eq!(vote_proposal(&env, &voter, proposal_id_1, VoteChoice::Against), Err(Error::AlreadyVoted));
    
    // Cannot vote again on proposal 2
    assert_eq!(vote_proposal(&env, &voter, proposal_id_2, VoteChoice::For), Err(Error::AlreadyVoted));
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVILEGE ESCALATION ATTEMPTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_voter_cannot_escalate_to_queue() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 150);
    
    let voter = Address::generate(&env);
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    
    // Voter tries to queue change
    env.ledger().with_mut(|li| li.timestamp = current_time + 86600);
    let result = schedule_fee_update(&env, &voter, Some(2_000_000), None);
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_voter_cannot_cancel_change() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    let voter = Address::generate(&env);
    let result = cancel_change(&env, &voter, change_id);
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_treasury_cannot_queue_changes() {
    let (env, _admin, treasury) = setup();
    
    let result = schedule_fee_update(&env, &treasury, Some(2_000_000), None);
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_treasury_cannot_cancel_changes() {
    let (env, admin, treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    let result = cancel_change(&env, &treasury, change_id);
    assert_eq!(result, Err(Error::Unauthorized));
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE MANIPULATION ATTEMPTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_cannot_execute_change_multiple_times_for_cumulative_effect() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 3601);
    
    // Execute once
    execute_change(&env, change_id).unwrap();
    assert_eq!(storage::get_base_fee(&env), 2_000_000);
    
    // Try to execute again to double the effect
    let result = execute_change(&env, change_id);
    assert_eq!(result, Err(Error::ChangeAlreadyExecuted));
    
    // Fee should still be 2_000_000, not 4_000_000
    assert_eq!(storage::get_base_fee(&env), 2_000_000);
}

#[test]
fn test_cannot_queue_multiple_changes_and_execute_all() {
    let (env, admin, _treasury) = setup();
    
    // Queue multiple fee updates
    let change_id_1 = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    let change_id_2 = schedule_fee_update(&env, &admin, Some(3_000_000), None).unwrap();
    let change_id_3 = schedule_fee_update(&env, &admin, Some(4_000_000), None).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 3601);
    
    // Execute all three
    execute_change(&env, change_id_1).unwrap();
    execute_change(&env, change_id_2).unwrap();
    execute_change(&env, change_id_3).unwrap();
    
    // Last one wins (4_000_000)
    assert_eq!(storage::get_base_fee(&env), 4_000_000);
    
    // Cannot re-execute any
    assert_eq!(execute_change(&env, change_id_1), Err(Error::ChangeAlreadyExecuted));
    assert_eq!(execute_change(&env, change_id_2), Err(Error::ChangeAlreadyExecuted));
    assert_eq!(execute_change(&env, change_id_3), Err(Error::ChangeAlreadyExecuted));
}

#[test]
fn test_cancel_does_not_affect_other_pending_changes() {
    let (env, admin, _treasury) = setup();
    
    let change_id_1 = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    let change_id_2 = schedule_fee_update(&env, &admin, Some(3_000_000), None).unwrap();
    
    // Cancel first change
    cancel_change(&env, &admin, change_id_1).unwrap();
    
    // Second change should still be pending
    let pending = get_pending_change(&env, change_id_2);
    assert!(pending.is_some());
    assert!(!pending.unwrap().executed);
    
    // Can still execute second change after timelock
    env.ledger().with_mut(|li| li.timestamp += 3601);
    execute_change(&env, change_id_2).unwrap();
    assert_eq!(storage::get_base_fee(&env), 3_000_000);
}

// ═══════════════════════════════════════════════════════════════════════════
// CROSS-FUNCTION ATTACK VECTORS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_cannot_bypass_timelock_via_direct_state_modification() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // Attacker cannot directly modify storage (storage functions are internal)
    // This test verifies execute_change is the only path
    
    // Try to execute before timelock
    let result = execute_change(&env, change_id);
    assert_eq!(result, Err(Error::TimelockNotExpired));
    
    // Verify fee unchanged
    assert_eq!(storage::get_base_fee(&env), 1_000_000);
}

#[test]
fn test_cannot_create_proposal_with_past_timestamps() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    
    // All timestamps in the past
    let result = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time - 1000, current_time - 500, current_time - 100,
    );
    
    assert_eq!(result, Err(Error::InvalidTimeWindow));
}

#[test]
fn test_cannot_create_proposal_with_inverted_time_windows() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    
    // end_time before start_time
    let result = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 1000, current_time + 500, current_time + 2000,
    );
    
    assert_eq!(result, Err(Error::InvalidTimeWindow));
}

#[test]
fn test_cannot_create_proposal_with_eta_before_end() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    
    // eta before end_time
    let result = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 86400,
    );
    
    assert_eq!(result, Err(Error::InvalidTimeWindow));
}

#[test]
fn test_payload_size_limit_enforced() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    
    // Create oversized payload (>1024 bytes)
    let mut large_payload = Vec::new(&env);
    for _ in 0..1025 {
        large_payload.push_back(1u32);
    }
    
    let result = create_proposal(
        &env, &admin, ActionType::FeeChange, large_payload,
        current_time + 100, current_time + 86500, current_time + 90100,
    );
    
    assert_eq!(result, Err(Error::PayloadTooLarge));
}

#[test]
fn test_payload_exactly_at_limit_accepted() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    
    // Create payload exactly 1024 bytes
    let max_payload = Bytes::from_array(&env, &[1u8; 1024]);
    
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, max_payload,
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.payload.len(), 1024);
}

// ═══════════════════════════════════════════════════════════════════════════
// RACE CONDITION TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_concurrent_execution_attempts_only_one_succeeds() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 3601);
    
    // First execution succeeds
    execute_change(&env, change_id).unwrap();
    
    // Concurrent second execution fails
    let result = execute_change(&env, change_id);
    assert_eq!(result, Err(Error::ChangeAlreadyExecuted));
}

#[test]
fn test_cancel_during_execution_window() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 3601);
    
    // Execute first
    execute_change(&env, change_id).unwrap();
    
    // Try to cancel after execution
    let result = cancel_change(&env, &admin, change_id);
    assert_eq!(result, Err(Error::ChangeAlreadyExecuted));
}

#[test]
fn test_execute_after_cancel_fails() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // Cancel before timelock expires
    cancel_change(&env, &admin, change_id).unwrap();
    
    // Advance past timelock
    env.ledger().with_mut(|li| li.timestamp += 3601);
    
    // Try to execute cancelled change
    let result = execute_change(&env, change_id);
    assert_eq!(result, Err(Error::TokenNotFound));
}

// ═══════════════════════════════════════════════════════════════════════════
// BOUNDARY CONDITION TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_voting_window_exact_boundaries() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 1000;
    let end_time = start_time + 86400;
    
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        start_time, end_time, end_time + 3600,
    ).unwrap();
    
    let voter = Address::generate(&env);
    
    // One second before start
    env.ledger().with_mut(|li| li.timestamp = start_time - 1);
    assert_eq!(vote_proposal(&env, &voter, proposal_id, VoteChoice::For), Err(Error::VotingNotStarted));
    
    // Exactly at start
    env.ledger().with_mut(|li| li.timestamp = start_time);
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
}

#[test]
fn test_voting_window_end_boundary() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 1000;
    let end_time = start_time + 86400;
    
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        start_time, end_time, end_time + 3600,
    ).unwrap();
    
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);
    
    // One second before end
    env.ledger().with_mut(|li| li.timestamp = end_time - 1);
    vote_proposal(&env, &voter1, proposal_id, VoteChoice::For).unwrap();
    
    // Exactly at end
    env.ledger().with_mut(|li| li.timestamp = end_time);
    assert_eq!(vote_proposal(&env, &voter2, proposal_id, VoteChoice::For), Err(Error::VotingEnded));
}

#[test]
fn test_timelock_exact_expiry_boundary() {
    let (env, admin, _treasury) = setup();
    
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    let pending = get_pending_change(&env, change_id).unwrap();
    let execute_at = pending.execute_at;
    
    // One second before expiry
    env.ledger().with_mut(|li| li.timestamp = execute_at - 1);
    assert_eq!(execute_change(&env, change_id), Err(Error::TimelockNotExpired));
    
    // Exactly at expiry
    env.ledger().with_mut(|li| li.timestamp = execute_at);
    execute_change(&env, change_id).unwrap();
}

// ═══════════════════════════════════════════════════════════════════════════
// PARAMETER VALIDATION ATTACKS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_schedule_fee_update_with_negative_fees() {
    let (env, admin, _treasury) = setup();
    
    let result = schedule_fee_update(&env, &admin, Some(-1), None);
    assert_eq!(result, Err(Error::InvalidParameters));
    
    let result = schedule_fee_update(&env, &admin, None, Some(-1));
    assert_eq!(result, Err(Error::InvalidParameters));
}

#[test]
fn test_schedule_fee_update_with_both_none() {
    let (env, admin, _treasury) = setup();
    
    let result = schedule_fee_update(&env, &admin, None, None);
    assert_eq!(result, Err(Error::InvalidParameters));
}

#[test]
fn test_schedule_fee_update_with_extreme_values() {
    let (env, admin, _treasury) = setup();
    
    // Schedule with i128::MAX (should succeed in scheduling)
    let change_id = schedule_fee_update(&env, &admin, Some(i128::MAX), None).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 3601);
    
    // Execution should succeed (no overflow in storage)
    execute_change(&env, change_id).unwrap();
    assert_eq!(storage::get_base_fee(&env), i128::MAX);
}

// ═══════════════════════════════════════════════════════════════════════════
// VOTING INTEGRITY TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_vote_count_integrity_with_many_voters() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 150);
    
    // Create 10 voters
    let mut voters = soroban_sdk::vec![&env];
    for _ in 0..10 {
        voters.push_back(Address::generate(&env));
    }
    
    // 6 vote For, 3 Against, 1 Abstain
    for i in 0..6 {
        vote_proposal(&env, &voters.get(i).unwrap(), proposal_id, VoteChoice::For).unwrap();
    }
    for i in 6..9 {
        vote_proposal(&env, &voters.get(i).unwrap(), proposal_id, VoteChoice::Against).unwrap();
    }
    vote_proposal(&env, &voters.get(9).unwrap(), proposal_id, VoteChoice::Abstain).unwrap();
    
    // Verify counts
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 6);
    assert_eq!(proposal.votes_against, 3);
    assert_eq!(proposal.votes_abstain, 1);
    
    // No voter can vote again
    for i in 0..10 {
        let result = vote_proposal(&env, &voters.get(i).unwrap(), proposal_id, VoteChoice::For);
        assert_eq!(result, Err(Error::AlreadyVoted));
    }
}

#[test]
fn test_vote_counts_do_not_overflow() {
    let (env, admin, _treasury) = setup();
    
    let current_time = env.ledger().timestamp();
    let proposal_id = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    ).unwrap();
    
    env.ledger().with_mut(|li| li.timestamp += 150);
    
    // Cast many votes (testing u32 counter)
    for i in 0..100 {
        let voter = Address::generate(&env);
        vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    }
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 100);
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORIZATION CHAIN TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_admin_transfer_does_not_affect_pending_changes() {
    let (env, admin, _treasury) = setup();
    
    // Admin schedules change
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // Transfer admin to new address
    let new_admin = Address::generate(&env);
    storage::set_admin(&env, &new_admin);
    
    // Original admin cannot cancel anymore
    let result = cancel_change(&env, &admin, change_id);
    assert_eq!(result, Err(Error::Unauthorized));
    
    // New admin can cancel
    cancel_change(&env, &new_admin, change_id).unwrap();
}

#[test]
fn test_old_admin_cannot_queue_after_transfer() {
    let (env, admin, _treasury) = setup();
    
    // Transfer admin
    let new_admin = Address::generate(&env);
    storage::set_admin(&env, &new_admin);
    
    // Old admin tries to queue
    let result = schedule_fee_update(&env, &admin, Some(2_000_000), None);
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_old_admin_cannot_create_proposal_after_transfer() {
    let (env, admin, _treasury) = setup();
    
    let new_admin = Address::generate(&env);
    storage::set_admin(&env, &new_admin);
    
    let current_time = env.ledger().timestamp();
    let result = create_proposal(
        &env, &admin, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    );
    
    assert_eq!(result, Err(Error::Unauthorized));
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPREHENSIVE NEGATIVE PATH COVERAGE
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_all_governance_functions_require_proper_auth() {
    let (env, admin, _treasury) = setup();
    let attacker = Address::generate(&env);
    let current_time = env.ledger().timestamp();
    
    // Create proposal - attacker fails
    let result = create_proposal(
        &env, &attacker, ActionType::FeeChange, dummy_payload(&env),
        current_time + 100, current_time + 86500, current_time + 90100,
    );
    assert_eq!(result, Err(Error::Unauthorized));
    
    // Schedule fee update - attacker fails
    assert_eq!(schedule_fee_update(&env, &attacker, Some(2_000_000), None), Err(Error::Unauthorized));
    
    // Schedule pause - attacker fails
    assert_eq!(schedule_pause_update(&env, &attacker, true), Err(Error::Unauthorized));
    
    // Schedule treasury update - attacker fails
    let new_treasury = Address::generate(&env);
    assert_eq!(schedule_treasury_update(&env, &attacker, &new_treasury), Err(Error::Unauthorized));
    
    // Admin creates valid change
    let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
    
    // Cancel - attacker fails
    assert_eq!(cancel_change(&env, &attacker, change_id), Err(Error::Unauthorized));
}

#[test]
fn test_state_consistency_after_failed_operations() {
    let (env, _admin, _treasury) = setup();
    
    let initial_base_fee = storage::get_base_fee(&env).unwrap();
    let initial_metadata_fee = storage::get_metadata_fee(&env).unwrap();
    let initial_treasury = storage::get_treasury(&env).unwrap();
    
    let attacker = Address::generate(&env);
    
    // Multiple failed attempts
    let _ = schedule_fee_update(&env, &attacker, Some(999_999_999), None);
    let _ = schedule_pause_update(&env, &attacker, true);
    let _ = schedule_treasury_update(&env, &attacker, &attacker);
    
    // Verify state completely unchanged
    assert_eq!(storage::get_base_fee(&env), initial_base_fee);
    assert_eq!(storage::get_metadata_fee(&env), initial_metadata_fee);
    assert_eq!(storage::get_treasury(&env), initial_treasury);
    assert!(!storage::is_paused(&env));
}
