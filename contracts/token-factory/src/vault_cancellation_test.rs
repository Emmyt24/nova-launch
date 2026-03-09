#![cfg(test)]

use crate::{
    types::{DataKey, TokenInfo, VaultStatus},
    TokenFactory, TokenFactoryClient,
};
use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, BytesN, Env, String,
};

fn setup() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &1_000_000, &500_000);

    let creator = Address::generate(&env);
    let owner = Address::generate(&env);
    let token = Address::generate(&env);
    let token_info = TokenInfo {
        address: token.clone(),
        creator: creator.clone(),
        name: String::from_str(&env, "Vault Token"),
        symbol: String::from_str(&env, "VLT"),
        decimals: 7,
        total_supply: 1_000_000_000,
        initial_supply: 1_000_000_000,
        max_supply: None,
        total_burned: 0,
        burn_count: 0,
        metadata_uri: None,
        created_at: 0,
        is_paused: false,
        clawback_enabled: false,
        freeze_enabled: false,
    };

    env.as_contract(&contract_id, || {
        crate::storage::set_token_info_by_address(&env, &token, &token_info);
    });

    (env, contract_id, admin, creator, owner, token)
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_cancel_vault_rejects_unauthorized_actor() {
    let (env, contract_id, _admin, creator, owner, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);
    let attacker = Address::generate(&env);
    let no_milestone = BytesN::from_array(&env, &[0u8; 32]);

    let vault_id = client.create_vault(&creator, &token, &owner, &500_000, &1, &no_milestone);
    let _ = client.cancel_vault(&vault_id, &attacker);
}

#[test]
fn test_cancel_vault_emits_event_and_marks_cancelled() {
    let (env, contract_id, _admin, creator, owner, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);
    let no_milestone = BytesN::from_array(&env, &[0u8; 32]);

    let vault_id = client.create_vault(&creator, &token, &owner, &500_000, &1, &no_milestone);
    let before = env.events().all().len();
    client.cancel_vault(&vault_id, &creator);

    let vault = client.get_vault(&vault_id);
    assert_eq!(vault.status, VaultStatus::Cancelled);

    let events = env.events().all();
    assert_eq!(events.len(), before + 1);
    let last = events.get(events.len() - 1).unwrap();
    let topics = last.1;
    let first_topic: soroban_sdk::Symbol =
        soroban_sdk::FromVal::from_val(&env, &topics.get(0).unwrap());
    assert_eq!(first_topic, soroban_sdk::symbol_short!("vlt_cnl"));
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_claim_rejected_after_cancel() {
    let (env, contract_id, _admin, creator, owner, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);
    let no_milestone = BytesN::from_array(&env, &[0u8; 32]);

    let vault_id = client.create_vault(&creator, &token, &owner, &500_000, &1, &no_milestone);
    client.cancel_vault(&vault_id, &creator);

    let _ = client.claim_vault(&vault_id, &owner);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_cancel_partially_claimed_vault_preserves_claimed_amount() {
    let (env, contract_id, _admin, creator, owner, token) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);
    let no_milestone = BytesN::from_array(&env, &[0u8; 32]);

    let vault_id = client.create_vault(&creator, &token, &owner, &500_000, &1, &no_milestone);
    let mut vault = client.get_vault(&vault_id);
    vault.claimed_amount = 200_000;

    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&DataKey::Vault(vault_id), &vault);
    });

    client.cancel_vault(&vault_id, &creator);
    let cancelled = client.get_vault(&vault_id);
    assert_eq!(cancelled.status, VaultStatus::Cancelled);
    assert_eq!(cancelled.claimed_amount, 200_000);

    let _ = client.claim_vault(&vault_id, &owner);
}
