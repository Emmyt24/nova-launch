use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

#[test]
fn test_snapshot_counter_balance_overflow() {
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

    // Manually set the balance snapshot count to u32::MAX to test overflow
    let holder = creator.clone();
    let count_key = DataKey::BalanceSnapshotCount(token_index, holder.clone());
    env.storage().persistent().set(&count_key, &u32::MAX);

    // Attempt to record a balance snapshot - should return ArithmeticError
    let result = snapshot::record_balance_snapshot(&env, token_index, &holder, 100);

    assert_eq!(result, Err(Error::ArithmeticError));
}

#[test]
fn test_snapshot_counter_supply_overflow() {
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

    // Manually set the supply snapshot count to u32::MAX to test overflow
    let count_key = DataKey::SupplySnapshotCount(token_index);
    env.storage().persistent().set(&count_key, &u32::MAX);

    // Attempt to record a supply snapshot - should return ArithmeticError
    let result = snapshot::record_supply_snapshot(&env, token_index, 1_000_000_0000000);

    assert_eq!(result, Err(Error::ArithmeticError));
}
