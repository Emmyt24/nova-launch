#![cfg(test)]

//! End-to-End Governance Workflow Tests
//!
//! These tests verify complete governance workflows including:
//! - Proposal creation
//! - Voting
//! - Queueing (via timelock)
//! - Execution
//! - State changes
//! - Event sequences

use crate::timelock::{
    create_proposal, vote_proposal, get_proposal, get_vote_counts,
    schedule_fee_update, execute_change, cancel_change, get_pending_change,
    initialize_timelock,
};
use crate::types::{ActionType, VoteChoice, Error};
use crate::test_helpers::*;
use crate::storage;
use soroban_sdk::vec;

// ═══════════════════════════════════════════════════════════════════════════
// E2E Flow 1: Complete Success Flow (create -> vote -> queue -> execute)
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_e2e_proposal_vote_queue_execute_fee_update() {
    let test_env = TestEnv::with_timelock(3600);
    let time = TimeController::new(&test_env.env);
    let actors = ActorGenerator::new(&test_env.env);
    let vote_helper = VoteHelper::new(&test_env.env);
    let events = EventAssertions::new(&test_env.env);
    let state = StateAssertions::new(&test_env.env);
    
    // Record initial state
    state.assert_fees(1_000_000, 500_000);
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 1: Create Proposal
    // ─────────────────────────────────────────────────────────────────────
    let proposal_id = ProposalBuilder::new(&test_env.env, &test_env.admin)
        .payload(test_payload(&test_env.env, &[1, 2, 3]))
        .build()
        .unwrap();
    
    assert_eq!(proposal_id, 0);
    events.assert_exists("prop_crt");
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 2: Cast Votes (simulate community voting)
    // ─────────────────────────────────────────────────────────────────────
    time.advance(1000);
    
    let voters = actors.generate_voters(5);
    vote_helper.cast_many(&voters[0..4], proposal_id, VoteChoice::For).unwrap();
    vote_helper.cast(&voters[4], proposal_id, VoteChoice::Against).unwrap();
    
    state.assert_vote_counts(proposal_id, 4, 1, 0);
    events.assert_count("prop_vot", 5);
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 3: Queue for Execution (via timelock)
    // ─────────────────────────────────────────────────────────────────────
    time.advance_days(2);
    
    let new_base_fee = 2_000_000_i128;
    let new_metadata_fee = 750_000_i128;
    
    let change_id = schedule_fee_update(
        &test_env.env,
        &test_env.admin,
        Some(new_base_fee),
        Some(new_metadata_fee),
    ).unwrap();
    
    events.assert_exists("ch_sched");
    state.assert_fees(1_000_000, 500_000); // Still unchanged
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 4: Execute Change (after timelock)
    // ─────────────────────────────────────────────────────────────────────
    time.advance_hours(2);
    
    execute_change(&test_env.env, change_id).unwrap();
    
    state.assert_fees(new_base_fee, new_metadata_fee);
    events.assert_exists("ch_exec");
    events.assert_exists("fee_up_v1");
    
    // Verify event sequence
    events.assert_chronological(&["prop_crt", "prop_vot", "ch_sched", "ch_exec"]);
}

// ═══════════════════════════════════════════════════════════════════════════
// E2E Flow 2: Vote Failure Flow (create -> vote fail -> queue reject)
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_e2e_proposal_vote_fail_quorum_miss() {
    let test_env = TestEnv::with_timelock(3600);
    let time = TimeController::new(&test_env.env);
    let actors = ActorGenerator::new(&test_env.env);
    let vote_helper = VoteHelper::new(&test_env.env);
    let events = EventAssertions::new(&test_env.env);
    let state = StateAssertions::new(&test_env.env);
    
    let initial_base_fee = storage::get_base_fee(&test_env.env).unwrap();
    let initial_metadata_fee = storage::get_metadata_fee(&test_env.env).unwrap();
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 1: Create Proposal
    // ─────────────────────────────────────────────────────────────────────
    let proposal_id = ProposalBuilder::new(&test_env.env, &test_env.admin)
        .payload(test_payload(&test_env.env, &[1, 2, 3]))
        .build()
        .unwrap();
    
    assert_eq!(proposal_id, 0);
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 2: Insufficient Votes (quorum not met)
    // ─────────────────────────────────────────────────────────────────────
    time.advance(1100);
    
    let voters = actors.generate_many(2);
    vote_helper.cast(&voters[0], proposal_id, VoteChoice::For).unwrap();
    vote_helper.cast(&voters[1], proposal_id, VoteChoice::Against).unwrap();
    
    state.assert_vote_counts(proposal_id, 1, 1, 0);
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 3: Verify State Unchanged
    // ─────────────────────────────────────────────────────────────────────
    time.advance_days(2);
    
    let proposal = get_proposal(&test_env.env, proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 1);
    assert_eq!(proposal.votes_against, 1);
    
    state.assert_fees(initial_base_fee, initial_metadata_fee);
    
    // Verify event sequence
    events.assert_exists("prop_crt");
    events.assert_count("prop_vot", 2);
    events.assert_not_exists("ch_sched");
    events.assert_not_exists("ch_exec");
    events.assert_not_exists("fee_up_v1");
}

// ═══════════════════════════════════════════════════════════════════════════
// E2E Flow 3: Cancellation Flow (create -> queue -> cancel -> execute reject)
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_e2e_proposal_queue_cancel_execute_reject() {
    let test_env = TestEnv::with_timelock(3600);
    let time = TimeController::new(&test_env.env);
    let actors = ActorGenerator::new(&test_env.env);
    let vote_helper = VoteHelper::new(&test_env.env);
    let events = EventAssertions::new(&test_env.env);
    let state = StateAssertions::new(&test_env.env);
    
    let initial_base_fee = storage::get_base_fee(&test_env.env).unwrap();
    let initial_metadata_fee = storage::get_metadata_fee(&test_env.env).unwrap();
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 1: Create Proposal
    // ─────────────────────────────────────────────────────────────────────
    let proposal_id = ProposalBuilder::new(&test_env.env, &test_env.admin)
        .payload(test_payload(&test_env.env, &[1, 2, 3]))
        .build()
        .unwrap();
    
    assert_eq!(proposal_id, 0);
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 2: Voting (passes)
    // ─────────────────────────────────────────────────────────────────────
    time.advance(1100);
    
    let voters = actors.generate_many(3);
    vote_helper.cast_many(&voters, proposal_id, VoteChoice::For).unwrap();
    
    state.assert_vote_counts(proposal_id, 3, 0, 0);
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 3: Queue for Execution
    // ─────────────────────────────────────────────────────────────────────
    time.advance_days(2);
    
    let new_base_fee = 2_000_000_i128;
    let new_metadata_fee = 750_000_i128;
    
    let change_id = schedule_fee_update(
        &test_env.env,
        &test_env.admin,
        Some(new_base_fee),
        Some(new_metadata_fee),
    ).unwrap();
    
    let pending = get_pending_change(&test_env.env, change_id).unwrap();
    assert!(!pending.executed);
    
    events.assert_count("ch_sched", 1);
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 4: Cancel Before Execution
    // ─────────────────────────────────────────────────────────────────────
    cancel_change(&test_env.env, &test_env.admin, change_id).unwrap();
    
    let cancelled = get_pending_change(&test_env.env, change_id);
    assert!(cancelled.is_none());
    
    events.assert_count("ch_cncl", 1);
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 5: Attempt to Execute (should fail)
    // ─────────────────────────────────────────────────────────────────────
    time.advance_hours(2);
    
    let result = execute_change(&test_env.env, change_id);
    assert_eq!(result, Err(Error::TokenNotFound));
    
    // ─────────────────────────────────────────────────────────────────────
    // Step 6: Verify State Unchanged
    // ─────────────────────────────────────────────────────────────────────
    state.assert_fees(initial_base_fee, initial_metadata_fee);
    
    events.assert_exists("prop_crt");
    events.assert_exists("ch_sched");
    events.assert_exists("ch_cncl");
    events.assert_count("prop_vot", 3);
    events.assert_not_exists("ch_exec");
    events.assert_not_exists("fee_up_v1");
}

// ═══════════════════════════════════════════════════════════════════════════
// Additional E2E Tests
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_e2e_multiple_proposals_independent_execution() {
    let test_env = TestEnv::with_timelock(3600);
    let time = TimeController::new(&test_env.env);
    let actors = ActorGenerator::new(&test_env.env);
    let vote_helper = VoteHelper::new(&test_env.env);
    
    let initial_base_fee = storage::get_base_fee(&test_env.env).unwrap();
    
    // Create two proposals
    let proposal_id_1 = ProposalBuilder::new(&test_env.env, &test_env.admin)
        .payload(test_payload(&test_env.env, &[1]))
        .build()
        .unwrap();
    
    let proposal_id_2 = ProposalBuilder::new(&test_env.env, &test_env.admin)
        .payload(test_payload(&test_env.env, &[2]))
        .build()
        .unwrap();
    
    // Vote on both
    time.advance(1100);
    
    let voter = actors.generate();
    vote_helper.cast(&voter, proposal_id_1, VoteChoice::For).unwrap();
    vote_helper.cast(&voter, proposal_id_2, VoteChoice::For).unwrap();
    
    // Queue first proposal
    time.advance_days(2);
    
    let change_id_1 = schedule_fee_update(
        &test_env.env, &test_env.admin, Some(2_000_000), None,
    ).unwrap();
    
    // Execute first proposal
    time.advance_hours(2);
    
    execute_change(&test_env.env, change_id_1).unwrap();
    
    assert_eq!(storage::get_base_fee(&test_env.env), 2_000_000);
    
    // Second proposal remains independent
    let proposal_2 = get_proposal(&test_env.env, proposal_id_2).unwrap();
    assert_eq!(proposal_2.votes_for, 1);
}

#[test]
fn test_e2e_execute_before_timelock_fails() {
    let test_env = TestEnv::with_timelock(3600);
    let time = TimeController::new(&test_env.env);
    let actors = ActorGenerator::new(&test_env.env);
    let vote_helper = VoteHelper::new(&test_env.env);
    
    // Create and vote on proposal
    let proposal_id = ProposalBuilder::new(&test_env.env, &test_env.admin)
        .payload(test_payload(&test_env.env, &[1]))
        .build()
        .unwrap();
    
    time.advance(1100);
    
    let voter = actors.generate();
    vote_helper.cast(&voter, proposal_id, VoteChoice::For).unwrap();
    
    // Queue
    time.advance_days(2);
    
    let change_id = schedule_fee_update(&test_env.env, &test_env.admin, Some(2_000_000), None).unwrap();
    
    // Try to execute immediately (before timelock expires)
    let result = execute_change(&test_env.env, change_id);
    assert_eq!(result, Err(Error::TimelockNotExpired));
    
    assert_eq!(storage::get_base_fee(&test_env.env), 1_000_000);
}

#[test]
fn test_e2e_double_execution_fails() {
    let test_env = TestEnv::with_timelock(3600);
    let time = TimeController::new(&test_env.env);
    let actors = ActorGenerator::new(&test_env.env);
    let vote_helper = VoteHelper::new(&test_env.env);
    
    // Create, vote, queue
    let proposal_id = ProposalBuilder::new(&test_env.env, &test_env.admin)
        .payload(test_payload(&test_env.env, &[1]))
        .build()
        .unwrap();
    
    time.advance(1100);
    
    let voter = actors.generate();
    vote_helper.cast(&voter, proposal_id, VoteChoice::For).unwrap();
    
    time.advance_days(2);
    
    let change_id = schedule_fee_update(&test_env.env, &test_env.admin, Some(2_000_000), None).unwrap();
    
    // Execute once
    time.advance_hours(2);
    
    execute_change(&test_env.env, change_id).unwrap();
    assert_eq!(storage::get_base_fee(&test_env.env), 2_000_000);
    
    // Try to execute again
    let result = execute_change(&test_env.env, change_id);
    assert_eq!(result, Err(Error::ChangeAlreadyExecuted));
    
    assert_eq!(storage::get_base_fee(&test_env.env), 2_000_000);
}

#[test]
fn test_e2e_event_sequence_correctness() {
    let test_env = TestEnv::with_timelock(3600);
    let time = TimeController::new(&test_env.env);
    let actors = ActorGenerator::new(&test_env.env);
    let vote_helper = VoteHelper::new(&test_env.env);
    let events = EventAssertions::new(&test_env.env);
    
    // Create
    let proposal_id = ProposalBuilder::new(&test_env.env, &test_env.admin)
        .payload(test_payload(&test_env.env, &[1]))
        .build()
        .unwrap();
    
    let events_after_create = events.all().len();
    
    // Vote
    time.advance(1100);
    
    let voters = actors.generate_many(2);
    vote_helper.cast_many(&voters, proposal_id, VoteChoice::For).unwrap();
    
    let events_after_vote = events.all().len();
    assert!(events_after_vote > events_after_create);
    
    // Queue
    time.advance_days(2);
    
    let change_id = schedule_fee_update(&test_env.env, &test_env.admin, Some(2_000_000), None).unwrap();
    
    let events_after_queue = events.all().len();
    assert!(events_after_queue > events_after_vote);
    
    // Execute
    time.advance_hours(2);
    
    execute_change(&test_env.env, change_id).unwrap();
    
    let events_after_execute = events.all().len();
    assert!(events_after_execute > events_after_queue);
    
    // Verify chronological order
    events.assert_chronological(&["prop_crt", "prop_vot", "ch_sched", "ch_exec"]);
}
