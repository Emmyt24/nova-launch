#![cfg(test)]

use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, String,
};

fn setup<'a>(env: &'a Env) -> (Address, TokenFactoryClient<'a>, Address, Address, u32) {
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let creator = Address::generate(env);
    client.initialize(&admin, &treasury, &100_i128, &50_i128);

    let token_index = env.as_contract(&contract_id, || {
        let token_address = Address::generate(env);
        let info = crate::types::TokenInfo {
            address: token_address.clone(),
            creator: creator.clone(),
            name: String::from_str(env, "Test Token"),
            symbol: String::from_str(env, "TST"),
            decimals: 7,
            total_supply: 1_000_000,
            initial_supply: 1_000_000,
            total_burned: 0,
            burn_count: 0,
            metadata_uri: None,
            metadata_version: 0,
            created_at: env.ledger().timestamp(),
            clawback_enabled: false,
        };
        let idx = crate::storage::get_token_count(env);
        crate::storage::set_token_info(env, idx, &info);
        crate::storage::set_token_info_by_address(env, &token_address, &info);
        crate::storage::increment_token_count(env);
        crate::storage::set_balance(env, idx, &creator, 1_000_000);
        idx
    });
    (contract_id, client, admin, creator, token_index)
}

#[test]
fn test_burn_unlimited_by_default() {
    let env = Env::default();
    let (_c, client, _admin, creator, idx) = setup(&env);
    assert_eq!(client.get_burn_rate_limit(&idx), None);
    client.burn(&creator, &idx, &900_000);
}

#[test]
fn test_burn_within_cap_and_over_cap_rejected() {
    let env = Env::default();
    let (_c, client, admin, creator, idx) = setup(&env);
    client.set_burn_rate_limit(&admin, &idx, &100, &1000);
    assert_eq!(client.get_burn_rate_limit(&idx), Some((100, 1000)));

    client.burn(&creator, &idx, &600);
    client.burn(&creator, &idx, &400);
    assert_eq!(client.get_burn_window_usage(&idx), 1000);
    assert!(client.try_burn(&creator, &idx, &1).is_err());
    assert_eq!(client.get_burn_window_usage(&idx), 1000);
}

#[test]
fn test_single_burn_over_cap_rejected() {
    let env = Env::default();
    let (_c, client, admin, creator, idx) = setup(&env);
    client.set_burn_rate_limit(&admin, &idx, &100, &1000);
    assert!(client.try_burn(&creator, &idx, &1001).is_err());
    assert_eq!(client.get_burn_window_usage(&idx), 0);
}

#[test]
fn test_window_rolls_over() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.sequence_number = 1000);
    let (_c, client, admin, creator, idx) = setup(&env);
    client.set_burn_rate_limit(&admin, &idx, &100, &500);

    client.burn(&creator, &idx, &500);
    assert!(client.try_burn(&creator, &idx, &1).is_err());

    // Same window (ledgers 1000..1099): still limited.
    env.ledger().with_mut(|li| li.sequence_number = 1099);
    assert!(client.try_burn(&creator, &idx, &1).is_err());

    // Next window: cap resets.
    env.ledger().with_mut(|li| li.sequence_number = 1100);
    assert_eq!(client.get_burn_window_usage(&idx), 0);
    client.burn(&creator, &idx, &500);
}

#[test]
fn test_only_admin_can_configure() {
    let env = Env::default();
    let (_c, client, _admin, creator, idx) = setup(&env);
    assert!(client.try_set_burn_rate_limit(&creator, &idx, &100, &1000).is_err());
    assert_eq!(client.get_burn_rate_limit(&idx), None);
}

#[test]
fn test_invalid_config_rejected() {
    let env = Env::default();
    let (_c, client, admin, _creator, idx) = setup(&env);
    assert!(client.try_set_burn_rate_limit(&admin, &idx, &0, &1000).is_err());
    assert!(client.try_set_burn_rate_limit(&admin, &idx, &100, &-1).is_err());
    assert!(client.try_set_burn_rate_limit(&admin, &99, &100, &1000).is_err());
}

#[test]
fn test_clearing_limit_removes_cap() {
    let env = Env::default();
    let (_c, client, admin, creator, idx) = setup(&env);
    client.set_burn_rate_limit(&admin, &idx, &100, &10);
    assert!(client.try_burn(&creator, &idx, &11).is_err());

    client.set_burn_rate_limit(&admin, &idx, &100, &0);
    assert_eq!(client.get_burn_rate_limit(&idx), None);
    client.burn(&creator, &idx, &11);
}

#[test]
fn test_usage_never_exceeds_cap() {
    // Property-style: whatever the sequence, window usage stays <= cap.
    let env = Env::default();
    let (_c, client, admin, creator, idx) = setup(&env);
    let cap: i128 = 300;
    client.set_burn_rate_limit(&admin, &idx, &50, &cap);
    for amount in [10_i128, 90, 150, 51, 49, 1, 300, 7] {
        let _ = client.try_burn(&creator, &idx, &amount);
        assert!(client.get_burn_window_usage(&idx) <= cap);
    }
}
