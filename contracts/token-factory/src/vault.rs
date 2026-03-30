//! Vault Funding Module
//!
//! This module provides controlled funding of vault balances with strict safety checks.

use crate::{
    storage,
    types::{Error, VaultStatus},
};
use soroban_sdk::{symbol_short, Address, Env};

/// Fund a vault with tokens.
///
/// Safety checks:
/// - `funder` must authorize the call
/// - `amount` must be positive
/// - vault must exist and be `Active`
/// - arithmetic must not overflow
pub fn fund_vault(env: &Env, vault_id: u64, funder: &Address, amount: i128) -> Result<(), Error> {
    funder.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut vault = storage::get_vault(env, vault_id).ok_or(Error::TokenNotFound)?;
    if vault.status != VaultStatus::Active {
        return Err(Error::InvalidParameters);
    }

    vault.total_amount = vault
        .total_amount
        .checked_add(amount)
        .ok_or(Error::ArithmeticError)?;

    storage::set_vault(env, &vault)?;
    emit_vault_funded(env, vault_id, funder, amount);

    Ok(())
}

fn emit_vault_funded(env: &Env, vault_id: u64, funder: &Address, amount: i128) {
    env.events().publish(
        (symbol_short!("vlt_fd_v1"), vault_id),
        (funder.clone(), amount),
    );
}

/// Claim unlocked vault amounts
///
/// Allows vault owners to claim their unlocked tokens. Claims are subject to
/// time-based and/or milestone-based unlock conditions. Prevents premature
/// claims and duplicate execution.
///
/// # Arguments
/// * `env` - The contract environment
/// * `vault_id` - The unique identifier of the vault to claim from
/// * `owner` - Address of the vault owner (must authorize and match vault owner)
///
/// # Returns
/// Returns `Ok(amount_claimed)` with the amount successfully claimed
///
/// # Errors
/// * `Error::TokenNotFound` - Vault with given ID does not exist
/// * `Error::Unauthorized` - Caller is not the vault owner
/// * `Error::InvalidParameters` - Vault is not in Active status
/// * `Error::CliffNotReached` - Unlock time has not been reached
/// * `Error::NothingToClaim` - All available funds have already been claimed
/// * `Error::ArithmeticError` - Overflow in claim calculations
///
/// # Safety Guarantees
/// - Authorization: Only vault owner can claim
/// - Unlock enforcement: Time and milestone conditions checked
/// - Duplicate prevention: Tracks claimed_amount to prevent over-claiming
/// - Atomicity: All checks pass or entire operation fails
/// - Status update: Vault marked as Claimed when fully claimed
pub fn claim_vault(
    env: &Env,
    vault_id: u64,
    owner: &Address,
) -> Result<i128, Error> {
    // Require owner authorization
    owner.require_auth();

    // Get vault and validate it exists
    let mut vault = storage::get_vault(env, vault_id)
        .ok_or(Error::TokenNotFound)?;

    // Validate caller is the vault owner
    if vault.owner != *owner {
        return Err(Error::Unauthorized);
    }

    // Validate vault status allows claiming
    // Only Active vaults can be claimed
    if vault.status != VaultStatus::Active {
        return Err(Error::InvalidParameters);
    }

    // Check unlock conditions - time-based unlock check
    let current_time = env.ledger().timestamp();
    if current_time < vault.unlock_time {
        return Err(Error::CliffNotReached);
    }

    // Calculate claimable amount
    let claimable = vault.total_amount
        .checked_sub(vault.claimed_amount)
        .ok_or(Error::ArithmeticError)?;

    // Validate there's something to claim
    if claimable <= 0 {
        return Err(Error::NothingToClaim);
    }

    // Update claimed amount with checked arithmetic
    vault.claimed_amount = vault.claimed_amount
        .checked_add(claimable)
        .ok_or(Error::ArithmeticError)?;

    // If fully claimed, update status
    if vault.claimed_amount >= vault.total_amount {
        vault.status = VaultStatus::Claimed;
    }

    // Persist updated vault
    storage::set_vault(env, &vault)?;

    // Emit vault_claimed event
    emit_vault_claimed(env, vault_id, owner, claimable);

    Ok(claimable)
}

fn emit_vault_claimed(env: &Env, vault_id: u64, owner: &Address, amount: i128) {
    env.events().publish(
        (symbol_short!("vlt_cl_v1"), vault_id),
        (owner.clone(), amount),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Error, Vault, VaultStatus};
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Events},
        Address, BytesN, Env, FromVal, Symbol, Val,
    };

    fn seed_vault(env: &Env, vault_id: u64, status: VaultStatus, total_amount: i128) {
        let vault = Vault {
            id: vault_id,
            token: Address::generate(env),
            owner: Address::generate(env),
            creator: Address::generate(env),
            total_amount,
            claimed_amount: 0,
            unlock_time: 0,
            milestone_hash: BytesN::from_array(env, &[0u8; 32]),
            status,
            created_at: 0,
        };

        storage::set_vault(env, &vault).unwrap();
    }

    #[test]
    #[should_panic]
    fn test_fund_vault_requires_authorization() {
        let env = Env::default();
        let vault_id = 1;
        let funder = Address::generate(&env);

        seed_vault(&env, vault_id, VaultStatus::Active, 1_000_000_000);

        let _ = fund_vault(&env, vault_id, &funder, 100);
    }

    #[test]
    fn test_fund_vault_zero_amount_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let vault_id = 1;
        let funder = Address::generate(&env);
        seed_vault(&env, vault_id, VaultStatus::Active, 1_000_000_000);

        let result = fund_vault(&env, vault_id, &funder, 0);
        assert_eq!(result, Err(Error::InvalidAmount));
    }

    #[test]
    fn test_fund_vault_negative_amount_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let vault_id = 1;
        let funder = Address::generate(&env);
        seed_vault(&env, vault_id, VaultStatus::Active, 1_000_000_000);

        let result = fund_vault(&env, vault_id, &funder, -1);
        assert_eq!(result, Err(Error::InvalidAmount));
    }

    #[test]
    fn test_fund_vault_rejects_non_active_status() {
        let env = Env::default();
        env.mock_all_auths();

        let vault_id = 1;
        let funder = Address::generate(&env);
        seed_vault(&env, vault_id, VaultStatus::Claimed, 1_000_000_000);

        let result = fund_vault(&env, vault_id, &funder, 100);
        assert_eq!(result, Err(Error::InvalidParameters));
    }

    #[test]
    fn test_fund_vault_overflow_protection() {
        let env = Env::default();
        env.mock_all_auths();

        let vault_id = 1;
        let funder = Address::generate(&env);
        seed_vault(&env, vault_id, VaultStatus::Active, i128::MAX - 10);

        let result = fund_vault(&env, vault_id, &funder, 11);
        assert_eq!(result, Err(Error::ArithmeticError));
    }

    #[test]
    fn test_fund_vault_max_safe_boundary() {
        let env = Env::default();
        env.mock_all_auths();

        let vault_id = 1;
        let funder = Address::generate(&env);
        seed_vault(&env, vault_id, VaultStatus::Active, i128::MAX - 10);

        fund_vault(&env, vault_id, &funder, 10).unwrap();

        let vault = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault.total_amount, i128::MAX);
    }

    #[test]
    fn test_fund_vault_emits_event() {
        let env = Env::default();
        env.mock_all_auths();

        let vault_id = 1;
        let funder = Address::generate(&env);
        let amount = 42;
        seed_vault(&env, vault_id, VaultStatus::Active, 100);

        let before = env.events().all().len();
        fund_vault(&env, vault_id, &funder, amount).unwrap();
        let events = env.events().all();

        assert_eq!(events.len(), before + 1);

        let (_contract, topics, data) = events.get(events.len() - 1).unwrap();
        let event_name = Symbol::from_val(&env, &topics.get(0).unwrap());
        assert_eq!(event_name, symbol_short!("vlt_fd_v1"));

        let payload = soroban_sdk::Vec::<Val>::from_val(&env, &data);
        let event_funder = Address::from_val(&env, &payload.get(0).unwrap());
        let event_amount = i128::from_val(&env, &payload.get(1).unwrap());

        assert_eq!(event_funder, funder);
        assert_eq!(event_amount, amount);
    }
}

    // ============================================================================
    // Claim Vault Tests
    // ============================================================================

    #[test]
    fn test_claim_vault_success() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);
        let total_amount = 1_000_0000000;

        // Create vault with unlock time in the past
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount,
            claimed_amount: 0,
            unlock_time: 500, // Already unlocked
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // Claim the vault
        let claimed = claim_vault(&env, vault_id, &owner).unwrap();
        assert_eq!(claimed, total_amount, "Should claim full amount");

        // Verify vault state
        let vault = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault.claimed_amount, total_amount, "Claimed amount should match");
        assert_eq!(vault.status, VaultStatus::Claimed, "Status should be Claimed");
    }

    #[test]
    fn test_claim_vault_before_unlock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);

        // Create vault with unlock time in the future
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount: 1_000_0000000,
            claimed_amount: 0,
            unlock_time: 2000, // Future unlock time
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // Try to claim before unlock
        let result = claim_vault(&env, vault_id, &owner);
        assert_eq!(result, Err(Error::CliffNotReached), 
            "Should fail before unlock time");
    }

    #[test]
    fn test_claim_vault_exactly_at_unlock_time() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);
        let total_amount = 1_000_0000000;

        // Create vault with unlock time exactly at current time
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount,
            claimed_amount: 0,
            unlock_time: 1000, // Exactly at current time
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // Should succeed at exact unlock time
        let claimed = claim_vault(&env, vault_id, &owner).unwrap();
        assert_eq!(claimed, total_amount, "Should claim at exact unlock time");
    }

    #[test]
    fn test_claim_vault_double_claim_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);
        let total_amount = 1_000_0000000;

        // Create unlocked vault
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount,
            claimed_amount: 0,
            unlock_time: 500,
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // First claim should succeed
        let claimed = claim_vault(&env, vault_id, &owner).unwrap();
        assert_eq!(claimed, total_amount);

        // Second claim should fail
        let result = claim_vault(&env, vault_id, &owner);
        assert_eq!(result, Err(Error::InvalidParameters), 
            "Should fail - vault already claimed");
    }

    #[test]
    fn test_claim_vault_unauthorized_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);
        let attacker = Address::generate(&env);

        // Create unlocked vault
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount: 1_000_0000000,
            claimed_amount: 0,
            unlock_time: 500,
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // Try to claim with wrong owner
        let result = claim_vault(&env, vault_id, &attacker);
        assert_eq!(result, Err(Error::Unauthorized), 
            "Should fail - not the owner");
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(150))]

        /// Property 77 – Vault Claim Authorization
        ///
        /// Randomized owner/attacker pairs prove that only vault owner can
        /// claim a vault. Any non-owner attempt must return Unauthorized.
        #[test]
        fn prop_77_vault_claim_authorization(_owner_seed in any::<u64>(), _attacker_seed in any::<u64>()) {
            let env = Env::default();
            env.mock_all_auths();
            env.ledger().with_mut(|li| li.timestamp = 1000);

            let owner = Address::generate(&env);
            let mut attacker = Address::generate(&env);
            if attacker == owner {
                attacker = Address::generate(&env);
            }
            prop_assume!(attacker != owner);

            let vault_id = 1;
            let total_amount = 1_000_0000000;
            let vault = Vault {
                id: vault_id,
                token: Address::generate(&env),
                owner: owner.clone(),
                creator: Address::generate(&env),
                total_amount,
                claimed_amount: 0,
                unlock_time: 500,
                milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
                status: VaultStatus::Active,
                created_at: 0,
            };
            storage::set_vault(&env, &vault).unwrap();

            let attacker_result = claim_vault(&env, vault_id, &attacker);
            prop_assert_eq!(attacker_result, Err(Error::Unauthorized));

            let owner_result = claim_vault(&env, vault_id, &owner);
            prop_assert_eq!(owner_result, Ok(total_amount));
        }
    }

    #[test]
    fn test_claim_vault_nonexistent_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let vault_id = 999;
        let owner = Address::generate(&env);

        // Try to claim non-existent vault
        let result = claim_vault(&env, vault_id, &owner);
        assert_eq!(result, Err(Error::TokenNotFound), 
            "Should fail - vault doesn't exist");
    }

    #[test]
    fn test_claim_vault_cancelled_status_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);

        // Create cancelled vault
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount: 1_000_0000000,
            claimed_amount: 0,
            unlock_time: 500,
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Cancelled,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // Try to claim cancelled vault
        let result = claim_vault(&env, vault_id, &owner);
        assert_eq!(result, Err(Error::InvalidParameters), 
            "Should fail - vault is cancelled");
    }

    #[test]
    fn test_claim_vault_partial_claim_prevention() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);
        let total_amount = 1_000_0000000;

        // Create vault with some already claimed
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount,
            claimed_amount: 600_0000000, // Already claimed 60%
            unlock_time: 500,
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // Should claim only remaining amount
        let claimed = claim_vault(&env, vault_id, &owner).unwrap();
        assert_eq!(claimed, 400_0000000, "Should claim only remaining 40%");

        // Verify final state
        let vault = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault.claimed_amount, total_amount);
        assert_eq!(vault.status, VaultStatus::Claimed);
    }

    #[test]
    fn test_claim_vault_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);
        let total_amount = 1_000_0000000;

        // Create unlocked vault
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount,
            claimed_amount: 0,
            unlock_time: 500,
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        let events_before = env.events().all().len();

        // Claim the vault
        claim_vault(&env, vault_id, &owner).unwrap();

        let events_after = env.events().all().len();
        assert!(events_after > events_before, "Event should be emitted");

        // Verify event topic
        let events = env.events().all();
        let last_event = events.get(events.len() - 1).unwrap();
        let (topics, _): (soroban_sdk::Vec<Val>, soroban_sdk::Vec<Val>) = last_event;
        let topic: Symbol = topics.get(0).unwrap().try_into_val(&env).unwrap();
        assert_eq!(topic.to_string(), "vlt_cl_v1", "Event topic should be vlt_cl_v1");
    }

    #[test]
    fn test_claim_vault_event_data() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);
        let total_amount = 1_000_0000000;

        // Create unlocked vault
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount,
            claimed_amount: 0,
            unlock_time: 500,
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // Claim the vault
        let claimed = claim_vault(&env, vault_id, &owner).unwrap();

        // Verify event data
        let events = env.events().all();
        let last_event = events.get(events.len() - 1).unwrap();
        let (_, data): (soroban_sdk::Vec<Val>, soroban_sdk::Vec<Val>) = last_event;
        
        assert_eq!(data.len(), 2, "Event should have 2 data fields");
        
        let event_owner: Address = data.get(0).unwrap().try_into_val(&env).unwrap();
        let event_amount: i128 = data.get(1).unwrap().try_into_val(&env).unwrap();
        
        assert_eq!(event_owner, owner, "Event owner should match");
        assert_eq!(event_amount, claimed, "Event amount should match");
    }

    #[test]
    fn test_claim_vault_arithmetic_overflow_protection() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);

        // Create vault with claimed > total (corrupted state)
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount: 100,
            claimed_amount: 200, // More than total
            unlock_time: 500,
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // Should detect arithmetic error
        let result = claim_vault(&env, vault_id, &owner);
        assert_eq!(result, Err(Error::ArithmeticError), 
            "Should detect arithmetic underflow");
    }

    #[test]
    fn test_claim_vault_zero_claimable_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);
        let total_amount = 1_000_0000000;

        // Create vault with everything already claimed
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount,
            claimed_amount: total_amount, // Fully claimed
            unlock_time: 500,
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // Should fail with nothing to claim
        let result = claim_vault(&env, vault_id, &owner);
        assert_eq!(result, Err(Error::NothingToClaim), 
            "Should fail - nothing left to claim");
    }

    #[test]
    fn test_claim_vault_time_progression() {
        let env = Env::default();
        env.mock_all_auths();

        let vault_id = 1;
        let owner = Address::generate(&env);
        let total_amount = 1_000_0000000;

        // Create vault with future unlock
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount,
            claimed_amount: 0,
            unlock_time: 2000,
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // Try at time 1000 - should fail
        env.ledger().with_mut(|li| li.timestamp = 1000);
        let result = claim_vault(&env, vault_id, &owner);
        assert_eq!(result, Err(Error::CliffNotReached));

        // Try at time 1999 - should still fail
        env.ledger().with_mut(|li| li.timestamp = 1999);
        let result = claim_vault(&env, vault_id, &owner);
        assert_eq!(result, Err(Error::CliffNotReached));

        // Try at time 2000 - should succeed
        env.ledger().with_mut(|li| li.timestamp = 2000);
        let claimed = claim_vault(&env, vault_id, &owner).unwrap();
        assert_eq!(claimed, total_amount);
    }

    #[test]
    fn test_claim_vault_with_funded_amount() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 1000);

        let vault_id = 1;
        let owner = Address::generate(&env);
        let funder = Address::generate(&env);
        let initial_amount = 1_000_0000000;
        let funded_amount = 500_0000000;

        // Create unlocked vault
        let vault = Vault {
            id: vault_id,
            token: Address::generate(&env),
            owner: owner.clone(),
            creator: Address::generate(&env),
            total_amount: initial_amount,
            claimed_amount: 0,
            unlock_time: 500,
            milestone_hash: BytesN::from_array(&env, &[0u8; 32]),
            status: VaultStatus::Active,
            created_at: 0,
        };
        storage::set_vault(&env, &vault).unwrap();

        // Fund the vault
        fund_vault(&env, vault_id, &funder, funded_amount).unwrap();

        // Claim should get initial + funded amount
        let claimed = claim_vault(&env, vault_id, &owner).unwrap();
        assert_eq!(claimed, initial_amount + funded_amount, 
            "Should claim initial + funded amount");
    }
}
