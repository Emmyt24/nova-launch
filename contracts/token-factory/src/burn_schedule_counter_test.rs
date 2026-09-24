use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

#[test]
fn test_burn_schedule_counter_overflow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let name = String::from_str(&env, "Test Token");
    let symbol = String::from_str(&env, "TEST");
    let decimals = 7u32;
    let initial_supply = 1_000_000_0000000i128;

    let token_address = client.create_token(
        &creator,
        &name,
        &symbol,
        &decimals,
        &initial_supply,
        &None,
        &70_000_000,
    );

    let token_index = storage::get_token_count(&env) - 1;

    // Manually set the burn schedule count to u32::MAX to test overflow
    let count_key = DataKey::BurnScheduleCountByToken(token_index);
    env.storage().instance().set(&count_key, &u32::MAX);

    // Attempt to add a burn schedule - should return ArithmeticError
    let result = storage::add_burn_schedule_by_token(&env, token_index, 1);

    assert_eq!(result, Err(Error::ArithmeticError));
}

#[test]
fn test_burn_schedule_counter_normal_operation() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let name = String::from_str(&env, "Test Token");
    let symbol = String::from_str(&env, "TEST");
    let decimals = 7u32;
    let initial_supply = 1_000_000_0000000i128;

    let token_address = client.create_token(
        &creator,
        &name,
        &symbol,
        &decimals,
        &initial_supply,
        &None,
        &70_000_000,
    );

    let token_index = storage::get_token_count(&env) - 1;

    // Add some burn schedules
    assert_eq!(storage::add_burn_schedule_by_token(&env, token_index, 1), Ok(()));
    assert_eq!(storage::add_burn_schedule_by_token(&env, token_index, 2), Ok(()));
    assert_eq!(storage::add_burn_schedule_by_token(&env, token_index, 3), Ok(()));

    // Verify the count is correct
    let count = storage::get_burn_schedule_count_by_token(&env, token_index);
    assert_eq!(count, 3);

    // Verify the schedules were stored
    assert_eq!(storage::get_burn_schedule_id_by_token(&env, token_index, 0), Some(1));
    assert_eq!(storage::get_burn_schedule_id_by_token(&env, token_index, 1), Some(2));
    assert_eq!(storage::get_burn_schedule_id_by_token(&env, token_index, 2), Some(3));
}
