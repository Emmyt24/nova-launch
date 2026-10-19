#![cfg(test)]

use crate::fee_tiering::*;
use crate::types::Error;
use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env, Vec};

fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &1_000_000, &500_000);
    (env, contract_id, admin)
}

#[test]
fn test_set_and_get_feature_fee() {
    let (env, cid, admin) = setup();
    let burn = symbol_short!("burn");
    assert_eq!(env.as_contract(&cid, || get_feature_fee(&env, &burn)), 0);
    assert_eq!(
        env.as_contract(&cid, || set_feature_fee(&env, &admin, &burn, 250)),
        Ok(())
    );
    assert_eq!(env.as_contract(&cid, || get_feature_fee(&env, &burn)), 250);
    // Updating does not duplicate the feature list entry.
    env.as_contract(&cid, || set_feature_fee(&env, &admin, &burn, 300)).unwrap();
    assert_eq!(env.as_contract(&cid, || get_fee_tier_features(&env)).len(), 1);
}

#[test]
fn test_fee_bounds_and_auth() {
    let (env, cid, admin) = setup();
    let f = symbol_short!("mint");
    assert_eq!(
        env.as_contract(&cid, || set_feature_fee(&env, &admin, &f, -1)),
        Err(Error::FeeTierOutOfBounds)
    );
    assert_eq!(
        env.as_contract(&cid, || set_feature_fee(&env, &admin, &f, MAX_FEATURE_FEE + 1)),
        Err(Error::FeeTierOutOfBounds)
    );
    assert_eq!(
        env.as_contract(&cid, || set_feature_fee(&env, &admin, &f, MAX_FEATURE_FEE)),
        Ok(())
    );
    assert_eq!(
        env.as_contract(&cid, || set_feature_fee(&env, &admin, &f, 0)),
        Ok(())
    );
    let other = Address::generate(&env);
    assert_eq!(
        env.as_contract(&cid, || set_feature_fee(&env, &other, &f, 1)),
        Err(Error::Unauthorized)
    );
}

#[test]
fn test_quote_sums_base_and_surcharges_once() {
    let (env, cid, admin) = setup();
    let burn = symbol_short!("burn");
    let mint = symbol_short!("mint");
    env.as_contract(&cid, || set_feature_fee(&env, &admin, &burn, 100)).unwrap();
    env.as_contract(&cid, || set_feature_fee(&env, &admin, &mint, 40)).unwrap();

    let mut features: Vec<soroban_sdk::Symbol> = Vec::new(&env);
    assert_eq!(
        env.as_contract(&cid, || quote_creation_fee(&env, &features)),
        Ok(1_000_000)
    );
    features.push_back(burn.clone());
    features.push_back(mint.clone());
    features.push_back(burn.clone());
    assert_eq!(
        env.as_contract(&cid, || quote_creation_fee(&env, &features)),
        Ok(1_000_140)
    );
}

#[test]
fn test_quote_rejects_too_many_features() {
    let (env, cid, _admin) = setup();
    let mut features: Vec<soroban_sdk::Symbol> = Vec::new(&env);
    for _ in 0..(MAX_FEATURES_PER_QUOTE + 1) {
        features.push_back(symbol_short!("burn"));
    }
    assert_eq!(
        env.as_contract(&cid, || quote_creation_fee(&env, &features)),
        Err(Error::TooManyFeeTierFeatures)
    );
}
