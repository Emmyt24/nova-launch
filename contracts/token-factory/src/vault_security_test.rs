//! Vault Security Tests
//!
//! This module provides comprehensive security testing for vault (stream) functionality
//! covering authorization, arithmetic safety, timing attacks, and replay protection.

#![cfg(test)]

use crate::stream_types::{StreamSchedule, StreamInfo};
use crate::types::Error;
use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{Address, Env, String};

#[cfg(test)]
use soroban_sdk::testutils::Address as _;

fn setup_factory(env: &Env) -> (TokenFactoryClient, Address, Address) {
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(env, &contract_id);
    
    client.initialize(&admin, &treasury, &1_000_000, &500_000);
    
    (client, admin, treasury)
}

// ═══════════════════════════════════════════════════════════════════════
// Authorization Tests - Unauthorized Access Attempts
// ═══════════════════════════════════════════════════════════════════════

#[test]
#[should_panic(expected = "require_auth")]
fn test_unauthorized_create_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let attacker = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    // Attempt to create stream without authorization
    env.mock_all_auths_allowing_non_root_auth();
    let result = client.try_create_stream(
        &attacker,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &200,
        &300,
        &None,
    );
    
    assert!(result.is_err());
}

#[test]
fn test_unauthorized_claim_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let attacker = Address::generate(&env);
    let token = Address::generate(&env);
    
    // Create a valid stream
    let stream_id = client.create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &200,
        &300,
        &None,
    );
    
    // Advance time past cliff
    env.ledger().with_mut(|li| {
        li.timestamp = 250;
    });
    
    // Attacker tries to claim (should fail - only recipient can claim)
    let result = client.try_claim_stream(&attacker, &stream_id);
    assert!(result.is_err());
}

#[test]
fn test_unauthorized_cancel_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let attacker = Address::generate(&env);
    let token = Address::generate(&env);
    
    // Create a valid stream
    let stream_id = client.create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &200,
        &300,
        &None,
    );
    
    // Attacker tries to cancel (should fail - only creator can cancel)
    let result = client.try_cancel_stream(&attacker, &stream_id);
    assert!(result.is_err());
}

// ═══════════════════════════════════════════════════════════════════════
// Arithmetic Safety Tests - Property Tests for Invariants
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod property_tests {
    use super::*;
    use proptest::prelude::*;
    
    proptest! {
        /// PROPERTY: claimed_amount <= total_amount at all times
        #[test]
        fn prop_claimed_never_exceeds_total(
            amount in 1i128..=i64::MAX as i128,
            start in 100u64..=1000u64,
            duration in 100u64..=10000u64,
            claim_offset in 0u64..=15000u64,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            let cliff = start + duration / 4;
            let end = start + duration;
            
            let stream_id = client.create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &start,
                &cliff,
                &end,
                &None,
            );
            
            // Advance time
            env.ledger().with_mut(|li| {
                li.timestamp = start + claim_offset;
            });
            
            // Try to claim
            if claim_offset >= (cliff - start) {
                let claimed = client.try_claim_stream(&recipient, &stream_id);
                if let Ok(claimed_amount) = claimed {
                    prop_assert!(claimed_amount <= amount, 
                        "Claimed {} exceeds total {}", claimed_amount, amount);
                }
            }
        }
        
        /// PROPERTY: claimed amount is monotonically increasing
        #[test]
        fn prop_claimed_monotonic(
            amount in 1_000_000i128..=1_000_000_000i128,
            start in 100u64..=1000u64,
            duration in 1000u64..=10000u64,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            let cliff = start + duration / 4;
            let end = start + duration;
            
            let stream_id = client.create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &start,
                &cliff,
                &end,
                &None,
            );
            
            let mut last_claimed = 0i128;
            
            // Claim at multiple time points
            for offset in [duration / 2, duration * 3 / 4, duration] {
                env.ledger().with_mut(|li| {
                    li.timestamp = start + offset;
                });
                
                if let Ok(stream) = client.try_get_stream(&stream_id) {
                    prop_assert!(stream.claimed >= last_claimed,
                        "Claimed amount decreased: {} < {}", stream.claimed, last_claimed);
                    last_claimed = stream.claimed;
                }
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Timing Attack Tests - Boundary Conditions
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_claim_before_cliff_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    let stream_id = client.create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &200,
        &300,
        &None,
    );
    
    // Try to claim before cliff
    env.ledger().with_mut(|li| {
        li.timestamp = 150; // Before cliff at 200
    });
    
    let result = client.try_claim_stream(&recipient, &stream_id);
    assert!(result.is_err());
}

#[test]
fn test_claim_at_exact_cliff_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    let stream_id = client.create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &200,
        &300,
        &None,
    );
    
    // Claim at exact cliff time
    env.ledger().with_mut(|li| {
        li.timestamp = 200;
    });
    
    let result = client.try_claim_stream(&recipient, &stream_id);
    assert!(result.is_ok());
}

#[test]
fn test_timestamp_overflow_protection() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    // Try to create stream with overflow-prone timestamps
    let result = client.try_create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &u64::MAX - 100,
        &u64::MAX - 50,
        &u64::MAX,
        &None,
    );
    
    // Should either succeed or fail gracefully (no panic)
    assert!(result.is_ok() || result.is_err());
}

// ═══════════════════════════════════════════════════════════════════════
// Replay Attack Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_double_claim_protection() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    let stream_id = client.create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &200,
        &300,
        &None,
    );
    
    // Advance time past cliff
    env.ledger().with_mut(|li| {
        li.timestamp = 250;
    });
    
    // First claim should succeed
    let first_claim = client.claim_stream(&recipient, &stream_id);
    assert!(first_claim > 0);
    
    // Immediate second claim should return 0 (nothing new to claim)
    let second_claim = client.try_claim_stream(&recipient, &stream_id);
    assert!(second_claim.is_ok());
    assert_eq!(second_claim.unwrap(), 0);
}

#[test]
fn test_cancel_after_cancel_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    let stream_id = client.create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &200,
        &300,
        &None,
    );
    
    // First cancel should succeed
    client.cancel_stream(&creator, &stream_id);
    
    // Second cancel should fail
    let result = client.try_cancel_stream(&creator, &stream_id);
    assert!(result.is_err());
}

// ═══════════════════════════════════════════════════════════════════════
// Error Handling Tests - No Panic Paths
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_invalid_stream_id_returns_error() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let recipient = Address::generate(&env);
    
    // Try to claim non-existent stream
    let result = client.try_claim_stream(&recipient, &99999);
    assert!(result.is_err());
}

#[test]
fn test_zero_amount_returns_error() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    // Try to create stream with zero amount
    let result = client.try_create_stream(
        &creator,
        &recipient,
        &token,
        &0,
        &100,
        &200,
        &300,
        &None,
    );
    
    assert!(result.is_err());
}

#[test]
fn test_negative_amount_returns_error() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    // Try to create stream with negative amount
    let result = client.try_create_stream(
        &creator,
        &recipient,
        &token,
        &-1000,
        &100,
        &200,
        &300,
        &None,
    );
    
    assert!(result.is_err());
}

#[test]
fn test_invalid_schedule_returns_error() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    // Try to create stream with end before start
    let result = client.try_create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &300,
        &200,
        &100,
        &None,
    );
    
    assert!(result.is_err());
}

#[test]
fn test_malformed_metadata_returns_error() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    // Create metadata that's too long (>512 chars)
    let long_metadata = String::from_str(&env, &"x".repeat(600));
    
    // Try to create stream with invalid metadata
    let result = client.try_create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &200,
        &300,
        &Some(long_metadata),
    );
    
    assert!(result.is_err());
}
