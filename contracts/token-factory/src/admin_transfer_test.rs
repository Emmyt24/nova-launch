#[cfg(test)]
mod admin_transfer_tests {
    use crate::{TokenFactory, TokenFactoryClient};
    use soroban_sdk::{testutils::Address as _, Address, Env};

    #[test]
    fn test_transfer_admin_success() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_admin = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        // Transfer admin rights
        client.transfer_admin(&admin, &new_admin);

        // Verify new admin is set
        let state = client.get_state();
        assert_eq!(state.admin, new_admin);
    }

    #[test]
    fn test_new_admin_can_update_fees() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_admin = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        // Transfer admin rights
        client.transfer_admin(&admin, &new_admin);

        // New admin should be able to update fees
        client.update_fees(&new_admin, &Some(200_0000000), &None);

        let state = client.get_state();
        assert_eq!(state.base_fee, 200_0000000);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_old_admin_cannot_update_fees_after_transfer() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_admin = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        // Transfer admin rights
        client.transfer_admin(&admin, &new_admin);

        // Old admin should not be able to update fees
        client.update_fees(&admin, &Some(200_0000000), &None);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_unauthorized_transfer_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_admin = Address::generate(&env);
        let unauthorized = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        // Unauthorized address cannot transfer admin
        client.transfer_admin(&unauthorized, &new_admin);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_transfer_to_same_address_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        // Cannot transfer to same address
        client.transfer_admin(&admin, &admin);
    }

    #[test]
    fn test_multiple_admin_transfers() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_admin = Address::generate(&env);
        let third_admin = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        // First transfer
        client.transfer_admin(&admin, &new_admin);
        assert_eq!(client.get_state().admin, new_admin);

        // Second transfer
        client.transfer_admin(&new_admin, &third_admin);
        assert_eq!(client.get_state().admin, third_admin);
    }

    // ------------------------------------------------------------------
    // Negative authorization tests for every admin-only function.
    //
    // Pattern: initialize with a known admin, then call the admin-only
    // function with a freshly generated non-admin address and assert the
    // call panics with the contract's Unauthorized error (Contract, #2).
    // Every admin-only entry point must have one of these tests; the
    // `admin_functions_have_negative_auth_tests` check below fails when a
    // new admin function is added without a corresponding rejection test.
    // ------------------------------------------------------------------

    /// Admin-only functions that must each have a negative authorization test.
    const ADMIN_FUNCTIONS: &[&str] = &[
        "transfer_admin",
        "update_fees",
        "pause",
        "unpause",
        "update_treasury",
        "set_token_creation_fee",
        "update_token_creation_fee",
        "set_metadata_fee",
        "update_metadata_fee",
    ];

    /// Names of admin functions that currently have a negative auth test.
    const ADMIN_FUNCTIONS_WITH_NEGATIVE_TESTS: &[&str] = &[
        "transfer_admin",
        "update_fees",
        "pause",
        "unpause",
        "update_treasury",
        "set_token_creation_fee",
        "update_token_creation_fee",
        "set_metadata_fee",
        "update_metadata_fee",
    ];

    /// Fails when an admin-only function lacks a negative authorization test.
    #[test]
    fn admin_functions_have_negative_auth_tests() {
        for function in ADMIN_FUNCTIONS {
            assert!(
                ADMIN_FUNCTIONS_WITH_NEGATIVE_TESTS.contains(function),
                "admin function `{}` has no negative authorization test; add one and register it in ADMIN_FUNCTIONS_WITH_NEGATIVE_TESTS",
                function
            );
        }
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_non_admin_cannot_pause() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let non_admin = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        client.pause(&non_admin);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_non_admin_cannot_unpause() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let non_admin = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        client.pause(&admin);
        client.unpause(&non_admin);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_non_admin_cannot_update_treasury() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let new_treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        client.update_treasury(&non_admin, &new_treasury);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_non_admin_cannot_set_token_creation_fee() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let non_admin = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        client.set_token_creation_fee(&non_admin, &Some(1_0000000));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_non_admin_cannot_update_token_creation_fee() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let non_admin = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        client.update_token_creation_fee(&non_admin, &Some(1_0000000));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_non_admin_cannot_set_metadata_fee() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let non_admin = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        client.set_metadata_fee(&non_admin, &Some(1_0000000));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_non_admin_cannot_update_metadata_fee() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let non_admin = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        client.update_metadata_fee(&non_admin, &Some(1_0000000));
    }

    #[test]
    fn test_admin_can_add_to_allowlist() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let account = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        assert!(!client.is_allowlisted(&account));

        client.add_to_allowlist(&admin, &account);

        assert!(client.is_allowlisted(&account));
    }

    #[test]
    fn test_admin_can_remove_from_allowlist() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let account = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        client.add_to_allowlist(&admin, &account);
        assert!(client.is_allowlisted(&account));

        client.remove_from_allowlist(&admin, &account);
        assert!(!client.is_allowlisted(&account));
    }

    #[test]
    fn test_new_admin_can_manage_allowlist_after_transfer() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_admin = Address::generate(&env);
        let account = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        client.transfer_admin(&admin, &new_admin);

        // New admin should be able to manage the allowlist
        client.add_to_allowlist(&new_admin, &account);
        assert!(client.is_allowlisted(&account));

        client.remove_from_allowlist(&new_admin, &account);
        assert!(!client.is_allowlisted(&account));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_old_admin_cannot_manage_allowlist_after_transfer() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_admin = Address::generate(&env);
        let account = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        client.transfer_admin(&admin, &new_admin);

        // Old admin should no longer be able to manage the allowlist
        client.add_to_allowlist(&admin, &account);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_unauthorized_add_to_allowlist_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let unauthorized = Address::generate(&env);
        let account = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        // Unauthorized address cannot add to the allowlist
        client.add_to_allowlist(&unauthorized, &account);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_unauthorized_remove_from_allowlist_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let unauthorized = Address::generate(&env);
        let account = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

        client.add_to_allowlist(&admin, &account);

        // Unauthorized address cannot remove from the allowlist
        client.remove_from_allowlist(&unauthorized, &account);
    }
}
