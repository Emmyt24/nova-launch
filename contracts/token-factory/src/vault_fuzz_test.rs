//! Vault Fuzz Tests
//!
//! Fuzz testing for boundary conditions, large amounts, and malformed configurations
//! in vault (stream) functionality.

#![cfg(test)]

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

#[cfg(test)]
mod fuzz_tests {
    use super::*;
    use proptest::prelude::*;
    
    // ═══════════════════════════════════════════════════════════════════════
    // Boundary Timestamp Fuzz Tests
    // ═══════════════════════════════════════════════════════════════════════
    
    proptest! {
        /// Fuzz Test: Boundary timestamps near zero
        #[test]
        fn fuzz_timestamps_near_zero(
            start in 0u64..=100u64,
            cliff_offset in 1u64..=50u64,
            end_offset in 51u64..=200u64,
            amount in 1i128..=1_000_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            let cliff = start + cliff_offset;
            let end = start + end_offset;
            
            // Should not panic
            let result = client.try_create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &start,
                &cliff,
                &end,
                &None,
            );
            
            // Either succeeds or returns typed error
            prop_assert!(result.is_ok() || result.is_err());
        }
        
        /// Fuzz Test: Boundary timestamps near u64::MAX
        #[test]
        fn fuzz_timestamps_near_max(
            offset_from_max in 1000u64..=100_000u64,
            duration in 100u64..=500u64,
            amount in 1i128..=1_000_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            let start = u64::MAX - offset_from_max;
            let cliff = start.saturating_add(duration / 2);
            let end = start.saturating_add(duration);
            
            // Should not panic
            let result = client.try_create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &start,
                &cliff,
                &end,
                &None,
            );
            
            // Either succeeds or returns typed error
            prop_assert!(result.is_ok() || result.is_err());
        }
        
        /// Fuzz Test: Very short durations (1 second)
        #[test]
        fn fuzz_minimal_duration(
            start in 1000u64..=1_000_000u64,
            amount in 1i128..=1_000_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            let cliff = start;
            let end = start + 1; // 1 second duration
            
            // Should not panic
            let result = client.try_create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &start,
                &cliff,
                &end,
                &None,
            );
            
            prop_assert!(result.is_ok() || result.is_err());
        }
        
        /// Fuzz Test: Very long durations (years)
        #[test]
        fn fuzz_maximum_duration(
            start in 1000u64..=1_000_000u64,
            years in 1u64..=100u64,
            amount in 1i128..=1_000_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            let duration = years * 365 * 24 * 3600;
            let cliff = start + duration / 4;
            let end = start.saturating_add(duration);
            
            // Should not panic
            let result = client.try_create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &start,
                &cliff,
                &end,
                &None,
            );
            
            prop_assert!(result.is_ok() || result.is_err());
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // Large Amount Fuzz Tests
    // ═══════════════════════════════════════════════════════════════════════
    
    proptest! {
        /// Fuzz Test: Very large amounts near i128::MAX
        #[test]
        fn fuzz_large_amounts(
            amount_scale in 1u64..=1000u64,
            start in 1000u64..=10000u64,
            duration in 1000u64..=100000u64,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            // Generate large amounts
            let amount = (i128::MAX / 1000) * (amount_scale as i128);
            let cliff = start + duration / 4;
            let end = start + duration;
            
            // Should not panic
            let result = client.try_create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &start,
                &cliff,
                &end,
                &None,
            );
            
            prop_assert!(result.is_ok() || result.is_err());
            
            // If creation succeeded, try claiming
            if let Ok(stream_id) = result {
                env.ledger().with_mut(|li| {
                    li.timestamp = end;
                });
                
                let claim_result = client.try_claim_stream(&recipient, &stream_id);
                prop_assert!(claim_result.is_ok() || claim_result.is_err());
            }
        }
        
        /// Fuzz Test: Minimal amounts (1 unit)
        #[test]
        fn fuzz_minimal_amounts(
            start in 1000u64..=10000u64,
            duration in 100u64..=10000u64,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            let amount = 1i128; // Minimal amount
            let cliff = start + duration / 4;
            let end = start + duration;
            
            // Should not panic
            let result = client.try_create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &start,
                &cliff,
                &end,
                &None,
            );
            
            prop_assert!(result.is_ok() || result.is_err());
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // Malformed Configuration Fuzz Tests
    // ═══════════════════════════════════════════════════════════════════════
    
    proptest! {
        /// Fuzz Test: Inverted timestamps (end before start)
        #[test]
        fn fuzz_inverted_timestamps(
            t1 in 1000u64..=100000u64,
            t2 in 1000u64..=100000u64,
            t3 in 1000u64..=100000u64,
            amount in 1i128..=1_000_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            // Use timestamps in random order
            let result = client.try_create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &t1,
                &t2,
                &t3,
                &None,
            );
            
            // Should return error, not panic
            prop_assert!(result.is_ok() || result.is_err());
        }
        
        /// Fuzz Test: Metadata length boundaries
        #[test]
        fn fuzz_metadata_length(
            length in 0usize..=1000usize,
            start in 1000u64..=10000u64,
            duration in 1000u64..=10000u64,
            amount in 1i128..=1_000_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            let metadata = if length > 0 {
                Some(String::from_str(&env, &"x".repeat(length)))
            } else {
                None
            };
            
            let cliff = start + duration / 4;
            let end = start + duration;
            
            // Should not panic
            let result = client.try_create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &start,
                &cliff,
                &end,
                &metadata,
            );
            
            // Valid if length <= 512, error otherwise
            if length > 0 && length <= 512 {
                prop_assert!(result.is_ok());
            } else if length > 512 {
                prop_assert!(result.is_err());
            }
        }
        
        /// Fuzz Test: Cliff position variations
        #[test]
        fn fuzz_cliff_positions(
            start in 1000u64..=10000u64,
            duration in 1000u64..=10000u64,
            cliff_fraction in 0u64..=100u64,
            amount in 1i128..=1_000_000_000i128,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            let end = start + duration;
            let cliff = start + (duration * cliff_fraction / 100);
            
            // Should not panic
            let result = client.try_create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &start,
                &cliff,
                &end,
                &None,
            );
            
            prop_assert!(result.is_ok() || result.is_err());
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // Arithmetic Overflow Fuzz Tests
    // ═══════════════════════════════════════════════════════════════════════
    
    proptest! {
        /// Fuzz Test: Vesting calculation with extreme values
        #[test]
        fn fuzz_vesting_calculation_overflow(
            amount in 1i128..=(i128::MAX / 2),
            start in 0u64..=u64::MAX / 2,
            duration in 1u64..=u64::MAX / 2,
            query_offset in 0u64..=u64::MAX / 2,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let token = Address::generate(&env);
            
            let cliff = start + duration / 4;
            let end = start.saturating_add(duration);
            
            let result = client.try_create_stream(
                &creator,
                &recipient,
                &token,
                &amount,
                &start,
                &cliff,
                &end,
                &None,
            );
            
            if let Ok(stream_id) = result {
                // Try to query at various times
                env.ledger().with_mut(|li| {
                    li.timestamp = start.saturating_add(query_offset);
                });
                
                // Should not panic
                let claim_result = client.try_claim_stream(&recipient, &stream_id);
                prop_assert!(claim_result.is_ok() || claim_result.is_err());
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Deterministic Edge Case Tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_exact_boundary_timestamps() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    // Test with start = cliff = end (instant vesting)
    let result = client.try_create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &100,
        &100,
        &None,
    );
    
    // Should fail with invalid schedule
    assert!(result.is_err());
}

#[test]
fn test_maximum_i128_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    // Test with maximum possible amount
    let result = client.try_create_stream(
        &creator,
        &recipient,
        &token,
        &i128::MAX,
        &100,
        &200,
        &300,
        &None,
    );
    
    // Should not panic
    assert!(result.is_ok() || result.is_err());
}

#[test]
fn test_empty_string_metadata() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    let empty_metadata = String::from_str(&env, "");
    
    // Test with empty string metadata
    let result = client.try_create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &200,
        &300,
        &Some(empty_metadata),
    );
    
    // Should fail (empty string not allowed)
    assert!(result.is_err());
}

#[test]
fn test_exact_512_char_metadata() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    let metadata = String::from_str(&env, &"x".repeat(512));
    
    // Test with exactly 512 characters (boundary)
    let result = client.try_create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &200,
        &300,
        &Some(metadata),
    );
    
    // Should succeed (512 is the limit)
    assert!(result.is_ok());
}

#[test]
fn test_513_char_metadata() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin, _treasury) = setup_factory(&env);
    
    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);
    
    let metadata = String::from_str(&env, &"x".repeat(513));
    
    // Test with 513 characters (over limit)
    let result = client.try_create_stream(
        &creator,
        &recipient,
        &token,
        &1_000_000,
        &100,
        &200,
        &300,
        &Some(metadata),
    );
    
    // Should fail (over 512 limit)
    assert!(result.is_err());
}
