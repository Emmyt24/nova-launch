use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

#[cfg(test)]
mod arithmetic_boundaries {
    use super::*;

    #[test]
    fn test_i128_max_fees() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let result = client.try_initialize(&admin, &treasury, &i128::MAX, &0);
        assert!(result.is_ok());

        let state = client.get_state();
        assert_eq!(state.base_fee, i128::MAX);
    }

    #[test]
    fn test_i128_min_fees_rejected() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let result = client.try_initialize(&admin, &treasury, &i128::MIN, &0);
        assert!(result.is_err());
    }

    #[test]
    fn test_near_max_fee_addition() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let half_max = i128::MAX / 2;
        let result = client.try_initialize(&admin, &treasury, &half_max, &half_max);
        assert!(result.is_ok());

        let state = client.get_state();
        let total = state.base_fee.checked_add(state.metadata_fee);
        assert!(total.is_some());
        assert!(total.unwrap() < i128::MAX);
    }

    #[test]
    fn test_overflow_detection_in_fee_sum() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let near_max = i128::MAX - 1000;
        client.initialize(&admin, &treasury, &near_max, &2000);

        let state = client.get_state();
        let total = state.base_fee.checked_add(state.metadata_fee);
        assert!(total.is_none());
    }

    #[test]
    fn test_zero_boundary() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let result = client.try_initialize(&admin, &treasury, &0, &0);
        assert!(result.is_ok());

        let state = client.get_state();
        assert_eq!(state.base_fee, 0);
        assert_eq!(state.metadata_fee, 0);
    }

    #[test]
    fn test_one_stroop_boundary() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let result = client.try_initialize(&admin, &treasury, &1, &1);
        assert!(result.is_ok());

        let state = client.get_state();
        assert_eq!(state.base_fee, 1);
        assert_eq!(state.metadata_fee, 1);
    }

    #[test]
    fn test_negative_one_rejected() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let result = client.try_initialize(&admin, &treasury, &-1, &0);
        assert!(result.is_err());

        let result = client.try_initialize(&admin, &treasury, &0, &-1);
        assert!(result.is_err());
    }

    #[test]
    fn test_update_fees_overflow_protection() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &1000, &1000);

        let result = client.try_update_fees(&admin, &Some(i128::MAX), &None);
        assert!(result.is_ok());

        let state = client.get_state();
        assert_eq!(state.base_fee, i128::MAX);
    }

    #[test]
    fn test_update_fees_negative_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &1000, &1000);

        let result = client.try_update_fees(&admin, &Some(-1), &None);
        assert!(result.is_err());

        let result = client.try_update_fees(&admin, &None, &Some(-1));
        assert!(result.is_err());
    }

    #[test]
    fn test_large_fee_values() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let large_fee = 1_000_000_000_000_000_000i128;
        let result = client.try_initialize(&admin, &treasury, &large_fee, &large_fee);
        assert!(result.is_ok());

        let state = client.get_state();
        assert_eq!(state.base_fee, large_fee);
        assert_eq!(state.metadata_fee, large_fee);
    }

    #[test]
    fn test_sequential_fee_updates_no_overflow() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &1000, &1000);

        let increments = [1000, 10000, 100000, 1000000, 10000000];
        for increment in increments {
            let result = client.try_update_fees(&admin, &Some(increment), &None);
            assert!(result.is_ok());

            let state = client.get_state();
            assert_eq!(state.base_fee, increment);
        }
    }

    #[test]
    fn test_fee_subtraction_boundary() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &1000000, &500000);

        client.update_fees(&admin, &Some(1), &None);
        let state = client.get_state();
        assert_eq!(state.base_fee, 1);

        client.update_fees(&admin, &Some(0), &None);
        let state = client.get_state();
        assert_eq!(state.base_fee, 0);
    }

    #[test]
    fn test_alternating_fee_updates() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &1000, &1000);

        for i in 0..10 {
            let fee = if i % 2 == 0 { 100000 } else { 1 };
            client.update_fees(&admin, &Some(fee), &None);

            let state = client.get_state();
            assert_eq!(state.base_fee, fee);
        }
    }

    #[test]
    fn test_max_u32_token_count() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &1000, &1000);

        let count = client.get_token_count();
        assert_eq!(count, 0);

        let result = client.try_get_token_info(&u32::MAX);
        assert!(result.is_err());
    }

    #[test]
    fn test_token_index_boundaries() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &1000, &1000);

        let result = client.try_get_token_info(&0);
        assert!(result.is_err());

        let result = client.try_get_token_info(&1);
        assert!(result.is_err());

        let result = client.try_get_token_info(&u32::MAX);
        assert!(result.is_err());
    }

    #[test]
    fn test_fee_precision_boundaries() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let one_xlm = 10_000_000i128;
        let result = client.try_initialize(&admin, &treasury, &one_xlm, &one_xlm);
        assert!(result.is_ok());

        let state = client.get_state();
        assert_eq!(state.base_fee, one_xlm);
        assert_eq!(state.metadata_fee, one_xlm);
    }

    #[test]
    fn test_extreme_fee_difference() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let result = client.try_initialize(&admin, &treasury, &i128::MAX, &1);
        assert!(result.is_ok());

        let state = client.get_state();
        assert_eq!(state.base_fee, i128::MAX);
        assert_eq!(state.metadata_fee, 1);
    }

    #[test]
    fn test_checked_arithmetic_in_fee_calculation() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let fee1 = i128::MAX / 3;
        let fee2 = i128::MAX / 3;

        client.initialize(&admin, &treasury, &fee1, &fee2);

        let state = client.get_state();
        let sum = state.base_fee.checked_add(state.metadata_fee);
        assert!(sum.is_some());

        let product = state.base_fee.checked_mul(2);
        assert!(product.is_some());
    }

    #[test]
    fn test_fee_multiplication_overflow() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let large_fee = i128::MAX / 2 + 1;
        client.initialize(&admin, &treasury, &large_fee, &0);

        let state = client.get_state();
        let doubled = state.base_fee.checked_mul(2);
        assert!(doubled.is_none());
    }

    #[test]
    fn test_safe_fee_ranges() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        let safe_ranges = [
            (0, 0),
            (1, 1),
            (10_000_000, 10_000_000),
            (100_000_000, 50_000_000),
            (1_000_000_000, 500_000_000),
            (10_000_000_000, 5_000_000_000),
        ];

        for (base, metadata) in safe_ranges {
            let contract_id = env.register_contract(None, TokenFactory);
            let client = TokenFactoryClient::new(&env, &contract_id);

            let result = client.try_initialize(&admin, &treasury, &base, &metadata);
            assert!(result.is_ok());

            let state = client.get_state();
            let sum = state.base_fee.checked_add(state.metadata_fee);
            assert!(sum.is_some());
        }
    }

    #[test]
    fn test_quote_zero_fee_configuration() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &0, &0);

        let quote = client.quote_token_creation(&false, &false);
        assert_eq!(quote, 0);

        let quote = client.quote_token_creation(&true, &false);
        assert_eq!(quote, 0);

        let quote = client.quote_token_creation(&false, &true);
        assert_eq!(quote, 0);

        let quote = client.quote_token_creation(&true, &true);
        assert_eq!(quote, 0);
    }

    #[test]
    fn test_quote_matches_charge_at_max_fees() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &i128::MAX, &0);

        let quote = client.quote_token_creation(&false, &false);
        assert_eq!(quote, i128::MAX);

        let quote = client.quote_token_creation(&true, &false);
        assert_eq!(quote, i128::MAX);
    }

    #[test]
    fn test_quote_overflow_returns_error() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &(i128::MAX - 1000), &2000);

        let result = client.try_quote_token_creation(&true, &false);
        assert!(result.is_err());
    }

    #[test]
    fn test_quote_metadata_fee_boundary() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &1000, &i128::MAX);

        let quote = client.quote_token_creation(&false, &false);
        assert_eq!(quote, 1000);

        let result = client.try_quote_token_creation(&false, &true);
        assert!(result.is_err());
    }
}

#[cfg(test)]
mod allowlist_boundaries {
    use super::*;

    fn setup(env: &Env) -> (TokenFactoryClient<'_>, Address, Address) {
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        client.initialize(&admin, &treasury, &1000, &1000);
        (client, admin, treasury)
    }

    #[test]
    fn test_allowlist_empty_denies_all() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, _treasury) = setup(&env);

        let token_id = client.create_token(
            &admin,
            &soroban_sdk::String::from_str(&env, "TKN"),
            &soroban_sdk::String::from_str(&env, "Token"),
            &7,
            &0,
            &None,
            &Some(true),
        );

        let holder = Address::generate(&env);
        let result = client.try_transfer(&admin, &token_id, &admin, &holder, &1);
        assert!(result.is_err());
    }

    #[test]
    fn test_allowlist_max_entries() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, _treasury) = setup(&env);

        let token_id = client.create_token(
            &admin,
            &soroban_sdk::String::from_str(&env, "TKN"),
            &soroban_sdk::String::from_str(&env, "Token"),
            &7,
            &0,
            &None,
            &Some(true),
        );

        for _ in 0..100 {
            let addr = Address::generate(&env);
            client.allowlist_add(&admin, &token_id, &addr);
        }

        let count = client.get_allowlist_count(&token_id);
        assert_eq!(count, 100);
    }

    #[test]
    fn test_allowlist_remove_unknown_is_noop() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, _treasury) = setup(&env);

        let token_id = client.create_token(
            &admin,
            &soroban_sdk::String::from_str(&env, "TKN"),
            &soroban_sdk::String::from_str(&env, "Token"),
            &7,
            &0,
            &None,
            &Some(true),
        );

        let unknown = Address::generate(&env);
        let result = client.try_allowlist_remove(&admin, &token_id, &unknown);
        assert!(result.is_ok());
        assert!(!client.is_allowlisted(&token_id, &unknown));
    }

    #[test]
    fn test_allowlist_mint_blocked_for_non_member() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, _treasury) = setup(&env);

        let token_id = client.create_token(
            &admin,
            &soroban_sdk::String::from_str(&env, "TKN"),
            &soroban_sdk::String::from_str(&env, "Token"),
            &7,
            &0,
            &None,
            &Some(true),
        );

        let outsider = Address::generate(&env);
        let result = client.try_mint(&admin, &token_id, &outsider, &1);
        assert!(result.is_err());
    }
}
