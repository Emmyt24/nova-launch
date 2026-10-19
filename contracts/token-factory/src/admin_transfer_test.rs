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
