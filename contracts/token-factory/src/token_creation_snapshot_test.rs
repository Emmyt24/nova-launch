use super::*;
use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
use soroban_sdk::{token, Address, Env, String};

#[test]
fn test_dividend_distribution_immediate_initiate() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    client.initialize(&admin, &treasury, &1_000_000_i128, &500_000_i128);

    // A real, transferable Stellar asset used as the dividend payout currency.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let asset = sac.address();
    token::StellarAssetClient::new(&env, &asset).mint(&admin, &1_000_000_000_i128);

    let name = String::from_str(&env, "Test Token");
    let symbol = String::from_str(&env, "TEST");
    let decimals = 7u32;
    let initial_supply = 1_000_000_i128;

    client.create_token(
        &creator,
        &name,
        &symbol,
        &decimals,
        &initial_supply,
        &None,
        &1_000_000_i128,
    );

    let token_index = 0u32;
    let deadline = env.ledger().sequence() + 100;

    // Immediately initiate a dividend distribution without any mint/burn
    // This should succeed because we now record the initial supply snapshot
    let distribution_id =
        client.initiate_distribution(&admin, &token_index, &asset, &500_000_i128, &deadline);

    // Verify the distribution was created with the correct supply
    let record = client.get_distribution(&distribution_id);
    assert_eq!(record.total_supply_at_snapshot, initial_supply);
}

#[test]
fn test_dividend_creator_claim_without_mint() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    client.initialize(&admin, &treasury, &1_000_000_i128, &500_000_i128);

    // A real, transferable Stellar asset used as the dividend payout currency.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let asset = sac.address();
    token::StellarAssetClient::new(&env, &asset).mint(&admin, &1_000_000_000_i128);

    let name = String::from_str(&env, "Test Token");
    let symbol = String::from_str(&env, "TEST");
    let decimals = 7u32;
    let initial_supply = 1_000_000_i128;

    client.create_token(
        &creator,
        &name,
        &symbol,
        &decimals,
        &initial_supply,
        &None,
        &1_000_000_i128,
    );

    let token_index = 0u32;
    let deadline = env.ledger().sequence() + 100;

    // Initiate a dividend distribution immediately after creation
    let distribution_id =
        client.initiate_distribution(&admin, &token_index, &asset, &1_000_000_i128, &deadline);

    // The creator should be able to claim their pro-rata share
    // They hold the entire initial supply, so they get 100% of the distribution
    let claimed_amount = client.claim_dividend(&creator, &distribution_id);

    // Should succeed, not fail with NothingToClaim
    // The full amount should be claimed since creator holds 100% of tokens
    assert_eq!(claimed_amount, 1_000_000_i128);

    // Verify the funds were transferred
    let asset_client = token::Client::new(&env, &asset);
    assert_eq!(asset_client.balance(&creator), 1_000_000_i128);
}

#[test]
fn test_dividend_distribution_supply_snapshot_recorded() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    client.initialize(&admin, &treasury, &1_000_000_i128, &500_000_i128);

    // A real, transferable Stellar asset used as the dividend payout currency.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let asset = sac.address();
    token::StellarAssetClient::new(&env, &asset).mint(&admin, &1_000_000_000_i128);

    let name = String::from_str(&env, "Test Token");
    let symbol = String::from_str(&env, "TEST");
    let decimals = 7u32;
    let initial_supply = 5_000_000_i128;

    client.create_token(
        &creator,
        &name,
        &symbol,
        &decimals,
        &initial_supply,
        &None,
        &1_000_000_i128,
    );

    let token_index = 0u32;

    // Verify that the supply snapshot was recorded at creation time
    let supply_snapshot_count = snapshot::get_supply_snapshot_count(&env, token_index);
    assert!(supply_snapshot_count > 0);

    // Verify that we can retrieve the supply at creation
    let current_ledger = env.ledger().sequence();
    let supply_at_creation = snapshot::get_supply_at_ledger(&env, token_index, current_ledger);
    assert_eq!(supply_at_creation, Ok(initial_supply));
}
