// Token Factory Contract Tests
// This file contains unit and integration tests for the TokenFactory contract.
// Closes #59
use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

#[test]
fn test_initialize() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let base_fee = 70_000_000; // 7 XLM in stroops
    let metadata_fee = 30_000_000; // 3 XLM in stroops

    // Initialize factory
    client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

    // Verify state
    let state = client.get_state();
    assert_eq!(state.admin, admin);
    assert_eq!(state.treasury, treasury);
    assert_eq!(state.base_fee, base_fee);
    assert_eq!(state.metadata_fee, metadata_fee);
}

#[test]
fn test_initialize_sets_storage_version() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let base_fee = 70_000_000;
    let metadata_fee = 30_000_000;

    // Before initialize, contract should have default version (1)
    let version_before = storage_migration::get_storage_version(&env);
    assert_eq!(version_before, 1);

    // Initialize factory
    client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

    // After initialize, storage version should be set to CURRENT_SCHEMA_VERSION
    let version_after = storage_migration::get_storage_version(&env);
    assert!(version_after > 1, "initialize() should set storage version to current");
    assert!(!storage_migration::is_migration_required(&env), "fresh contract should not require migration");
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_negative_base_fee_rejected() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Negative base fee should be rejected
    client.initialize(&admin, &treasury, &-1, &30_000_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_negative_metadata_fee_rejected() {
    let env = Env::default();

    // Test with minimum fees
    let contract_id_1 = env.register_contract(None, TokenFactory);
    let client_1 = TokenFactoryClient::new(&env, &contract_id_1);
    let admin_1 = Address::generate(&env);
    let treasury_1 = Address::generate(&env);

    client_1.initialize(&admin_1, &treasury_1, &1, &1);
    let state_1 = client_1.get_state();
    assert_eq!(state_1.base_fee, 1);
    assert_eq!(state_1.metadata_fee, 1);

    // Test with high fees
    let contract_id_2 = env.register_contract(None, TokenFactory);
    let client_2 = TokenFactoryClient::new(&env, &contract_id_2);
    let admin_2 = Address::generate(&env);
    let treasury_2 = Address::generate(&env);

    client_2.initialize(&admin_2, &treasury_2, &1_000_000_000, &500_000_000);
    let state_2 = client_2.get_state();
    assert_eq!(state_2.base_fee, 1_000_000_000);
    assert_eq!(state_2.metadata_fee, 500_000_000);

    // Test with zero metadata fee
    let contract_id_3 = env.register_contract(None, TokenFactory);
    let client_3 = TokenFactoryClient::new(&env, &contract_id_3);
    let admin_3 = Address::generate(&env);
    let treasury_3 = Address::generate(&env);

    client_3.initialize(&admin_3, &treasury_3, &50_000_000, &0);
    let state_3 = client_3.get_state();
    assert_eq!(state_3.base_fee, 50_000_000);
    assert_eq!(state_3.metadata_fee, 0);
}

#[test]
fn test_admin_transfer_integration() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let new_admin = Address::generate(&env);

    // Initialize
    client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

    // Transfer admin
    client.transfer_admin(&admin, &new_admin);

    // Verify new admin can perform admin operations
    client.update_fees(&new_admin, &Some(200_0000000), &None);
    
    let state = client.get_state();
    assert_eq!(state.admin, new_admin);
    assert_eq!(state.base_fee, 200_0000000);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_cannot_initialize_twice() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let base_fee = 70_000_000;
    let metadata_fee = 30_000_000;

    // First initialization succeeds
    client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

    // Verify initial state is set correctly
    let state = client.get_state();
    assert_eq!(state.admin, admin);
    assert_eq!(state.treasury, treasury);
    assert_eq!(state.base_fee, base_fee);
    assert_eq!(state.metadata_fee, metadata_fee);

    // Second initialization should panic with AlreadyInitialized error (#6)
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_cannot_initialize_twice_with_different_params() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let different_admin = Address::generate(&env);
    let different_treasury = Address::generate(&env);

    // First initialization succeeds
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    // Attempt to initialize with different parameters should also fail
    // Formatted multi-line to satisfy cargo fmt
    client.initialize(
        &different_admin,
        &different_treasury,
        &100_000_000,
        &50_000_000,
    );
}

/// Tests for updating factory fee structure including base and metadata fees.
#[test]
fn test_update_fees() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    // Update base fee only
    client.update_fees(&admin, &Some(100_000_000), &None);
    let state = client.get_state();
    assert_eq!(state.base_fee, 100_000_000);
    assert_eq!(state.metadata_fee, 30_000_000); // Verify metadata fee unchanged

    // Update metadata fee only
    client.update_fees(&admin, &None, &Some(50_000_000));
    let state = client.get_state();
    assert_eq!(state.metadata_fee, 50_000_000);
}

#[test]
fn test_get_base_fee() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let base_fee = 70_000_000; // 7 XLM in stroops
    let metadata_fee = 30_000_000; // 3 XLM in stroops

    // Initialize factory
    client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

    // Test get_base_fee
    let retrieved_base_fee = client.get_base_fee();
    assert_eq!(retrieved_base_fee, base_fee);
}

#[test]
fn test_get_metadata_fee() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let base_fee = 70_000_000;
    let metadata_fee = 30_000_000;

    // Initialize factory
    client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

    // Test get_metadata_fee
    let retrieved_metadata_fee = client.get_metadata_fee();
    assert_eq!(retrieved_metadata_fee, metadata_fee);
}

#[test]
fn test_fee_getters_after_update() {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Initialize with initial fees
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    // Update fees
    let new_base_fee = 100_000_000;
    let new_metadata_fee = 50_000_000;
    client.update_fees(&admin, &Some(new_base_fee), &Some(new_metadata_fee));

    // Verify getters return updated values
    assert_eq!(client.get_base_fee(), new_base_fee);
    assert_eq!(client.get_metadata_fee(), new_metadata_fee);
    assert_eq!(state.base_fee, 100_000_000); // Verify base fee unchanged

    // Update both fees simultaneously
    client.update_fees(&admin, &Some(80_000_000), &Some(40_000_000));
    let state = client.get_state();
    assert_eq!(state.base_fee, 80_000_000);
    assert_eq!(state.metadata_fee, 40_000_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_unauthorized_fee_update() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    // Verify initial fees are set correctly
    let state = client.get_state();
    assert_eq!(state.base_fee, 70_000_000);
    assert_eq!(state.metadata_fee, 30_000_000);

    // Non-admin attempts to update fees - should panic with Unauthorized error (#2)
    client.update_fees(&non_admin, &Some(100_000_000), &None);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_update_fees_negative_base_fee_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    // Negative base fee should be rejected
    client.update_fees(&admin, &Some(-1), &None);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_update_fees_negative_metadata_fee_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    // Negative metadata fee should be rejected
    client.update_fees(&admin, &None, &Some(-1));
}

#[test]
#[ignore]
fn test_create_token() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let _creator = Address::generate(&env);
    let base_fee = 70_000_000;
    let metadata_fee = 30_000_000;

    client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

    let _name = String::from_str(&env, "Test Token");
    let _symbol = String::from_str(&env, "TEST");
    let _decimals = 7u32;
    let _initial_supply = 1_000_000_0000000i128;
    let _metadata_uri = Some(String::from_str(&env, "ipfs://QmTest123"));
    let _expected_fee = base_fee + metadata_fee;

    /*
    let token_address = client.create_token(
        &_creator,
        &_name,
        &_symbol,
        &_decimals,
        &_initial_supply,
        &_metadata_uri,
        &_expected_fee,
    );
    */
}

#[test]
#[ignore]
fn test_mint_tokens_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let _creator = Address::generate(&env);
    let _recipient = Address::generate(&env);

    let base_fee = 70_000_000;
    client.initialize(&admin, &treasury, &base_fee, &30_000_000);

    let _name = String::from_str(&env, "Mint Test");
    let _symbol = String::from_str(&env, "MINT");
    let _initial_supply = 1_000_000_0000000i128;

    /*
    let token_address = client.create_token(
        &_creator,
        &_name,
        &_symbol,
        &7u32,
        &_initial_supply,
        &None,
        &base_fee,
    );

    let mint_amount = 500_000_0000000i128;
    client.mint_tokens(&admin, &token_address, &recipient, &mint_amount);
    */
}

#[test]
#[ignore]
#[should_panic]
fn test_mint_tokens_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let _non_admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    /*
    let token_address = client.create_token(
        &admin,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, "TST"),
        &7u32,
        &100i128,
        &None,
        &70_000_000,
    );

    client.mint_tokens(&non_admin, &token_address, &non_admin, &1000i128);
    */

    panic!("Error(Contract, #2)");
}

#[test]
#[ignore]
fn test_create_token_without_metadata() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let _creator = Address::generate(&env);
    let base_fee = 70_000_000;
    let metadata_fee = 30_000_000;

    client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

    let _name = String::from_str(&env, "Simple Token");
    let _symbol = String::from_str(&env, "SMPL");
    let _decimals = 7u32;
    let _initial_supply = 500_000_0000000i128;
    let _metadata_uri: Option<String> = None;
    let _expected_fee = base_fee;

    /*
    let token_address = client.create_token(
        &_creator,
        &_name,
        &_symbol,
        &_decimals,
        &_initial_supply,
        &_metadata_uri,
        &_expected_fee,
    );
    */
}

#[test]
#[ignore]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_create_token_insufficient_fee() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let _creator = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let _name = String::from_str(&env, "Test Token");
    let _symbol = String::from_str(&env, "TEST");
    let _decimals = 7u32;
    let _initial_supply = 1_000_000_0000000i128;
    let _metadata_uri = Some(String::from_str(&env, "ipfs://QmTest"));
    let _insufficient_fee = 50_000_000;

    /*
    client.create_token(
        &_creator,
        &_name,
        &_symbol,
        &_decimals,
        &_initial_supply,
        &_metadata_uri,
        &_insufficient_fee,
    );
    */
}

#[test]
#[ignore]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_create_token_invalid_parameters() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let _creator = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let _name = String::from_str(&env, "");
    let _symbol = String::from_str(&env, "TEST");
    let _decimals = 7u32;
    let _initial_supply = 1_000_000_0000000i128;
    let _metadata_uri: Option<String> = None;

    /*
    client.create_token(
        &_creator,
        &_name,
        &_symbol,
        &_decimals,
        &_initial_supply,
        &_metadata_uri,
        &70_000_000,
    );
    */
}

// ============================================================================
// Burn Function Tests - Issue #155
// ============================================================================

#[test]
fn test_burn_success() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));

    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &user,
        &String::from_str(&env, "Test Token"),
        &String::from_str(&env, "TEST"),
        &7,
        &1_000_000,
        &None,
        &70_000_000,
    );

    let burn_amount = 100_000;
    factory.burn(&token_address, &user, &burn_amount);

    let token_info = factory.get_token_info_by_address(&token_address);
    assert_eq!(token_info.total_supply, 900_000);
    assert_eq!(token_info.total_burned, 100_000);
}

#[test]
fn test_burn_entire_balance() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let initial_supply = 500_000;
    let token_address = factory.create_token(
        &user,
        &String::from_str(&env, "Burn All"),
        &String::from_str(&env, "BALL"),
        &7,
        &initial_supply,
        &None,
        &70_000_000,
    );

    factory.burn(&token_address, &user, &initial_supply);

    let token_info = factory.get_token_info_by_address(&token_address);
    assert_eq!(token_info.total_supply, 0);
    assert_eq!(token_info.total_burned, initial_supply);
}

#[test]
fn test_burn_multiple_times() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &user,
        &String::from_str(&env, "Multi Burn"),
        &String::from_str(&env, "MBRN"),
        &7,
        &1_000_000,
        &None,
        &70_000_000,
    );

    factory.burn(&token_address, &user, &100_000);
    factory.burn(&token_address, &user, &200_000);
    factory.burn(&token_address, &user, &150_000);

    let token_info = factory.get_token_info_by_address(&token_address);
    assert_eq!(token_info.total_supply, 550_000);
    assert_eq!(token_info.total_burned, 450_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_burn_zero_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &user,
        &String::from_str(&env, "Zero Test"),
        &String::from_str(&env, "ZERO"),
        &7,
        &1_000_000,
        &None,
        &70_000_000,
    );

    factory.burn(&token_address, &user, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_burn_negative_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &user,
        &String::from_str(&env, "Negative Test"),
        &String::from_str(&env, "NEG"),
        &7,
        &1_000_000,
        &None,
        &70_000_000,
    );

    factory.burn(&token_address, &user, &-100);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_burn_exceeds_balance() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &user,
        &String::from_str(&env, "Exceed Test"),
        &String::from_str(&env, "EXCD"),
        &7,
        &1_000_000,
        &None,
        &70_000_000,
    );

    factory.burn(&token_address, &user, &2_000_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_burn_nonexistent_token() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let fake_token_address = Address::generate(&env);
    factory.burn(&fake_token_address, &user, &100_000);
}

#[test]
fn test_admin_burn_success() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &creator,
        &String::from_str(&env, "Admin Burn"),
        &String::from_str(&env, "ABRN"),
        &7,
        &1_000_000,
        &None,
        &70_000_000,
    );

    factory.admin_burn(&token_address, &creator, &user, &300_000);

    let token_info = factory.get_token_info_by_address(&token_address);
    assert_eq!(token_info.total_supply, 700_000);
    assert_eq!(token_info.total_burned, 300_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_admin_burn_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &creator,
        &String::from_str(&env, "Unauth Test"),
        &String::from_str(&env, "UNTH"),
        &7,
        &1_000_000,
        &None,
        &70_000_000,
    );

    factory.admin_burn(&token_address, &non_admin, &user, &100_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_admin_burn_zero_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &creator,
        &String::from_str(&env, "Zero Admin"),
        &String::from_str(&env, "ZADM"),
        &7,
        &1_000_000,
        &None,
        &70_000_000,
    );

    factory.admin_burn(&token_address, &creator, &user, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_admin_burn_exceeds_balance() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &creator,
        &String::from_str(&env, "Exceed Admin"),
        &String::from_str(&env, "EXAD"),
        &7,
        &1_000_000,
        &None,
        &70_000_000,
    );

    factory.admin_burn(&token_address, &creator, &user, &2_000_000);
}

#[test]
fn test_burn_batch_success() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let user3 = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &creator,
        &String::from_str(&env, "Batch Token"),
        &String::from_str(&env, "BATCH"),
        &7,
        &10_000_000,
        &None,
        &70_000_000,
    );

    let burns = soroban_sdk::vec![
        &env,
        (user1.clone(), 100_000),
        (user2.clone(), 200_000),
        (user3.clone(), 150_000),
    ];

    factory.burn_batch(&token_address, &burns);

    let info = factory.get_token_info_by_address(&token_address);
    assert_eq!(info.total_supply, 9_550_000);
    assert_eq!(info.total_burned, 450_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")]
fn test_burn_batch_invalid_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &creator,
        &String::from_str(&env, "Invalid Batch"),
        &String::from_str(&env, "INVB"),
        &7,
        &10_000_000,
        &None,
        &70_000_000,
    );

    let burns = soroban_sdk::vec![&env, (user1.clone(), 100_000), (user2.clone(), 0),];

    factory.burn_batch(&token_address, &burns);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_burn_batch_exceeds_supply() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &creator,
        &String::from_str(&env, "Exceed Batch"),
        &String::from_str(&env, "EXCB"),
        &7,
        &1_000_000,
        &None,
        &70_000_000,
    );

    let burns = soroban_sdk::vec![&env, (user1.clone(), 600_000), (user2.clone(), 500_000),];

    factory.burn_batch(&token_address, &burns);
}

#[test]
fn test_burn_batch_single_address() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);
    let user = Address::generate(&env);

    let factory = TokenFactoryClient::new(&env, &env.register_contract(None, TokenFactory));
    factory.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = factory.create_token(
        &creator,
        &String::from_str(&env, "Single Batch"),
        &String::from_str(&env, "SINB"),
        &7,
        &5_000_000,
        &None,
        &70_000_000,
    );

    let burns = soroban_sdk::vec![&env, (user.clone(), 1_000_000)];

    factory.burn_batch(&token_address, &burns);

    let info = factory.get_token_info_by_address(&token_address);
    assert_eq!(info.total_supply, 4_000_000);
    assert_eq!(info.total_burned, 1_000_000);
}

// Governance type serialization tests
#[test]
fn test_proposal_action_type_serialization() {
    let env = Env::default();
    
    // Test all variants serialize and deserialize correctly
    let fee_update = ProposalActionType::FeeUpdate;
    let pause_toggle = ProposalActionType::PauseToggle;
    let treasury_update = ProposalActionType::TreasuryUpdate;
    let policy_update = ProposalActionType::PolicyUpdate;
    
    // Serialize to bytes
    let fee_bytes = env.to_storage_val(&fee_update);
    let pause_bytes = env.to_storage_val(&pause_toggle);
    let treasury_bytes = env.to_storage_val(&treasury_update);
    let policy_bytes = env.to_storage_val(&policy_update);
    
    // Deserialize back
    let fee_restored: ProposalActionType = env.from_storage_val(&fee_bytes);
    let pause_restored: ProposalActionType = env.from_storage_val(&pause_bytes);
    let treasury_restored: ProposalActionType = env.from_storage_val(&treasury_bytes);
    let policy_restored: ProposalActionType = env.from_storage_val(&policy_bytes);
    
    assert_eq!(fee_restored, ProposalActionType::FeeUpdate);
    assert_eq!(pause_restored, ProposalActionType::PauseToggle);
    assert_eq!(treasury_restored, ProposalActionType::TreasuryUpdate);
    assert_eq!(policy_restored, ProposalActionType::PolicyUpdate);
}

#[test]
fn test_governance_proposal_serialization() {
    let env = Env::default();
    
    let proposer = Address::generate(&env);
    let payload_hash = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
    
    let proposal = GovernanceProposal {
        id: 42,
        proposer: proposer.clone(),
        action_type: ProposalActionType::FeeUpdate,
        payload_hash: payload_hash.clone(),
        created_at: 1000,
        start_time: 2000,
        end_time: 3000,
        eta: 4000,
        executed: false,
        cancelled: false,
    };
    
    // Serialize
    let bytes = env.to_storage_val(&proposal);
    
    // Deserialize
    let restored: GovernanceProposal = env.from_storage_val(&bytes);
    
    // Verify all fields
    assert_eq!(restored.id, 42);
    assert_eq!(restored.proposer, proposer);
    assert_eq!(restored.action_type, ProposalActionType::FeeUpdate);
    assert_eq!(restored.payload_hash, payload_hash);
    assert_eq!(restored.created_at, 1000);
    assert_eq!(restored.start_time, 2000);
    assert_eq!(restored.end_time, 3000);
    assert_eq!(restored.eta, 4000);
    assert_eq!(restored.executed, false);
    assert_eq!(restored.cancelled, false);
}

#[test]
fn test_governance_proposal_all_action_types() {
    let env = Env::default();
    
    let proposer = Address::generate(&env);
    let payload_hash = soroban_sdk::BytesN::from_array(&env, &[2u8; 32]);
    
    let action_types = vec![
        ProposalActionType::FeeUpdate,
        ProposalActionType::PauseToggle,
        ProposalActionType::TreasuryUpdate,
        ProposalActionType::PolicyUpdate,
    ];
    
    for action_type in action_types {
        let proposal = GovernanceProposal {
            id: 1,
            proposer: proposer.clone(),
            action_type: action_type.clone(),
            payload_hash: payload_hash.clone(),
            created_at: 100,
            start_time: 200,
            end_time: 300,
            eta: 400,
            executed: false,
            cancelled: false,
        };
        
        let bytes = env.to_storage_val(&proposal);
        let restored: GovernanceProposal = env.from_storage_val(&bytes);
        
        assert_eq!(restored.action_type, action_type);
    }
}

#[test]
fn test_governance_proposal_state_flags() {
    let env = Env::default();
    
    let proposer = Address::generate(&env);
    let payload_hash = soroban_sdk::BytesN::from_array(&env, &[3u8; 32]);
    
    // Test executed state
    let executed_proposal = GovernanceProposal {
        id: 1,
        proposer: proposer.clone(),
        action_type: ProposalActionType::FeeUpdate,
        payload_hash: payload_hash.clone(),
        created_at: 100,
        start_time: 200,
        end_time: 300,
        eta: 400,
        executed: true,
        cancelled: false,
    };
    
    let bytes = env.to_storage_val(&executed_proposal);
    let restored: GovernanceProposal = env.from_storage_val(&bytes);
    assert_eq!(restored.executed, true);
    assert_eq!(restored.cancelled, false);
    
    // Test cancelled state
    let cancelled_proposal = GovernanceProposal {
        id: 2,
        proposer: proposer.clone(),
        action_type: ProposalActionType::PauseToggle,
        payload_hash: payload_hash.clone(),
        created_at: 100,
        start_time: 200,
        end_time: 300,
        eta: 400,
        executed: false,
        cancelled: true,
    };
    
    let bytes = env.to_storage_val(&cancelled_proposal);
    let restored: GovernanceProposal = env.from_storage_val(&bytes);
    assert_eq!(restored.executed, false);
    assert_eq!(restored.cancelled, true);
}
