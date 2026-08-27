//! Tests for issue #1678: bounds validation in create_proposal
//! Tests for issue #1679: checked arithmetic in finalize_proposal

#![cfg(test)]

use crate::{GovernanceContract, GovernanceContractClient};
use crate::types::ProposalStatus;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, String};

// ─── Helpers ──────────────────────────────────────────────────────────────

fn setup() -> (Env, GovernanceContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, GovernanceContract);
    let client = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &10_000_000_i128);
    (env, client, admin)
}

// ─── #1678 — create_proposal bounds validation ────────────────────────────

/// threshold_percent > 100 must be rejected
#[test]
fn test_create_proposal_rejects_threshold_above_100() {
    let (env, client, creator) = setup();
    let result = client.try_create_proposal(
        &creator,
        &String::from_str(&env, "bad threshold"),
        &Bytes::new(&env),
        &3600_u64,   // valid voting_period
        &1000_i128,  // valid quorum
        &101_u32,    // invalid: > 100
    );
    assert!(result.is_err(), "threshold_percent=101 must be rejected");
}

/// threshold_percent == 100 must be accepted (exact boundary)
#[test]
fn test_create_proposal_accepts_threshold_100() {
    let (env, client, creator) = setup();
    let result = client.try_create_proposal(
        &creator,
        &String::from_str(&env, "max threshold"),
        &Bytes::new(&env),
        &3600_u64,
        &1000_i128,
        &100_u32,
    );
    assert!(result.is_ok(), "threshold_percent=100 is a valid boundary");
}

/// threshold_percent == 0 must be accepted (minimum valid boundary)
#[test]
fn test_create_proposal_accepts_threshold_0() {
    let (env, client, creator) = setup();
    let result = client.try_create_proposal(
        &creator,
        &String::from_str(&env, "zero threshold"),
        &Bytes::new(&env),
        &3600_u64,
        &1000_i128,
        &0_u32,
    );
    assert!(result.is_ok(), "threshold_percent=0 is a valid boundary");
}

/// quorum == 0 must be rejected
#[test]
fn test_create_proposal_rejects_zero_quorum() {
    let (env, client, creator) = setup();
    let result = client.try_create_proposal(
        &creator,
        &String::from_str(&env, "zero quorum"),
        &Bytes::new(&env),
        &3600_u64,
        &0_i128,   // invalid: zero quorum
        &50_u32,
    );
    assert!(result.is_err(), "quorum=0 must be rejected");
}

/// quorum < 0 must be rejected
#[test]
fn test_create_proposal_rejects_negative_quorum() {
    let (env, client, creator) = setup();
    let result = client.try_create_proposal(
        &creator,
        &String::from_str(&env, "negative quorum"),
        &Bytes::new(&env),
        &3600_u64,
        &-1_i128,  // invalid: negative quorum
        &50_u32,
    );
    assert!(result.is_err(), "quorum=-1 must be rejected");
}

/// quorum == 1 must be accepted (minimum valid positive boundary)
#[test]
fn test_create_proposal_accepts_quorum_1() {
    let (env, client, creator) = setup();
    let result = client.try_create_proposal(
        &creator,
        &String::from_str(&env, "quorum 1"),
        &Bytes::new(&env),
        &3600_u64,
        &1_i128,
        &50_u32,
    );
    assert!(result.is_ok(), "quorum=1 is the minimum valid positive boundary");
}

/// voting_period == 0 must be rejected
#[test]
fn test_create_proposal_rejects_zero_voting_period() {
    let (env, client, creator) = setup();
    let result = client.try_create_proposal(
        &creator,
        &String::from_str(&env, "zero period"),
        &Bytes::new(&env),
        &0_u64,     // invalid: zero voting_period
        &1000_i128,
        &50_u32,
    );
    assert!(result.is_err(), "voting_period=0 must be rejected");
}

/// voting_period == 1 must be accepted (minimum valid boundary)
#[test]
fn test_create_proposal_accepts_voting_period_1() {
    let (env, client, creator) = setup();
    let result = client.try_create_proposal(
        &creator,
        &String::from_str(&env, "period 1"),
        &Bytes::new(&env),
        &1_u64,
        &1000_i128,
        &50_u32,
    );
    assert!(result.is_ok(), "voting_period=1 is the minimum valid positive boundary");
}

// ─── #1679 — finalize_proposal checked arithmetic ─────────────────────────

/// Normal finalization should still succeed (regression guard)
#[test]
fn test_finalize_proposal_normal_path() {
    let (env, client, admin) = setup();
    let creator = Address::generate(&env);

    // Give creator some balance so they can vote
    client.set_balance(&admin, &creator, &1_000_i128);

    let proposal_id = client.create_proposal(
        &creator,
        &String::from_str(&env, "normal proposal"),
        &Bytes::new(&env),
        &100_u64,    // voting_period = 100 seconds
        &1_i128,     // quorum = 1
        &50_u32,     // threshold = 50%
    );

    // Cast a vote
    client.cast_vote(&creator, &proposal_id, &true);

    // Advance ledger past voting end
    env.ledger().with_mut(|li| {
        li.timestamp += 200;
    });

    let status = client.finalize_proposal(&proposal_id);
    assert_eq!(status, ProposalStatus::Passed);
}

/// Finalization with votes_for + votes_against overflow must return ArithmeticOverflow,
/// not panic. We simulate this by injecting a proposal with i128::MAX in both fields
/// through the storage layer directly, then finalising it.
#[test]
fn test_finalize_proposal_overflow_returns_typed_error() {
    use crate::storage;
    use crate::types::{GovernanceProposal, ProposalStatus};
    use soroban_sdk::Bytes;

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, GovernanceContract);

    // Initialize the contract
    let admin = Address::generate(&env);
    let client = GovernanceContractClient::new(&env, &contract_id);
    client.initialize(&admin, &10_000_000_i128);

    // Build a proposal where votes_for + votes_against would overflow i128
    let overflowing_proposal = GovernanceProposal {
        id: 0,
        creator: admin.clone(),
        description: String::from_str(&env, "overflow test"),
        voting_end: 0,   // already ended (timestamp starts at 0)
        quorum: 1_i128,
        threshold_percent: 50,
        votes_for: i128::MAX,
        votes_against: 1,
        payload: Bytes::new(&env),
        status: ProposalStatus::Active,
    };

    // Write directly to storage inside the contract's context
    env.as_contract(&contract_id, || {
        storage::set_proposal(&env, 0, &overflowing_proposal);
        storage::set_proposal_count(&env, 1);
    });

    // Advance time past voting_end so finalization is allowed
    env.ledger().with_mut(|li| {
        li.timestamp = 100;
    });

    // Should return a typed error, not panic
    let result = client.try_finalize_proposal(&0_u32);
    assert!(
        result.is_err(),
        "overflow during total_votes calculation must return an error, not panic"
    );
}
