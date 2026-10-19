#![cfg(test)]

use crate::batch_transfer::{batch_transfer, MAX_BATCH_TRANSFER_SIZE};
use crate::types::Error;
use crate::TokenFactory;
use soroban_sdk::{
    testutils::{Address as _, Events},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Vec,
};

fn setup(balance: i128) -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);
    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(token_admin).address();
    let sender = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&sender, &balance);
    let other = Address::generate(&env);
    (env, contract_id, token, sender, other)
}

#[test]
fn test_batch_transfer_success_and_events() {
    let (env, contract_id, token, sender, r1) = setup(1_000);
    let r2 = Address::generate(&env);
    let mut transfers: Vec<(Address, i128)> = Vec::new(&env);
    transfers.push_back((r1.clone(), 100));
    transfers.push_back((r2.clone(), 250));

    let n = env
        .as_contract(&contract_id, || batch_transfer(&env, &sender, &token, &transfers))
        .unwrap();
    assert_eq!(n, 2);

    let client = TokenClient::new(&env, &token);
    assert_eq!(client.balance(&r1), 100);
    assert_eq!(client.balance(&r2), 250);
    assert_eq!(client.balance(&sender), 650);
    // 2 per-item events + 1 summary (token transfer events are also recorded).
    assert!(env.events().all().len() >= 3);
}

#[test]
fn test_batch_transfer_rejects_empty_and_oversized() {
    let (env, contract_id, token, sender, r1) = setup(1_000_000);
    let empty: Vec<(Address, i128)> = Vec::new(&env);
    let res = env.as_contract(&contract_id, || batch_transfer(&env, &sender, &token, &empty));
    assert_eq!(res, Err(Error::InvalidParameters));

    let mut big: Vec<(Address, i128)> = Vec::new(&env);
    for _ in 0..(MAX_BATCH_TRANSFER_SIZE + 1) {
        big.push_back((r1.clone(), 1));
    }
    let res = env.as_contract(&contract_id, || batch_transfer(&env, &sender, &token, &big));
    assert_eq!(res, Err(Error::BatchTooLarge));
}

#[test]
fn test_batch_transfer_max_size_allowed() {
    let (env, contract_id, token, sender, r1) = setup(1_000_000);
    let mut batch: Vec<(Address, i128)> = Vec::new(&env);
    for _ in 0..MAX_BATCH_TRANSFER_SIZE {
        batch.push_back((r1.clone(), 1));
    }
    let n = env
        .as_contract(&contract_id, || batch_transfer(&env, &sender, &token, &batch))
        .unwrap();
    assert_eq!(n, MAX_BATCH_TRANSFER_SIZE);
    assert_eq!(
        TokenClient::new(&env, &token).balance(&r1),
        MAX_BATCH_TRANSFER_SIZE as i128
    );
}

#[test]
fn test_batch_transfer_is_atomic_on_validation_failure() {
    let (env, contract_id, token, sender, r1) = setup(1_000);
    let r2 = Address::generate(&env);

    // Invalid amount in the second item: nothing is transferred.
    let mut bad: Vec<(Address, i128)> = Vec::new(&env);
    bad.push_back((r1.clone(), 100));
    bad.push_back((r2.clone(), 0));
    let res = env.as_contract(&contract_id, || batch_transfer(&env, &sender, &token, &bad));
    assert_eq!(res, Err(Error::InvalidAmount));

    // Aggregate exceeds balance: nothing is transferred.
    let mut over: Vec<(Address, i128)> = Vec::new(&env);
    over.push_back((r1.clone(), 600));
    over.push_back((r2.clone(), 600));
    let res = env.as_contract(&contract_id, || batch_transfer(&env, &sender, &token, &over));
    assert_eq!(res, Err(Error::InsufficientBalance));

    let client = TokenClient::new(&env, &token);
    assert_eq!(client.balance(&sender), 1_000);
    assert_eq!(client.balance(&r1), 0);
    assert_eq!(client.balance(&r2), 0);
}

#[test]
fn test_batch_transfer_overflow_total() {
    let (env, contract_id, token, sender, r1) = setup(1_000);
    let mut batch: Vec<(Address, i128)> = Vec::new(&env);
    batch.push_back((r1.clone(), i128::MAX));
    batch.push_back((r1.clone(), 1));
    let res = env.as_contract(&contract_id, || batch_transfer(&env, &sender, &token, &batch));
    assert_eq!(res, Err(Error::ArithmeticError));
}

/// Gas benchmark: prints CPU/memory cost of a full-size batch.
#[test]
fn test_batch_transfer_gas_benchmark() {
    let (env, contract_id, token, sender, r1) = setup(1_000_000);
    let mut batch: Vec<(Address, i128)> = Vec::new(&env);
    for _ in 0..MAX_BATCH_TRANSFER_SIZE {
        batch.push_back((r1.clone(), 10));
    }
    env.budget().reset_unlimited();
    env.as_contract(&contract_id, || batch_transfer(&env, &sender, &token, &batch))
        .unwrap();
    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();
    std::println!(
        "batch_transfer({}) - CPU: {}, Memory: {}",
        MAX_BATCH_TRANSFER_SIZE,
        cpu,
        mem
    );
    assert!(cpu > 0);
}
