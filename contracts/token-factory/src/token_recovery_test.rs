//! Token Recovery Authorization Coverage Tests
//!
//! Validates that only the rightful owner (admin) can recover tokens,
//! and that double-recovery and zero-balance recovery are properly rejected.

#[cfg(test)]
mod token_recovery_authorization_tests {
    use crate::storage;
    use crate::token_recovery::{
        initiate_recovery, execute_recovery, get_recovery_request, RecoveryStatus,
    };
    use crate::types::{Error, TokenInfo};
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    fn setup(env: &Env) -> (Address, Address) {
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let admin = Address::generate(env);
        let treasury = Address::generate(env);

        storage::set_admin(env, &admin);
        storage::set_treasury(env, &treasury);
        storage::set_base_fee(env, 1_000_000);
        storage::set_metadata_fee(env, 500_000);

        (admin, treasury)
    }

    fn create_token_with_balance(
        env: &Env,
        token_index: u32,
        holder: &Address,
        balance: i128,
    ) {
        let info = TokenInfo {
            creator: Address::generate(env),
            name: String::from_str(env, "Test Token"),
            symbol: String::from_str(env, "TST"),
            initial_supply: balance,
            decimals: 7,
            created_at: env.ledger().timestamp(),
            transfer_fee_basis_points: 0,
            clawback_enabled: false,
            freeze_enabled: false,
            paused: false,
        };

        storage::set_token_info(env, token_index, &info);
        storage::set_balance(env, token_index, holder, balance);
    }

    // ── Authorization Coverage ───────────────────────────────────────────

    #[test]
    fn test_rightful_owner_can_initiate_recovery() {
        let env = Env::default();
        let (admin, _treasury) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let token_index = 0;
        let balance = 1_000_000;
        let recovery_amount = 500_000;

        create_token_with_balance(&env, token_index, &from, balance);

        let result = initiate_recovery(&env, &admin, token_index, &from, &to, recovery_amount);

        assert!(
            result.is_ok(),
            "Admin should be able to initiate recovery for lost tokens"
        );
        assert!(result.unwrap() > 0, "Request ID should be assigned");
    }

    #[test]
    fn test_non_owner_recovery_attempt_is_rejected() {
        let env = Env::default();
        let (admin, _treasury) = setup(&env);
        let attacker = Address::generate(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let token_index = 0;
        let balance = 1_000_000;
        let recovery_amount = 500_000;

        create_token_with_balance(&env, token_index, &from, balance);

        let result = initiate_recovery(&env, &attacker, token_index, &from, &to, recovery_amount);

        assert!(
            result.is_err(),
            "Non-admin should not be able to initiate recovery"
        );
        assert_eq!(
            result.unwrap_err(),
            Error::Unauthorized,
            "Expected Unauthorized error for non-admin caller"
        );
    }

    // ── Double-Recovery Prevention ──────────────────────────────────────

    #[test]
    fn test_double_recovery_of_same_balance_is_rejected() {
        let env = Env::default();
        let (admin, _treasury) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let token_index = 0;
        let balance = 1_000_000;
        let recovery_amount = 500_000;

        create_token_with_balance(&env, token_index, &from, balance);

        let request_id_1 = initiate_recovery(&env, &admin, token_index, &from, &to, recovery_amount)
            .expect("First recovery should succeed");

        // Advance ledger past timelock
        env.ledger().with_mut(|l| l.timestamp = 2_000_000);

        execute_recovery(&env, &admin, request_id_1)
            .expect("First recovery execution should succeed");

        // Try to recover the same amount again from the already-recovered balance
        env.ledger().with_mut(|l| l.timestamp = 3_000_000);
        let result = initiate_recovery(
            &env,
            &admin,
            token_index,
            &from,
            &to,
            recovery_amount,
        );

        assert!(
            result.is_err(),
            "Second recovery of same balance should fail due to insufficient balance"
        );
        assert_eq!(
            result.unwrap_err(),
            Error::InsufficientBalance,
            "Expected InsufficientBalance error after tokens were already recovered"
        );
    }

    // ── Zero-Balance Recovery ──────────────────────────────────────────

    #[test]
    fn test_recovery_of_zero_balance_is_rejected() {
        let env = Env::default();
        let (admin, _treasury) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let token_index = 0;
        let balance = 1_000_000;

        create_token_with_balance(&env, token_index, &from, balance);

        let result = initiate_recovery(&env, &admin, token_index, &from, &to, 0);

        assert!(
            result.is_err(),
            "Recovery of zero amount should be rejected"
        );
        assert_eq!(
            result.unwrap_err(),
            Error::InvalidParameters,
            "Expected InvalidParameters error for zero recovery amount"
        );
    }

    #[test]
    fn test_recovery_is_noop_when_balance_already_zero() {
        let env = Env::default();
        let (admin, _treasury) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let token_index = 0;

        create_token_with_balance(&env, token_index, &from, 0);

        let result = initiate_recovery(&env, &admin, token_index, &from, &to, 1);

        assert!(
            result.is_err(),
            "Recovery should be rejected when source has zero balance"
        );
        assert_eq!(
            result.unwrap_err(),
            Error::InsufficientBalance,
            "Expected InsufficientBalance when source has no tokens"
        );
    }

    // ── Status Transitions ─────────────────────────────────────────────

    #[test]
    fn test_recovery_request_starts_in_pending_status() {
        let env = Env::default();
        let (admin, _treasury) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let token_index = 0;
        let balance = 1_000_000;
        let recovery_amount = 500_000;

        create_token_with_balance(&env, token_index, &from, balance);

        let request_id =
            initiate_recovery(&env, &admin, token_index, &from, &to, recovery_amount)
                .expect("Recovery initiation should succeed");

        let request = get_recovery_request(&env, request_id)
            .expect("Request should be retrievable after initiation");

        assert_eq!(
            request.status,
            RecoveryStatus::Pending,
            "Recovery request should start in Pending status"
        );
    }

    #[test]
    fn test_recovery_execution_transitions_status_to_executed() {
        let env = Env::default();
        let (admin, _treasury) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let token_index = 0;
        let balance = 1_000_000;
        let recovery_amount = 500_000;

        create_token_with_balance(&env, token_index, &from, balance);

        let request_id =
            initiate_recovery(&env, &admin, token_index, &from, &to, recovery_amount)
                .expect("Recovery initiation should succeed");

        env.ledger().with_mut(|l| l.timestamp = 2_000_000);

        execute_recovery(&env, &admin, request_id)
            .expect("Recovery execution should succeed after timelock");

        let request = get_recovery_request(&env, request_id)
            .expect("Request should be retrievable after execution");

        assert_eq!(
            request.status,
            RecoveryStatus::Executed,
            "Recovery request status should be Executed after execution"
        );
    }

    // ── Idempotency & Edge Cases ──────────────────────────────────────

    #[test]
    fn test_recovery_cannot_be_executed_before_timelock_expires() {
        let env = Env::default();
        let (admin, _treasury) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let token_index = 0;
        let balance = 1_000_000;
        let recovery_amount = 500_000;

        create_token_with_balance(&env, token_index, &from, balance);

        let request_id =
            initiate_recovery(&env, &admin, token_index, &from, &to, recovery_amount)
                .expect("Recovery initiation should succeed");

        let result = execute_recovery(&env, &admin, request_id);

        assert!(
            result.is_err(),
            "Recovery should not execute before timelock expires"
        );
        assert_eq!(
            result.unwrap_err(),
            Error::TimelockNotExpired,
            "Expected TimelockNotExpired error when timelock has not elapsed"
        );
    }

    #[test]
    fn test_recovery_with_different_addresses_succeeds() {
        let env = Env::default();
        let (admin, _treasury) = setup(&env);
        let lost_holder = Address::generate(&env);
        let recovery_target = Address::generate(&env);
        let token_index = 0;
        let balance = 2_000_000;
        let recovery_amount = 2_000_000;

        create_token_with_balance(&env, token_index, &lost_holder, balance);

        let result = initiate_recovery(
            &env,
            &admin,
            token_index,
            &lost_holder,
            &recovery_target,
            recovery_amount,
        );

        assert!(
            result.is_ok(),
            "Recovery from one address to another should succeed"
        );
    }

    #[test]
    fn test_recovery_rejects_same_from_and_to_address() {
        let env = Env::default();
        let (admin, _treasury) = setup(&env);
        let same_address = Address::generate(&env);
        let token_index = 0;
        let balance = 1_000_000;
        let recovery_amount = 500_000;

        create_token_with_balance(&env, token_index, &same_address, balance);

        let result = initiate_recovery(
            &env,
            &admin,
            token_index,
            &same_address,
            &same_address,
            recovery_amount,
        );

        assert!(
            result.is_err(),
            "Recovery to the same address should be rejected"
        );
        assert_eq!(
            result.unwrap_err(),
            Error::InvalidParameters,
            "Expected InvalidParameters when from == to"
        );
    }
}
