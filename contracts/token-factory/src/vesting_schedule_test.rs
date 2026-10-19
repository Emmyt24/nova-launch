#![cfg(test)]

use crate::types::Error;
use crate::vesting_schedule::*;
use crate::TokenFactory;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

// start = 1000, cliff = 1000 + 100, end = 1000 + 1000; total 10_000.
fn setup() -> (Env, Address, Address, Address, Address, u64) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let contract_id = env.register_contract(None, TokenFactory);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let creator = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&creator, &10_000);
    let id = env
        .as_contract(&contract_id, || {
            create_vesting_schedule(&env, &creator, &token, &beneficiary, 10_000, 1_000, 100, 1_000)
        })
        .unwrap();
    (env, contract_id, token, beneficiary, creator, id)
}

fn set_time(env: &Env, t: u64) {
    env.ledger().with_mut(|li| li.timestamp = t);
}

#[test]
fn test_validate_schedule_parameters() {
    assert_eq!(validate_schedule(0, 0, 0, 10), Err(Error::InvalidAmount));
    assert_eq!(validate_schedule(1, 0, 0, 0), Err(Error::InvalidVestingSchedule));
    assert_eq!(validate_schedule(1, 0, 11, 10), Err(Error::InvalidVestingSchedule));
    assert_eq!(validate_schedule(1, u64::MAX, 0, 10), Err(Error::InvalidVestingSchedule));
    assert_eq!(validate_schedule(1, 5, 10, 10), Ok((15, 15)));
}

#[test]
fn test_nothing_claimable_before_cliff() {
    let (env, cid, _token, b, _c, id) = setup();
    set_time(&env, 1_099);
    assert_eq!(env.as_contract(&cid, || get_vested_amount(&env, id)), Ok(0));
    let res = env.as_contract(&cid, || claim_vesting_schedule(&env, &b, id));
    assert_eq!(res, Err(Error::CliffNotReached));
}

#[test]
fn test_claim_at_cliff_boundary_is_linear_from_start() {
    let (env, cid, token, b, _c, id) = setup();
    set_time(&env, 1_100);
    // 10_000 * 100 / 1_000 = 1_000
    let got = env.as_contract(&cid, || claim_vesting_schedule(&env, &b, id));
    assert_eq!(got, Ok(1_000));
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 1_000);
}

#[test]
fn test_incremental_claims_and_full_vest_at_end() {
    let (env, cid, token, b, _c, id) = setup();
    set_time(&env, 1_500);
    assert_eq!(env.as_contract(&cid, || claim_vesting_schedule(&env, &b, id)), Ok(5_000));
    // Nothing new at same timestamp.
    assert_eq!(
        env.as_contract(&cid, || claim_vesting_schedule(&env, &b, id)),
        Err(Error::NothingToClaim)
    );
    set_time(&env, 2_000);
    assert_eq!(env.as_contract(&cid, || claim_vesting_schedule(&env, &b, id)), Ok(5_000));
    set_time(&env, 9_999);
    assert_eq!(
        env.as_contract(&cid, || claim_vesting_schedule(&env, &b, id)),
        Err(Error::NothingToClaim)
    );
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 10_000);
}

#[test]
fn test_wrong_beneficiary_and_unknown_id() {
    let (env, cid, _token, _b, _c, id) = setup();
    set_time(&env, 2_000);
    let other = Address::generate(&env);
    assert_eq!(
        env.as_contract(&cid, || claim_vesting_schedule(&env, &other, id)),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        env.as_contract(&cid, || get_vesting_schedule(&env, 99)),
        Err(Error::VestingScheduleNotFound)
    );
}
