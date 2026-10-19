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

fn balance_of(env: &Env, contract_id: &Address, token_index: u32, who: &Address) -> i128 {
    env.as_contract(contract_id, || {
        crate::storage::get_balance(env, token_index, who)
    })
}

#[test]
fn test_set_and_mint_with_allowance() {
    let env = Env::default();
    let (contract_id, client, _admin, creator, idx) = setup(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env);
    let expires = env.ledger().timestamp() + 1000;

    client.set_mint_allowance(&creator, &idx, &spender, &500, &expires);
    assert_eq!(client.get_mint_allowance(&idx, &spender), 500);

    client.mint_with_allowance(&spender, &idx, &to, &200);
    assert_eq!(balance_of(&env, &contract_id, idx, &to), 200);
    assert_eq!(client.get_mint_allowance(&idx, &spender), 300);

    client.mint_with_allowance(&spender, &idx, &to, &300);
    assert_eq!(client.get_mint_allowance(&idx, &spender), 0);
    assert!(client.try_mint_with_allowance(&spender, &idx, &to, &1).is_err());
}

#[test]
fn test_mint_above_allowance_rejected() {
    let env = Env::default();
    let (_c, client, _admin, creator, idx) = setup(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env);
    client.set_mint_allowance(&creator, &idx, &spender, &100, &(env.ledger().timestamp() + 10));

    assert!(client.try_mint_with_allowance(&spender, &idx, &to, &101).is_err());
    assert_eq!(client.get_mint_allowance(&idx, &spender), 100);
}

#[test]
fn test_expired_allowance_rejected() {
    let env = Env::default();
    let (_c, client, _admin, creator, idx) = setup(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env);
    let expires = env.ledger().timestamp() + 100;
    client.set_mint_allowance(&creator, &idx, &spender, &100, &expires);

    env.ledger().with_mut(|li| li.timestamp = expires);
    assert_eq!(client.get_mint_allowance(&idx, &spender), 0);
    assert!(client.try_mint_with_allowance(&spender, &idx, &to, &1).is_err());
}

#[test]
fn test_revoke_allowance() {
    let env = Env::default();
    let (_c, client, _admin, creator, idx) = setup(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env);
    client.set_mint_allowance(&creator, &idx, &spender, &100, &(env.ledger().timestamp() + 10));

    client.revoke_mint_allowance(&creator, &idx, &spender);
    assert_eq!(client.get_mint_allowance(&idx, &spender), 0);
    assert!(client.try_mint_with_allowance(&spender, &idx, &to, &1).is_err());
    assert!(client.try_revoke_mint_allowance(&creator, &idx, &spender).is_err());
}

#[test]
fn test_only_creator_can_set_or_revoke() {
    let env = Env::default();
    let (_c, client, _admin, creator, idx) = setup(&env);
    let other = Address::generate(&env);
    let spender = Address::generate(&env);
    let expires = env.ledger().timestamp() + 10;

    assert!(client.try_set_mint_allowance(&other, &idx, &spender, &100, &expires).is_err());
    client.set_mint_allowance(&creator, &idx, &spender, &100, &expires);
    assert!(client.try_revoke_mint_allowance(&other, &idx, &spender).is_err());
}

#[test]
fn test_invalid_allowance_parameters_rejected() {
    let env = Env::default();
    let (_c, client, _admin, creator, idx) = setup(&env);
    let spender = Address::generate(&env);
    let now = env.ledger().timestamp();

    assert!(client.try_set_mint_allowance(&creator, &idx, &spender, &0, &(now + 10)).is_err());
    assert!(client.try_set_mint_allowance(&creator, &idx, &spender, &-5, &(now + 10)).is_err());
    assert!(client.try_set_mint_allowance(&creator, &idx, &spender, &10, &now).is_err());
    assert!(client.try_set_mint_allowance(&creator, &99, &spender, &10, &(now + 10)).is_err());
}

#[test]
fn test_allowance_invariant_over_many_mints() {
    // Property-style: for any sequence of mints, minted + remaining == granted.
    let env = Env::default();
    let (contract_id, client, _admin, creator, idx) = setup(&env);
    let spender = Address::generate(&env);
    let to = Address::generate(&env);
    let granted: i128 = 1000;
    client.set_mint_allowance(&creator, &idx, &spender, &granted, &(env.ledger().timestamp() + 10));

    let mut minted: i128 = 0;
    for amount in [1_i128, 7, 13, 100, 250, 5000, 0, 629, 1] {
        let res = client.try_mint_with_allowance(&spender, &idx, &to, &amount);
        if res.is_ok() {
            minted += amount;
        }
        assert_eq!(
            minted + client.get_mint_allowance(&idx, &spender),
            granted
        );
        assert_eq!(balance_of(&env, &contract_id, idx, &to), minted);
    }
}
