//! Tests for delegation expiry (#2238), proposal cancellation (#2239) and the
//! vote change window (#2240).

#![cfg(test)]

use crate::proposal_cancellation::CancelError;
use crate::types::{Error, ProposalStatus};
use crate::{GovernanceContract, GovernanceContractClient};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Bytes, Env, String,
};

fn setup() -> (Env, GovernanceContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, GovernanceContract);
    let client = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &100_000_000_i128);
    (env, client, admin)
}

fn set_time(env: &Env, ts: u64) {
    env.ledger().with_mut(|l| l.timestamp = ts);
}

fn new_proposal(env: &Env, client: &GovernanceContractClient<'static>, creator: &Address) -> u32 {
    client.create_proposal(
        creator,
        &String::from_str(env, "proposal"),
        &Bytes::new(env),
        &1000_u64,
        &1_i128,
        &50_u32,
    )
}

fn funded(
    env: &Env,
    client: &GovernanceContractClient<'static>,
    admin: &Address,
    amount: i128,
) -> Address {
    let a = Address::generate(env);
    client.set_balance(admin, &a, &amount);
    a
}

// ─── #2238 delegation expiry ───────────────────────────────────────────────

#[test]
fn expiry_rejects_past_timestamp() {
    let (env, client, admin) = setup();
    let a = funded(&env, &client, &admin, 100);
    let b = funded(&env, &client, &admin, 100);
    set_time(&env, 100);
    let r = client.try_delegate_with_expiry(&a, &b, &100_u64);
    assert_eq!(r, Err(Ok(Error::InvalidParameters)));
}

#[test]
fn delegation_counts_before_expiry() {
    let (env, client, admin) = setup();
    let delegator = funded(&env, &client, &admin, 300);
    let delegatee = funded(&env, &client, &admin, 500);
    client.delegate_with_expiry(&delegator, &delegatee, &500_u64);
    assert_eq!(client.get_delegation_expiry(&delegator), Some(500_u64));

    let pid = new_proposal(&env, &client, &admin);
    set_time(&env, 499);
    client.cast_vote(&delegatee, &pid, &true);
    assert_eq!(client.get_proposal(&pid).unwrap().votes_for, 800);
}

#[test]
fn expired_delegation_is_ignored_in_vote_weight() {
    let (env, client, admin) = setup();
    let delegator = funded(&env, &client, &admin, 300);
    let delegatee = funded(&env, &client, &admin, 500);
    client.delegate_with_expiry(&delegator, &delegatee, &500_u64);

    let pid = new_proposal(&env, &client, &admin);
    set_time(&env, 500);
    client.cast_vote(&delegatee, &pid, &true);
    assert_eq!(client.get_proposal(&pid).unwrap().votes_for, 500);
    assert!(client.get_delegation(&delegator).is_none());
    assert_eq!(client.get_delegation_expiry(&delegator), None);
    assert_eq!(client.get_vote_power(&delegator), 300);
}

#[test]
fn delegator_regains_weight_after_expiry() {
    let (env, client, admin) = setup();
    let delegator = funded(&env, &client, &admin, 300);
    let delegatee = funded(&env, &client, &admin, 500);
    client.delegate_with_expiry(&delegator, &delegatee, &500_u64);

    let pid = new_proposal(&env, &client, &admin);
    set_time(&env, 600);
    client.cast_vote(&delegator, &pid, &false);
    assert_eq!(client.get_proposal(&pid).unwrap().votes_against, 300);
}

#[test]
fn expire_delegation_is_permissionless_and_idempotent() {
    let (env, client, admin) = setup();
    let delegator = funded(&env, &client, &admin, 300);
    let delegatee = funded(&env, &client, &admin, 500);
    client.delegate_with_expiry(&delegator, &delegatee, &500_u64);

    set_time(&env, 499);
    assert!(!client.expire_delegation(&delegator));
    set_time(&env, 500);
    assert!(client.expire_delegation(&delegator));
    assert!(!client.expire_delegation(&delegator));
    assert_eq!(client.get_vote_power(&delegatee), 500);
    assert_eq!(client.get_vote_power(&delegator), 300);
}

#[test]
fn plain_delegate_clears_expiry() {
    let (env, client, admin) = setup();
    let delegator = funded(&env, &client, &admin, 300);
    let delegatee = funded(&env, &client, &admin, 500);
    client.delegate_with_expiry(&delegator, &delegatee, &500_u64);
    client.delegate(&delegator, &delegatee);
    assert_eq!(client.get_delegation_expiry(&delegator), None);
}

proptest! {
    #[test]
    fn prop_expired_delegation_never_adds_weight(
        delegator_bal in 1i128..=1_000_000i128,
        delegatee_bal in 1i128..=1_000_000i128,
        expires_at in 1u64..=900u64,
        extra in 0u64..=50u64,
    ) {
        let (env, client, admin) = setup();
        let delegator = funded(&env, &client, &admin, delegator_bal);
        let delegatee = funded(&env, &client, &admin, delegatee_bal);
        client.delegate_with_expiry(&delegator, &delegatee, &(expires_at + 1000));
        set_time(&env, expires_at + 1000 + extra);
        client.expire_delegation(&delegator);
        prop_assert_eq!(client.get_vote_power(&delegatee), delegatee_bal);
        prop_assert_eq!(client.get_vote_power(&delegator), delegator_bal);
    }
}

// ─── #2239 proposal cancellation ───────────────────────────────────────────

#[test]
fn proposer_can_cancel_pending_proposal() {
    let (env, client, admin) = setup();
    let pid = new_proposal(&env, &client, &admin);
    client.cancel_proposal(&admin, &pid);
    assert_eq!(client.get_proposal(&pid).unwrap().status, ProposalStatus::Cancelled);
}

#[test]
fn only_proposer_can_cancel() {
    let (env, client, admin) = setup();
    let pid = new_proposal(&env, &client, &admin);
    let other = Address::generate(&env);
    let r = client.try_cancel_proposal(&other, &pid);
    assert_eq!(r, Err(Ok(CancelError::NotProposer)));
}

#[test]
fn cannot_cancel_after_vote_or_twice() {
    let (env, client, admin) = setup();
    let voter = funded(&env, &client, &admin, 100);
    let pid = new_proposal(&env, &client, &admin);
    client.cast_vote(&voter, &pid, &true);
    assert_eq!(
        client.try_cancel_proposal(&admin, &pid),
        Err(Ok(CancelError::NotPending))
    );

    let pid2 = new_proposal(&env, &client, &admin);
    client.cancel_proposal(&admin, &pid2);
    assert_eq!(
        client.try_cancel_proposal(&admin, &pid2),
        Err(Ok(CancelError::NotPending))
    );
}

#[test]
fn cancelled_proposal_rejects_votes_and_missing_id_errors() {
    let (env, client, admin) = setup();
    let voter = funded(&env, &client, &admin, 100);
    let pid = new_proposal(&env, &client, &admin);
    client.cancel_proposal(&admin, &pid);
    assert!(client.try_cast_vote(&voter, &pid, &true).is_err());
    assert_eq!(
        client.try_cancel_proposal(&admin, &99_u32),
        Err(Ok(CancelError::ProposalNotFound))
    );
}

