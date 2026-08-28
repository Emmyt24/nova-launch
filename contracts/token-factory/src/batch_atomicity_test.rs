//! Batch Operation Atomicity Tests
//!
//! Verifies that batch operations maintain all-or-nothing semantics:
//! - Invalid element mid-batch causes entire batch to revert
//! - Valid batch applies all elements atomically
//! - Empty and single-element batches handled correctly
//! - State before/after failed batch is identical

#[cfg(test)]
mod tests {
    use crate::batch_operations::MAX_BATCH_SIZE;
    use crate::types::{Error, TokenCreationParams};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env, String as SorobanString, Vec};

    fn setup_env() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, crate::TokenFactory);
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000_i128, &30_000_000_i128);

        (env, contract_id, admin)
    }

    fn create_token_params(env: &Env, name: &str, symbol: &str) -> TokenCreationParams {
        TokenCreationParams {
            name: SorobanString::from_str(env, name),
            symbol: SorobanString::from_str(env, symbol),
            decimals: 7,
            initial_supply: 1_000_000_000_000,
            max_supply: None,
            metadata_uri: None,
        }
    }

    fn create_token_params_with_metadata(
        env: &Env,
        name: &str,
        symbol: &str,
    ) -> TokenCreationParams {
        TokenCreationParams {
            name: SorobanString::from_str(env, name),
            symbol: SorobanString::from_str(env, symbol),
            decimals: 7,
            initial_supply: 1_000_000_000_000,
            max_supply: None,
            metadata_uri: Some(SorobanString::from_str(env, "ipfs://QmTest")),
        }
    }

    #[test]
    fn test_batch_atomicity_invalid_element_mid_batch() {
        let (env, contract_id, creator) = setup_env();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        assert!(
            client.try_get_token_info(&0_u32).is_err(),
            "no tokens should exist yet"
        );

        // Create batch with invalid element in the middle
        let mut tokens = Vec::new(&env);
        tokens.push_back(create_token_params(&env, "Token1", "T1"));
        tokens.push_back(TokenCreationParams {
            name: SorobanString::from_str(&env, ""), // Invalid: empty name
            symbol: SorobanString::from_str(&env, "INVALID"),
            decimals: 7,
            initial_supply: 1_000_000_000_000,
            max_supply: None,
            metadata_uri: None,
        });
        tokens.push_back(create_token_params(&env, "Token3", "T3"));

        let base_fee = client.get_state().base_fee;
        let required_fee = base_fee * 3;

        let result = client.try_batch_reveal(&creator, &tokens, &required_fee);
        assert!(result.is_err());

        // Verify state is unchanged: token index 0 still doesn't exist.
        assert!(client.try_get_token_info(&0_u32).is_err());
    }

    #[test]
    fn test_batch_atomicity_valid_batch_applies_all() {
        let (env, contract_id, creator) = setup_env();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let mut tokens = Vec::new(&env);
        tokens.push_back(create_token_params(&env, "Token1", "T1"));
        tokens.push_back(create_token_params(&env, "Token2", "T2"));
        tokens.push_back(create_token_params(&env, "Token3", "T3"));

        let base_fee = client.get_state().base_fee;
        let required_fee = base_fee * 3;

        let indices = client.batch_reveal(&creator, &tokens, &required_fee);
        assert_eq!(indices.len(), 3, "should return 3 token indices");

        assert!(client.try_get_token_info(&0_u32).is_ok());
        assert!(client.try_get_token_info(&1_u32).is_ok());
        assert!(client.try_get_token_info(&2_u32).is_ok());

        assert_eq!(indices.get(0).unwrap(), 0);
        assert_eq!(indices.get(1).unwrap(), 1);
        assert_eq!(indices.get(2).unwrap(), 2);
    }

    #[test]
    fn test_batch_atomicity_empty_batch() {
        let (env, contract_id, creator) = setup_env();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let tokens: Vec<TokenCreationParams> = Vec::new(&env);
        let base_fee = client.get_state().base_fee;

        let result = client.try_batch_reveal(&creator, &tokens, &base_fee);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
    }

    #[test]
    fn test_batch_atomicity_single_element() {
        let (env, contract_id, creator) = setup_env();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let mut tokens = Vec::new(&env);
        tokens.push_back(create_token_params(&env, "SingleToken", "ST"));

        let base_fee = client.get_state().base_fee;

        let indices = client.batch_reveal(&creator, &tokens, &base_fee);
        assert_eq!(indices.len(), 1);
        assert_eq!(indices.get(0).unwrap(), 0);

        assert!(client.try_get_token_info(&0_u32).is_ok());
    }

    #[test]
    fn test_batch_atomicity_insufficient_fee() {
        let (env, contract_id, creator) = setup_env();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let mut tokens = Vec::new(&env);
        tokens.push_back(create_token_params(&env, "Token1", "T1"));
        tokens.push_back(create_token_params(&env, "Token2", "T2"));

        let base_fee = client.get_state().base_fee;
        let insufficient_fee = base_fee; // Only enough for 1 token

        let result = client.try_batch_reveal(&creator, &tokens, &insufficient_fee);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().unwrap(), Error::InsufficientFee);

        // Verify state unchanged.
        assert!(client.try_get_token_info(&0_u32).is_err());
    }

    #[test]
    fn test_batch_atomicity_with_metadata() {
        let (env, contract_id, creator) = setup_env();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let mut tokens = Vec::new(&env);
        tokens.push_back(create_token_params_with_metadata(&env, "Token1", "T1"));
        tokens.push_back(create_token_params_with_metadata(&env, "Token2", "T2"));

        let state = client.get_state();
        let required_fee = (state.base_fee + state.metadata_fee) * 2;

        let indices = client.batch_reveal(&creator, &tokens, &required_fee);
        assert_eq!(indices.len(), 2);
        assert!(client.try_get_token_info(&0_u32).is_ok());
        assert!(client.try_get_token_info(&1_u32).is_ok());
    }

    #[test]
    fn test_batch_atomicity_max_batch_size() {
        let (env, contract_id, creator) = setup_env();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let mut tokens = Vec::new(&env);
        for _ in 0..MAX_BATCH_SIZE {
            tokens.push_back(TokenCreationParams {
                name: SorobanString::from_str(&env, "Token"),
                symbol: SorobanString::from_str(&env, "TK0"),
                decimals: 7,
                initial_supply: 1_000_000_000_000,
                max_supply: None,
                metadata_uri: None,
            });
        }

        let base_fee = client.get_state().base_fee;
        let required_fee = base_fee * (MAX_BATCH_SIZE as i128);

        let indices = client.batch_reveal(&creator, &tokens, &required_fee);
        assert_eq!(indices.len() as u32, MAX_BATCH_SIZE);
    }

    #[test]
    fn test_batch_atomicity_exceeds_max_size() {
        let (env, contract_id, creator) = setup_env();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let mut tokens = Vec::new(&env);
        for _ in 0..=MAX_BATCH_SIZE {
            tokens.push_back(TokenCreationParams {
                name: SorobanString::from_str(&env, "Token"),
                symbol: SorobanString::from_str(&env, "TK0"),
                decimals: 7,
                initial_supply: 1_000_000_000_000,
                max_supply: None,
                metadata_uri: None,
            });
        }

        let base_fee = client.get_state().base_fee;
        let required_fee = base_fee * ((MAX_BATCH_SIZE + 1) as i128);

        let result = client.try_batch_reveal(&creator, &tokens, &required_fee);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().unwrap(), Error::BatchTooLarge);
    }

    #[test]
    fn test_batch_atomicity_state_consistency_after_failure() {
        let (env, contract_id, creator) = setup_env();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        // First successful batch.
        let mut tokens1 = Vec::new(&env);
        tokens1.push_back(create_token_params(&env, "Token1", "T1"));
        let base_fee = client.get_state().base_fee;
        let indices1 = client.batch_reveal(&creator, &tokens1, &base_fee);
        assert_eq!(indices1.len(), 1);

        // Second batch with an invalid element must fail and change nothing.
        let mut tokens2 = Vec::new(&env);
        tokens2.push_back(create_token_params(&env, "Token2", "T2"));
        tokens2.push_back(TokenCreationParams {
            name: SorobanString::from_str(&env, ""), // Invalid
            symbol: SorobanString::from_str(&env, "INVALID"),
            decimals: 7,
            initial_supply: 1_000_000_000_000,
            max_supply: None,
            metadata_uri: None,
        });

        let result = client.try_batch_reveal(&creator, &tokens2, &(base_fee * 2));
        assert!(result.is_err());

        // Token index 1 (the would-be "Token2") must not exist.
        assert!(client.try_get_token_info(&1_u32).is_err());
        // Token index 0 (from the first batch) must be unaffected.
        assert!(client.try_get_token_info(&0_u32).is_ok());
    }

    // ── pre-flight: catches failures before any execution ──────────────────

    #[test]
    fn test_preflight_catches_invalid_element_with_no_side_effects() {
        let (env, contract_id, _creator) = setup_env();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let mut tokens = Vec::new(&env);
        tokens.push_back(create_token_params(&env, "Token1", "T1"));
        tokens.push_back(TokenCreationParams {
            name: SorobanString::from_str(&env, ""), // Invalid: empty name
            symbol: SorobanString::from_str(&env, "INVALID"),
            decimals: 7,
            initial_supply: 1_000_000_000_000,
            max_supply: None,
            metadata_uri: None,
        });

        let base_fee = client.get_state().base_fee;
        let results = client.preflight_batch_reveal(&tokens, &(base_fee * 2));

        assert_eq!(results.len(), 2);
        assert_eq!(results.get(0).unwrap().error_code, 0);
        assert_eq!(
            results.get(1).unwrap().error_code,
            Error::InvalidTokenParams.0
        );

        // The dry-run must not have created anything.
        assert!(client.try_get_token_info(&0_u32).is_err());
    }

    #[test]
    fn test_preflight_reports_all_valid_for_clean_batch() {
        let (env, contract_id, _creator) = setup_env();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let tokens = {
            let mut v = Vec::new(&env);
            v.push_back(create_token_params(&env, "Token1", "T1"));
            v.push_back(create_token_params(&env, "Token2", "T2"));
            v
        };

        let base_fee = client.get_state().base_fee;
        let results = client.preflight_batch_reveal(&tokens, &(base_fee * 2));

        assert_eq!(results.len(), 2);
        for r in results.iter() {
            assert_eq!(r.error_code, 0);
        }
        assert!(client.try_get_token_info(&0_u32).is_err());
    }
}
