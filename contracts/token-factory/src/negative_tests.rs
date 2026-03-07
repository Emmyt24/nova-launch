#![cfg(test)]

use soroban_sdk::{
    testutils::Address as _,
    vec, Address, Env, String, Vec,
};

use crate::{TokenFactory, TokenFactoryClient, Error};

// ─────────────────────────────────────────────────────────────────────────────
// Shared test setup
// Builds a fully initialized factory with an admin, treasury, and a plain user.
// Re-used across every test to avoid boilerplate.
// ─────────────────────────────────────────────────────────────────────────────

struct TestSetup {
    env: Env,
    client: TokenFactoryClient<'static>,
    admin: Address,
    treasury: Address,
    user: Address,
    base_fee: i128,
    metadata_fee: i128,
}

impl TestSetup {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);

        let base_fee: i128 = 70_000_000;
        let metadata_fee: i128 = 30_000_000;

        // initialize returns () so no unwrap needed
        client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

        Self { env, client, admin, treasury, user, base_fee, metadata_fee }
    }

    fn token_name(&self) -> String {
        String::from_str(&self.env, "TestToken")
    }

    fn token_symbol(&self) -> String {
        String::from_str(&self.env, "TST")
    }

    // Deploys a token and returns its index in the factory registry.
    // create_token returns Address, not Result, so no unwrap needed.
    fn deploy_token(&self) -> u32 {
        self.client.create_token(
            &self.user,
            &self.token_name(),
            &self.token_symbol(),
            &7u32,
            &1_000_000_000i128,
            &None,
            &self.base_fee,
        );
        self.client.get_token_count() - 1
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// initialize
// ─────────────────────────────────────────────────────────────────────────────

// Calling initialize a second time must fail — the contract is already set up.
#[test]
fn initialize_already_initialized_returns_error() {
    let setup = TestSetup::new();
    let other_admin = Address::generate(&setup.env);
    let other_treasury = Address::generate(&setup.env);

    let result = setup.client.try_initialize(
        &other_admin,
        &other_treasury,
        &setup.base_fee,
        &setup.metadata_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::AlreadyInitialized);
}

// A negative base fee makes no sense and must be rejected at initialization.
#[test]
fn initialize_negative_base_fee_returns_invalid_parameters() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    let result = client.try_initialize(&admin, &treasury, &-1i128, &30_000_000i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// A negative metadata fee must also be rejected at initialization.
#[test]
fn initialize_negative_metadata_fee_returns_invalid_parameters() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    let result = client.try_initialize(&admin, &treasury, &70_000_000i128, &-1i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// ─────────────────────────────────────────────────────────────────────────────
// create_token
// ─────────────────────────────────────────────────────────────────────────────

// Paying one stroop less than the required base fee must be rejected.
#[test]
fn create_token_insufficient_fee_returns_error() {
    let setup = TestSetup::new();
    let low_fee = setup.base_fee - 1;

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &1_000_000_000i128,
        &None,
        &low_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InsufficientFee);
}

// Paying zero fee must be rejected regardless of the configured base fee.
#[test]
fn create_token_zero_fee_returns_insufficient_fee() {
    let setup = TestSetup::new();

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &1_000_000_000i128,
        &None,
        &0i128,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InsufficientFee);
}

// An empty token name (zero length) violates the 1–64 character rule.
#[test]
fn create_token_empty_name_returns_invalid_parameters() {
    let setup = TestSetup::new();
    let empty_name = String::from_str(&setup.env, "");

    let result = setup.client.try_create_token(
        &setup.user,
        &empty_name,
        &setup.token_symbol(),
        &7u32,
        &1_000_000_000i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// An empty token symbol (zero length) violates the 1–12 character rule.
#[test]
fn create_token_empty_symbol_returns_invalid_parameters() {
    let setup = TestSetup::new();
    let empty_symbol = String::from_str(&setup.env, "");

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &empty_symbol,
        &7u32,
        &1_000_000_000i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// A zero initial supply means no tokens would be minted — not a valid token.
#[test]
fn create_token_zero_initial_supply_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &0i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// A negative initial supply is nonsensical and must be rejected.
#[test]
fn create_token_negative_initial_supply_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &-1i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// Decimals above 18 exceed the Stellar standard and must be rejected.
#[test]
fn create_token_decimals_out_of_range_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &19u32,
        &1_000_000_000i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// An empty string supplied as the metadata URI must be rejected.
#[test]
fn create_token_empty_metadata_uri_returns_invalid_parameters() {
    let setup = TestSetup::new();
    let empty_uri = Some(String::from_str(&setup.env, ""));

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &1_000_000_000i128,
        &empty_uri,
        &(setup.base_fee + setup.metadata_fee),
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// ─────────────────────────────────────────────────────────────────────────────
// burn
// ─────────────────────────────────────────────────────────────────────────────

// Burning zero tokens is a no-op that the contract must explicitly reject.
#[test]
fn burn_zero_amount_returns_invalid_burn_amount() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();

    let result = setup.client.try_burn(&setup.user, &token_index, &0i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidBurnAmount);
}

// A negative burn amount is undefined behaviour and must be rejected.
#[test]
fn burn_negative_amount_returns_invalid_burn_amount() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();

    let result = setup.client.try_burn(&setup.user, &token_index, &-1i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidBurnAmount);
}

// Attempting to burn more than the holder's balance must be rejected.
#[test]
fn burn_exceeds_balance_returns_error() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let too_much: i128 = 1_000_000_001; // one above the initial supply

    let result = setup.client.try_burn(&setup.user, &token_index, &too_much);
    assert_eq!(result.unwrap_err().unwrap(), Error::BurnAmountExceedsBalance);
}

// Referencing a token index that was never created must return TokenNotFound.
#[test]
fn burn_token_not_found_returns_error() {
    let setup = TestSetup::new();

    let result = setup.client.try_burn(&setup.user, &9999u32, &100i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::TokenNotFound);
}

// ─────────────────────────────────────────────────────────────────────────────
// batch_burn
// ─────────────────────────────────────────────────────────────────────────────

// An empty burn list provides nothing to process and must be rejected.
#[test]
fn batch_burn_empty_list_returns_invalid_parameters() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let burns: Vec<(Address, i128)> = Vec::new(&setup.env);

    let result = setup.client.try_batch_burn(&setup.admin, &token_index, &burns);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// Only the factory admin may invoke batch_burn; any other caller must be rejected.
#[test]
fn batch_burn_unauthorized_non_admin_returns_error() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let stranger = Address::generate(&setup.env);
    let burns = vec![&setup.env, (setup.user.clone(), 100i128)];

    let result = setup.client.try_batch_burn(&stranger, &token_index, &burns);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// Providing a non-existent token index to batch_burn must return TokenNotFound.
#[test]
fn batch_burn_token_not_found_returns_error() {
    let setup = TestSetup::new();
    let burns = vec![&setup.env, (setup.user.clone(), 100i128)];

    let result = setup.client.try_batch_burn(&setup.admin, &9999u32, &burns);
    assert_eq!(result.unwrap_err().unwrap(), Error::TokenNotFound);
}

// ─────────────────────────────────────────────────────────────────────────────
// update_fees
// ─────────────────────────────────────────────────────────────────────────────

// A non-admin address must not be able to change fees.
#[test]
fn update_fees_unauthorized_non_admin_returns_error() {
    let setup = TestSetup::new();
    let stranger = Address::generate(&setup.env);

    let result = setup.client.try_update_fees(&stranger, &Some(80_000_000i128), &None);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// A negative base fee must be rejected even when sent by the admin.
#[test]
fn update_fees_negative_base_fee_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_update_fees(&setup.admin, &Some(-1i128), &None);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// A negative metadata fee must be rejected even when sent by the admin.
#[test]
fn update_fees_negative_metadata_fee_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_update_fees(&setup.admin, &None, &Some(-1i128));
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// Passing None for both fees means no change was requested — must be rejected.
#[test]
fn update_fees_both_none_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_update_fees(&setup.admin, &None, &None);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// ─────────────────────────────────────────────────────────────────────────────
// get_token_info
// ─────────────────────────────────────────────────────────────────────────────

// Querying index 0 when no tokens have been deployed must return TokenNotFound.
#[test]
fn get_token_info_out_of_bounds_index_returns_token_not_found() {
    let setup = TestSetup::new();

    let result = setup.client.try_get_token_info(&0u32);
    assert_eq!(result.unwrap_err().unwrap(), Error::TokenNotFound);
}

// Querying u32::MAX when only one token exists must return TokenNotFound.
#[test]
fn get_token_info_large_index_returns_token_not_found() {
    let setup = TestSetup::new();
    setup.deploy_token();

    let result = setup.client.try_get_token_info(&u32::MAX);
    assert_eq!(result.unwrap_err().unwrap(), Error::TokenNotFound);
}

// ─────────────────────────────────────────────────────────────────────────────
// mint
// ─────────────────────────────────────────────────────────────────────────────

// Only the token creator may mint; any other address must be rejected.
#[test]
fn mint_unauthorized_non_creator_returns_error() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let stranger = Address::generate(&setup.env);

    let result = setup.client.try_mint(&stranger, &token_index, &setup.user, &1_000i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// Minting to a non-existent token index must return TokenNotFound.
#[test]
fn mint_token_not_found_returns_error() {
    let setup = TestSetup::new();

    let result = setup.client.try_mint(&setup.user, &9999u32, &setup.user, &1_000i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::TokenNotFound);
}

// ─────────────────────────────────────────────────────────────────────────────
// pause / unpause
// ─────────────────────────────────────────────────────────────────────────────

// A non-admin address must not be able to pause the contract.
#[test]
fn pause_unauthorized_non_admin_returns_error() {
    let setup = TestSetup::new();
    let stranger = Address::generate(&setup.env);

    let result = setup.client.try_pause(&stranger);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// A non-admin address must not be able to unpause the contract.
// pause() returns () so it is called directly without unwrap.
#[test]
fn unpause_unauthorized_non_admin_returns_error() {
    let setup = TestSetup::new();
    setup.client.pause(&setup.admin);
    let stranger = Address::generate(&setup.env);

    let result = setup.client.try_unpause(&stranger);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// ─────────────────────────────────────────────────────────────────────────────
// transfer_admin
// ─────────────────────────────────────────────────────────────────────────────

// A non-admin address must not be able to transfer admin rights.
#[test]
fn transfer_admin_unauthorized_returns_error() {
    let setup = TestSetup::new();
    let stranger = Address::generate(&setup.env);
    let new_admin = Address::generate(&setup.env);

    let result = setup.client.try_transfer_admin(&stranger, &new_admin);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// Transferring admin to the same address that already holds it must be rejected.
#[test]
fn transfer_admin_same_address_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_transfer_admin(&setup.admin, &setup.admin);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// ─────────────────────────────────────────────────────────────────────────────
// contract paused guard
// ─────────────────────────────────────────────────────────────────────────────

// When the contract is paused, create_token must return ContractPaused
// regardless of whether the other parameters are valid.
// pause() returns () so it is called directly without unwrap.
#[test]
fn create_token_paused_contract_returns_error() {
    let setup = TestSetup::new();
    setup.client.pause(&setup.admin);

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &1_000_000_000i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::ContractPaused);
}