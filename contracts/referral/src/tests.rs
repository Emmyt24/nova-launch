use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, Env,
};

fn setup(env: &Env) -> (ReferralClient, Address) {
    let admin = Address::generate(env);
    let cid = env.register_contract(None, Referral);
    let client = ReferralClient::new(env, &cid);
    env.mock_all_auths();
    client.initialize(&admin);
    (client, admin)
}

// -----------------------------------------------------------------------
// First-time registration
// -----------------------------------------------------------------------
#[test]
fn test_first_time_registration() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let referrer = Address::generate(&env);
    let referred = Address::generate(&env);

    client.register_referral(&referrer, &referred);

    assert_eq!(client.get_referrer(&referred), Some(referrer.clone()));
    assert_eq!(client.get_referral_count(&referrer), 1);

    // Event emitted
    assert_eq!(env.events().all().len(), 1);
}

// -----------------------------------------------------------------------
// Duplicate registration rejected
// -----------------------------------------------------------------------
#[test]
fn test_duplicate_registration_rejected() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let referrer = Address::generate(&env);
    let referred = Address::generate(&env);

    client.register_referral(&referrer, &referred);

    let result = client.try_register_referral(&referrer, &referred);
    assert_eq!(result, Err(Ok(Error::AlreadyReferred)));
}

// -----------------------------------------------------------------------
// Referrer credit
// -----------------------------------------------------------------------
#[test]
fn test_referrer_credit() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let referrer = Address::generate(&env);
    let referred = Address::generate(&env);

    client.register_referral(&referrer, &referred);

    let credited_to = client.credit_referrer(&referred, &500);
    assert_eq!(credited_to, referrer);

    // Two events: register + credit
    assert_eq!(env.events().all().len(), 2);
}

// -----------------------------------------------------------------------
// Counter increments correctly across multiple referrals
// -----------------------------------------------------------------------
#[test]
fn test_counter_increments() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let referrer = Address::generate(&env);

    for _ in 0..5 {
        let referred = Address::generate(&env);
        client.register_referral(&referrer, &referred);
    }

    assert_eq!(client.get_referral_count(&referrer), 5);
}

// -----------------------------------------------------------------------
// Credit fails when no referral exists
// -----------------------------------------------------------------------
#[test]
fn test_credit_without_referral_fails() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let unknown = Address::generate(&env);

    let result = client.try_credit_referrer(&unknown, &100);
    assert_eq!(result, Err(Ok(Error::ReferralNotFound)));
}

// -----------------------------------------------------------------------
// Self-referral rejected
// -----------------------------------------------------------------------
#[test]
fn test_self_referral_rejected() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let addr = Address::generate(&env);

    let result = client.try_register_referral(&addr, &addr);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

// -----------------------------------------------------------------------
// get_referrer returns None for unknown address
// -----------------------------------------------------------------------
#[test]
fn test_get_referrer_unknown() {
    let env = Env::default();
    let (client, _) = setup(&env);
    let unknown = Address::generate(&env);

    assert_eq!(client.get_referrer(&unknown), None);
}
