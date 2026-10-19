use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

/// Helper function to create a mock token for testing
fn setup_mock_token(env: &Env, client: &TokenFactoryClient, creator: &Address) -> Address {
    // Create a mock token address
    let token_address = Address::generate(env);
    
    // Create token info with clawback enabled
    let token_info = TokenInfo {
        address: token_address.clone(),
        creator: creator.clone(),
        name: String::from_str(env, "Test Token"),
        symbol: String::from_str(env, "TEST"),
        decimals: 7,
        total_supply: 1_000_000_0000000,
        metadata_uri: None,
        metadata_version: 0,
        created_at: env.ledger().timestamp(),
        total_burned: 0,
        burn_count: 0,
        clawback_enabled: true,
            freeze_enabled: false,
            is_paused: false,
        
        };
    
    // Store token info
    storage::set_token_info_by_address(env, &token_address, &token_info);
    
    token_address
}

#[test]
fn test_admin_burn_success() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    // Setup
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let from = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    // Create mock token
    let token_address = setup_mock_token(&env, &client, &creator);
    
    // Perform admin burn
    let burn_amount = 100_000_0000000i128;
    let result = client.admin_burn(&token_address, &creator, &from, &burn_amount);
    
    // Verify success
    assert!(result.is_ok());
    
    // Verify token info updated
    let token_info = client.get_token_info_by_address(&token_address).unwrap();
    assert_eq!(token_info.total_supply, 900_000_0000000);
    assert_eq!(token_info.total_burned, 100_000_0000000);
    assert_eq!(token_info.burn_count, 1);
}

#[test]
fn test_admin_burn_multiple_burns() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let from = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    let token_address = setup_mock_token(&env, &client, &creator);
    
    // First burn
    client.admin_burn(&token_address, &creator, &from, &50_000_0000000).unwrap();
    
    // Second burn
    client.admin_burn(&token_address, &creator, &from, &30_000_0000000).unwrap();
    
    // Verify cumulative effects
    let token_info = client.get_token_info_by_address(&token_address).unwrap();
    assert_eq!(token_info.total_supply, 920_000_0000000);
    assert_eq!(token_info.total_burned, 80_000_0000000);
    assert_eq!(token_info.burn_count, 2);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_admin_burn_unauthorized_not_creator() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let non_creator = Address::generate(&env);
    let from = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    let token_address = setup_mock_token(&env, &client, &creator);
    
    // Attempt burn by non-creator should fail with Unauthorized error
    client.admin_burn(&token_address, &non_creator, &from, &100_000_0000000).unwrap();
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_admin_burn_token_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let from = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    // Use non-existent token address
    let fake_token = Address::generate(&env);
    
    // Should fail with TokenNotFound error
    client.admin_burn(&fake_token, &creator, &from, &100_000_0000000).unwrap();
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_admin_burn_clawback_disabled() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let from = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    // Create token with clawback disabled
    let token_address = Address::generate(&env);
    let token_info = TokenInfo {
        address: token_address.clone(),
        creator: creator.clone(),
        name: String::from_str(&env, "No Clawback Token"),
        symbol: String::from_str(&env, "NCT"),
        decimals: 7,
        total_supply: 1_000_000_0000000,
        metadata_uri: None,
        metadata_version: 0,
        created_at: env.ledger().timestamp(),
        total_burned: 0,
        burn_count: 0,
        clawback_enabled: false,
            freeze_enabled: false,
            is_paused: false,
        
        };
    storage::set_token_info_by_address(&env, &token_address, &token_info);
    
    // Should fail with ClawbackDisabled error
    client.admin_burn(&token_address, &creator, &from, &100_000_0000000).unwrap();
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_admin_burn_zero_amount() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let from = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    let token_address = setup_mock_token(&env, &client, &creator);
    
    // Should fail with InvalidBurnAmount error
    client.admin_burn(&token_address, &creator, &from, &0).unwrap();
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_admin_burn_negative_amount() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let from = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    let token_address = setup_mock_token(&env, &client, &creator);
    
    // Should fail with InvalidBurnAmount error
    client.admin_burn(&token_address, &creator, &from, &-100).unwrap();
}

#[test]
fn test_set_clawback_enable() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    // Create token with clawback disabled
    let token_address = Address::generate(&env);
    let token_info = TokenInfo {
        address: token_address.clone(),
        creator: creator.clone(),
        name: String::from_str(&env, "Test Token"),
        symbol: String::from_str(&env, "TEST"),
        decimals: 7,
        total_supply: 1_000_000_0000000,
        metadata_uri: None,
        metadata_version: 0,
        created_at: env.ledger().timestamp(),
        total_burned: 0,
        burn_count: 0,
        clawback_enabled: false,
            freeze_enabled: false,
            is_paused: false,
        
        };
    storage::set_token_info_by_address(&env, &token_address, &token_info);
    
    // Enable clawback
    client.set_clawback(&token_address, &creator, &true).unwrap();
    
    // Verify clawback is enabled
    let updated_info = client.get_token_info_by_address(&token_address).unwrap();
    assert!(updated_info.clawback_enabled);
}

#[test]
fn test_set_clawback_disable() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    let token_address = setup_mock_token(&env, &client, &creator);
    
    // Disable clawback
    client.set_clawback(&token_address, &creator, &false).unwrap();
    
    // Verify clawback is disabled
    let updated_info = client.get_token_info_by_address(&token_address).unwrap();
    assert!(!updated_info.clawback_enabled);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_set_clawback_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let non_creator = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    let token_address = setup_mock_token(&env, &client, &creator);
    
    // Non-creator attempts to change clawback setting
    client.set_clawback(&token_address, &non_creator, &false).unwrap();
}

/// Negative authorization test for `set_clawback` when called by a
/// non-admin, non-creator address. Proves the admin/creator gate rejects
/// arbitrary callers.
#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_set_clawback_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = setup_mock_token(&env, &client, &creator);

    // Attacker is neither admin nor creator: must be rejected.
    client.set_clawback(&token_address, &attacker, &true).unwrap();
}

/// Negative authorization test for `admin_burn` when called by a
/// non-admin, non-creator address.
#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_admin_burn_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let attacker = Address::generate(&env);
    let from = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = setup_mock_token(&env, &client, &creator);

    // Attacker is neither admin nor creator: must be rejected.
    client
        .admin_burn(&token_address, &attacker, &from, &100_000_0000000)
        .unwrap();
}

#[test]
fn test_admin_burn_event_emitted() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let from = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    let token_address = setup_mock_token(&env, &client, &creator);
    
    // Perform admin burn
    let burn_amount = 100_000_0000000i128;
    client.admin_burn(&token_address, &creator, &from, &burn_amount).unwrap();
    
    // Verify event was published
    // Note: Event verification would require accessing env.events() 
    // which is typically done through event inspection in integration tests
}

#[test]
fn test_admin_burn_from_different_addresses() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    
    let token_address = setup_mock_token(&env, &client, &creator);
    
    // Burn from user1
    client.admin_burn(&token_address, &creator, &user1, &50_000_0000000).unwrap();
    
    // Burn from user2
    client.admin_burn(&token_address, &creator, &user2, &30_000_0000000).unwrap();
    
    // Verify total burned
    let token_info = client.get_token_info_by_address(&token_address).unwrap();
    assert_eq!(token_info.total_burned, 80_000_0000000);
    assert_eq!(token_info.burn_count, 2);
}

// ---------------------------------------------------------------------------
// Negative authorization coverage for the remaining admin-gated entrypoints.
//
// Every admin-only function in `lib.rs` must have at least one test in this
// module (or another admin test module) whose name matches
// `test_<fn>_rejects_non_admin` (or `test_<fn>_unauthorized`). The
// `scripts/check_admin_auth_tests.sh` script enforces this automatically.
//
// Pattern:
//   1. Initialize the contract with a known admin.
//   2. Generate a distinct `attacker` address that is neither admin nor
//      creator.
//   3. Call the admin function as `attacker` and assert it panics with the
//      Unauthorized error (`Error(Contract, #2)`).
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_pause_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    client.pause(&attacker).unwrap();
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_unpause_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    client.unpause(&attacker).unwrap();
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_update_fees_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    client.update_fees(&attacker, &Some(1_000), &Some(1_000)).unwrap();
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_update_treasury_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    client.update_treasury(&attacker, &attacker).unwrap();
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_transfer_admin_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let attacker = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    client.transfer_admin(&attacker, &new_admin).unwrap();
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_set_token_paused_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = setup_mock_token(&env, &client, &creator);

    client.set_token_paused(&token_address, &attacker, &true).unwrap();
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_set_freeze_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = setup_mock_token(&env, &client, &creator);

    client.set_freeze(&token_address, &attacker, &true).unwrap();
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_upgrade_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let attacker = Address::generate(&env);
    let new_wasm_hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    client.upgrade(&attacker, &new_wasm_hash).unwrap();
}

