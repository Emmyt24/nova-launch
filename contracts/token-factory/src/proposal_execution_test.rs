#![cfg(test)]

//! Proposal Execution Integration Tests
//!
//! These tests verify the execute_proposal functionality:
//! - Timelock enforcement (eta check)
//! - State transition safety (queued, not cancelled, not executed)
//! - Action dispatch (fee, pause, treasury)
//! - Event emissions

use crate::test_helpers::{fee_change_payload, pause_payload, policy_update_payload, treasury_change_payload};
use crate::timelock::{
    create_proposal, vote_proposal, get_proposal, initialize_timelock,
    execute_proposal, queue_proposal,
};
use crate::types::{ActionType, VoteChoice, Error, ProposalState};
use crate::storage;
use soroban_sdk::{testutils::Address as _, Env};
use soroban_sdk::testutils::{Ledger, Events};
use soroban_sdk::Symbol;

fn setup_governance() -> (Env, soroban_sdk::Address) {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = soroban_sdk::Address::generate(&env);
    storage::set_admin(&env, &admin);
    storage::set_treasury(&env, &soroban_sdk::Address::generate(&env));
    storage::set_base_fee(&env, 1_000_000);
    storage::set_metadata_fee(&env, 500_000);
    
    // Initialize timelock with 1 hour delay
    initialize_timelock(&env, Some(3600)).unwrap();
    
    (env, admin)
}

fn create_and_pass_proposal(
    env: &Env, 
    admin: &soroban_sdk::Address,
    action_type: ActionType,
) -> u64 {
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 100;
    let end_time = start_time + 86400;
    let eta = end_time + 7200; // 2 hour timelock after voting
    
    let payload = match action_type {
        ActionType::FeeChange => fee_change_payload(env, 2_000_000, 750_000),
        ActionType::PauseContract | ActionType::UnpauseContract => pause_payload(env),
        ActionType::TreasuryChange => {
            let new_treasury = soroban_sdk::Address::generate(env);
            treasury_change_payload(env, &new_treasury)
        }
        ActionType::PolicyUpdate => policy_update_payload(env, 100_0000000, true, 86400),
    };
    
    let proposal_id = create_proposal(
        env,
        admin,
        action_type,
        payload,
        start_time,
        end_time,
        eta,
    ).unwrap();
    
    // Advance to voting period
    env.ledger().with_mut(|li| {
        li.timestamp = start_time + 1000;
    });
    
    // Create voters and pass the proposal
    let voter1 = soroban_sdk::Address::generate(env);
    let voter2 = soroban_sdk::Address::generate(env);
    let voter3 = soroban_sdk::Address::generate(env);
    
    vote_proposal(env, &voter1, proposal_id, VoteChoice::For).unwrap();
    vote_proposal(env, &voter2, proposal_id, VoteChoice::For).unwrap();
    vote_proposal(env, &voter3, proposal_id, VoteChoice::Against).unwrap();
    
    // Advance past voting period
    env.ledger().with_mut(|li| {
        li.timestamp = end_time + 100;
    });
    
    proposal_id
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: Complete execution flow for fee change
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_execute_proposal_fee_change_success() {
    let (env, admin) = setup_governance();
    
    let initial_base_fee = storage::get_base_fee(&env).unwrap();
    
    // Create and pass fee change proposal
    let proposal_id = create_and_pass_proposal(&env, &admin, ActionType::FeeChange);
    
    // Queue the proposal
    queue_proposal(&env, proposal_id).unwrap();
    
    // Verify proposal is queued
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.state, ProposalState::Queued);
    
    // Try to execute before timelock - should fail
    let result = execute_proposal(&env, proposal_id);
    assert_eq!(result, Err(Error::TimelockNotExpired));
    
    // Advance past timelock (eta)
    env.ledger().with_mut(|li| {
        li.timestamp = proposal.eta + 1;
    });
    
    // Execute proposal
    execute_proposal(&env, proposal_id).unwrap();
    
    // Verify proposal marked as executed
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.state, ProposalState::Executed);
    assert!(proposal.executed_at.is_some());
    
    // Verify event emitted
    let events: Vec<_> = env.events().all()
        .iter()
        .filter(|e| e.0.get(0).unwrap() == Symbol::new(&env, "prop_exe"))
        .collect();
    assert_eq!(events.len(), 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: Execute proposal for pause action
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_execute_proposal_pause_contract() {
    let (env, admin) = setup_governance();
    
    // Verify initially not paused
    assert!(!storage::get_paused(&env));
    
    // Create and pass pause proposal
    let proposal_id = create_and_pass_proposal(&env, &admin, ActionType::PauseContract);
    
    // Queue and execute
    queue_proposal(&env, proposal_id).unwrap();
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    env.ledger().with_mut(|li| {
        li.timestamp = proposal.eta + 1;
    });
    
    execute_proposal(&env, proposal_id).unwrap();
    
    // Verify contract is now paused
    assert!(storage::get_paused(&env));
    
    // Verify pause event emitted
    let events: Vec<_> = env.events().all()
        .iter()
        .filter(|e| e.0.get(0).unwrap() == Symbol::new(&env, "pause"))
        .collect();
    assert_eq!(events.len(), 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: Execute proposal for unpause action
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_execute_proposal_unpause_contract() {
    let (env, admin) = setup_governance();
    
    // First pause the contract
    storage::set_paused(&env, true);
    assert!(storage::get_paused(&env));
    
    // Create and pass unpause proposal
    let proposal_id = create_and_pass_proposal(&env, &admin, ActionType::UnpauseContract);
    
    // Queue and execute
    queue_proposal(&env, proposal_id).unwrap();
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    env.ledger().with_mut(|li| {
        li.timestamp = proposal.eta + 1;
    });
    
    execute_proposal(&env, proposal_id).unwrap();
    
    // Verify contract is now unpaused
    assert!(!storage::get_paused(&env));
    
    // Verify unpause event emitted
    let events: Vec<_> = env.events().all()
        .iter()
        .filter(|e| e.0.get(0).unwrap() == Symbol::new(&env, "unpause"))
        .collect();
    assert_eq!(events.len(), 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: Cannot execute unqueued proposal
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_execute_proposal_not_queued_fails() {
    let (env, admin) = setup_governance();
    
    // Create and pass proposal but don't queue it
    let proposal_id = create_and_pass_proposal(&env, &admin, ActionType::FeeChange);
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    
    // Advance past eta
    env.ledger().with_mut(|li| {
        li.timestamp = proposal.eta + 1;
    });
    
    // Try to execute without queueing - should fail
    let result = execute_proposal(&env, proposal_id);
    assert_eq!(result, Err(Error::InvalidParameters));
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 5: Cannot execute cancelled proposal
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_execute_cancelled_proposal_fails() {
    let (env, admin) = setup_governance();
    
    // Create and pass proposal
    let proposal_id = create_and_pass_proposal(&env, &admin, ActionType::FeeChange);
    
    // Queue the proposal
    queue_proposal(&env, proposal_id).unwrap();
    
    // Manually cancel the proposal (cancel_proposal is another contributor's issue)
    let mut proposal = storage::get_proposal(&env, proposal_id).unwrap();
    proposal.state = ProposalState::Cancelled;
    proposal.cancelled_at = Some(env.ledger().timestamp());
    storage::set_proposal(&env, proposal_id, &proposal);
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    
    // Advance past eta
    env.ledger().with_mut(|li| {
        li.timestamp = proposal.eta + 1;
    });
    
    // Try to execute cancelled proposal - should fail
    let result = execute_proposal(&env, proposal_id);
    assert_eq!(result, Err(Error::InvalidParameters));
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 6: Cannot execute before timelock expires
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_execute_before_eta_fails() {
    let (env, admin) = setup_governance();
    
    // Create and pass proposal
    let proposal_id = create_and_pass_proposal(&env, &admin, ActionType::FeeChange);
    
    // Queue the proposal
    queue_proposal(&env, &admin, proposal_id).unwrap();
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    
    // Try to execute at eta - 1 (should fail)
    env.ledger().with_mut(|li| {
        li.timestamp = proposal.eta - 1;
    });
    
    let result = execute_proposal(&env, proposal_id);
    assert_eq!(result, Err(Error::TimelockNotExpired));
    
    // Try to execute exactly at eta (should still fail, needs to be after)
    env.ledger().with_mut(|li| {
        li.timestamp = proposal.eta;
    });
    
    let result = execute_proposal(&env, proposal_id);
    assert_eq!(result, Err(Error::TimelockNotExpired));
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 7: Cannot double-execute proposal
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_double_execute_fails() {
    let (env, admin) = setup_governance();
    
    // Create and pass proposal
    let proposal_id = create_and_pass_proposal(&env, &admin, ActionType::FeeChange);
    
    // Queue the proposal
    queue_proposal(&env, proposal_id).unwrap();
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    
    // Advance past eta
    env.ledger().with_mut(|li| {
        li.timestamp = proposal.eta + 1;
    });
    
    // Execute proposal first time
    execute_proposal(&env, proposal_id).unwrap();
    
    // Try to execute again - should fail
    let result = execute_proposal(&env, proposal_id);
    assert_eq!(result, Err(Error::InvalidParameters));
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 8: Event sequence verification
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_execution_event_sequence() {
    let (env, admin) = setup_governance();
    
    // Create and pass proposal
    let proposal_id = create_and_pass_proposal(&env, &admin, ActionType::FeeChange);
    
    // Queue the proposal
    queue_proposal(&env, proposal_id).unwrap();
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    
    // Advance past eta
    env.ledger().with_mut(|li| {
        li.timestamp = proposal.eta + 1;
    });
    
    // Execute proposal
    execute_proposal(&env, proposal_id).unwrap();
    
    // Verify event sequence
    let all_events = env.events().all();
    let event_types: Vec<Symbol> = all_events
        .iter()
        .map(|e| e.0.get(0).unwrap())
        .collect();
    
    // Should have: prop_crt (created), prop_vot (votes), prop_que (queued), prop_exe (executed)
    assert!(event_types.contains(&Symbol::new(&env, "prop_crt")));
    assert!(event_types.contains(&Symbol::new(&env, "prop_que")));
    assert!(event_types.contains(&Symbol::new(&env, "prop_exe")));
    
    let vote_count = event_types.iter()
        .filter(|s| **s == Symbol::new(&env, "prop_vot"))
        .count();
    assert_eq!(vote_count, 3); // Three votes were cast
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 9: Multiple proposals independent execution
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_multiple_proposals_execution() {
    let (env, admin) = setup_governance();
    
    // Create multiple proposals with different actions
    let proposal_id_1 = create_and_pass_proposal(&env, &admin, ActionType::FeeChange);
    
    // Advance time a bit before creating second proposal
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 1000;
    });
    
    let proposal_id_2 = create_and_pass_proposal(&env, &admin, ActionType::PauseContract);
    
    // Queue both proposals (manually since queue_proposal is another contributor's issue)
    manually_queue_proposal(&env, proposal_id_1);
    manually_queue_proposal(&env, proposal_id_2);
    
    // Get proposals to find their etas
    let proposal_1 = get_proposal(&env, proposal_id_1).unwrap();
    let proposal_2 = get_proposal(&env, proposal_id_2).unwrap();
    
    // Execute first proposal
    env.ledger().with_mut(|li| {
        li.timestamp = proposal_1.eta + 1;
    });
    execute_proposal(&env, proposal_id_1).unwrap();
    
    // Verify first is executed, second is not
    let proposal_1 = get_proposal(&env, proposal_id_1).unwrap();
    let proposal_2 = get_proposal(&env, proposal_id_2).unwrap();
    assert!(proposal_1.executed);
    assert!(!proposal_2.executed);
    
    // Execute second proposal
    env.ledger().with_mut(|li| {
        li.timestamp = proposal_2.eta + 1;
    });
    execute_proposal(&env, proposal_id_2).unwrap();
    
    // Verify both are executed
    let proposal_2 = get_proposal(&env, proposal_id_2).unwrap();
    assert!(proposal_2.executed);
}
