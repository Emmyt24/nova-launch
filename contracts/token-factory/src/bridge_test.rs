#![cfg(test)]

use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Bytes, Env, String,
};

/// Registers the factory (initialized) and a real Stellar Asset Contract
/// token, so `lock_tokens` / `release_tokens` exercise genuine token
/// transfers rather than internal accounting.
///
/// Returns `(env, contract_id, admin, token)`.
fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &1_000_000, &500_000);

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(token_admin).address();

    (env, contract_id, admin, token)
}

fn destination(env: &Env, chain: &str, addr_byte: u8) -> (String, Bytes) {
    (
        String::from_str(env, chain),
        Bytes::from_array(env, &[addr_byte; 20]),
    )
}

#[test]
fn test_lock_release_happy_path() {
    let (env, contract_id, admin, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);
    let token_client = TokenClient::new(&env, &token);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let amount = 1_000_000_i128;
    StellarAssetClient::new(&env, &token).mint(&sender, &amount);

    let (destination_chain, destination_address) = destination(&env, "ethereum", 0xAB);

    let nonce = client.lock_tokens(
        &sender,
        &token,
        &amount,
        &destination_chain,
        &destination_address,
    );

    // Tokens are escrowed in contract custody.
    assert_eq!(token_client.balance(&sender), 0);
    assert_eq!(token_client.balance(&contract_id), amount);

    let lock = client.get_bridge_lock(&nonce).unwrap();
    assert_eq!(lock.nonce, nonce);
    assert_eq!(lock.sender, sender);
    assert_eq!(lock.token, token);
    assert_eq!(lock.amount, amount);
    assert_eq!(lock.destination_chain, destination_chain);
    assert_eq!(lock.destination_address, destination_address);
    assert!(!client.is_bridge_nonce_released(&nonce));

    client.release_tokens(&admin, &nonce, &token, &recipient, &amount);

    assert_eq!(token_client.balance(&recipient), amount);
    assert_eq!(token_client.balance(&contract_id), 0);
    assert!(client.is_bridge_nonce_released(&nonce));
}

#[test]
fn test_lock_tokens_nonces_increment_monotonically() {
    let (env, contract_id, _admin, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&sender, &10_000);
    let (destination_chain, destination_address) = destination(&env, "ethereum", 0x01);

    let nonce_a = client.lock_tokens(
        &sender,
        &token,
        &1_000,
        &destination_chain,
        &destination_address,
    );
    let nonce_b = client.lock_tokens(
        &sender,
        &token,
        &2_000,
        &destination_chain,
        &destination_address,
    );

    assert_eq!(nonce_b, nonce_a + 1, "nonces must be assigned monotonically");
}

#[test]
fn test_lock_tokens_rejects_non_positive_amount() {
    let (env, contract_id, _admin, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);
    let sender = Address::generate(&env);
    let (destination_chain, destination_address) = destination(&env, "ethereum", 0x02);

    let result = client.try_lock_tokens(
        &sender,
        &token,
        &0_i128,
        &destination_chain,
        &destination_address,
    );
    assert!(result.is_err(), "zero amount must be rejected");

    let result = client.try_lock_tokens(
        &sender,
        &token,
        &(-1_i128),
        &destination_chain,
        &destination_address,
    );
    assert!(result.is_err(), "negative amount must be rejected");
}

#[test]
fn test_lock_tokens_rejects_empty_destination() {
    let (env, contract_id, _admin, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);
    let sender = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&sender, &1_000);

    let empty_chain = String::from_str(&env, "");
    let (_, destination_address) = destination(&env, "ethereum", 0x03);
    let result = client.try_lock_tokens(
        &sender,
        &token,
        &1_000_i128,
        &empty_chain,
        &destination_address,
    );
    assert!(result.is_err(), "empty destination chain must be rejected");

    let (destination_chain, _) = destination(&env, "ethereum", 0x03);
    let empty_address = Bytes::new(&env);
    let result = client.try_lock_tokens(
        &sender,
        &token,
        &1_000_i128,
        &destination_chain,
        &empty_address,
    );
    assert!(result.is_err(), "empty destination address must be rejected");
}

#[test]
fn test_lock_tokens_rejects_when_contract_paused() {
    let (env, contract_id, admin, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);
    let sender = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&sender, &1_000);
    client.pause(&admin);

    let (destination_chain, destination_address) = destination(&env, "ethereum", 0x04);
    let result = client.try_lock_tokens(
        &sender,
        &token,
        &1_000_i128,
        &destination_chain,
        &destination_address,
    );
    assert!(result.is_err(), "locking must be rejected while the contract is paused");
}

#[test]
fn test_nonce_replay_rejected_even_with_different_parameters() {
    let (env, contract_id, admin, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let attacker_recipient = Address::generate(&env);
    let amount = 500_000_i128;
    StellarAssetClient::new(&env, &token).mint(&sender, &amount);

    let (destination_chain, destination_address) = destination(&env, "ethereum", 0x05);
    let nonce = client.lock_tokens(
        &sender,
        &token,
        &amount,
        &destination_chain,
        &destination_address,
    );

    client.release_tokens(&admin, &nonce, &token, &recipient, &amount);

    // A replay of the same nonce must be rejected even when the attacker
    // supplies different recipient/amount parameters — the nonce alone
    // gates replay, independent of the payload.
    let result = client.try_release_tokens(&admin, &nonce, &token, &attacker_recipient, &1_i128);
    assert!(
        result.is_err(),
        "replayed nonce must be rejected regardless of parameters"
    );
}

#[test]
fn test_double_release_rejected() {
    let (env, contract_id, admin, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let amount = 750_000_i128;
    StellarAssetClient::new(&env, &token).mint(&sender, &amount);

    let (destination_chain, destination_address) = destination(&env, "ethereum", 0x06);
    let nonce = client.lock_tokens(
        &sender,
        &token,
        &amount,
        &destination_chain,
        &destination_address,
    );

    client.release_tokens(&admin, &nonce, &token, &recipient, &amount);

    let result = client.try_release_tokens(&admin, &nonce, &token, &recipient, &amount);
    assert!(result.is_err(), "double release of the same nonce must fail");

    // Recipient balance must reflect exactly one release, not two.
    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&recipient), amount);
}

#[test]
fn test_release_tokens_unauthorized_rejected() {
    let (env, contract_id, _admin, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let attacker = Address::generate(&env);
    let amount = 250_000_i128;
    StellarAssetClient::new(&env, &token).mint(&sender, &amount);

    let (destination_chain, destination_address) = destination(&env, "ethereum", 0x07);
    let nonce = client.lock_tokens(
        &sender,
        &token,
        &amount,
        &destination_chain,
        &destination_address,
    );

    let result = client.try_release_tokens(&attacker, &nonce, &token, &recipient, &amount);
    assert!(result.is_err(), "a non-admin caller must not be able to release");
    assert!(
        !client.is_bridge_nonce_released(&nonce),
        "an unauthorized attempt must not consume the nonce"
    );

    // The legitimate admin can still release afterwards.
    client.release_tokens(&_admin, &nonce, &token, &recipient, &amount);
    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&recipient), amount);
}

#[test]
fn test_release_tokens_rejects_unknown_nonce_replay_flag_but_moves_funds() {
    // release_tokens does not require a matching local BridgeLock (by
    // design — see bridge.rs module docs on the trust model), so an admin
    // can release against a nonce this instance never locked, as long as
    // it hasn't been released before.
    let (env, contract_id, admin, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let contract_funder = Address::generate(&env);
    let recipient = Address::generate(&env);
    let amount = 300_000_i128;
    StellarAssetClient::new(&env, &token).mint(&contract_id, &amount);
    let _ = contract_funder;

    let unseen_nonce = 42_u64;
    assert!(client.get_bridge_lock(&unseen_nonce).is_none());

    client.release_tokens(&admin, &unseen_nonce, &token, &recipient, &amount);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&recipient), amount);
    assert!(client.is_bridge_nonce_released(&unseen_nonce));
}

#[test]
fn test_release_tokens_rejects_non_positive_amount() {
    let (env, contract_id, admin, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);
    let recipient = Address::generate(&env);

    let result = client.try_release_tokens(&admin, &0_u64, &token, &recipient, &0_i128);
    assert!(result.is_err(), "zero amount release must be rejected");
}

#[test]
fn test_bridge_lock_query_returns_none_for_unknown_nonce() {
    let (env, contract_id, _admin, _token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    assert!(client.get_bridge_lock(&999_u64).is_none());
    assert!(!client.is_bridge_nonce_released(&999_u64));
}
