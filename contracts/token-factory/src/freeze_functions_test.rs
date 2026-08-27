//! Freeze/Unfreeze Access Control Test Suite
//!
//! Validates that only authorized callers (token creator or governance)
//! can invoke freeze/unfreeze operations, and that freeze state behaves
//! correctly under repeated calls.

#[cfg(test)]
mod freeze_functions_test {
    use crate::freeze_functions;
    use crate::storage;
    use crate::test_helpers::TestEnv;
    use crate::token_creation;
    use crate::types::{Error, TokenInfo};
    use soroban_sdk::{
        testutils::Address as _, Address, Env, String,
    };

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_treasury(&env, &treasury);
            storage::set_base_fee(&env, 1_000_000);
            storage::set_metadata_fee(&env, 500_000);
        });

        (env, contract_id, admin, treasury)
    }

    fn create_token_with_freeze(
        env: &Env,
        contract_id: &Address,
        creator: &Address,
        freeze_enabled: bool,
    ) -> Address {
        let token_address = Address::generate(env);
        let name = String::from_str(env, "Test Token");
        let symbol = String::from_str(env, "TST");

        env.as_contract(contract_id, || {
            let token_info = TokenInfo {
                creator: creator.clone(),
                name,
                symbol,
                initial_supply: 1_000_000_000,
                decimals: 6,
                created_at: env.ledger().timestamp(),
                transfer_fee_basis_points: 0,
                clawback_enabled: false,
                freeze_enabled,
                paused: false,
            };

            storage::set_token_info_by_address(env, &token_address, &token_info);
        });

        token_address
    }

    // ── Authorized freeze succeeds ──────────────────────────────────────────

    #[test]
    fn test_authorized_admin_freeze_succeeds() {
        let (env, contract_id, admin, _treasury) = setup();
        let creator = &admin;
        let token = create_token_with_freeze(&env, &contract_id, creator, true);
        let target = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let result = freeze_functions::freeze_address(&env, &token, &admin, &target);
            assert!(result.is_ok(), "Authorized admin freeze must succeed");

            let is_frozen = freeze_functions::is_frozen(&env, &token, &target);
            assert!(is_frozen, "Target address must be frozen after freeze_address");
        });
    }

    #[test]
    fn test_authorized_admin_unfreeze_succeeds() {
        let (env, contract_id, admin, _treasury) = setup();
        let creator = &admin;
        let token = create_token_with_freeze(&env, &contract_id, creator, true);
        let target = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // First freeze
            freeze_functions::freeze_address(&env, &token, &admin, &target).unwrap();

            // Then unfreeze
            let result = freeze_functions::unfreeze_address(&env, &token, &admin, &target);
            assert!(result.is_ok(), "Authorized admin unfreeze must succeed");

            let is_frozen = freeze_functions::is_frozen(&env, &token, &target);
            assert!(!is_frozen, "Target address must be unfrozen after unfreeze_address");
        });
    }

    // ── Unauthorized caller freeze is rejected ──────────────────────────────

    #[test]
    fn test_unauthorized_caller_freeze_rejected() {
        let (env, contract_id, admin, _treasury) = setup();
        let token = create_token_with_freeze(&env, &contract_id, &admin, true);
        let attacker = Address::generate(&env);
        let target = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let result = freeze_functions::freeze_address(&env, &token, &attacker, &target);
            assert_eq!(
                result,
                Err(Error::Unauthorized),
                "Non-admin must not be able to freeze"
            );
        });
    }

    #[test]
    fn test_unauthorized_caller_unfreeze_rejected() {
        let (env, contract_id, admin, _treasury) = setup();
        let token = create_token_with_freeze(&env, &contract_id, &admin, true);
        let target = Address::generate(&env);
        let attacker = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // Admin freezes first
            freeze_functions::freeze_address(&env, &token, &admin, &target).unwrap();

            // Attacker attempts unfreeze
            let result = freeze_functions::unfreeze_address(&env, &token, &attacker, &target);
            assert_eq!(
                result,
                Err(Error::Unauthorized),
                "Non-admin must not be able to unfreeze"
            );
        });
    }

    // ── Freezing an already-frozen address ──────────────────────────────────

    #[test]
    fn test_freeze_already_frozen_returns_error() {
        let (env, contract_id, admin, _treasury) = setup();
        let token = create_token_with_freeze(&env, &contract_id, &admin, true);
        let target = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // Freeze once
            freeze_functions::freeze_address(&env, &token, &admin, &target).unwrap();

            // Attempt to freeze again
            let result = freeze_functions::freeze_address(&env, &token, &admin, &target);
            assert_eq!(
                result,
                Err(Error::InvalidParameters),
                "Re-freezing an already-frozen address must return InvalidParameters error"
            );
        });
    }

    // ── Unfreezing a non-frozen address ──────────────────────────────────────

    #[test]
    fn test_unfreeze_non_frozen_returns_error() {
        let (env, contract_id, admin, _treasury) = setup();
        let token = create_token_with_freeze(&env, &contract_id, &admin, true);
        let target = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // Attempt to unfreeze a never-frozen address
            let result = freeze_functions::unfreeze_address(&env, &token, &admin, &target);
            assert_eq!(
                result,
                Err(Error::InvalidParameters),
                "Unfreezing a non-frozen address must return InvalidParameters error"
            );
        });
    }

    // ── Freeze disabled returns error ───────────────────────────────────────

    #[test]
    fn test_freeze_when_disabled_returns_error() {
        let (env, contract_id, admin, _treasury) = setup();
        let token = create_token_with_freeze(&env, &contract_id, &admin, false);
        let target = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let result = freeze_functions::freeze_address(&env, &token, &admin, &target);
            assert_eq!(
                result,
                Err(Error::Unauthorized),
                "Freezing when freeze is disabled must return Unauthorized error"
            );
        });
    }

    #[test]
    fn test_unfreeze_when_disabled_returns_error() {
        let (env, contract_id, admin, _treasury) = setup();
        let token = create_token_with_freeze(&env, &contract_id, &admin, false);
        let target = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let result = freeze_functions::unfreeze_address(&env, &token, &admin, &target);
            assert_eq!(
                result,
                Err(Error::Unauthorized),
                "Unfreezing when freeze is disabled must return Unauthorized error"
            );
        });
    }

    // ── Toggle freeze enabled ───────────────────────────────────────────────

    #[test]
    fn test_toggle_freeze_enabled_by_creator() {
        let (env, contract_id, admin, _treasury) = setup();
        let token = create_token_with_freeze(&env, &contract_id, &admin, false);

        env.as_contract(&contract_id, || {
            // Enable freeze
            let result = freeze_functions::set_freeze_enabled(&env, &token, &admin, true);
            assert!(result.is_ok(), "Creator must be able to enable freeze");

            let info = storage::get_token_info_by_address(&env, &token).unwrap();
            assert!(info.freeze_enabled, "Freeze must be enabled after set_freeze_enabled(true)");

            // Disable freeze
            let result = freeze_functions::set_freeze_enabled(&env, &token, &admin, false);
            assert!(result.is_ok(), "Creator must be able to disable freeze");

            let info = storage::get_token_info_by_address(&env, &token).unwrap();
            assert!(!info.freeze_enabled, "Freeze must be disabled after set_freeze_enabled(false)");
        });
    }

    #[test]
    fn test_toggle_freeze_enabled_non_creator_rejected() {
        let (env, contract_id, admin, _treasury) = setup();
        let token = create_token_with_freeze(&env, &contract_id, &admin, false);
        let attacker = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let result = freeze_functions::set_freeze_enabled(&env, &token, &attacker, true);
            assert_eq!(
                result,
                Err(Error::Unauthorized),
                "Non-creator must not be able to toggle freeze enabled"
            );
        });
    }

    // ── Idempotency: repeated freeze/unfreeze calls ─────────────────────────

    #[test]
    fn test_freeze_then_unfreeze_then_freeze_idempotent() {
        let (env, contract_id, admin, _treasury) = setup();
        let token = create_token_with_freeze(&env, &contract_id, &admin, true);
        let target = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // First freeze
            freeze_functions::freeze_address(&env, &token, &admin, &target).unwrap();
            assert!(freeze_functions::is_frozen(&env, &token, &target));

            // Unfreeze
            freeze_functions::unfreeze_address(&env, &token, &admin, &target).unwrap();
            assert!(!freeze_functions::is_frozen(&env, &token, &target));

            // Freeze again (should succeed)
            let result = freeze_functions::freeze_address(&env, &token, &admin, &target);
            assert!(result.is_ok(), "Freeze after unfreeze must succeed");
            assert!(freeze_functions::is_frozen(&env, &token, &target));

            // Unfreeze again (should succeed)
            let result = freeze_functions::unfreeze_address(&env, &token, &admin, &target);
            assert!(result.is_ok(), "Unfreeze after freeze must succeed");
            assert!(!freeze_functions::is_frozen(&env, &token, &target));
        });
    }

    // ── Token not found cases ───────────────────────────────────────────────

    #[test]
    fn test_freeze_nonexistent_token_returns_error() {
        let (env, contract_id, admin, _treasury) = setup();
        let nonexistent_token = Address::generate(&env);
        let target = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let result = freeze_functions::freeze_address(&env, &nonexistent_token, &admin, &target);
            assert_eq!(
                result,
                Err(Error::TokenNotFound),
                "Freezing for non-existent token must return TokenNotFound error"
            );
        });
    }

    #[test]
    fn test_unfreeze_nonexistent_token_returns_error() {
        let (env, contract_id, admin, _treasury) = setup();
        let nonexistent_token = Address::generate(&env);
        let target = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let result =
                freeze_functions::unfreeze_address(&env, &nonexistent_token, &admin, &target);
            assert_eq!(
                result,
                Err(Error::TokenNotFound),
                "Unfreezing for non-existent token must return TokenNotFound error"
            );
        });
    }

    #[test]
    fn test_unfreeze_cooldown_grace_period() {
        let (env, contract_id, admin, _treasury) = setup();
        let token = create_token_with_freeze(&env, &contract_id, &admin, true);
        let target = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // Set cooldown to 100 seconds
            freeze_functions::set_freeze_cooldown(&env, &token, &admin, 100).unwrap();
            assert_eq!(freeze_functions::get_freeze_cooldown(&env, &token), 100);

            // Freeze at timestamp 1000
            env.ledger().set_timestamp(1000);
            freeze_functions::freeze_address(&env, &token, &admin, &target).unwrap();

            // Attempt unfreeze inside cooldown window (at timestamp 1050) -> should fail with FreezeCooldownActive
            env.ledger().set_timestamp(1050);
            let result = freeze_functions::unfreeze_address(&env, &token, &admin, &target);
            assert_eq!(result, Err(Error::FreezeCooldownActive));

            // Attempt unfreeze after cooldown elapses (at timestamp 1101) -> should succeed
            env.ledger().set_timestamp(1101);
            let result = freeze_functions::unfreeze_address(&env, &token, &admin, &target);
            assert!(result.is_ok());
            assert!(!freeze_functions::is_frozen(&env, &token, &target));
        });
    }
}
