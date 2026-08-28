//! Fee Update Governance Flow Tests (#1385)
//!
//! Fees in the token-factory contract can no longer be updated directly by
//! the admin. All fee changes must flow through the governance proposal
//! system: `propose_fee_update` -> `vote_proposal` -> `queue_proposal`
//! (quorum/approval gate) -> `execute_proposal` (timelock gate).
//!
//! These tests cover the three explicit requirements from the issue:
//! 1. The direct admin fee update entry point no longer exists / cannot be
//!    used to bypass governance.
//! 2. The full proposal -> vote -> queue -> execute flow succeeds and
//!    actually mutates `base_fee`/`metadata_fee`.
//! 3. The timelock is enforced: execution before `eta` is rejected.
//!
//! Run with: `cargo test fee_collection`

#![cfg(test)]
extern crate std;

use crate::types::{ActionType, Error, ProposalState, VoteChoice};
use crate::{timelock, TokenFactory, TokenFactoryClient};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env};

const ONE_HOUR: u64 = 3_600;

fn setup() -> (Env, Address, Address, TokenFactoryClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &100_0000000, &50_0000000);

    env.as_contract(&contract_id, || {
        timelock::initialize_timelock(&env, Some(ONE_HOUR)).unwrap();
    });

    (env, contract_id, admin, client)
}

/// Basic smoke test: factory initializes with the expected starting fees.
#[test]
fn test_fee_collection_setup() {
    let (_env, _contract_id, _admin, client) = setup();
    assert_eq!(client.get_base_fee(), 100_0000000);
    assert_eq!(client.get_metadata_fee(), 50_0000000);
}

// ── 1. Direct fee update rejected ──────────────────────────────────────────

/// `update_fees` no longer exists on the contract — fee changes can only be
/// requested via `propose_fee_update`, which itself only *creates a
/// proposal* and never mutates `base_fee`/`metadata_fee` directly. This test
/// asserts that creating a fee-update proposal has no immediate effect on
/// the live fee values; only a fully executed proposal (post quorum +
/// timelock) can change them.
#[test]
fn test_direct_fee_update_rejected_proposal_alone_does_not_change_fees() {
    let (env, contract_id, admin, client) = setup();

    let now = env.ledger().timestamp();
    let start = now + 10;
    let end = start + 86_400;
    let eta = end + ONE_HOUR;

    let proposal_id =
        client.propose_fee_update(&admin, &200_0000000, &75_0000000, &start, &end, &eta);

    // Fees must be unchanged immediately after proposing — there is no
    // direct admin path that can apply them ahead of governance.
    assert_eq!(client.get_base_fee(), 100_0000000);
    assert_eq!(client.get_metadata_fee(), 50_0000000);

    // The proposal exists but has not been voted on, queued, or executed.
    let proposal = env
        .as_contract(&contract_id, || timelock::get_proposal(&env, proposal_id))
        .unwrap();
    assert_eq!(proposal.state, ProposalState::Created);
    assert!(proposal.executed_at.is_none());
}

/// A non-admin cannot create a fee-update proposal either — governance
/// proposal creation is still gated to the admin (consistent with the rest
/// of the proposal system), so there is no way to bypass the vote/timelock
/// gates by impersonating governance.
#[test]
fn test_propose_fee_update_rejects_non_admin() {
    let (env, _contract_id, _admin, client) = setup();
    let stranger = Address::generate(&env);

    let now = env.ledger().timestamp();
    let start = now + 10;
    let end = start + 86_400;
    let eta = end + ONE_HOUR;

    let result =
        client.try_propose_fee_update(&stranger, &200_0000000, &75_0000000, &start, &end, &eta);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

/// Negative fees are rejected at proposal time, before they ever reach the
/// governance queue.
#[test]
fn test_propose_fee_update_rejects_negative_fees() {
    let (env, _contract_id, admin, client) = setup();

    let now = env.ledger().timestamp();
    let start = now + 10;
    let end = start + 86_400;
    let eta = end + ONE_HOUR;

    let result = client.try_propose_fee_update(&admin, &-1, &75_0000000, &start, &end, &eta);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));

    let result = client.try_propose_fee_update(&admin, &200_0000000, &-1, &start, &end, &eta);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

// ── 2. Full proposal -> vote -> queue -> execute flow succeeds ────────────

#[test]
fn test_full_governance_flow_updates_fees() {
    let (env, contract_id, admin, client) = setup();

    let now = env.ledger().timestamp();
    let start = now + 10;
    let end = start + 86_400; // 1 day voting window
    let eta = end + ONE_HOUR; // 1 hour timelock after voting ends

    let new_base_fee = 200_0000000i128;
    let new_metadata_fee = 75_0000000i128;

    let proposal_id =
        client.propose_fee_update(&admin, &new_base_fee, &new_metadata_fee, &start, &end, &eta);

    // Vote during the voting window with enough support to pass quorum
    // (default quorum is 30% of eligible weight, approval 51% of votes
    // cast; with no tokens deployed yet eligible weight falls back to the
    // number of votes cast, so unanimous `For` votes always pass).
    env.ledger().with_mut(|li| li.timestamp = start + 1);
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);
    client.vote_proposal(&voter1, &proposal_id, &VoteChoice::For);
    client.vote_proposal(&voter2, &proposal_id, &VoteChoice::For);

    // Fees still unchanged mid-vote.
    assert_eq!(client.get_base_fee(), 100_0000000);

    // Move past the voting window and queue the proposal (this finalizes
    // voting and checks quorum/approval under the hood).
    env.ledger().with_mut(|li| li.timestamp = end + 1);
    client.queue_proposal(&proposal_id);

    let proposal = env
        .as_contract(&contract_id, || timelock::get_proposal(&env, proposal_id))
        .unwrap();
    assert_eq!(proposal.state, ProposalState::Queued);

    // Fees still unchanged once queued — timelock has not elapsed yet.
    assert_eq!(client.get_base_fee(), 100_0000000);
    assert_eq!(client.get_metadata_fee(), 50_0000000);

    // Move past eta and execute.
    env.ledger().with_mut(|li| li.timestamp = eta + 1);
    client.execute_proposal(&proposal_id);

    assert_eq!(client.get_base_fee(), new_base_fee);
    assert_eq!(client.get_metadata_fee(), new_metadata_fee);

    let proposal = env
        .as_contract(&contract_id, || timelock::get_proposal(&env, proposal_id))
        .unwrap();
    assert_eq!(proposal.state, ProposalState::Executed);
    assert!(proposal.executed_at.is_some());
}

/// A fee-update proposal that fails to reach quorum/approval cannot be
/// queued, and therefore can never reach execution.
#[test]
fn test_fee_update_proposal_without_quorum_cannot_queue() {
    let (env, _contract_id, admin, client) = setup();

    let now = env.ledger().timestamp();
    let start = now + 10;
    let end = start + 86_400;
    let eta = end + ONE_HOUR;

    let proposal_id =
        client.propose_fee_update(&admin, &200_0000000, &75_0000000, &start, &end, &eta);

    env.ledger().with_mut(|li| li.timestamp = start + 1);
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);
    // Majority votes against — approval threshold (51%) is not met.
    client.vote_proposal(&voter1, &proposal_id, &VoteChoice::Against);
    client.vote_proposal(&voter2, &proposal_id, &VoteChoice::For);

    env.ledger().with_mut(|li| li.timestamp = end + 1);
    let result = client.try_queue_proposal(&proposal_id);
    assert!(result.is_err());

    // Fees remain untouched.
    assert_eq!(client.get_base_fee(), 100_0000000);
    assert_eq!(client.get_metadata_fee(), 50_0000000);
}

// ── 3. Timelock enforced ───────────────────────────────────────────────────

#[test]
fn test_execute_before_eta_rejected_timelock_enforced() {
    let (env, _contract_id, admin, client) = setup();

    let now = env.ledger().timestamp();
    let start = now + 10;
    let end = start + 86_400;
    let eta = end + ONE_HOUR;

    let proposal_id =
        client.propose_fee_update(&admin, &200_0000000, &75_0000000, &start, &end, &eta);

    env.ledger().with_mut(|li| li.timestamp = start + 1);
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);
    client.vote_proposal(&voter1, &proposal_id, &VoteChoice::For);
    client.vote_proposal(&voter2, &proposal_id, &VoteChoice::For);

    env.ledger().with_mut(|li| li.timestamp = end + 1);
    client.queue_proposal(&proposal_id);

    // One second before eta: execution must be rejected.
    env.ledger().with_mut(|li| li.timestamp = eta - 1);
    let result = client.try_execute_proposal(&proposal_id);
    assert_eq!(result, Err(Ok(Error::TimelockNotExpired)));

    // Fees still unchanged.
    assert_eq!(client.get_base_fee(), 100_0000000);
    assert_eq!(client.get_metadata_fee(), 50_0000000);

    // At eta: the timelock has elapsed (execute_proposal allows
    // `current_time >= eta`), so execution now succeeds.
    env.ledger().with_mut(|li| li.timestamp = eta);
    client.execute_proposal(&proposal_id);
    assert_eq!(client.get_base_fee(), 200_0000000);
    assert_eq!(client.get_metadata_fee(), 75_0000000);
}

/// The configured timelock delay (`eta - end_time`) must itself fall within
/// `MIN_TIMELOCK_DELAY..=MAX_TIMELOCK_DELAY`; a fee-update proposal that
/// tries to set an eta delay below the minimum is rejected outright.
#[test]
fn test_propose_fee_update_rejects_eta_below_minimum_timelock() {
    let (env, _contract_id, admin, client) = setup();

    let now = env.ledger().timestamp();
    let start = now + 10;
    let end = start + 86_400;
    let eta = end + 10; // Far below MIN_TIMELOCK_DELAY (1 hour)

    let result =
        client.try_propose_fee_update(&admin, &200_0000000, &75_0000000, &start, &end, &eta);
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

/// Cannot execute a proposal that hasn't been queued yet, even after eta —
/// queueing (and its quorum check) is a mandatory step in the flow.
#[test]
fn test_execute_without_queue_rejected() {
    let (env, _contract_id, admin, client) = setup();

    let now = env.ledger().timestamp();
    let start = now + 10;
    let end = start + 86_400;
    let eta = end + ONE_HOUR;

    let proposal_id =
        client.propose_fee_update(&admin, &200_0000000, &75_0000000, &start, &end, &eta);

    env.ledger().with_mut(|li| li.timestamp = start + 1);
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);
    client.vote_proposal(&voter1, &proposal_id, &VoteChoice::For);
    client.vote_proposal(&voter2, &proposal_id, &VoteChoice::For);

    // Skip queue_proposal entirely and jump straight to eta.
    env.ledger().with_mut(|li| li.timestamp = eta + 1);
    let result = client.try_execute_proposal(&proposal_id);
    assert!(result.is_err());

    assert_eq!(client.get_base_fee(), 100_0000000);
    assert_eq!(client.get_metadata_fee(), 50_0000000);
}

/// `ActionType::FeeChange` proposals encode exactly (base_fee, metadata_fee)
/// — `propose_fee_update` must round-trip both values through the
/// governance payload without loss.
#[test]
fn test_propose_fee_update_payload_round_trips_both_fees() {
    let (env, contract_id, admin, client) = setup();

    let now = env.ledger().timestamp();
    let start = now + 10;
    let end = start + 86_400;
    let eta = end + ONE_HOUR;

    let proposal_id =
        client.propose_fee_update(&admin, &123_4567890, &9_8765432, &start, &end, &eta);

    let proposal = env
        .as_contract(&contract_id, || timelock::get_proposal(&env, proposal_id))
        .unwrap();
    assert_eq!(proposal.action_type, ActionType::FeeChange);

    let (base_fee, metadata_fee) = env.as_contract(&contract_id, || {
        crate::payload_validation::parse_fee_payload(&proposal.payload)
    });
    assert_eq!(base_fee, 123_4567890);
    assert_eq!(metadata_fee, 9_8765432);
}

/// `batch_update_admin` (the remaining direct-admin batch entry point) no
/// longer accepts fee parameters at all — it can only toggle the pause
/// state. Fees are exclusively reachable through governance.
#[test]
fn test_batch_update_admin_only_controls_pause_not_fees() {
    let (_env, _contract_id, admin, client) = setup();

    client.batch_update_admin(&admin, &true);
    assert!(client.is_paused());
    assert_eq!(client.get_base_fee(), 100_0000000);
    assert_eq!(client.get_metadata_fee(), 50_0000000);

    client.batch_update_admin(&admin, &false);
    assert!(!client.is_paused());
}
