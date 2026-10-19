//! Batch token creation tests.
//!
//! Covers batch creation with allowlist (whitelist) mode enabled and verifies
//! that the read-only fee quote function matches the actual charges applied
//! during batch token creation.

use crate::{Error, TokenFactory, TokenFactoryClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, String, Vec,
};

fn setup() -> (Env, TokenFactoryClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &1_000_000, &500_000);

    (env, client, admin)
}

fn make_options(
    env: &Env,
    count: u32,
    allowlist_mode: bool,
) -> Vec<crate::types::TokenCreationOptions> {
    let mut options = Vec::new(env);
    for i in 0..count {
        options.push_back(crate::types::TokenCreationOptions {
            name: String::from_str(env, "Batch Token"),
            symbol: String::from_str(env, "BATCH"),
            decimals: 7,
            initial_supply: 1_000_000,
            allowlist_mode,
            metadata_uri: String::from_str(env, "ipfs://batch"),
            salt: i as u64,
        });
    }
    options
}

#[test]
fn test_batch_create_with_allowlist_mode() {
    let (env, client, admin) = setup();

    let options = make_options(&env, 3, true);
    let creator = Address::generate(&env);

    let tokens = client.batch_create_tokens(&creator, &options);
    assert_eq!(tokens.len(), 3);

    for token_addr in tokens.iter() {
        let info = client.get_token_info(&token_addr);
        assert!(info.allowlist_mode, "allowlist mode should be enabled");
        assert_eq!(info.creator, creator);
        assert_eq!(info.admin, admin);
    }
}

#[test]
fn test_batch_create_without_allowlist_mode() {
    let (env, client, _admin) = setup();

    let options = make_options(&env, 2, false);
    let creator = Address::generate(&env);

    let tokens = client.batch_create_tokens(&creator, &options);
    assert_eq!(tokens.len(), 2);

    for token_addr in tokens.iter() {
        let info = client.get_token_info(&token_addr);
        assert!(!info.allowlist_mode, "allowlist mode should be disabled");
    }
}

#[test]
fn test_batch_create_mixed_allowlist_modes() {
    let (env, client, _admin) = setup();

    let mut options = Vec::new(&env);
    options.push_back(crate::types::TokenCreationOptions {
        name: String::from_str(&env, "Restricted"),
        symbol: String::from_str(&env, "RST"),
        decimals: 7,
        initial_supply: 1_000,
        allowlist_mode: true,
        metadata_uri: String::from_str(&env, "ipfs://rst"),
        salt: 1,
    });
    options.push_back(crate::types::TokenCreationOptions {
        name: String::from_str(&env, "Open"),
        symbol: String::from_str(&env, "OPN"),
        decimals: 7,
        initial_supply: 1_000,
        allowlist_mode: false,
        metadata_uri: String::from_str(&env, "ipfs://opn"),
        salt: 2,
    });

    let creator = Address::generate(&env);
    let tokens = client.batch_create_tokens(&creator, &options);
    assert_eq!(tokens.len(), 2);

    let first = client.get_token_info(&tokens.get(0).unwrap());
    let second = client.get_token_info(&tokens.get(1).unwrap());
    assert!(first.allowlist_mode);
    assert!(!second.allowlist_mode);
}

#[test]
fn test_batch_fee_quote_matches_actual_charge() {
    let (env, client, _admin) = setup();

    let creator = Address::generate(&env);
    let options = make_options(&env, 4, false);

    let quote = client.quote_batch_creation_fee(&options);
    let balance_before = client.get_balance(&creator);

    client.batch_create_tokens(&creator, &options);

    let balance_after = client.get_balance(&creator);
    let charged = balance_before - balance_after;

    assert_eq!(
        quote, charged,
        "quoted batch fee must equal actual charge"
    );
}

#[test]
fn test_batch_fee_quote_matches_actual_charge_with_allowlist() {
    let (env, client, _admin) = setup();

    let creator = Address::generate(&env);
    let options = make_options(&env, 3, true);

    let quote = client.quote_batch_creation_fee(&options);
    let balance_before = client.get_balance(&creator);

    client.batch_create_tokens(&creator, &options);

    let balance_after = client.get_balance(&creator);
    let charged = balance_before - balance_after;

    assert_eq!(
        quote, charged,
        "quoted batch fee must equal actual charge with allowlist mode"
    );
}

#[test]
fn test_batch_fee_quote_single_matches_single_creation() {
    let (env, client, _admin) = setup();

    let creator = Address::generate(&env);
    let options = make_options(&env, 1, false);

    let quote = client.quote_batch_creation_fee(&options);
    let balance_before = client.get_balance(&creator);

    client.batch_create_tokens(&creator, &options);

    let balance_after = client.get_balance(&creator);
    assert_eq!(quote, balance_before - balance_after);
}

#[test]
fn test_batch_fee_quote_empty_options() {
    let (env, client, _admin) = setup();

    let options: Vec<crate::types::TokenCreationOptions> = Vec::new(&env);
    let quote = client.quote_batch_creation_fee(&options);
    assert_eq!(quote, 0, "empty batch should quote zero fee");
}

#[test]
fn test_batch_create_insufficient_funds() {
    let (env, client, _admin) = setup();

    let creator = Address::generate(&env);
    let options = make_options(&env, 5, false);

    let quote = client.quote_batch_creation_fee(&options);
    assert!(quote > 0);

    // Drain the creator's balance to force a failure.
    let balance = client.get_balance(&creator);
    if balance > 0 {
        client.withdraw(&creator, &balance);
    }

    let result = client.try_batch_create_tokens(&creator, &options);
    assert_eq!(result, Err(Ok(Error::InsufficientBalance)));
}

#[test]
fn test_batch_allowlist_admin_management() {
    let (env, client, _admin) = setup();

    let creator = Address::generate(&env);
    let options = make_options(&env, 1, true);
    let tokens = client.batch_create_tokens(&creator, &options);
    let token = tokens.get(0).unwrap();

    let allowed = Address::generate(&env);
    client.add_to_allowlist(&token, &allowed);
    assert!(client.is_allowlisted(&token, &allowed));

    client.remove_from_allowlist(&token, &allowed);
    assert!(!client.is_allowlisted(&token, &allowed));
}