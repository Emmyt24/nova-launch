#![cfg(test)]

use crate::storage;
use crate::treasury_timelock::*;
use crate::types::Error;
use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

fn setup() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 10_000);
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &1_000_000, &500_000);

    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &token).mint(&contract_id, &1_000_000);
    env.as_contract(&contract_id, || storage::set_fee_token(&env, &token));
    let recipient = Address::generate(&env);
    (env, contract_id, admin, recipient, token)
}

#[test]
fn test_queue_then_execute_after_delay_boundary() {
    let (env, cid, admin, recipient, token) = setup();
    let id = env
        .as_contract(&cid, || queue_withdrawal(&env, &admin, &recipient, 500))
        .unwrap();
    let item = env.as_contract(&cid, || get_queued_withdrawal(&env, id)).unwrap();
    assert_eq!(item.executable_at, 10_000 + DEFAULT_WITHDRAWAL_DELAY);

    // One second early fails.
    env.ledger()
        .with_mut(|li| li.timestamp = 10_000 + DEFAULT_WITHDRAWAL_DELAY - 1);
    assert_eq!(
        env.as_contract(&cid, || execute_withdrawal(&env, &admin, id)),
        Err(Error::TimelockNotElapsed)
    );

    // Exactly at executable_at succeeds.
    env.ledger()
        .with_mut(|li| li.timestamp = 10_000 + DEFAULT_WITHDRAWAL_DELAY);
    assert_eq!(env.as_contract(&cid, || execute_withdrawal(&env, &admin, id)), Ok(()));
    assert_eq!(TokenClient::new(&env, &token).balance(&recipient), 500);

    // Cannot execute twice.
    assert_eq!(
        env.as_contract(&cid, || execute_withdrawal(&env, &admin, id)),
        Err(Error::TimelockedWithdrawalNotFound)
    );
}

#[test]
fn test_cancel_prevents_execution() {
    let (env, cid, admin, recipient, _token) = setup();
    let id = env
        .as_contract(&cid, || queue_withdrawal(&env, &admin, &recipient, 500))
        .unwrap();
    assert_eq!(env.as_contract(&cid, || cancel_withdrawal(&env, &admin, id)), Ok(()));
    env.ledger()
        .with_mut(|li| li.timestamp = 10_000 + DEFAULT_WITHDRAWAL_DELAY + 1);
    assert_eq!(
        env.as_contract(&cid, || execute_withdrawal(&env, &admin, id)),
        Err(Error::TimelockedWithdrawalNotFound)
    );
    assert_eq!(
        env.as_contract(&cid, || cancel_withdrawal(&env, &admin, id)),
        Err(Error::TimelockedWithdrawalNotFound)
    );
}

#[test]
fn test_delay_configuration_bounds() {
    let (env, cid, admin, recipient, _token) = setup();
    assert_eq!(
        env.as_contract(&cid, || set_withdrawal_delay(&env, &admin, MIN_WITHDRAWAL_DELAY - 1)),
        Err(Error::InvalidTimelockDelay)
    );
    assert_eq!(
        env.as_contract(&cid, || set_withdrawal_delay(&env, &admin, MAX_WITHDRAWAL_DELAY + 1)),
        Err(Error::InvalidTimelockDelay)
    );
    assert_eq!(
        env.as_contract(&cid, || set_withdrawal_delay(&env, &admin, MIN_WITHDRAWAL_DELAY)),
        Ok(())
    );
    let id = env
        .as_contract(&cid, || queue_withdrawal(&env, &admin, &recipient, 1))
        .unwrap();
    let item = env.as_contract(&cid, || get_queued_withdrawal(&env, id)).unwrap();
    assert_eq!(item.executable_at, 10_000 + MIN_WITHDRAWAL_DELAY);
}

#[test]
fn test_non_admin_rejected_and_invalid_amount() {
    let (env, cid, admin, recipient, _token) = setup();
    let attacker = Address::generate(&env);
    assert_eq!(
        env.as_contract(&cid, || queue_withdrawal(&env, &attacker, &recipient, 5)),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        env.as_contract(&cid, || queue_withdrawal(&env, &admin, &recipient, 0)),
        Err(Error::InvalidAmount)
    );
}
