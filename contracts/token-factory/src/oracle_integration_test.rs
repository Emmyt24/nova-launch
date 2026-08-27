//! Oracle price-feed integration tests.
//!
//! Covers the acceptance criteria for the oracle primitive: submit/read
//! happy path, staleness rejection, unauthorized-source rejection,
//! non-positive-price rejection, and admin authorize/deauthorize.

#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

use crate::{types::Error, TokenFactory, TokenFactoryClient};

const BASE_FEE: i128 = 100_000_000;
const METADATA_FEE: i128 = 50_000_000;
const MAX_AGE_SECONDS: u64 = 300;

/// Deploy and initialize the factory, returning `(env, client, admin)`.
fn setup(env: &Env) -> (TokenFactoryClient<'_>, Address) {
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    client.initialize(&admin, &treasury, &BASE_FEE, &METADATA_FEE);
    (client, admin)
}

#[test]
fn submit_and_read_price_happy_path() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let source = Address::generate(&env);
    let asset = Address::generate(&env);

    client.configure_oracle(&admin, &MAX_AGE_SECONDS);
    client.set_oracle_authorized(&admin, &source, &true);

    client.submit_price(&source, &asset, &12_345_i128, &7u32);

    let price = client.get_price(&asset);
    assert_eq!(price.price, 12_345_i128);
    assert_eq!(price.decimals, 7);
    assert_eq!(price.timestamp, env.ledger().timestamp());
}

#[test]
fn get_price_rejects_stale_submission() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let source = Address::generate(&env);
    let asset = Address::generate(&env);

    client.configure_oracle(&admin, &MAX_AGE_SECONDS);
    client.set_oracle_authorized(&admin, &source, &true);
    client.submit_price(&source, &asset, &1_000_i128, &2u32);

    // Advance the ledger clock past the staleness window.
    env.ledger().with_mut(|li| {
        li.timestamp += MAX_AGE_SECONDS + 1;
    });

    let result = client.try_get_price(&asset);
    assert_eq!(
        result,
        Err(Ok(Error::OraclePriceStale)),
        "price older than max_age_seconds must be rejected as stale"
    );
}

#[test]
fn submit_price_rejects_unauthorized_source() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let unauthorized_source = Address::generate(&env);
    let asset = Address::generate(&env);

    client.configure_oracle(&admin, &MAX_AGE_SECONDS);
    // Note: unauthorized_source is never authorized.

    let result = client.try_submit_price(&unauthorized_source, &asset, &1_000_i128, &2u32);
    assert_eq!(
        result,
        Err(Ok(Error::OracleUnauthorizedSource)),
        "unauthorized source must not be able to submit a price"
    );
}

#[test]
fn submit_price_rejects_non_positive_price() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let source = Address::generate(&env);
    let asset = Address::generate(&env);

    client.configure_oracle(&admin, &MAX_AGE_SECONDS);
    client.set_oracle_authorized(&admin, &source, &true);

    let zero_result = client.try_submit_price(&source, &asset, &0_i128, &2u32);
    assert_eq!(zero_result, Err(Ok(Error::OracleInvalidPrice)));

    let negative_result = client.try_submit_price(&source, &asset, &(-5_i128), &2u32);
    assert_eq!(negative_result, Err(Ok(Error::OracleInvalidPrice)));
}

#[test]
fn admin_can_authorize_and_deauthorize_sources() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let source = Address::generate(&env);
    let asset = Address::generate(&env);

    client.configure_oracle(&admin, &MAX_AGE_SECONDS);

    // Authorize, submission succeeds.
    client.set_oracle_authorized(&admin, &source, &true);
    client.submit_price(&source, &asset, &500_i128, &2u32);

    // Deauthorize, further submissions are rejected.
    client.set_oracle_authorized(&admin, &source, &false);
    let result = client.try_submit_price(&source, &asset, &600_i128, &2u32);
    assert_eq!(result, Err(Ok(Error::OracleUnauthorizedSource)));
}

#[test]
fn non_admin_cannot_authorize_sources_or_configure_oracle() {
    let env = Env::default();
    let (client, _admin) = setup(&env);
    let impostor = Address::generate(&env);
    let source = Address::generate(&env);

    let configure_result = client.try_configure_oracle(&impostor, &MAX_AGE_SECONDS);
    assert_eq!(configure_result, Err(Ok(Error::Unauthorized)));

    let authorize_result = client.try_set_oracle_authorized(&impostor, &source, &true);
    assert_eq!(authorize_result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn get_price_before_any_submission_is_not_found() {
    let env = Env::default();
    let (client, admin) = setup(&env);
    let asset = Address::generate(&env);

    client.configure_oracle(&admin, &MAX_AGE_SECONDS);

    let result = client.try_get_price(&asset);
    assert_eq!(result, Err(Ok(Error::OraclePriceNotFound)));
}
