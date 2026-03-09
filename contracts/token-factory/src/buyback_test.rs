#![cfg(test)]

use crate::types::Error;
use crate::TokenFactory;
use crate::TokenFactoryClient;
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup_test() -> (Env, TokenFactoryClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    
    client.initialize(&admin, &treasury, &1_000_000, &500_000);
    
    (env, client, admin, treasury)
}

#[test]
fn test_create_buyback_campaign_success() {
    let (env, client, admin, _treasury) = setup_test();

    let token_index = 0;

    let campaign_id = client.create_buyback_campaign(
        &admin,
        &token_index,
        &10_000_0000000,
        &1_000_0000000,
    );

    assert_eq!(campaign_id, 1);
}

#[test]
fn test_create_buyback_campaign_unauthorized() {
    let (env, client, _admin, _treasury) = setup_test();

    let non_admin = Address::generate(&env);
    let token_index = 0;

    let result = client.try_create_buyback_campaign(
        &non_admin,
        &token_index,
        &10_000_0000000,
        &1_000_0000000,
    );

    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_create_buyback_campaign_invalid_budget() {
    let (_env, client, admin, _treasury) = setup_test();

    // Zero budget
    let result = client.try_create_buyback_campaign(&admin, &0, &0, &1_000_0000000);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));

    // Negative budget
    let result = client.try_create_buyback_campaign(&admin, &0, &-100, &1_000_0000000);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));

    // Max spend exceeds budget
    let result = client.try_create_buyback_campaign(&admin, &0, &1_000_0000000, &2_000_0000000);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

#[test]
fn test_execute_buyback_step_success() {
    let (env, client, admin, _treasury) = setup_test();

    let token_index = 0;

    let campaign_id = client.create_buyback_campaign(
        &admin,
        &token_index,
        &10_000_0000000,
        &1_000_0000000,
    );

    let executor = Address::generate(&env);
    let dex = Address::generate(&env);
    
    let tokens_bought = client.execute_buyback_step(
        &campaign_id,
        &executor,
        &500_0000000,
        &40_000_0000000,
        &dex,
    );

    assert_eq!(tokens_bought, 50_000_0000000);
}

#[test]
fn test_execute_buyback_step_enforces_max_spend_per_step() {
    let (env, client, admin, _treasury) = setup_test();

    let token_index = 0;

    let campaign_id = client.create_buyback_campaign(
        &admin,
        &token_index,
        &10_000_0000000,
        &1_000_0000000,
    );

    let executor = Address::generate(&env);
    let dex = Address::generate(&env);

    let tokens_bought = client.execute_buyback_step(
        &campaign_id,
        &executor,
        &2_000_0000000,
        &90_000_0000000,
        &dex,
    );

    assert_eq!(tokens_bought, 100_000_0000000);
}

#[test]
fn test_execute_buyback_step_enforces_remaining_budget() {
    let (env, client, admin, _treasury) = setup_test();

    let token_index = 0;

    let campaign_id = client.create_buyback_campaign(
        &admin,
        &token_index,
        &1_500_0000000,
        &1_000_0000000,
    );

    let executor = Address::generate(&env);
    let dex = Address::generate(&env);

    client.execute_buyback_step(&campaign_id, &executor, &1_000_0000000, &90_000_0000000, &dex);

    let tokens_bought = client.execute_buyback_step(
        &campaign_id,
        &executor,
        &1_000_0000000,
        &40_000_0000000,
        &dex,
    );

    assert_eq!(tokens_bought, 50_000_0000000);
}

#[test]
fn test_execute_buyback_step_slippage_protection() {
    let (env, client, admin, _treasury) = setup_test();

    let token_index = 0;

    let campaign_id = client.create_buyback_campaign(
        &admin,
        &token_index,
        &10_000_0000000,
        &1_000_0000000,
    );

    let executor = Address::generate(&env);
    let dex = Address::generate(&env);

    let result = client.try_execute_buyback_step(
        &campaign_id,
        &executor,
        &500_0000000,
        &60_000_0000000,
        &dex,
    );

    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_execute_buyback_step_budget_exhausted() {
    let (env, client, admin, _treasury) = setup_test();

    let token_index = 0;

    let campaign_id = client.create_buyback_campaign(
        &admin,
        &token_index,
        &1_000_0000000,
        &1_000_0000000,
    );

    let executor = Address::generate(&env);
    let dex = Address::generate(&env);

    client.execute_buyback_step(&campaign_id, &executor, &1_000_0000000, &90_000_0000000, &dex);

    let result = client.try_execute_buyback_step(
        &campaign_id,
        &executor,
        &100_0000000,
        &9_000_0000000,
        &dex,
    );

    assert_eq!(result, Err(Ok(Error::InsufficientFee)));
}

#[test]
fn test_execute_buyback_step_inactive_campaign() {
    let (env, client, _admin, _treasury) = setup_test();

    let executor = Address::generate(&env);
    let dex = Address::generate(&env);

    let result = client.try_execute_buyback_step(
        &999,
        &executor,
        &500_0000000,
        &40_000_0000000,
        &dex,
    );

    assert_eq!(result, Err(Ok(Error::TokenNotFound)));
}

#[test]
fn test_buyback_multiple_campaigns() {
    let (env, client, admin, _treasury) = setup_test();

    let campaign1 = client.create_buyback_campaign(&admin, &0, &5_000_0000000, &500_0000000);
    let campaign2 = client.create_buyback_campaign(&admin, &1, &3_000_0000000, &300_0000000);

    assert_eq!(campaign1, 1);
    assert_eq!(campaign2, 2);

    let executor = Address::generate(&env);
    let dex = Address::generate(&env);

    let bought1 = client.execute_buyback_step(&campaign1, &executor, &500_0000000, &40_000_0000000, &dex);
    let bought2 = client.execute_buyback_step(&campaign2, &executor, &300_0000000, &25_000_0000000, &dex);

    assert_eq!(bought1, 50_000_0000000);
    assert_eq!(bought2, 30_000_0000000);
}
