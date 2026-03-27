use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, Env,
};

fn make_client(env: &Env) -> (EventEmitterClient, Address) {
    let cid = env.register_contract(None, EventEmitter);
    let client = EventEmitterClient::new(env, &cid);
    (client, cid)
}

// -----------------------------------------------------------------------
// NovaToken
// -----------------------------------------------------------------------
#[test]
fn test_mint_event() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let to = Address::generate(&env);

    client.emit_mint(&to, &1_000);

    let events = env.events().all();
    assert_eq!(events.len(), 1);
}

#[test]
fn test_burn_event() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let from = Address::generate(&env);

    client.emit_burn(&from, &500);

    assert_eq!(env.events().all().len(), 1);
}

#[test]
fn test_transfer_event() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    client.emit_transfer(&from, &to, &250);

    assert_eq!(env.events().all().len(), 1);
}

#[test]
fn test_approve_event() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);

    client.emit_approve(&owner, &spender, &100);

    assert_eq!(env.events().all().len(), 1);
}

// -----------------------------------------------------------------------
// RewardPool
// -----------------------------------------------------------------------
#[test]
fn test_deposited_event() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let depositor = Address::generate(&env);

    client.emit_deposited(&depositor, &5_000);

    assert_eq!(env.events().all().len(), 1);
}

#[test]
fn test_withdrawn_event() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let recipient = Address::generate(&env);

    client.emit_withdrawn(&recipient, &2_000);

    assert_eq!(env.events().all().len(), 1);
}

// -----------------------------------------------------------------------
// ClaimDistribution
// -----------------------------------------------------------------------
#[test]
fn test_claimed_event() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let claimant = Address::generate(&env);

    client.emit_claimed(&claimant, &300);

    assert_eq!(env.events().all().len(), 1);
}

// -----------------------------------------------------------------------
// Staking
// -----------------------------------------------------------------------
#[test]
fn test_staked_event() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let staker = Address::generate(&env);

    client.emit_staked(&staker, &10_000);

    assert_eq!(env.events().all().len(), 1);
}

#[test]
fn test_unstaked_event() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let staker = Address::generate(&env);

    client.emit_unstaked(&staker, &10_000);

    assert_eq!(env.events().all().len(), 1);
}

// -----------------------------------------------------------------------
// AdminRoles
// -----------------------------------------------------------------------
#[test]
fn test_admin_proposed_event() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let proposer = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.emit_admin_proposed(&proposer, &new_admin);

    assert_eq!(env.events().all().len(), 1);
}

#[test]
fn test_admin_transferred_event() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let old_admin = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.emit_admin_transferred(&old_admin, &new_admin);

    assert_eq!(env.events().all().len(), 1);
}

// -----------------------------------------------------------------------
// Multiple events in sequence
// -----------------------------------------------------------------------
#[test]
fn test_multiple_events_sequence() {
    let env = Env::default();
    let (client, _) = make_client(&env);
    let addr = Address::generate(&env);

    client.emit_mint(&addr, &100);
    client.emit_transfer(&addr, &addr, &50);
    client.emit_burn(&addr, &50);

    assert_eq!(env.events().all().len(), 3);
}
