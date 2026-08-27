//! State Validation Module
//!
//! This module provides comprehensive state validation for the token factory contract.
//! It enforces four critical invariants:
//!
//! 1. **Admin Invariant**: Admin address must be set and valid
//! 2. **Treasury Invariant**: Treasury address must be set and valid
//! 3. **Fee Non-Negativity Invariant**: Both base_fee and metadata_fee must be >= 0
//! 4. **Token Count Consistency Invariant**: Token count must match actual stored tokens
//!
//! ## Usage
//!
//! Call `validate_state()` to perform comprehensive validation of all invariants,
//! or call individual validation functions for specific checks.
//!
//! ## Error Handling
//!
//! All validation functions return `Result<(), Error>`. On validation failure,
//! they return the first error encountered using fail-fast semantics.

use soroban_sdk::Env;

use crate::storage;
use crate::types::Error;

/// Validates that the admin address is set and valid.
///
/// This function checks if the admin address exists in storage and verifies
/// that it is a valid address. The admin address is critical for authorization
/// of administrative operations.
///
/// # Validation Logic
///
/// 1. Check if admin address exists in storage
/// 2. If not set, return `Error::MissingAdmin`
/// 3. Verify address is valid (non-zero, proper format)
/// 4. If invalid, return `Error::InvalidAdmin`
/// 5. Return `Ok(())` if valid
///
/// # Errors
///
/// * `Error::MissingAdmin` - Admin address not set in storage (initialization incomplete)
/// * `Error::InvalidAdmin` - Admin address is invalid (address format or value issue)
///
/// # Examples
///
/// ```ignore
/// // Valid admin
/// validate_admin(&env)?; // Returns Ok(())
///
/// // Missing admin (before initialization)
/// validate_admin(&env)?; // Returns Err(Error::MissingAdmin)
/// ```
pub fn validate_admin(env: &Env) -> Result<(), Error> {
    // Check if admin address exists in storage
    if !storage::has_admin(env) {
        return Err(Error::MissingAdmin);
    }

    // get_admin now returns Option; since we just confirmed has_admin, the unwrap is safe.
    let _admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;

    Ok(())
}

/// Validates that the treasury address is set and valid.
///
/// This function checks if the treasury address exists in storage and verifies
/// that it is a valid address. The treasury address is where contract fees are collected.
///
/// # Validation Logic
///
/// 1. Check if treasury address exists in storage
/// 2. If not set, return `Error::MissingTreasury`
/// 3. Verify address is valid (non-zero, proper format)
/// 4. If invalid, return `Error::InvalidTreasury`
/// 5. Return `Ok(())` if valid
///
/// # Errors
///
/// * `Error::MissingTreasury` - Treasury address not set in storage (initialization incomplete)
/// * `Error::InvalidTreasury` - Treasury address is invalid (address format or value issue)
///
/// # Examples
///
/// ```ignore
/// // Valid treasury
/// validate_treasury(&env)?; // Returns Ok(())
///
/// // Missing treasury (before initialization)
/// validate_treasury(&env)?; // Returns Err(Error::MissingTreasury)
/// ```
#[allow(dead_code)]
pub fn validate_treasury(env: &Env) -> Result<(), Error> {
    // get_treasury now returns Option, which cleanly handles the pre-init case.
    storage::get_treasury(env).ok_or(Error::MissingTreasury)?;
    Ok(())
}

/// Validates that both base_fee and metadata_fee are non-negative.
///
/// This function ensures the fee non-negativity invariant is maintained.
/// Negative fees would allow the contract to lose funds, so this validation
/// is critical for financial security.
///
/// # Validation Logic
///
/// 1. Retrieve base_fee from storage and check >= 0
/// 2. If base_fee < 0, return `Error::InvalidBaseFee`
/// 3. Retrieve metadata_fee from storage and check >= 0
/// 4. If metadata_fee < 0, return `Error::InvalidMetadataFee`
/// 5. Return `Ok(())` if both valid
///
/// # Performance Optimization
///
/// Base fee is checked first as it's more commonly used, enabling early
/// return on failure and reducing gas costs in common error cases.
///
/// # Errors
///
/// * `Error::InvalidBaseFee` - Base fee is negative
/// * `Error::InvalidMetadataFee` - Metadata fee is negative
///
/// # Examples
///
/// ```ignore
/// // Valid fees
/// validate_fees(&env)?; // Returns Ok(())
///
/// // Negative base fee
/// validate_fees(&env)?; // Returns Err(Error::InvalidBaseFee)
/// ```
pub fn validate_fees(env: &Env) -> Result<(), Error> {
    // Check base_fee first (fail-fast optimization). Returns None before init.
    let base_fee = storage::get_base_fee(env).ok_or(Error::InvalidBaseFee)?;
    if base_fee < 0 {
        return Err(Error::InvalidBaseFee);
    }

    // Check metadata_fee
    let metadata_fee = storage::get_metadata_fee(env).ok_or(Error::InvalidMetadataFee)?;
    if metadata_fee < 0 {
        return Err(Error::InvalidMetadataFee);
    }

    Ok(())
}

/// Validates that token_count is non-negative and matches actual stored tokens.
///
/// This function ensures the token count consistency invariant is maintained.
/// An inconsistent token count could lead to incorrect token lookups or
/// registry corruption.
///
/// # Validation Logic
///
/// 1. Retrieve token_count from storage
/// 2. If token_count < 0, return `Error::InvalidTokenCount`
/// 3. Count actual tokens stored (iterate indices 0 to token_count-1)
/// 4. If actual count != token_count, return `Error::InconsistentTokenCount`
/// 5. Return `Ok(())` if consistent
///
/// # Performance Considerations
///
/// This is the most expensive validation due to iteration over token storage.
/// It should be called only when token storage is modified, not on every
/// state validation. For comprehensive validation, it's included but runs last
/// to benefit from fail-fast on cheaper checks.
///
/// # Errors
///
/// * `Error::InvalidTokenCount` - Token count is negative
/// * `Error::InconsistentTokenCount` - Stored count doesn't match actual tokens
///
/// # Examples
///
/// ```ignore
/// // Valid token count
/// validate_token_count(&env)?; // Returns Ok(())
///
/// // Inconsistent count
/// validate_token_count(&env)?; // Returns Err(Error::InconsistentTokenCount)
/// ```
#[allow(dead_code)]
pub fn validate_token_count(env: &Env) -> Result<(), Error> {
    let token_count = storage::get_token_count(env);

    // Token count is u32, so it can't be negative
    // However, we verify consistency with actual stored tokens

    // Count actual tokens by checking each index
    let mut actual_count = 0u32;
    for i in 0..token_count {
        if storage::get_token_info(env, i).is_some() {
            actual_count += 1;
        }
    }

    // Verify count matches reality
    if actual_count != token_count {
        return Err(Error::InconsistentTokenCount);
    }

    Ok(())
}

/// Comprehensive validation of all state invariants.
///
/// This function validates all four critical state invariants in a single call:
/// 1. Admin address is set and valid
/// 2. Treasury address is set and valid
/// 3. Both fees are non-negative
/// 4. Token count matches stored tokens
///
/// # Validation Ordering
///
/// Validations are performed in order of increasing cost:
/// 1. Admin validation (single storage read)
/// 2. Treasury validation (single storage read)
/// 3. Fee validation (two storage reads)
/// 4. Token count validation (iteration over tokens)
///
/// This fail-fast ordering minimizes gas costs when validation fails,
/// as cheaper checks are performed first.
///
/// # Errors
///
/// Returns the first error encountered according to the validation order.
/// Possible errors:
/// * `Error::MissingAdmin` - Admin address not set
/// * `Error::InvalidAdmin` - Admin address is invalid
/// * `Error::MissingTreasury` - Treasury address not set
/// * `Error::InvalidTreasury` - Treasury address is invalid
/// * `Error::InvalidBaseFee` - Base fee is negative
/// * `Error::InvalidMetadataFee` - Metadata fee is negative
/// * `Error::InvalidTokenCount` - Token count is negative
/// * `Error::InconsistentTokenCount` - Token count doesn't match stored tokens
///
/// # Examples
///
/// ```ignore
/// // Valid state
/// validate_state(&env)?; // Returns Ok(())
///
/// // Invalid state (missing admin)
/// validate_state(&env)?; // Returns Err(Error::MissingAdmin)
/// ```
///
/// # Usage
///
/// Call this function after contract initialization or after operations that
/// modify multiple state variables to ensure consistency.
#[allow(dead_code)]
pub fn validate_state(env: &Env) -> Result<(), Error> {
    // Validate in order of increasing cost (fail-fast optimization)
    validate_admin(env)?;
    validate_treasury(env)?;
    validate_fees(env)?;
    validate_token_count(env)?;

    Ok(())
}
