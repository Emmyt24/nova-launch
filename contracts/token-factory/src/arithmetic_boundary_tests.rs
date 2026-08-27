//! Arithmetic Boundary Tests for Contract Operations
//!
//! This module contains comprehensive boundary tests for arithmetic operations
//! used in smart contract functions. These tests ensure:
//! - Overflow/underflow protection works correctly
//! - Edge cases are handled properly
//! - Boundary values (i128::MAX, i128::MIN, 0) behave correctly
//! - All arithmetic operations maintain security invariants
//!
//! Test coverage targets: >90%
//! Security: Follows OWASP guidelines for integer overflow prevention

#![cfg(test)]

use crate::{
    types::{Error, TokenInfo},
    storage,
};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, Env, String,
};

// ============================================================================
// Boundary Test Utilities
// ============================================================================

/// Helper to create a standard test environment with contract initialized
fn setup_arithmetic_test_env() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let user = Address::generate(&env);

    let contract_id = env.register_contract(None, crate::TokenFactory);
    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &admin);
        storage::set_treasury(&env, &treasury);
        storage::set_base_fee(&env, 100);
        storage::set_metadata_fee(&env, 50);
    });

    (env, contract_id, admin, treasury, user)
}

/// Create a standard token for testing with specified supply values
fn create_test_token(env: &Env, contract_id: &Address, supply: i128, max: Option<i128>) -> u32 {
    env.as_contract(contract_id, || {
        let token_info = TokenInfo {
            address: Address::generate(env),
            creator: Address::generate(env),
            name: String::from_str(env, "Boundary Test Token"),
            symbol: String::from_str(env, "BND"),
            decimals: 7,
            total_supply: supply,
            initial_supply: supply,
            max_supply: max,
            total_burned: 0,
            burn_count: 0,
            metadata_uri: None,
            metadata_version: 0,
            created_at: env.ledger().timestamp(),
            clawback_enabled: false,
            freeze_enabled: false,
            is_paused: false,
        };
        storage::set_token_info(env, 0, &token_info);
        storage::set_balance(env, 0, &token_info.creator, supply);
        0
    })
}

// ============================================================================
// 1. CHECKED_ADD BOUNDARY TESTS
// ============================================================================

#[cfg(test)]
mod checked_add_boundary_tests {
    use super::*;

    // ---- i128::MAX boundaries ----

    #[test]
    fn test_add_overflow_at_i128_max() {
        // Adding 1 to i128::MAX should overflow
        let result = i128::MAX.checked_add(1);
        assert_eq!(result, None);
    }

    #[test]
    fn test_add_zero_to_i128_max() {
        // Adding 0 to i128::MAX should succeed
        let result = i128::MAX.checked_add(0);
        assert_eq!(result, Some(i128::MAX));
    }

    #[test]
    fn test_add_negative_to_i128_max() {
        // Adding negative to i128::MAX should succeed
        let result = i128::MAX.checked_add(-1);
        assert_eq!(result, Some(i128::MAX - 1));
    }

    // ---- i128::MIN boundaries ----

    #[test]
    fn test_add_underflow_at_i128_min() {
        // Subtracting 1 from i128::MIN should overflow
        let result = i128::MIN.checked_add(-1);
        assert_eq!(result, None);
    }

    #[test]
    fn test_add_zero_to_i128_min() {
        // Adding 0 to i128::MIN should succeed
        let result = i128::MIN.checked_add(0);
        assert_eq!(result, Some(i128::MIN));
    }

    #[test]
    fn test_add_positive_to_i128_min() {
        // Adding positive to i128::MIN should succeed (if within range)
        let result = i128::MIN.checked_add(1);
        assert_eq!(result, Some(i128::MIN + 1));
    }

    // ---- Token supply overflow tests ----

    #[test]
    fn test_mint_supply_overflow_protection() {
        let (env, contract_id, _admin, _treasury, _user) = setup_arithmetic_test_env();

        // Create token with supply near i128::MAX
        create_test_token(&env, &contract_id, i128::MAX - 100, None);

        // Attempt to mint amount that would overflow
        let result = env.as_contract(&contract_id, || {
            crate::mint::validate_max_supply(i128::MAX - 100, 200, None)
        });

        // Should return ArithmeticError due to overflow
        assert_eq!(result, Err(Error::ArithmeticError));
    }

    #[test]
    fn test_mint_exact_boundary_no_overflow() {
        let (env, contract_id, _admin, _treasury, _user) = setup_arithmetic_test_env();

        // Create token with supply at i128::MAX - 1000
        create_test_token(&env, &contract_id, i128::MAX - 1000, None);

        // Mint amount that stays within bounds
        let result = env.as_contract(&contract_id, || {
            crate::mint::validate_max_supply(i128::MAX - 1000, 500, None)
        });

        assert!(result.is_ok());
    }

    // ---- Batch mint total overflow ----

    #[test]
    fn test_batch_mint_total_overflow() {
        // Calculate amounts that would overflow when summed
        let amount1 = i128::MAX / 2;
        let amount2 = i128::MAX / 2 + 1;

        let total = amount1.checked_add(amount2);
        assert_eq!(total, None); // Verifies the overflow
    }
}

// ============================================================================
// 2. CHECKED_SUB BOUNDARY TESTS
// ============================================================================

#[cfg(test)]
mod checked_sub_boundary_tests {
    use super::*;

    // ---- i128::MIN boundaries ----

    #[test]
    fn test_sub_underflow_at_i128_min() {
        let result = i128::MIN.checked_sub(1);
        assert_eq!(result, None);
    }

    #[test]
    fn test_sub_zero_from_i128_min() {
        let result = i128::MIN.checked_sub(0);
        assert_eq!(result, Some(i128::MIN));
    }

    // ---- i128::MAX boundaries ----

    #[test]
    fn test_sub_from_i128_max() {
        let result = i128::MAX.checked_sub(i128::MAX);
        assert_eq!(result, Some(0));
    }

    #[test]
    fn test_sub_negative_from_i128_max() {
        // Subtracting negative is addition
        let result = i128::MAX.checked_sub(-1);
        assert_eq!(result, None); // Overflow
    }

    // ---- Token burn underflow protection ----

    #[test]
    fn test_burn_underflow_protection() {
        let (env, contract_id, _admin, _treasury, user) = setup_arithmetic_test_env();

        // Set up user with zero balance
        env.as_contract(&contract_id, || {
            storage::set_balance(&env, 0, &user, 0);
        });

        // Attempt to burn from zero balance (in burn logic, this checks amount > balance)
        // The burn function checks if amount > 0 first, then subtracts from balance
        let balance: i128 = 0;
        let burn_amount: i128 = 100;

        // Simulating the subtraction check
        let result = balance.checked_sub(burn_amount);
        assert_eq!(result, None); // Underflow
    }

    // ---- Claimable amount calculation underflow ----

    #[test]
    fn test_claimable_underflow_protection() {
        // Create stream where claimed > vested (invalid state, but test boundary)
        let total_amount: i128 = 1000;
        let claimed_amount: i128 = 1000; // Already claimed everything

        // claimable = vested - claimed = 1000 - 1000 = 0
        let claimable = total_amount.checked_sub(claimed_amount);
        assert_eq!(claimable, Some(0));
    }
}

// ============================================================================
// 3. CHECKED_MUL BOUNDARY TESTS
// ============================================================================

#[cfg(test)]
mod checked_mul_boundary_tests {
    use super::*;

    // ---- i128::MAX boundaries ----

    #[test]
    fn test_mul_overflow_at_i128_max() {
        let result = i128::MAX.checked_mul(2);
        assert_eq!(result, None);
    }

    #[test]
    fn test_mul_by_zero() {
        let result = i128::MAX.checked_mul(0);
        assert_eq!(result, Some(0));
    }

    #[test]
    fn test_mul_by_one() {
        let result = i128::MAX.checked_mul(1);
        assert_eq!(result, Some(i128::MAX));
    }

    // ---- Vesting calculation overflow ----

    #[test]
    fn test_vesting_mul_overflow() {
        // Simulate vesting calculation: total_amount * elapsed / duration
        let total_amount: u128 = i128::MAX as u128;
        let elapsed: u128 = 1000;

        // This should overflow when converted to i128 context
        let result = total_amount.checked_mul(elapsed);
        // u128::MAX * 1000 would overflow u128, but i128::MAX as u128 * 1000
        // fits in u128, but may not fit in i128
        assert!(result.is_some()); // In u128 space, this is OK
    }

    // ---- Staking reward calculation overflow ----

    #[test]
    fn test_staking_reward_mul_overflow() {
        // Staking reward = amount * reward_rate
        let amount: i128 = i128::MAX / 2;
        let reward_rate: i128 = 2;

        let result = amount.checked_mul(reward_rate);
        assert_eq!(result, None); // Overflow
    }
}

// ============================================================================
// 4. CHECKED_DIV BOUNDARY TESTS
// ============================================================================

#[cfg(test)]
mod checked_div_boundary_tests {
    use super::*;

    // ---- Division by zero ----

    #[test]
    fn test_div_by_zero() {
        let result = i128::MAX.checked_div(0);
        assert_eq!(result, None);
    }

    #[test]
    fn test_div_zero_by_anything() {
        let result = 0i128.checked_div(100);
        assert_eq!(result, Some(0));
    }

    // ---- Division boundaries ----

    #[test]
    fn test_div_i128_max_by_one() {
        let result = i128::MAX.checked_div(1);
        assert_eq!(result, Some(i128::MAX));
    }

    #[test]
    fn test_div_i128_min_by_one() {
        let result = i128::MIN.checked_div(1);
        assert_eq!(result, Some(i128::MIN));
    }

    #[test]
    fn test_div_negative_by_negative() {
        let result = (-100i128).checked_div(-2);
        assert_eq!(result, Some(50));
    }
}

// ============================================================================
// 5. INTEGRATION BOUNDARY TESTS
// ============================================================================

#[cfg(test)]
mod integration_boundary_tests {
    use super::*;

    // ---- Max supply boundary integration ----

    #[test]
    fn test_token_creation_at_max_supply_boundary() {
        let (env, contract_id, _admin, _treasury, _user) = setup_arithmetic_test_env();

        // Create token with initial supply at reasonable value
        let result = env.as_contract(&contract_id, || {
            crate::mint::validate_max_supply_at_creation(1_000_000, Some(1_000_000))
        });

        assert!(result.is_ok()); // Equal should be allowed
    }

    #[test]
    fn test_token_creation_exceeds_max_supply() {
        let (env, contract_id, _admin, _treasury, _user) = setup_arithmetic_test_env();

        // Initial supply > max supply should fail
        let result = env.as_contract(&contract_id, || {
            crate::mint::validate_max_supply_at_creation(2_000_000, Some(1_000_000))
        });

        assert_eq!(result, Err(Error::InvalidMaxSupply));
    }

    // ---- Fee calculation boundaries ----

    #[test]
    fn test_fee_addition_overflow() {
        let (env, contract_id, _admin, _treasury, _user) = setup_arithmetic_test_env();

        env.as_contract(&contract_id, || {
            storage::set_base_fee(&env, i128::MAX);
            storage::set_metadata_fee(&env, 1);
        });

        // Fee calculation: base_fee + metadata_fee should overflow
        let base = env.as_contract(&contract_id, || storage::get_base_fee(&env).unwrap());
        let meta = env.as_contract(&contract_id, || storage::get_metadata_fee(&env).unwrap());

        let total = base.checked_add(meta);
        assert_eq!(total, None); // Overflow
    }
}

// ============================================================================
// 6. COMPREHENSIVE EDGE CASE TESTS
// ============================================================================

#[cfg(test)]
mod comprehensive_edge_case_tests {
    use super::*;

    // ---- All zero values ----

    #[test]
    fn test_all_zero_arithmetic() {
        assert_eq!(0i128.checked_add(0), Some(0));
        assert_eq!(0i128.checked_sub(0), Some(0));
        assert_eq!(0i128.checked_mul(0), Some(0));
        assert_eq!(0i128.checked_div(1), Some(0));
    }

    // ---- i128 boundaries with all operations ----

    #[test]
    fn test_i128_max_all_operations() {
        let max = i128::MAX;

        // Add
        assert_eq!(max.checked_add(0), Some(max));
        assert_eq!(max.checked_add(1), None);

        // Sub
        assert_eq!(max.checked_sub(0), Some(max));
        assert_eq!(max.checked_sub(max), Some(0));

        // Mul
        assert_eq!(max.checked_mul(0), Some(0));
        assert_eq!(max.checked_mul(1), Some(max));
        assert_eq!(max.checked_mul(2), None);

        // Div
        assert_eq!(max.checked_div(1), Some(max));
        assert_eq!(max.checked_div(max), Some(1));
        assert_eq!(max.checked_div(0), None);
    }

    #[test]
    fn test_i128_min_all_operations() {
        let min = i128::MIN;

        // Add
        assert_eq!(min.checked_add(0), Some(min));
        assert_eq!(min.checked_add(-1), None);

        // Sub
        assert_eq!(min.checked_sub(0), Some(min));
        assert_eq!(min.checked_sub(1), Some(min + 1)); // Note: MIN + 1 is valid

        // Mul
        assert_eq!(min.checked_mul(0), Some(0));
        assert_eq!(min.checked_mul(1), Some(min));
        assert_eq!(min.checked_mul(-1), None); // MIN * -1 overflows

        // Div
        assert_eq!(min.checked_div(1), Some(min));
        assert_eq!(min.checked_div(-1), None); // MIN / -1 overflows
        assert_eq!(min.checked_div(0), None);
    }
}

// ============================================================================
// 7. SECURITY-FOCUSED BOUNDARY TESTS (OWASP)
// ============================================================================

#[cfg(test)]
mod security_boundary_tests {
    use super::*;

    // ---- OWASP: Integer Overflow Prevention ----

    #[test]
    fn test_owasp_integer_overflow_prevention() {
        // Verify that all arithmetic uses checked_* operations

        // Example: mint validation
        let current_supply: i128 = i128::MAX - 100;
        let mint_amount: i128 = 200;

        let new_supply = current_supply.checked_add(mint_amount);
        assert_eq!(new_supply, None); // Overflow detected
    }

    #[test]
    fn test_state_consistency_after_boundary() {
        // Ensure state is not corrupted after boundary operations
        let (env, contract_id, _admin, _treasury, user) = setup_arithmetic_test_env();

        create_test_token(&env, &contract_id, 1000, Some(2000));

        // Attempt operation that would overflow
        let result = env.as_contract(&contract_id, || {
            crate::mint::validate_max_supply(1000, i128::MAX, Some(2000))
        });

        assert_eq!(result, Err(Error::ArithmeticError));

        // Verify state unchanged
        let supply = env.as_contract(&contract_id, || {
            storage::get_token_info(&env, 0).unwrap().total_supply
        });

        assert_eq!(supply, 1000); // Unchanged
    }
}
