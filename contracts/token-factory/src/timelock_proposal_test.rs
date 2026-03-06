#![cfg(test)]

use crate::timelock::{create_proposal, get_proposal, initialize_timelock};
use crate::types::{ActionType, Error};
use crate::storage;
use soroban_sdk::{testutils::Address as _, vec, Env};
use soroban_sdk::testutils::Ledger;

fn setup_for_proposals() -> (Env, soroban_sdk::Address) {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = soroban_sdk::Address::generate(&env);
    storage::set_admin(&env, &admin);
    storage::set_treasury(&env, &soroban_sdk::Address::generate(&env));
    storage::set_base_fee(&env, 1_000_000);
    storage::set_metadata_fee(&env, 500_000);
    
    initialize_timelock(&env, Some(3600)).unwrap();
    
    (env, admin)
}

#[test]
fn test_create_proposal_valid() {
    let (env, admin) = setup_for_proposals();
    
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 100;
    let end_time = start_time + 86400; // 1 day voting period
    let eta = end_time + 3600; // 1 hour after voting ends
    
    let payload = vec![&env, 1u8, 2u8, 3u8];
    
    let proposal_id = create_proposal(
        &env,
        &admin,
        ActionType::FeeChange,
        payload.clone(),
        start_time,
        end_time,
        eta,
    ).unwrap();
    
    assert_eq!(proposal_id, 0);
    assert_eq!(storage::get_proposal_count(&env), 1);
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.id, proposal_id);
    assert_eq!(proposal.proposer, admin);
    assert_eq!(proposal.action_type, ActionType::FeeChange);
    assert_eq!(proposal.payload, payload);
    assert_eq!(proposal.start_time, start_time);
    assert_eq!(proposal.end_time, end_time);
    assert_eq!(proposal.eta, eta);
    assert_eq!(proposal.created_at, current_time);
    assert_eq!(proposal.votes_for, 0);
    assert_eq!(proposal.votes_against, 0);
    assert_eq!(proposal.votes_abstain, 0);
}

#[test]
fn test_create_proposal_unauthorized() {
    let (env, _admin) = setup_for_proposals();
    
    let unauthorized = soroban_sdk::Address::generate(&env);
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 100;
    let end_time = start_time + 86400;
    let eta = end_time + 3600;
    
    let payload = vec![&env, 1u8, 2u8, 3u8];
    
    let result = create_proposal(
        &env,
        &unauthorized,
        ActionType::FeeChange,
        payload,
        start_time,
        end_time,
        eta,
    );
    
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_create_proposal_start_time_in_past() {
    let (env, admin) = setup_for_proposals();
    
    let current_time = env.ledger().timestamp();
    let start_time = current_time - 100; // In the past
    let end_time = current_time + 86400;
    let eta = end_time + 3600;
    
    let payload = vec![&env, 1u8, 2u8, 3u8];
    
    let result = create_proposal(
        &env,
        &admin,
        ActionType::FeeChange,
        payload,
        start_time,
        end_time,
        eta,
    );
    
    assert_eq!(result, Err(Error::InvalidTimeWindow));
}

#[test]
fn test_create_proposal_end_before_start() {
    let (env, admin) = setup_for_proposals();
    
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 100;
    let end_time = start_time - 10; // Before start
    let eta = end_time + 3600;
    
    let payload = vec![&env, 1u8, 2u8, 3u8];
    
    let result = create_proposal(
        &env,
        &admin,
        ActionType::FeeChange,
        payload,
        start_time,
        end_time,
        eta,
    );
    
    assert_eq!(result, Err(Error::InvalidTimeWindow));
}

#[test]
fn test_create_proposal_eta_before_end() {
    let (env, admin) = setup_for_proposals();
    
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 100;
    let end_time = start_time + 86400;
    let eta = end_time - 100; // Before end time
    
    let payload = vec![&env, 1u8, 2u8, 3u8];
    
    let result = create_proposal(
        &env,
        &admin,
        ActionType::FeeChange,
        payload,
        start_time,
        end_time,
        eta,
    );
    
    assert_eq!(result, Err(Error::InvalidTimeWindow));
}

#[test]
fn test_create_proposal_payload_too_large() {
    let (env, admin) = setup_for_proposals();
    
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 100;
    let end_time = start_time + 86400;
    let eta = end_time + 3600;
    
    // Create payload larger than MAX_PAYLOAD_SIZE (1024 bytes)
    let mut large_payload = vec![&env];
    for _ in 0..1025 {
        large_payload.push_back(1u8);
    }
    
    let result = create_proposal(
        &env,
        &admin,
        ActionType::FeeChange,
        large_payload,
        start_time,
        end_time,
        eta,
    );
    
    assert_eq!(result, Err(Error::PayloadTooLarge));
}

#[test]
fn test_create_proposal_max_payload_size() {
    let (env, admin) = setup_for_proposals();
    
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 100;
    let end_time = start_time + 86400;
    let eta = end_time + 3600;
    
    // Create payload exactly at MAX_PAYLOAD_SIZE (1024 bytes)
    let mut max_payload = vec![&env];
    for _ in 0..1024 {
        max_payload.push_back(1u8);
    }
    
    let proposal_id = create_proposal(
        &env,
        &admin,
        ActionType::FeeChange,
        max_payload.clone(),
        start_time,
        end_time,
        eta,
    ).unwrap();
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.payload.len(), 1024);
}

#[test]
fn test_create_multiple_proposals() {
    let (env, admin) = setup_for_proposals();
    
    let current_time = env.ledger().timestamp();
    let payload = vec![&env, 1u8, 2u8, 3u8];
    
    // Create first proposal
    let proposal_id_1 = create_proposal(
        &env,
        &admin,
        ActionType::FeeChange,
        payload.clone(),
        current_time + 100,
        current_time + 86500,
        current_time + 90100,
    ).unwrap();
    
    // Create second proposal
    let proposal_id_2 = create_proposal(
        &env,
        &admin,
        ActionType::TreasuryChange,
        payload.clone(),
        current_time + 200,
        current_time + 86600,
        current_time + 90200,
    ).unwrap();
    
    assert_eq!(proposal_id_1, 0);
    assert_eq!(proposal_id_2, 1);
    assert_eq!(storage::get_proposal_count(&env), 2);
    
    let prop1 = get_proposal(&env, proposal_id_1).unwrap();
    let prop2 = get_proposal(&env, proposal_id_2).unwrap();
    
    assert_eq!(prop1.action_type, ActionType::FeeChange);
    assert_eq!(prop2.action_type, ActionType::TreasuryChange);
}

#[test]
fn test_create_proposal_different_action_types() {
    let (env, admin) = setup_for_proposals();
    
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 100;
    let end_time = start_time + 86400;
    let eta = end_time + 3600;
    let payload = vec![&env, 1u8, 2u8, 3u8];
    
    // Test all action types
    let action_types = vec![
        &env,
        ActionType::FeeChange,
        ActionType::TreasuryChange,
        ActionType::PauseContract,
        ActionType::UnpauseContract,
        ActionType::PolicyUpdate,
    ];
    
    for (i, action_type) in action_types.iter().enumerate() {
        let proposal_id = create_proposal(
            &env,
            &admin,
            action_type,
            payload.clone(),
            start_time + (i as u64 * 1000),
            end_time + (i as u64 * 1000),
            eta + (i as u64 * 1000),
        ).unwrap();
        
        let proposal = get_proposal(&env, proposal_id).unwrap();
        assert_eq!(proposal.action_type, action_type);
    }
    
    assert_eq!(storage::get_proposal_count(&env), 5);
}

#[test]
fn test_get_nonexistent_proposal() {
    let (env, _admin) = setup_for_proposals();
    
    let result = get_proposal(&env, 999);
    assert!(result.is_none());
}

#[test]
fn test_create_proposal_empty_payload() {
    let (env, admin) = setup_for_proposals();
    
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 100;
    let end_time = start_time + 86400;
    let eta = end_time + 3600;
    
    let empty_payload = vec![&env];
    
    let proposal_id = create_proposal(
        &env,
        &admin,
        ActionType::PauseContract,
        empty_payload.clone(),
        start_time,
        end_time,
        eta,
    ).unwrap();
    
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.payload.len(), 0);
}
