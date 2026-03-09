#![cfg(test)]

//! Campaign State Transition Tests
//!
//! Comprehensive test suite for campaign lifecycle management including:
//! - Valid state transitions
//! - Replay protection
//! - Authorization checks
//! - Terminal state enforcement
//! - Duplicate action rejection

use crate::campaign::{pause_campaign, resume_campaign, validate_state_transition};
use crate::storage;
use crate::test_helpers::TestEnv;
use crate::types::{BuybackCampaign, CampaignStatus, Error};
use soroban_sdk::testutils::{Address as _, Events};
use soroban_sdk::Address;

fn create_test_campaign(env: &soroban_sdk::Env, owner: &Address, status: CampaignStatus) -> BuybackCampaign {
    BuybackCampaign {
        id: 1,
        token_index: 0,
        owner: owner.clone(),
        budget_allocated: 1_000_000,
        budget_spent: 0,
        tokens_burned: 0,
        burn_count: 0,
        start_time: env.ledger().timestamp(),
        end_time: 0,
        status,
        created_at: env.ledger().timestamp(),
    }
}

// ============================================================
// Valid State Transition Tests
// ============================================================

#[test]
fn test_active_to_paused_transition() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Active);
        storage::set_campaign(env, 1, &campaign);

        let result = pause_campaign(env, admin, 1);
        assert!(result.is_ok());

        let updated = storage::get_campaign(env, 1).unwrap();
        assert_eq!(updated.status, CampaignStatus::Paused);
    });
}

#[test]
fn test_paused_to_active_transition() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Paused);
        storage::set_campaign(env, 1, &campaign);

        let result = resume_campaign(env, admin, 1);
        assert!(result.is_ok());

        let updated = storage::get_campaign(env, 1).unwrap();
        assert_eq!(updated.status, CampaignStatus::Active);
    });
}

#[test]
fn test_pause_resume_cycle() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Active);
        storage::set_campaign(env, 1, &campaign);

        // Pause
        pause_campaign(env, admin, 1).unwrap();
        let paused = storage::get_campaign(env, 1).unwrap();
        assert_eq!(paused.status, CampaignStatus::Paused);

        // Resume
        resume_campaign(env, admin, 1).unwrap();
        let resumed = storage::get_campaign(env, 1).unwrap();
        assert_eq!(resumed.status, CampaignStatus::Active);

        // Pause again
        pause_campaign(env, admin, 1).unwrap();
        let paused_again = storage::get_campaign(env, 1).unwrap();
        assert_eq!(paused_again.status, CampaignStatus::Paused);
    });
}

// ============================================================
// Replay Protection Tests
// ============================================================

#[test]
fn test_pause_already_paused_rejected() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Paused);
        storage::set_campaign(env, 1, &campaign);

        let result = pause_campaign(env, admin, 1);
        assert_eq!(result, Err(Error::CampaignAlreadyPaused));

        // Verify state unchanged
        let unchanged = storage::get_campaign(env, 1).unwrap();
        assert_eq!(unchanged.status, CampaignStatus::Paused);
    });
}

#[test]
fn test_resume_already_active_rejected() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Active);
        storage::set_campaign(env, 1, &campaign);

        let result = resume_campaign(env, admin, 1);
        assert_eq!(result, Err(Error::CampaignNotPaused));

        // Verify state unchanged
        let unchanged = storage::get_campaign(env, 1).unwrap();
        assert_eq!(unchanged.status, CampaignStatus::Active);
    });
}

#[test]
fn test_multiple_pause_attempts_rejected() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Active);
        storage::set_campaign(env, 1, &campaign);

        // First pause succeeds
        assert!(pause_campaign(env, admin, 1).is_ok());

        // Second pause fails (replay attack)
        assert_eq!(pause_campaign(env, admin, 1), Err(Error::CampaignAlreadyPaused));

        // Third pause also fails
        assert_eq!(pause_campaign(env, admin, 1), Err(Error::CampaignAlreadyPaused));
    });
}

#[test]
fn test_multiple_resume_attempts_rejected() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Paused);
        storage::set_campaign(env, 1, &campaign);

        // First resume succeeds
        assert!(resume_campaign(env, admin, 1).is_ok());

        // Second resume fails (replay attack)
        assert_eq!(resume_campaign(env, admin, 1), Err(Error::CampaignNotPaused));

        // Third resume also fails
        assert_eq!(resume_campaign(env, admin, 1), Err(Error::CampaignNotPaused));
    });
}

// ============================================================
// Terminal State Tests
// ============================================================

#[test]
fn test_pause_completed_campaign_rejected() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Completed);
        storage::set_campaign(env, 1, &campaign);

        let result = pause_campaign(env, admin, 1);
        assert_eq!(result, Err(Error::CampaignCompleted));
    });
}

#[test]
fn test_resume_completed_campaign_rejected() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Completed);
        storage::set_campaign(env, 1, &campaign);

        let result = resume_campaign(env, admin, 1);
        assert_eq!(result, Err(Error::CampaignCompleted));
    });
}

#[test]
fn test_pause_cancelled_campaign_rejected() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Cancelled);
        storage::set_campaign(env, 1, &campaign);

        let result = pause_campaign(env, admin, 1);
        assert_eq!(result, Err(Error::CampaignCancelled));
    });
}

#[test]
fn test_resume_cancelled_campaign_rejected() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Cancelled);
        storage::set_campaign(env, 1, &campaign);

        let result = resume_campaign(env, admin, 1);
        assert_eq!(result, Err(Error::CampaignCancelled));
    });
}

// ============================================================
// Authorization Tests
// ============================================================

#[test]
fn test_owner_can_pause_campaign() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let owner = Address::generate(env);

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, &owner, CampaignStatus::Active);
        storage::set_campaign(env, 1, &campaign);

        let result = pause_campaign(env, &owner, 1);
        assert!(result.is_ok());
    });
}

#[test]
fn test_admin_can_pause_campaign() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;
    let owner = Address::generate(env);

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, &owner, CampaignStatus::Active);
        storage::set_campaign(env, 1, &campaign);

        let result = pause_campaign(env, admin, 1);
        assert!(result.is_ok());
    });
}

#[test]
fn test_unauthorized_pause_rejected() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let owner = Address::generate(env);
    let attacker = Address::generate(env);

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, &owner, CampaignStatus::Active);
        storage::set_campaign(env, 1, &campaign);

        let result = pause_campaign(env, &attacker, 1);
        assert_eq!(result, Err(Error::Unauthorized));
    });
}

#[test]
fn test_unauthorized_resume_rejected() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let owner = Address::generate(env);
    let attacker = Address::generate(env);

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, &owner, CampaignStatus::Paused);
        storage::set_campaign(env, 1, &campaign);

        let result = resume_campaign(env, &attacker, 1);
        assert_eq!(result, Err(Error::Unauthorized));
    });
}

// ============================================================
// Event Emission Tests
// ============================================================

#[test]
fn test_pause_emits_event() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Active);
        storage::set_campaign(env, 1, &campaign);

        pause_campaign(env, admin, 1).unwrap();

        let events = env.events().all();
        let event = events.last().unwrap();
        
        // Verify event was emitted (basic check)
        assert!(event.topics.len() > 0);
    });
}

#[test]
fn test_resume_emits_event() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Paused);
        storage::set_campaign(env, 1, &campaign);

        resume_campaign(env, admin, 1).unwrap();

        let events = env.events().all();
        let event = events.last().unwrap();
        
        // Verify event was emitted (basic check)
        assert!(event.topics.len() > 0);
    });
}

// ============================================================
// State Transition Validation Tests
// ============================================================

#[test]
fn test_all_valid_transitions() {
    // Active -> Paused
    assert!(validate_state_transition(
        CampaignStatus::Active,
        CampaignStatus::Paused
    ).is_ok());

    // Paused -> Active
    assert!(validate_state_transition(
        CampaignStatus::Paused,
        CampaignStatus::Active
    ).is_ok());

    // Active -> Completed
    assert!(validate_state_transition(
        CampaignStatus::Active,
        CampaignStatus::Completed
    ).is_ok());

    // Active -> Cancelled
    assert!(validate_state_transition(
        CampaignStatus::Active,
        CampaignStatus::Cancelled
    ).is_ok());

    // Paused -> Cancelled
    assert!(validate_state_transition(
        CampaignStatus::Paused,
        CampaignStatus::Cancelled
    ).is_ok());
}

#[test]
fn test_all_invalid_transitions() {
    // Replay attempts
    assert_eq!(
        validate_state_transition(CampaignStatus::Active, CampaignStatus::Active),
        Err(Error::InvalidStateTransition)
    );
    assert_eq!(
        validate_state_transition(CampaignStatus::Paused, CampaignStatus::Paused),
        Err(Error::InvalidStateTransition)
    );

    // Terminal state transitions
    assert_eq!(
        validate_state_transition(CampaignStatus::Completed, CampaignStatus::Active),
        Err(Error::InvalidStateTransition)
    );
    assert_eq!(
        validate_state_transition(CampaignStatus::Completed, CampaignStatus::Paused),
        Err(Error::InvalidStateTransition)
    );
    assert_eq!(
        validate_state_transition(CampaignStatus::Cancelled, CampaignStatus::Active),
        Err(Error::InvalidStateTransition)
    );
    assert_eq!(
        validate_state_transition(CampaignStatus::Cancelled, CampaignStatus::Paused),
        Err(Error::InvalidStateTransition)
    );

    // Invalid direct transitions
    assert_eq!(
        validate_state_transition(CampaignStatus::Paused, CampaignStatus::Completed),
        Err(Error::InvalidStateTransition)
    );
}

// ============================================================
// Edge Case Tests
// ============================================================

#[test]
fn test_nonexistent_campaign_pause_fails() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let result = pause_campaign(env, admin, 999);
        assert_eq!(result, Err(Error::CampaignNotFound));
    });
}

#[test]
fn test_nonexistent_campaign_resume_fails() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let result = resume_campaign(env, admin, 999);
        assert_eq!(result, Err(Error::CampaignNotFound));
    });
}

#[test]
fn test_state_persists_after_failed_transition() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;

    env.as_contract(&env.current_contract_address(), || {
        let campaign = create_test_campaign(env, admin, CampaignStatus::Paused);
        storage::set_campaign(env, 1, &campaign);

        // Attempt invalid transition
        let _ = pause_campaign(env, admin, 1);

        // Verify state unchanged
        let unchanged = storage::get_campaign(env, 1).unwrap();
        assert_eq!(unchanged.status, CampaignStatus::Paused);
    });
}
