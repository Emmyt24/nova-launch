use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events},
    vec, Address, Env,
};

fn setup(env: &Env) -> (AdminRolesClient, Address, Address, Address) {
    let admin = Address::generate(env);
    let signer2 = Address::generate(env);
    let signer3 = Address::generate(env);
    let cid = env.register_contract(None, AdminRoles);
    let client = AdminRolesClient::new(env, &cid);
    env.mock_all_auths();
    let signers = vec![env, admin.clone(), signer2.clone(), signer3.clone()];
    client.initialize(&admin, &signers, &2);
    (client, admin, signer2, signer3)
}

// -----------------------------------------------------------------------
// Single-admin auth: privileged calls succeed when admin is authorised
// -----------------------------------------------------------------------
#[test]
fn test_single_admin_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, s2, _) = setup(&env);

    assert_eq!(client.get_admin(), admin);
    client.mint(&admin, &1000);
    client.withdraw(&admin, &500);
    client.update_rate(&100);
}

// -----------------------------------------------------------------------
// Two-step admin transfer
// -----------------------------------------------------------------------
#[test]
fn test_two_step_admin_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let cid = env.register_contract(None, AdminRoles);
    let client = AdminRolesClient::new(&env, &cid);

    let signers = vec![&env, admin.clone(), new_admin.clone()];
    client.initialize(&admin, &signers, &1);

    // Step 1: propose
    client.propose_admin(&new_admin);
    assert_eq!(client.get_pending_admin(), Some(new_admin.clone()));

    // admin_proposed event emitted
    let events = env.events().all();
    assert!(!events.is_empty());

    // Step 2: accept
    client.accept_admin();
    assert_eq!(client.get_admin(), new_admin);
    assert_eq!(client.get_pending_admin(), None);

    // admin_transferred event emitted
    let events = env.events().all();
    assert!(events.len() >= 2);
}

// -----------------------------------------------------------------------
// Reject accept_admin when no pending admin is set
// -----------------------------------------------------------------------
#[test]
fn test_reject_no_pending_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _, _) = setup(&env);

    let result = client.try_accept_admin();
    assert_eq!(result, Err(Ok(Error::NoPendingAdmin)));
}

// -----------------------------------------------------------------------
// Unauthorised call is rejected
// -----------------------------------------------------------------------
#[test]
fn test_unauthorised_mint_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let attacker = Address::generate(&env);
    let admin = Address::generate(&env);
    let s2 = Address::generate(&env);
    let cid = env.register_contract(None, AdminRoles);
    let client = AdminRolesClient::new(&env, &cid);

    let signers = vec![&env, admin.clone(), s2.clone()];
    client.initialize(&admin, &signers, &1);

    // attacker is not the stored admin – should return Unauthorized
    let result = client.try_mint(&attacker, &9999);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

// -----------------------------------------------------------------------
// Pause blocks privileged operations
// -----------------------------------------------------------------------
#[test]
fn test_pause_blocks_privileged_ops() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, _, _) = setup(&env);

    client.pause();
    assert!(client.is_paused());

    let result = client.try_mint(&admin, &100);
    assert_eq!(result, Err(Ok(Error::ContractPaused)));

    client.unpause();
    assert!(!client.is_paused());
    client.mint(&admin, &100);
}

// -----------------------------------------------------------------------
// Multisig threshold update
// -----------------------------------------------------------------------
#[test]
fn test_multisig_threshold_update() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, s2, s3) = setup(&env);

    assert_eq!(client.get_threshold(), 2);

    let signers = vec![&env, admin.clone(), s2.clone(), s3.clone()];
    client.update_signers(&signers, &3);
    assert_eq!(client.get_threshold(), 3);
}

// -----------------------------------------------------------------------
// Invalid threshold is rejected
// -----------------------------------------------------------------------
#[test]
fn test_invalid_threshold_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let s2 = Address::generate(&env);
    let cid = env.register_contract(None, AdminRoles);
    let client = AdminRolesClient::new(&env, &cid);

    let signers = vec![&env, admin.clone(), s2.clone()];
    // threshold (5) > signers count (2)
    let result = client.try_initialize(&admin, &signers, &5);
    assert_eq!(result, Err(Ok(Error::InvalidThreshold)));
}
