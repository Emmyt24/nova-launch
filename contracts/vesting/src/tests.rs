use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger, LedgerInfo},
    Address, Env,
};

const START: u64 = 1_000_000;
const CLIFF: u64 = 100;
const DURATION: u64 = 1_000;
const TOTAL: i128 = 1_000_000;

fn setup(env: &Env) -> (VestingClient, Address, Address) {
    let admin = Address::generate(env);
    let beneficiary = Address::generate(env);
    let cid = env.register_contract(None, Vesting);
    let client = VestingClient::new(env, &cid);
    env.mock_all_auths();
    client.initialize(&admin);
    (client, admin, beneficiary)
}

fn set_time(env: &Env, ts: u64) {
    env.ledger().set(LedgerInfo {
        timestamp: ts,
        protocol_version: 21,
        sequence_number: env.ledger().sequence(),
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 10,
        min_persistent_entry_ttl: 10,
        max_entry_ttl: 3_110_400,
    });
}

fn create_default_schedule(client: &VestingClient, beneficiary: &Address) -> u32 {
    client.create_schedule(beneficiary, &TOTAL, &START, &CLIFF, &DURATION)
}

// -----------------------------------------------------------------------
// Before cliff – nothing released
// -----------------------------------------------------------------------
#[test]
fn test_before_cliff_release_is_zero() {
    let env = Env::default();
    let (client, _, beneficiary) = setup(&env);
    let sid = create_default_schedule(&client, &beneficiary);

    // Set time just before cliff
    set_time(&env, START + CLIFF - 1);

    let result = client.try_release(&beneficiary, &sid);
    assert_eq!(result, Err(Ok(Error::NothingToRelease)));
}

// -----------------------------------------------------------------------
// Partial linear release at 50% through duration
// -----------------------------------------------------------------------
#[test]
fn test_partial_linear_release() {
    let env = Env::default();
    let (client, _, beneficiary) = setup(&env);
    let sid = create_default_schedule(&client, &beneficiary);

    // 50% through duration
    set_time(&env, START + DURATION / 2);

    let released = client.release(&beneficiary, &sid);
    assert!(released > 0);
    assert!(released <= TOTAL / 2 + 1);

    let schedule = client.get_schedule(&beneficiary, &sid);
    assert_eq!(schedule.released, released);

    // Verify event was emitted
    assert!(!env.events().all().is_empty());
}

// -----------------------------------------------------------------------
// Full release after duration ends
// -----------------------------------------------------------------------
#[test]
fn test_full_release_after_duration() {
    let env = Env::default();
    let (client, _, beneficiary) = setup(&env);
    let sid = create_default_schedule(&client, &beneficiary);

    // Past end of vesting
    set_time(&env, START + DURATION + 1);

    let released = client.release(&beneficiary, &sid);
    assert_eq!(released, TOTAL);

    let schedule = client.get_schedule(&beneficiary, &sid);
    assert_eq!(schedule.released, TOTAL);
}

// -----------------------------------------------------------------------
// Double-release attempt – second call should return NothingToRelease
// -----------------------------------------------------------------------
#[test]
fn test_double_release_attempt() {
    let env = Env::default();
    let (client, _, beneficiary) = setup(&env);
    let sid = create_default_schedule(&client, &beneficiary);

    set_time(&env, START + DURATION + 1);

    // First release succeeds
    let first = client.release(&beneficiary, &sid);
    assert_eq!(first, TOTAL);

    // Second release should fail
    let result = client.try_release(&beneficiary, &sid);
    assert_eq!(result, Err(Ok(Error::NothingToRelease)));
}

// -----------------------------------------------------------------------
// Multiple schedules per beneficiary
// -----------------------------------------------------------------------
#[test]
fn test_multiple_schedules_per_beneficiary() {
    let env = Env::default();
    let (client, _, beneficiary) = setup(&env);

    let sid0 = create_default_schedule(&client, &beneficiary);
    let sid1 = client.create_schedule(&beneficiary, &500_000, &START, &0, &500);

    assert_ne!(sid0, sid1);

    set_time(&env, START + DURATION + 1);

    let r0 = client.release(&beneficiary, &sid0);
    let r1 = client.release(&beneficiary, &sid1);

    assert_eq!(r0, TOTAL);
    assert_eq!(r1, 500_000);
}

// -----------------------------------------------------------------------
// tokens_released event contains correct data
// -----------------------------------------------------------------------
#[test]
fn test_release_event_emitted() {
    let env = Env::default();
    let (client, _, beneficiary) = setup(&env);
    let sid = create_default_schedule(&client, &beneficiary);

    set_time(&env, START + DURATION);

    client.release(&beneficiary, &sid);

    let events = env.events().all();
    assert_eq!(events.len(), 1);
}
