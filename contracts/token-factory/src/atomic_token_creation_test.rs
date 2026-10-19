// Suppress unused warnings for incomplete tests
#![allow(dead_code)]

use super::*;
use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

/// Strategy for generating valid token names (1-32 chars)
fn valid_token_name() -> impl Strategy<Value = &'static str> {
    prop_oneof![
        Just("Test Token"),
        Just("My Awesome Token"),
        Just("A"),
        Just("Short"),
        Just("Medium Length Token Name"),
        Just("ABCDEFGHIJKLMNOPQRSTUVWXYZ12345"), // 31 chars
    ]
}

/// Strategy for generating valid token symbols (1-12 chars)
fn valid_token_symbol() -> impl Strategy<Value = &'static str> {
    prop_oneof![
        Just("TEST"),
        Just("TKN"),
        Just("A"),
        Just("SYMBOL"),
        Just("ABCDEFGHIJKL"), // 12 chars max
    ]
}

/// Strategy for generating valid decimals (0-18 is standard)
fn valid_decimals() -> impl Strategy<Value = u32> {
    prop_oneof![Just(0u32), Just(6u32), Just(7u32), Just(9u32), Just(18u32),]
}

/// Strategy for generating valid supply amounts (positive values)
fn valid_supply() -> impl Strategy<Value = i128> {
    prop_oneof![
        Just(1i128),
        Just(1000i128),
        Just(1_000_000i128),
        Just(1_000_000_000_000i128),
        1i128..1_000_000_000_000_000i128,
    ]
}

/// Strategy for generating metadata URI (optional)
fn metadata_uri() -> impl Strategy<Value = Option<&'static str>> {
    prop_oneof![
        Just(None),
        Just(Some("ipfs://QmTest123")),
        Just(Some("https://example.com/metadata.json")),
        Just(Some("ar://abc123")),
    ]
}

/// Composite strategy for valid token parameters
fn valid_token_params(
) -> impl Strategy<Value = (&'static str, &'static str, u32, i128, Option<&'static str>)> {
    (
        valid_token_name(),
        valid_token_symbol(),
        valid_decimals(),
        valid_supply(),
        metadata_uri(),
    )
}

/// Strategy for generating invalid token parameters
fn invalid_token_params(
) -> impl Strategy<Value = (&'static str, &'static str, u32, i128, Option<&'static str>)> {
    prop_oneof![
        // Empty name
        (
            Just(""),
            valid_token_symbol(),
            valid_decimals(),
            valid_supply(),
            metadata_uri()
        ),
        // Empty symbol
        (
            valid_token_name(),
            Just(""),
            valid_decimals(),
            valid_supply(),
            metadata_uri()
        ),
        // Zero supply
        (
            valid_token_name(),
            valid_token_symbol(),
            valid_decimals(),
            Just(0i128),
            metadata_uri()
        ),
        // Negative supply
        (
            valid_token_name(),
            valid_token_symbol(),
            valid_decimals(),
            Just(-1000i128),
            metadata_uri()
        ),
    ]
}

/// Captures the current state of the contract for comparison
#[derive(Clone, Debug, PartialEq)]
struct ContractState {
    admin: Address,
    treasury: Address,
    base_fee: i128,
    metadata_fee: i128,
    token_count: u32,
}

impl ContractState {
    fn capture(client: &TokenFactoryClient) -> Self {
        let state = client.get_state();
        let token_count = client.get_token_count();

        Self {
            admin: state.admin,
            treasury: state.treasury,
            base_fee: state.base_fee,
            metadata_fee: state.metadata_fee,
            token_count,
        }
    }

    fn assert_unchanged(&self, other: &Self) {
        assert_eq!(self.admin, other.admin, "Admin should not change");
        assert_eq!(self.treasury, other.treasury, "Treasury should not change");
        assert_eq!(self.base_fee, other.base_fee, "Base fee should not change");
        assert_eq!(
            self.metadata_fee, other.metadata_fee,
            "Metadata fee should not change"
        );
        assert_eq!(
            self.token_count, other.token_count,
            "Token count should not change on failure"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 1000, // Run 1000+ test cases as required
        max_shrink_iters: 1000,
        .. ProptestConfig::default()
    })]

    /// Property: Token creation is atomic - either all effects occur or none
    ///
    /// This test verifies that for any valid token deployment:
    /// - IF deployment succeeds THEN:
    ///   * Token exists in registry
    ///   * Token count incremented
    ///   * All token info stored correctly
    /// - ELSE (deployment fails):
    ///   * No state changes occur
    ///   * Token count unchanged
    ///   * No partial data stored
    ///
    /// Runs 1000+ iterations with random valid parameters
    #[test]
    #[ignore] // Remove this when create_token is implemented
    fn prop_token_creation_is_atomic(
        params in valid_token_params(),
    ) {
        let (name_str, symbol_str, decimals, supply, metadata_str) = params;

        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        let base_fee = 70_000_000i128;
        let metadata_fee = 30_000_000i128;

        client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

        // Capture initial state
        let initial_state = ContractState::capture(&client);

        // Convert strings to Soroban String
        let name = String::from_str(&env, name_str);
        let symbol = String::from_str(&env, symbol_str);
        let metadata_uri = metadata_str.map(|s| String::from_str(&env, s));

        // Calculate expected fee
        let expected_fee = if metadata_uri.is_some() {
            base_fee + metadata_fee
        } else {
            base_fee
        };

        // Attempt token creation
        /*
        let result = client.try_create_token(
            &creator,
            &name,
            &symbol,
            &decimals,
            &supply,
            &metadata_uri,
            &expected_fee,
        );
        */

        // For now, simulate the test structure
        let result: Result<Address, Error> = Ok(Address::generate(&env));

        if result.is_ok() {
            // SUCCESS CASE: Verify all effects occurred atomically
            let token_address = result.unwrap();
            let final_state = ContractState::capture(&client);

            // Property 1: Token count incremented by exactly 1
            prop_assert_eq!(
                final_state.token_count,
                initial_state.token_count + 1,
                "Token count must increment by 1 on success"
            );

            // Property 2: Token exists in registry
            let token_index = final_state.token_count - 1;
            let token_info_result = client.try_get_token_info(&token_index);
            prop_assert!(
                token_info_result.is_ok(),
                "Token must exist in registry after successful creation"
            );

            // Property 3: Token info matches input parameters
            let token_info = token_info_result.unwrap().unwrap();
            prop_assert_eq!(token_info.address, token_address, "Token address must match");
            prop_assert_eq!(token_info.creator, creator, "Creator must match");
            prop_assert_eq!(token_info.name, name, "Name must match");
            prop_assert_eq!(token_info.symbol, symbol, "Symbol must match");
            prop_assert_eq!(token_info.decimals, decimals, "Decimals must match");
            prop_assert_eq!(token_info.total_supply, supply, "Supply must match");
            prop_assert_eq!(token_info.metadata_uri, metadata_uri, "Metadata URI must match");

            // Property 4: Other state unchanged
            prop_assert_eq!(final_state.admin, initial_state.admin);
            prop_assert_eq!(final_state.treasury, initial_state.treasury);
            prop_assert_eq!(final_state.base_fee, initial_state.base_fee);
            prop_assert_eq!(final_state.metadata_fee, initial_state.metadata_fee);

        } else {
            // FAILURE CASE: Verify NO state changes occurred
            let final_state = ContractState::capture(&client);

            // Property: State must be completely unchanged on failure
            initial_state.assert_unchanged(&final_state);

            // Property: No token should exist at the would-be index
            let would_be_index = initial_state.token_count;
            let token_result = client.try_get_token_info(&would_be_index);
            prop_assert!(
                token_result.is_err(),
                "No token should exist at index {} after failed creation",
                would_be_index
            );
        }
    }

    /// Property: Invalid parameters always fail atomically
    ///
    /// This test verifies that invalid parameters:
    /// - Always result in failure
    /// - Never cause partial state changes
    /// - Leave the contract in a consistent state
    ///
    /// Runs 1000+ iterations with random invalid parameters
    #[test]
    #[ignore] // Remove this when create_token is implemented
    fn prop_invalid_params_fail_atomically(
        params in invalid_token_params(),
    ) {
        let (name_str, symbol_str, decimals, supply, metadata_str) = params;

        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        let base_fee = 70_000_000i128;
        let metadata_fee = 30_000_000i128;

        client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

        // Capture initial state
        let initial_state = ContractState::capture(&client);

        let name = String::from_str(&env, name_str);
        let symbol = String::from_str(&env, symbol_str);
        let metadata_uri = metadata_str.map(|s| String::from_str(&env, s));

        let expected_fee = if metadata_uri.is_some() {
            base_fee + metadata_fee
        } else {
            base_fee
        };

        // Attempt token creation with invalid params
        /*
        let result = client.try_create_token(
            &creator,
            &name,
            &symbol,
            &decimals,
            &supply,
            &metadata_uri,
            &expected_fee,
        );
        */

        // Simulate failure for invalid params
        let result: Result<Address, Error> = Err(Error::InvalidParameters);

        // Property 1: Invalid parameters must fail
        prop_assert!(result.is_err(), "Invalid parameters must cause failure");

        // Property 2: State must be completely unchanged
        let final_state = ContractState::capture(&client);
        initial_state.assert_unchanged(&final_state);

        // Property 3: No token created
        let would_be_index = initial_state.token_count;
        let token_result = client.try_get_token_info(&would_be_index);
        prop_assert!(
            token_result.is_err(),
            "No token should exist after failed creation"
        );
    }

    /// Property: Insufficient fee always fails atomically
    ///
    /// Tests that providing insufficient fees:
    /// - Always results in failure
    /// - Never creates partial token state
    /// - Preserves contract state integrity
    #[test]
    #[ignore] // Remove this when create_token is implemented
    fn prop_insufficient_fee_fails_atomically(
        params in valid_token_params(),
        fee_reduction in 1i128..100_000_000i128,
    ) {
        let (name_str, symbol_str, decimals, supply, metadata_str) = params;

        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        let base_fee = 70_000_000i128;
        let metadata_fee = 30_000_000i128;

        client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

        let initial_state = ContractState::capture(&client);

        let name = String::from_str(&env, name_str);
        let symbol = String::from_str(&env, symbol_str);
        let metadata_uri = metadata_str.map(|s| String::from_str(&env, s));

        let required_fee = if metadata_uri.is_some() {
            base_fee + metadata_fee
        } else {
            base_fee
        };

        // Provide insufficient fee
        let insufficient_fee = required_fee.saturating_sub(fee_reduction).max(0);

        /*
        let result = client.try_create_token(
            &creator,
            &name,
            &symbol,
            &decimals,
            &supply,
            &metadata_uri,
            &insufficient_fee,
        );
        */

        let result: Result<Address, Error> = Err(Error::InsufficientFee);

        // Property 1: Must fail with insufficient fee
        prop_assert!(result.is_err(), "Insufficient fee must cause failure");

        // Property 2: State unchanged
        let final_state = ContractState::capture(&client);
        initial_state.assert_unchanged(&final_state);
    }

    /// Property: Concurrent token creation attempts are atomic
    ///
    /// Tests that multiple token creations:
    /// - Each complete atomically
    /// - Token count increments correctly
    /// - No race conditions or partial states
    #[test]
    #[ignore] // Remove this when create_token is implemented
    fn prop_multiple_creations_are_atomic(
        params_list in prop::collection::vec(valid_token_params(), 1..10),
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let base_fee = 70_000_000i128;
        let metadata_fee = 30_000_000i128;

        client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

        let mut expected_count = 0u32;

        for (name_str, symbol_str, decimals, supply, metadata_str) in params_list {
            let creator = Address::generate(&env);
            let name = String::from_str(&env, name_str);
            let symbol = String::from_str(&env, symbol_str);
            let metadata_uri = metadata_str.map(|s| String::from_str(&env, s));

            let expected_fee = if metadata_uri.is_some() {
                base_fee + metadata_fee
            } else {
                base_fee
            };

            /*
            let result = client.try_create_token(
                &creator,
                &name,
                &symbol,
                &decimals,
                &supply,
                &metadata_uri,
                &expected_fee,
            );
            */

            let result: Result<Address, Error> = Ok(Address::generate(&env));

            if result.is_ok() {
                expected_count += 1;

                // Verify token count incremented
                let current_count = client.get_token_count();
                prop_assert_eq!(
                    current_count, expected_count,
                    "Token count must increment sequentially"
                );

                // Verify token exists
                let token_info = client.try_get_token_info(&(expected_count - 1));
                prop_assert!(token_info.is_ok(), "Each created token must be retrievable");
            }
        }

        // Final verification: all tokens are accessible
        let final_count = client.get_token_count();
        for i in 0..final_count {
            let token_info = client.try_get_token_info(&i);
            prop_assert!(
                token_info.is_ok(),
                "Token at index {} must be accessible",
                i
            );
        }
    }
}

#[cfg(test)]
mod manual_atomicity_tests {
    use super::*;

    /// Manual test: Verify atomicity with specific edge cases
    #[test]
    #[ignore] // Remove when create_token is implemented
    fn test_atomicity_with_max_supply() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let initial_state = ContractState::capture(&client);

        let name = String::from_str(&env, "Max Supply Token");
        let symbol = String::from_str(&env, "MAX");
        let supply = i128::MAX / 2; // Safe maximum

        /*
        let result = client.try_create_token(
            &creator,
            &name,
            &symbol,
            &7u32,
            &supply,
            &None,
            &70_000_000,
        );
        */

        let result: Result<Address, Error> = Ok(Address::generate(&env));

        if result.is_ok() {
            let final_state = ContractState::capture(&client);
            assert_eq!(final_state.token_count, initial_state.token_count + 1);

            let token_info = client.get_token_info(&0);
            assert_eq!(token_info.total_supply, supply);
        } else {
            let final_state = ContractState::capture(&client);
            initial_state.assert_unchanged(&final_state);
        }
    }

    /// Manual test: Verify atomicity when metadata fee applies
    #[test]
    #[ignore] // Remove when create_token is implemented
    fn test_atomicity_with_metadata() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        let base_fee = 70_000_000i128;
        let metadata_fee = 30_000_000i128;

        client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

        let initial_state = ContractState::capture(&client);

        let metadata_uri = Some(String::from_str(&env, "ipfs://QmTest"));
        let total_fee = base_fee + metadata_fee;

        /*
        let result = client.try_create_token(
            &creator,
            &String::from_str(&env, "Meta Token"),
            &String::from_str(&env, "META"),
            &7u32,
            &1_000_000i128,
            &metadata_uri,
            &total_fee,
        );
        */

        let result: Result<Address, Error> = Ok(Address::generate(&env));

        if result.is_ok() {
            let token_info = client.get_token_info(&0);
            assert_eq!(token_info.metadata_uri, metadata_uri);
        } else {
            let final_state = ContractState::capture(&client);
            initial_state.assert_unchanged(&final_state);
        }
    }

    /// Manual test: Verify atomicity when allowlist mode is enabled at creation
    #[test]
    #[ignore] // Remove when create_token is implemented
    fn test_atomicity_with_allowlist_mode() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        let base_fee = 70_000_000i128;
        let metadata_fee = 30_000_000i128;

        client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

        let initial_state = ContractState::capture(&client);

        let name = String::from_str(&env, "Allowlist Token");
        let symbol = String::from_str(&env, "ALWL");
        let metadata_uri = Some(String::from_str(&env, "ipfs://QmAllowlist"));
        let allowlist_enabled = true;

        // Fee quote must match the actual charge for the same options
        let quoted_fee = client.get_creation_fee_quote(&metadata_uri.is_some(), &allowlist_enabled);
        let expected_fee = base_fee + metadata_fee;
        assert_eq!(quoted_fee, expected_fee, "Quote must match expected charge");

        /*
        let result = client.try_create_token(
            &creator,
            &name,
            &symbol,
            &7u32,
            &1_000_000i128,
            &metadata_uri,
            &allowlist_enabled,
            &quoted_fee,
        );
        */

        let result: Result<Address, Error> = Ok(Address::generate(&env));

        if result.is_ok() {
            // Atomic success: token count incremented exactly once
            let final_state = ContractState::capture(&client);
            assert_eq!(final_state.token_count, initial_state.token_count + 1);

            // Token stored with allowlist mode enabled
            let token_info = client.get_token_info(&initial_state.token_count);
            assert_eq!(token_info.metadata_uri, metadata_uri);
            assert!(token_info.allowlist_enabled, "Allowlist mode must be persisted");

            // Other state unchanged
            assert_eq!(final_state.admin, initial_state.admin);
            assert_eq!(final_state.treasury, initial_state.treasury);
            assert_eq!(final_state.base_fee, initial_state.base_fee);
            assert_eq!(final_state.metadata_fee, initial_state.metadata_fee);
        } else {
            // Atomic failure: no state changes, no token stored
            let final_state = ContractState::capture(&client);
            initial_state.assert_unchanged(&final_state);

            let token_result = client.try_get_token_info(&initial_state.token_count);
            assert!(
                token_result.is_err(),
                "No token should exist after failed allowlist creation"
            );
        }
    }

    /// Manual test: Verify fee quote equivalence across creation option combinations
    #[test]
    #[ignore] // Remove when create_token is implemented
    fn test_fee_quote_matches_charge_for_all_option_combinations() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let base_fee = 70_000_000i128;
        let metadata_fee = 30_000_000i128;

        client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

        for has_metadata in [false, true] {
            for allowlist_enabled in [false, true] {
                let quoted_fee =
                    client.get_creation_fee_quote(&has_metadata, &allowlist_enabled);

                let expected_fee = if has_metadata {
                    base_fee + metadata_fee
                } else {
                    base_fee
                };

                assert_eq!(
                    quoted_fee, expected_fee,
                    "Quote mismatch for metadata={}, allowlist={}",
                    has_metadata, allowlist_enabled
                );
            }
        }
    }

    /// Manual test: Verify state consistency after multiple operations
    #[test]
    #[ignore] // Remove when create_token is implemented
    fn test_atomicity_across_multiple_operations() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        // Create multiple tokens and verify atomicity each time
        for i in 0..5 {
            let initial_count = client.get_token_count();
            let creator = Address::generate(&env);

            let name = String::from_str(&env, "Token");
            let symbol = String::from_str(&env, "TKN");

            /*
            let result = client.try_create_token(
                &creator,
                &name,
                &symbol,
                &7u32,
                &1_000_000i128,
                &None,
                &70_000_000,
            );
            */

            let result: Result<Address, Error> = Ok(Address::generate(&env));

            if result.is_ok() {
                let new_count = client.get_token_count();
                assert_eq!(new_count, initial_count + 1, "Count must increment by 1");

                let token_info = client.get_token_info(&initial_count);
                assert_eq!(token_info.name, name);
                assert_eq!(token_info.symbol, symbol);
            }
        }
    }
}
