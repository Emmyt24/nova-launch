//! Vault Deposit/Withdraw Concurrent Interleaving Tests
//!
//! Models interleaved transaction sequences to detect TOCTOU race conditions
//! in the vault's balance accounting. All sequences are deterministic and
//! reproducible. "Deposit" = create_vault, "Withdraw" = claim_vault.
//!
//! Invariant under test: vault.balance >= 0 after every sequence,
//! and error codes are deterministic regardless of ordering for invalid sequences.

#![cfg(test)]

use crate::types::Error;
use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
use soroban_sdk::{Address, BytesN, Env};

// === Helpers

fn setup(env: &Env) -> (TokenFactoryClient, Address, Address) {
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(env, &contract_id);
    client.initialize(&admin, &treasury, &1_000_000, &500_000);
    (client, admin, treasury)
}

fn make_token(env: &Env, client: &TokenFactoryClient) -> Address {
    let creator = Address::generate(env);
    client.create_token(
        &creator,
        &soroban_sdk::String::from_str(env, "Test"),
        &soroban_sdk::String::from_str(env, "TST"),
        &7,
        &10_000_000_000,
        &None,
        &1_000_000,
    )
}

fn no_milestone(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

fn advance_time(env: &Env, seconds: u64) {
    let current = env.ledger().timestamp();
    env.ledger().set(LedgerInfo {
        timestamp: current + seconds,
        protocol_version: 20,
        sequence_number: env.ledger().sequence() + 1,
        network_id: soroban_sdk::bytesn!(
            env,
            0x0000000000000000000000000000000000000000000000000000000000000000
        ),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 6_312_000,
    });
}

// === concurrent_interleaving

#[cfg(test)]
mod concurrent_interleaving {
    use super::*;

    // Sequence 1: Deposit then immediate withdraw exceeding balance
    //
    // TOCTOU pattern: a concurrent reader checks the balance (total_amount),
    // then an interleaved writer attempts to claim an amount larger than what
    // was locked. In Soroban the contract enforces atomicity, so the over-claim
    // must be rejected deterministically.

    #[test]
    fn seq1_deposit_then_over_withdraw_is_rejected_deterministically() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);

        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &500_000,
            &1,
            &no_milestone(&env),
            &None,
        );

        advance_time(&env, 10);

        // First claim succeeds — balance becomes 0.
        let claimed = client.claim_vault(&owner, &vault_id, &None);
        assert_eq!(claimed, 500_000);

        // Second claim on same vault must fail (balance invariant: balance >= 0).
        let second_claim = client.try_claim_vault(&owner, &vault_id, &None);
        assert!(second_claim.is_err(), "double claim must be rejected");

        // Verify vault balance invariant: claimed_amount <= total_amount
        let vault = client.get_vault(&vault_id);
        assert!(vault.claimed_amount <= vault.total_amount, "balance invariant violated");
        assert!(vault.claimed_amount >= 0, "balance must never go negative");
    }

    // Sequence 2: Double-withdraw race
    //
    // Two withdraw operations target the same vault. In a concurrent environment
    // the first to commit wins; the second must receive a deterministic error.

    #[test]
    fn seq2_double_withdraw_race_second_always_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);

        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &1_000_000,
            &1,
            &no_milestone(&env),
            &None,
        );

        advance_time(&env, 5);

        // Interleaved sequence: withdraw_A commits first.
        let result_a = client.claim_vault(&owner, &vault_id, &None);
        assert_eq!(result_a, 1_000_000);

        // withdraw_B arrives after withdraw_A — must get a deterministic error,
        // NOT a panic or incorrect balance change.
        let result_b = client.try_claim_vault(&owner, &vault_id, &None);
        assert!(result_b.is_err());

        // Error code is deterministic across repeated orderings.
        let err = result_b.unwrap_err().unwrap();
        assert!(
            err == Error::InvalidParameters || err == Error::NothingToClaim,
            "unexpected error variant: {:?}", err
        );

        // Balance invariant holds.
        let vault = client.get_vault(&vault_id);
        assert!(vault.claimed_amount >= 0);
        assert!(vault.claimed_amount <= vault.total_amount);
    }

    // Sequence 3: Deposit during active withdraw
    //
    // A new vault is created (deposit_B) while vault_A is being claimed (withdraw_A).
    // Both operations must complete without corrupting each other's accounting.

    #[test]
    fn seq3_deposit_during_active_withdraw_no_cross_contamination() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor_a = Address::generate(&env);
        let owner_a = Address::generate(&env);
        let depositor_b = Address::generate(&env);
        let owner_b = Address::generate(&env);

        // Step 1: vault_A is deposited.
        let vault_a = client.create_vault(
            &depositor_a,
            &token,
            &owner_a,
            &300_000,
            &1,
            &no_milestone(&env),
            &None,
        );

        advance_time(&env, 5);

        // Step 2 (interleaved): vault_B is deposited while vault_A is being claimed.
        let vault_b = client.create_vault(
            &depositor_b,
            &token,
            &owner_b,
            &700_000,
            &1,
            &no_milestone(&env),
            &None,
        );

        // Step 3: vault_A claim completes.
        let claimed_a = client.claim_vault(&owner_a, &vault_a, &None);
        assert_eq!(claimed_a, 300_000);

        // Step 4: vault_B is unaffected — its balance is intact.
        let state_b = client.get_vault(&vault_b);
        assert_eq!(state_b.total_amount, 700_000);
        assert_eq!(state_b.claimed_amount, 0);

        // vault_B can be claimed independently.
        advance_time(&env, 1);
        let claimed_b = client.claim_vault(&owner_b, &vault_b, &None);
        assert_eq!(claimed_b, 700_000);
    }

    // Sequence 4: Deposit then cancel then withdraw attempt
    //
    // After a vault is cancelled the owner must not be able to withdraw. The error
    // code must be deterministic regardless of when the cancel is interleaved.

    #[test]
    fn seq4_cancel_before_withdraw_always_blocks_claim() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);

        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &500_000,
            &1,
            &no_milestone(&env),
            &None,
        );

        advance_time(&env, 5);

        // Interleaved: cancel arrives before the owner's claim.
        client.cancel_vault(&vault_id, &depositor);

        // Withdraw attempt after cancel must fail deterministically.
        let claim_result = client.try_claim_vault(&owner, &vault_id, &None);
        assert!(claim_result.is_err(), "claim on cancelled vault must fail");

        // Balance invariant: claimed_amount unchanged, total_amount unchanged.
        let vault = client.get_vault(&vault_id);
        assert_eq!(vault.claimed_amount, 0);
        assert_eq!(vault.total_amount, 500_000);
        assert!(vault.claimed_amount >= 0);
    }

    // Sequence 5: Multiple vaults — independent balance accounting
    //
    // Five vaults are created and withdrawn in non-sequential order to verify
    // that the storage isolation means no vault's accounting bleeds into another's.

    #[test]
    fn seq5_multiple_vaults_independent_balance_invariants() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let amounts = [100_000i128, 200_000, 300_000, 400_000, 500_000];
        let mut vault_ids = Vec::new();
        let mut owners = Vec::new();

        for &amount in &amounts {
            let depositor = Address::generate(&env);
            let owner = Address::generate(&env);
            let vault_id = client.create_vault(
                &depositor,
                &token,
                &owner,
                &amount,
                &1,
                &no_milestone(&env),
                &None,
            );
            vault_ids.push(vault_id);
            owners.push(owner);
        }

        advance_time(&env, 10);

        // Withdraw in reverse order to simulate interleaving.
        for i in (0..5).rev() {
            let claimed = client.claim_vault(&owners[i], &vault_ids[i], &None);
            assert_eq!(claimed, amounts[i]);

            // Verify balance invariant for all vaults after each withdrawal.
            for j in 0..5 {
                let v = client.get_vault(&vault_ids[j]);
                assert!(
                    v.claimed_amount >= 0,
                    "vault {} balance went negative after withdrawing vault {}", j, i
                );
                assert!(
                    v.claimed_amount <= v.total_amount,
                    "vault {} claimed_amount exceeds total_amount after withdrawing vault {}", j, i
                );
            }
        }
    }
}

// === vault_edge_cases

#[cfg(test)]
mod vault_edge_cases {
    use super::*;

    // Claiming from a vault that never existed returns an error (not a panic).
    #[test]
    fn claim_nonexistent_vault_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let owner = Address::generate(&env);

        let result = client.try_claim_vault(&owner, &9999_u64, &None);
        assert!(result.is_err(), "claim on non-existent vault must fail");
    }

    // A vault with no claimable remainder (already fully claimed) returns an error.
    #[test]
    fn claim_nothing_to_claim_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);

        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &1_000_000,
            &1,
            &no_milestone(&env),
            &None,
        );
        advance_time(&env, 5);

        // First claim drains the vault.
        client.claim_vault(&owner, &vault_id, &None);

        // Second claim must fail — nothing left.
        let result = client.try_claim_vault(&owner, &vault_id, &None);
        assert!(result.is_err(), "second claim must fail with nothing to claim");
    }

    // The full deposited amount is returned on a successful claim.
    #[test]
    fn full_withdrawal_bookkeeping_is_accurate() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);
        let amount = 1_000_000_000i128;

        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &amount,
            &1,
            &no_milestone(&env),
            &None,
        );
        advance_time(&env, 5);

        let claimed = client.claim_vault(&owner, &vault_id, &None);
        assert_eq!(claimed, amount);

        let vault = client.get_vault(&vault_id);
        assert_eq!(vault.claimed_amount, amount);
        assert_eq!(vault.total_amount, amount);
    }

    // A non-owner address must not be able to claim.
    #[test]
    fn unauthorized_claim_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);
        let attacker = Address::generate(&env);

        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &500_000,
            &1,
            &no_milestone(&env),
            &None,
        );
        advance_time(&env, 5);

        let result = client.try_claim_vault(&attacker, &vault_id, &None);
        assert!(result.is_err(), "non-owner must not be able to claim");
    }

    // Claim before the time-lock expires must be rejected.
    #[test]
    fn claim_before_unlock_time_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);

        // unlock_time set far in the future relative to current ledger timestamp.
        let unlock_time = env.ledger().timestamp() + 100_000;
        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &500_000,
            &unlock_time,
            &no_milestone(&env),
            &None,
        );

        // Do not advance time — cliff has not been reached.
        let result = client.try_claim_vault(&owner, &vault_id, &None);
        assert!(result.is_err(), "claim before unlock must be rejected");
    }

    // Claim at or after the unlock time must succeed.
    #[test]
    fn claim_after_unlock_time_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);

        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &500_000,
            &1,
            &no_milestone(&env),
            &None,
        );
        advance_time(&env, 5);

        let claimed = client.claim_vault(&owner, &vault_id, &None);
        assert_eq!(claimed, 500_000);
    }

    // Claiming a cancelled vault must fail deterministically.
    #[test]
    fn claim_cancelled_vault_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);

        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &500_000,
            &1,
            &no_milestone(&env),
            &None,
        );
        advance_time(&env, 5);

        client.cancel_vault(&vault_id, &depositor);

        let result = client.try_claim_vault(&owner, &vault_id, &None);
        assert!(result.is_err(), "cancelled vault must not be claimable");
    }
}
