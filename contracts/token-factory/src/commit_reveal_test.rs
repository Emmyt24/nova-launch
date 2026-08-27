#![cfg(test)]

//! Tests for the commit-reveal randomness scheme (#1626)
//!
//! Covers:
//! 1. Full commit-then-reveal happy path
//! 2. Hash-chain derivation determinism
//! 3. Non-revealer forfeiture
//! 4. Reveal-outside-window rejection
//! 5. Commit-outside-window rejection
//! 6. Mismatched pre-image rejection

use crate::commit_reveal::CommitRevealStatus;
use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Bytes, BytesN, Env,
};

const COMMIT_START: u64 = 100;
const COMMIT_END: u64 = 200;
const REVEAL_END: u64 = 300;

/// Registers and initializes the factory, returning `(env, contract_id, admin)`.
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

/// Builds a `(pre_image, commitment)` pair where `commitment = SHA256(pre_image)`.
fn commitment_pair(env: &Env, seed: u8) -> (BytesN<32>, BytesN<32>) {
    let mut raw = [0u8; 32];
    raw[0] = seed;
    let pre_image = BytesN::from_array(env, &raw);
    let bytes: Bytes = pre_image.clone().into();
    let commitment: BytesN<32> = env.crypto().sha256(&bytes).into();
    (pre_image, commitment)
}

fn open_session(env: &Env, client: &TokenFactoryClient, admin: &Address, auction_id: u64) -> u64 {
    env.ledger().with_mut(|l| l.timestamp = COMMIT_START);
    client.create_commit_reveal_session(admin, &auction_id, &COMMIT_START, &COMMIT_END, &REVEAL_END)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Full commit-then-reveal happy path
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_reveal_happy_path() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let session_id = open_session(&env, &client, &admin, 1);

    let bidder_a = Address::generate(&env);
    let bidder_b = Address::generate(&env);
    let bidder_c = Address::generate(&env);
    let (pre_a, comm_a) = commitment_pair(&env, 0xAA);
    let (pre_b, comm_b) = commitment_pair(&env, 0xBB);
    let (pre_c, comm_c) = commitment_pair(&env, 0xCC);

    env.ledger().with_mut(|l| l.timestamp = 150);
    let idx_a = client.submit_commitment(&session_id, &bidder_a, &comm_a);
    let idx_b = client.submit_commitment(&session_id, &bidder_b, &comm_b);
    let idx_c = client.submit_commitment(&session_id, &bidder_c, &comm_c);
    assert_eq!((idx_a, idx_b, idx_c), (0, 1, 2));

    env.ledger().with_mut(|l| l.timestamp = 210);
    client.reveal_pre_image(&session_id, &bidder_a, &pre_a);
    client.reveal_pre_image(&session_id, &bidder_b, &pre_b);
    client.reveal_pre_image(&session_id, &bidder_c, &pre_c);

    env.ledger().with_mut(|l| l.timestamp = 310);
    let seed = client.finalise_commit_reveal_session(&session_id);
    assert_eq!(seed.len(), 32);

    let session = client.get_commit_reveal_session(&session_id).unwrap();
    assert_eq!(session.status, CommitRevealStatus::Finalised);
    assert_eq!(session.commit_count, 3);
    assert_eq!(session.reveal_count, 3);
    assert_eq!(session.final_seed, Some(seed));

    // A second finalise on an already-terminal session must fail.
    let result = client.try_finalise_commit_reveal_session(&session_id);
    assert!(result.is_err(), "double finalise must be rejected");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Hash-chain derivation determinism
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_reveal_seed_is_deterministic() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let run = |auction_id: u64| -> BytesN<32> {
        let session_id = open_session(&env, &client, &admin, auction_id);

        let bidder_a = Address::generate(&env);
        let bidder_b = Address::generate(&env);

        // Fixed pre-images so both runs commit identical inputs.
        let mut raw_a = [0u8; 32];
        raw_a[0] = 0xDE;
        let mut raw_b = [0u8; 32];
        raw_b[0] = 0xAD;
        let pre_a = BytesN::from_array(&env, &raw_a);
        let pre_b = BytesN::from_array(&env, &raw_b);
        let comm_a: BytesN<32> = env.crypto().sha256(&pre_a.clone().into()).into();
        let comm_b: BytesN<32> = env.crypto().sha256(&pre_b.clone().into()).into();

        env.ledger().with_mut(|l| l.timestamp = 150);
        client.submit_commitment(&session_id, &bidder_a, &comm_a);
        client.submit_commitment(&session_id, &bidder_b, &comm_b);

        env.ledger().with_mut(|l| l.timestamp = 210);
        client.reveal_pre_image(&session_id, &bidder_a, &pre_a);
        client.reveal_pre_image(&session_id, &bidder_b, &pre_b);

        env.ledger().with_mut(|l| l.timestamp = 310);
        client.finalise_commit_reveal_session(&session_id)
    };

    let seed1 = run(1);
    let seed2 = run(2);
    assert_eq!(
        seed1, seed2,
        "identical commit/reveal inputs must produce identical seeds regardless of session id"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Non-revealer forfeiture
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_reveal_non_revealer_forfeiture() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let session_id = open_session(&env, &client, &admin, 1);

    let honest = Address::generate(&env);
    let forfeiter = Address::generate(&env);
    let (pre_honest, comm_honest) = commitment_pair(&env, 0x01);
    let (_pre_forfeiter, comm_forfeiter) = commitment_pair(&env, 0x02);

    env.ledger().with_mut(|l| l.timestamp = 150);
    client.submit_commitment(&session_id, &honest, &comm_honest);
    client.submit_commitment(&session_id, &forfeiter, &comm_forfeiter);

    // Only the honest bidder reveals; forfeiter never does.
    env.ledger().with_mut(|l| l.timestamp = 210);
    client.reveal_pre_image(&session_id, &honest, &pre_honest);

    env.ledger().with_mut(|l| l.timestamp = 310);
    let seed = client.finalise_commit_reveal_session(&session_id);
    assert_eq!(seed.len(), 32);

    let session = client.get_commit_reveal_session(&session_id).unwrap();
    assert_eq!(session.status, CommitRevealStatus::Finalised);
    assert_eq!(session.commit_count, 2);
    // Only 1 valid reveal despite 2 commits — forfeiter excluded, no refund advantage.
    assert_eq!(session.reveal_count, 1);

    let forfeiter_record = client.get_commitment(&session_id, &forfeiter).unwrap();
    assert!(!forfeiter_record.revealed);
    assert!(forfeiter_record.pre_image.is_none());
}

#[test]
fn test_commit_reveal_all_forfeit_has_no_valid_reveals() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let session_id = open_session(&env, &client, &admin, 1);

    let bidder = Address::generate(&env);
    let (_pre, commitment) = commitment_pair(&env, 0x33);

    env.ledger().with_mut(|l| l.timestamp = 150);
    client.submit_commitment(&session_id, &bidder, &commitment);
    // bidder never reveals

    env.ledger().with_mut(|l| l.timestamp = 310);
    let result = client.try_finalise_commit_reveal_session(&session_id);
    assert!(
        result.is_err(),
        "finalising a session where every bidder forfeited must fail"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Reveal-outside-window rejection
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_reveal_before_window_opens_rejected() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let session_id = open_session(&env, &client, &admin, 1);

    let bidder = Address::generate(&env);
    let (pre_image, commitment) = commitment_pair(&env, 0x55);

    env.ledger().with_mut(|l| l.timestamp = 150);
    client.submit_commitment(&session_id, &bidder, &commitment);

    // Still inside the commit window: reveal window has not opened yet.
    env.ledger().with_mut(|l| l.timestamp = 199);
    let result = client.try_reveal_pre_image(&session_id, &bidder, &pre_image);
    assert!(result.is_err(), "reveal before commit_end must be rejected");
}

#[test]
fn test_reveal_after_window_closes_rejected() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let session_id = open_session(&env, &client, &admin, 1);

    let bidder = Address::generate(&env);
    let (pre_image, commitment) = commitment_pair(&env, 0x55);

    env.ledger().with_mut(|l| l.timestamp = 150);
    client.submit_commitment(&session_id, &bidder, &commitment);

    env.ledger().with_mut(|l| l.timestamp = REVEAL_END + 1);
    let result = client.try_reveal_pre_image(&session_id, &bidder, &pre_image);
    assert!(result.is_err(), "reveal after reveal_end must be rejected");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Commit-outside-window rejection
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_before_window_opens_rejected() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    env.ledger().with_mut(|l| l.timestamp = COMMIT_START);
    let session_id =
        client.create_commit_reveal_session(&admin, &1u64, &COMMIT_START, &COMMIT_END, &REVEAL_END);

    let bidder = Address::generate(&env);
    let (_, commitment) = commitment_pair(&env, 0x66);

    env.ledger().with_mut(|l| l.timestamp = COMMIT_START - 1);
    let result = client.try_submit_commitment(&session_id, &bidder, &commitment);
    assert!(
        result.is_err(),
        "commit before commit_start must be rejected"
    );
}

#[test]
fn test_commit_after_window_closes_rejected() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let session_id = open_session(&env, &client, &admin, 1);

    let bidder = Address::generate(&env);
    let (_, commitment) = commitment_pair(&env, 0x77);

    env.ledger().with_mut(|l| l.timestamp = COMMIT_END);
    let result = client.try_submit_commitment(&session_id, &bidder, &commitment);
    assert!(
        result.is_err(),
        "commit at/after commit_end must be rejected"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Mismatched pre-image rejection
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commitment_mismatch_rejected() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let session_id = open_session(&env, &client, &admin, 1);

    let bidder = Address::generate(&env);
    let (_, commitment) = commitment_pair(&env, 0x11);
    let (wrong_pre_image, _) = commitment_pair(&env, 0x22);

    env.ledger().with_mut(|l| l.timestamp = 150);
    client.submit_commitment(&session_id, &bidder, &commitment);

    env.ledger().with_mut(|l| l.timestamp = 210);
    let result = client.try_reveal_pre_image(&session_id, &bidder, &wrong_pre_image);
    assert!(
        result.is_err(),
        "a pre-image that doesn't hash to the stored commitment must be rejected"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Additional coverage: duplicate commit, double reveal, unauthorized session
// creation, and window-parameter validation.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_duplicate_commit_rejected() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let session_id = open_session(&env, &client, &admin, 1);
    let bidder = Address::generate(&env);
    let (_, commitment) = commitment_pair(&env, 0x99);

    env.ledger().with_mut(|l| l.timestamp = 150);
    client.submit_commitment(&session_id, &bidder, &commitment);

    let result = client.try_submit_commitment(&session_id, &bidder, &commitment);
    assert!(result.is_err(), "a bidder may only commit once per session");
}

#[test]
fn test_double_reveal_rejected() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let session_id = open_session(&env, &client, &admin, 1);
    let bidder = Address::generate(&env);
    let (pre_image, commitment) = commitment_pair(&env, 0x44);

    env.ledger().with_mut(|l| l.timestamp = 150);
    client.submit_commitment(&session_id, &bidder, &commitment);

    env.ledger().with_mut(|l| l.timestamp = 210);
    client.reveal_pre_image(&session_id, &bidder, &pre_image);

    let result = client.try_reveal_pre_image(&session_id, &bidder, &pre_image);
    assert!(result.is_err(), "a bidder may only reveal once");
}

#[test]
fn test_non_admin_cannot_create_session() {
    let (env, contract_id, _admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let attacker = Address::generate(&env);
    env.ledger().with_mut(|l| l.timestamp = COMMIT_START);
    let result = client.try_create_commit_reveal_session(
        &attacker,
        &1u64,
        &COMMIT_START,
        &COMMIT_END,
        &REVEAL_END,
    );
    assert!(
        result.is_err(),
        "only the factory admin may create a commit-reveal session"
    );
}

#[test]
fn test_session_window_too_short_rejected() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    env.ledger().with_mut(|l| l.timestamp = COMMIT_START);
    // Commit window of 1 second is below MIN_COMMIT_WINDOW.
    let result = client.try_create_commit_reveal_session(
        &admin,
        &1u64,
        &COMMIT_START,
        &(COMMIT_START + 1),
        &(COMMIT_START + 1 + 3_600),
    );
    assert!(
        result.is_err(),
        "a commit window shorter than MIN_COMMIT_WINDOW must be rejected"
    );
}

#[test]
fn test_finalise_before_reveal_window_closes_rejected() {
    let (env, contract_id, admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let session_id = open_session(&env, &client, &admin, 1);
    let bidder = Address::generate(&env);
    let (pre_image, commitment) = commitment_pair(&env, 0x88);

    env.ledger().with_mut(|l| l.timestamp = 150);
    client.submit_commitment(&session_id, &bidder, &commitment);

    env.ledger().with_mut(|l| l.timestamp = 210);
    client.reveal_pre_image(&session_id, &bidder, &pre_image);

    // Reveal window is still open.
    let result = client.try_finalise_commit_reveal_session(&session_id);
    assert!(
        result.is_err(),
        "finalise must fail while the reveal window is still open"
    );
}

#[test]
fn test_unknown_session_queries_return_none() {
    let (env, contract_id, _admin) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    assert!(client.get_commit_reveal_session(&999_u64).is_none());
    let someone = Address::generate(&env);
    assert!(client.get_commitment(&999_u64, &someone).is_none());
}
