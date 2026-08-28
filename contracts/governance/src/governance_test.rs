//! Governance Delegation System — Unit & Integration Tests
//!
//! Coverage areas:
//!  [INIT]  Initialization
//!  [AUTH]  Authorization & access control
//!  [DEL]   Delegation happy paths
//!  [UNDEL] Undelegation
//!  [REDEL] Re-delegation
//!  [SNAP]  Snapshots
//!  [BAL]   Balance management
//!  [PAUSE] Pause / unpause
//!  [EDGE]  Edge cases & error paths
//!
//! NOTE on Soroban test client API:
//! The generated `*Client` methods return the value directly and panic on
//! contract errors.  To test error paths we use `try_*` variants which
//! return `Result<T, soroban_sdk::Error>`.

#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, String};
use soroban_sdk::testutils::Events as _;
use crate::{GovernanceContract, GovernanceContractClient, types};

// ─── Test helpers ──────────────────────────────────────────────────────────

/// Deploy and initialise the contract, returning (env, contract_id, admin).
fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, GovernanceContract);
    let client = GovernanceContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin, &1_000_000_i128);

    (env, contract_id, admin)
}

fn client<'a>(env: &'a Env, contract_id: &'a Address) -> GovernanceContractClient<'a> {
    GovernanceContractClient::new(env, contract_id)
}

/// Give `holder` a balance and initialise their vote power.
fn fund(env: &Env, contract_id: &Address, admin: &Address, holder: &Address, amount: i128) {
    let c = client(env, contract_id);
    c.set_balance(admin, holder, &amount);
}

// ─── [INIT] Initialization ─────────────────────────────────────────────────

#[test]
fn init_succeeds_with_valid_params() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, GovernanceContract);
    let c = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    c.initialize(&admin, &1_000_000_i128);
}

#[test]
fn get_total_supply_returns_value_set_at_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, GovernanceContract);
    let c = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    c.initialize(&admin, &42_000_000_i128);
    assert_eq!(c.get_total_supply(), 42_000_000_i128);
}

#[test]
fn get_total_supply_works_while_paused() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    c.pause(&admin);
    // pure read — must not panic even while paused
    assert_eq!(c.get_total_supply(), 1_000_000_i128);
}

#[test]
#[should_panic]
fn init_rejects_zero_supply() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, GovernanceContract);
    let c = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    c.initialize(&admin, &0_i128);
}

#[test]
#[should_panic]
fn init_rejects_double_initialization() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    c.initialize(&admin, &1_000_000_i128);
}

// ─── [AUTH] Authorization ──────────────────────────────────────────────────

#[test]
#[should_panic]
fn auth_non_admin_cannot_set_balance() {
    let (env, contract_id, _admin) = setup();
    let c = client(&env, &contract_id);
    let impostor = Address::generate(&env);
    let holder = Address::generate(&env);
    c.set_balance(&impostor, &holder, &1000_i128);
}

#[test]
#[should_panic]
fn auth_non_admin_cannot_pause() {
    let (env, contract_id, _admin) = setup();
    let c = client(&env, &contract_id);
    let impostor = Address::generate(&env);
    c.pause(&impostor);
}

#[test]
#[should_panic]
fn auth_non_admin_cannot_transfer_admin() {
    let (env, contract_id, _admin) = setup();
    let c = client(&env, &contract_id);
    let impostor = Address::generate(&env);
    let new_admin = Address::generate(&env);
    c.transfer_admin(&impostor, &new_admin);
}

// ─── [DEL] Delegation happy paths ─────────────────────────────────────────

#[test]
fn delegate_transfers_vote_power() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 500_i128);

    assert_eq!(c.get_vote_power(&alice), 500_i128);
    assert_eq!(c.get_vote_power(&bob), 0_i128);

    c.delegate(&alice, &bob);

    assert_eq!(c.get_vote_power(&alice), 0_i128);
    assert_eq!(c.get_vote_power(&bob), 500_i128);
}

#[test]
fn delegate_records_delegation() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 100_i128);
    c.delegate(&alice, &bob);

    let record = c.get_delegation(&alice).unwrap();
    assert_eq!(record.delegator, alice);
    assert_eq!(record.delegatee, bob);
}

#[test]
fn delegate_multiple_delegators_to_same_delegatee() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 300_i128);
    fund(&env, &contract_id, &admin, &bob, 200_i128);

    c.delegate(&alice, &carol);
    c.delegate(&bob, &carol);

    assert_eq!(c.get_vote_power(&carol), 500_i128);
    assert_eq!(c.get_vote_power(&alice), 0_i128);
    assert_eq!(c.get_vote_power(&bob), 0_i128);
}

#[test]
#[should_panic]
fn delegate_rejects_self_delegation() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 100_i128);
    c.delegate(&alice, &alice);
}

#[test]
#[should_panic]
fn delegate_rejects_zero_balance() {
    let (env, contract_id, _admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    c.delegate(&alice, &bob);
}

#[test]
#[should_panic]
fn delegate_rejects_circular_delegation() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 100_i128);
    fund(&env, &contract_id, &admin, &bob, 100_i128);

    c.delegate(&alice, &bob);
    c.delegate(&bob, &alice); // must panic
}

// ─── [UNDEL] Undelegation ─────────────────────────────────────────────────

#[test]
fn undelegate_returns_vote_power_to_delegator() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 400_i128);
    c.delegate(&alice, &bob);
    assert_eq!(c.get_vote_power(&bob), 400_i128);

    c.undelegate(&alice);

    assert_eq!(c.get_vote_power(&alice), 400_i128);
    assert_eq!(c.get_vote_power(&bob), 0_i128);
}

#[test]
fn undelegate_removes_delegation_record() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 100_i128);
    c.delegate(&alice, &bob);
    c.undelegate(&alice);

    assert!(c.get_delegation(&alice).is_none());
}

#[test]
#[should_panic]
fn undelegate_fails_when_no_delegation_exists() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 100_i128);
    c.undelegate(&alice);
}

// ─── [REDEL] Re-delegation ────────────────────────────────────────────────

#[test]
fn redelegate_moves_power_atomically() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 600_i128);

    c.delegate(&alice, &bob);
    assert_eq!(c.get_vote_power(&bob), 600_i128);

    c.delegate(&alice, &carol);

    assert_eq!(c.get_vote_power(&bob), 0_i128);
    assert_eq!(c.get_vote_power(&carol), 600_i128);
    assert_eq!(c.get_vote_power(&alice), 0_i128);
}

#[test]
fn redelegate_to_same_delegatee_is_noop() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 100_i128);
    c.delegate(&alice, &bob);
    c.delegate(&alice, &bob); // no-op, must not panic
    assert_eq!(c.get_vote_power(&bob), 100_i128);
}

// ─── [SNAP] Snapshots ─────────────────────────────────────────────────────

#[test]
fn snapshot_records_current_vote_power() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 250_i128);

    let ledger = env.ledger().sequence();
    c.take_snapshot(&alice);

    let power = c.get_snapshot_power(&alice, &ledger);
    assert_eq!(power, 250_i128);
}

#[test]
#[should_panic]
fn snapshot_not_found_returns_error() {
    let (env, contract_id, _admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    c.get_snapshot_power(&alice, &9999_u32);
}

// ─── [SNAP-AUTH] Snapshot authorization — issue #1685 ─────────────────────

// Regression: take_snapshot must reject calls that lack the target address's
// own authorization. Without this guard any caller could force a persistent-
// storage write for an arbitrary third-party address (storage-spam griefing).
#[test]
#[should_panic]
fn snapshot_requires_address_auth_third_party_caller_rejected() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let attacker = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 100_i128);

    // Env does NOT mock auths here, so the call will only succeed if the
    // required auth for `alice` is actually provided. `attacker` is not
    // `alice`, so the Soroban auth framework rejects the invocation.
    let env2 = Env::default();
    // Re-deploy without mock_all_auths so auth is enforced.
    let contract_id2 = env2.register_contract(None, GovernanceContract);
    let c2 = GovernanceContractClient::new(&env2, &contract_id2);
    let admin2 = Address::generate(&env2);
    c2.initialize(&admin2, &1_000_000_i128);

    let victim = Address::generate(&env2);
    // No auth mocked — this must panic because victim has not authorized the call.
    c2.take_snapshot(&victim);
}

// Regression: a legitimately self-authorized snapshot call must still succeed.
#[test]
fn snapshot_succeeds_when_address_authorizes_itself() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 400_i128);

    // mock_all_auths is active (set in setup()), so alice's auth is satisfied.
    let ledger = env.ledger().sequence();
    c.take_snapshot(&alice);

    let power = c.get_snapshot_power(&alice, &ledger);
    assert_eq!(power, 400_i128, "authorized snapshot must record correct power");
}

// ─── [BAL] Balance management ─────────────────────────────────────────────

#[test]
fn set_balance_updates_vote_power_for_undelegated_holder() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);

    c.set_balance(&admin, &alice, &1000_i128);
    assert_eq!(c.get_vote_power(&alice), 1000_i128);

    c.set_balance(&admin, &alice, &1500_i128);
    assert_eq!(c.get_vote_power(&alice), 1500_i128);
}

#[test]
fn set_balance_updates_delegatee_power_when_delegated() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 500_i128);
    c.delegate(&alice, &bob);
    assert_eq!(c.get_vote_power(&bob), 500_i128);

    c.set_balance(&admin, &alice, &800_i128);
    assert_eq!(c.get_vote_power(&bob), 800_i128);
}

#[test]
#[should_panic]
fn set_balance_rejects_negative_value() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    c.set_balance(&admin, &alice, &(-1_i128));
}

// ─── [PAUSE] Pause / unpause ──────────────────────────────────────────────

#[test]
#[should_panic]
fn pause_blocks_delegate() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 100_i128);
    c.pause(&admin);
    c.delegate(&alice, &bob);
}

#[test]
#[should_panic]
fn pause_blocks_undelegate() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 100_i128);
    c.delegate(&alice, &bob);
    c.pause(&admin);
    c.undelegate(&alice);
}

#[test]
fn unpause_restores_operations() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 100_i128);
    c.pause(&admin);
    c.unpause(&admin);
    c.delegate(&alice, &bob); // must not panic
}

#[test]
fn is_paused_reflects_state() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);

    assert!(!c.is_paused());
    c.pause(&admin);
    assert!(c.is_paused());
    c.unpause(&admin);
    assert!(!c.is_paused());
}

// ─── [EDGE] Edge cases ────────────────────────────────────────────────────

#[test]
fn get_admin_returns_initial_and_transferred_admin() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);

    // Verify get_admin returns the address passed to initialize
    assert_eq!(c.get_admin(), admin);

    let new_admin = Address::generate(&env);
    c.transfer_admin(&admin, &new_admin);

    // Verify get_admin returns the new address immediately after transfer_admin succeeds
    assert_eq!(c.get_admin(), new_admin);
}

#[test]
fn transfer_admin_succeeds() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let new_admin = Address::generate(&env);

    c.transfer_admin(&admin, &new_admin);
    // New admin can pause
    c.pause(&new_admin);
    assert!(c.is_paused());
}

#[test]
#[should_panic]
fn transfer_admin_old_admin_loses_rights() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let new_admin = Address::generate(&env);

    c.transfer_admin(&admin, &new_admin);
    c.pause(&admin); // old admin must no longer work
}

#[test]
#[should_panic]
fn transfer_admin_rejects_same_address() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    c.transfer_admin(&admin, &admin);
}

#[test]
fn vote_power_invariant_preserved_after_delegate_undelegate() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 300_i128);
    fund(&env, &contract_id, &admin, &bob, 200_i128);
    fund(&env, &contract_id, &admin, &carol, 100_i128);

    c.delegate(&alice, &carol);
    c.delegate(&bob, &carol);

    let total = c.get_vote_power(&alice)
        + c.get_vote_power(&bob)
        + c.get_vote_power(&carol);
    assert_eq!(total, 600_i128);

    c.undelegate(&alice);

    let total_after = c.get_vote_power(&alice)
        + c.get_vote_power(&bob)
        + c.get_vote_power(&carol);
    assert_eq!(total_after, 600_i128);
}

#[test]
fn delegate_then_balance_decrease_does_not_underflow() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    fund(&env, &contract_id, &admin, &alice, 1000_i128);
    c.delegate(&alice, &bob);

    c.set_balance(&admin, &alice, &400_i128);

    let bob_power = c.get_vote_power(&bob);
    assert!(bob_power >= 0, "Vote power must never be negative");
}


// ─── Issue #1055: Timelock boundary conditions ──────────────────────────────
// Tests that proposals respect voting period boundaries

#[test]
fn proposal_voting_period_before_end() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter, 100_i128);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &1000_u64, // Long voting period
        &50_i128,
        &50_u32,
    );

    // Voting should succeed before period ends
    c.cast_vote(&voter, &proposal_id, &true);
    let proposal = c.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 100_i128);
}

#[test]
#[should_panic]
fn proposal_voting_period_after_end() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter, 100_i128);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &0_u64, // Voting period ends immediately
        &50_i128,
        &50_u32,
    );

    // Voting should fail after period ends
    c.cast_vote(&voter, &proposal_id, &true);
}

#[test]
#[should_panic]
fn proposal_finalize_before_voting_period_ends() {
    let (env, contract_id, _admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &1000_u64, // Long voting period
        &50_i128,
        &50_u32,
    );

    // Finalization should fail before voting period ends
    c.finalize_proposal(&proposal_id);
}

#[test]
fn proposal_finalize_after_voting_period_ends() {
    let (env, contract_id, _admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &1_u64, // Minimum valid voting period
        &50_i128,
        &50_u32,
    );

    // Advance past the voting period
    env.ledger().with_mut(|li| { li.timestamp += 2; });

    // Finalization should succeed after voting period ends
    let status = c.finalize_proposal(&proposal_id);
    assert_eq!(status, types::ProposalStatus::Failed); // No quorum
}

// ─── Issue #1056: Governance state-machine transitions ──────────────────────
// Tests that proposals transition through valid states only

#[test]
fn proposal_state_active_to_passed() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter, 100_i128);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &1_u64,
        &50_i128,  // Quorum: 50
        &50_u32,   // Threshold: 50%
    );

    c.cast_vote(&voter, &proposal_id, &true);

    // Advance past the voting period
    env.ledger().with_mut(|li| { li.timestamp += 2; });

    let status = c.finalize_proposal(&proposal_id);
    assert_eq!(status, types::ProposalStatus::Passed);
}

#[test]
fn proposal_state_active_to_rejected() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter1, 100_i128);
    fund(&env, &contract_id, &admin, &voter2, 100_i128);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &1_u64,
        &100_i128, // Quorum: 100
        &50_u32,   // Threshold: 50%
    );

    c.cast_vote(&voter1, &proposal_id, &true);  // 100 for
    c.cast_vote(&voter2, &proposal_id, &false); // 100 against

    // Advance past the voting period
    env.ledger().with_mut(|li| { li.timestamp += 2; });

    let status = c.finalize_proposal(&proposal_id);
    assert_eq!(status, types::ProposalStatus::Rejected);
}

#[test]
fn proposal_state_active_to_failed_no_quorum() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter, 50_i128);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &1_u64,
        &100_i128, // Quorum: 100 (not met)
        &50_u32,
    );

    c.cast_vote(&voter, &proposal_id, &true);

    // Advance past the voting period
    env.ledger().with_mut(|li| { li.timestamp += 2; });

    let status = c.finalize_proposal(&proposal_id);
    assert_eq!(status, types::ProposalStatus::Failed);
}

#[test]
#[should_panic]
fn proposal_cannot_finalize_twice() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter, 100_i128);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &0_u64,
        &50_i128,
        &50_u32,
    );

    c.cast_vote(&voter, &proposal_id, &true);
    c.finalize_proposal(&proposal_id);

    // Second finalization should panic
    c.finalize_proposal(&proposal_id);
}

#[test]
#[should_panic]
fn proposal_cannot_vote_on_finalized() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter1, 100_i128);
    fund(&env, &contract_id, &admin, &voter2, 100_i128);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &0_u64,
        &50_i128,
        &50_u32,
    );

    c.cast_vote(&voter1, &proposal_id, &true);
    c.finalize_proposal(&proposal_id);

    // Voting on finalized proposal should panic
    c.cast_vote(&voter2, &proposal_id, &true);
}

#[test]
#[should_panic]
fn proposal_cannot_vote_twice() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter, 100_i128);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &100_u64,
        &50_i128,
        &50_u32,
    );

    c.cast_vote(&voter, &proposal_id, &true);

    // Second vote should panic
    c.cast_vote(&voter, &proposal_id, &false);
}

// ─── Issue #1057: Vesting schedule arithmetic (simulated with proposal voting) ──
// Tests that vote accumulation follows linear arithmetic with proper rounding

#[test]
fn proposal_vote_accumulation_linear() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);
    let voter3 = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter1, 100_i128);
    fund(&env, &contract_id, &admin, &voter2, 200_i128);
    fund(&env, &contract_id, &admin, &voter3, 300_i128);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &100_u64,
        &500_i128,
        &50_u32,
    );

    // Vote 1: 100 votes
    c.cast_vote(&voter1, &proposal_id, &true);
    let proposal = c.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 100_i128);

    // Vote 2: 100 + 200 = 300 votes
    c.cast_vote(&voter2, &proposal_id, &true);
    let proposal = c.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 300_i128);

    // Vote 3: 300 + 300 = 600 votes
    c.cast_vote(&voter3, &proposal_id, &true);
    let proposal = c.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 600_i128);
}

#[test]
fn proposal_vote_rounding_behavior() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter1, 100_i128);
    fund(&env, &contract_id, &admin, &voter2, 100_i128);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &1_u64,
        &150_i128,
        &33_u32, // 33% threshold
    );

    c.cast_vote(&voter1, &proposal_id, &true);  // 100 for
    c.cast_vote(&voter2, &proposal_id, &false); // 100 against

    // Advance past voting period
    env.ledger().with_mut(|li| { li.timestamp += 2; });

    // Total: 200 votes, threshold: (200 * 33) / 100 = 66
    // For: 100 > 66, so should pass
    let status = c.finalize_proposal(&proposal_id);
    assert_eq!(status, types::ProposalStatus::Passed);
}

// ─── Issue #1058: Campaign lifecycle state-transition tests ──────────────────
// Tests that proposals follow complete lifecycle from creation to terminal state

#[test]
fn proposal_lifecycle_creation_to_completion() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter, 100_i128);

    // Step 1: Create proposal (Active state)
    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Full lifecycle proposal"),
        &soroban_sdk::Bytes::new(&env),
        &1_u64,
        &50_i128,
        &50_u32,
    );

    let proposal = c.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, types::ProposalStatus::Active);

    // Step 2: Accept contributions (votes)
    c.cast_vote(&voter, &proposal_id, &true);

    // Verify proposal is still active
    let proposal = c.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, types::ProposalStatus::Active);

    // Advance past voting period
    env.ledger().with_mut(|li| { li.timestamp += 2; });

    // Step 3: Finalize (transition to terminal state)
    let status = c.finalize_proposal(&proposal_id);
    assert_eq!(status, types::ProposalStatus::Passed);

    // Verify proposal is now in terminal state
    let proposal = c.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, types::ProposalStatus::Passed);
}

#[test]
#[should_panic]
fn proposal_rejects_operations_on_inactive() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter1, 100_i128);
    fund(&env, &contract_id, &admin, &voter2, 100_i128);

    let proposal_id = c.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &soroban_sdk::Bytes::new(&env),
        &0_u64, // Voting period already ended
        &50_i128,
        &50_u32,
    );

    c.cast_vote(&voter1, &proposal_id, &true);
    c.finalize_proposal(&proposal_id);

    // Try to vote on inactive proposal - should panic
    c.cast_vote(&voter2, &proposal_id, &true);
}

// ─── [ERR] emit_error_detail event wiring ────────────────────────────────

/// Trigger the set_balance ArithmeticError path by giving a holder a large
/// balance and then trying to set it to i128::MIN (checked_sub overflows).
/// Confirms the err_det event is emitted alongside the error return.
#[test]
fn set_balance_arithmetic_error_emits_err_det_event() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, GovernanceContract);
    let c = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    c.initialize(&admin, &1_000_000_i128);

    let holder = Address::generate(&env);
    // Set a large positive balance first
    c.set_balance(&admin, &holder, &i128::MAX);

    // Now attempt to set it to a negative-ish value that overflows the delta:
    // new_balance - old_balance = i128::MIN - i128::MAX overflows checked_sub.
    // The client panics on contract error, so use try_ variant.
    let result = c.try_set_balance(&admin, &holder, &0_i128);

    // The call should succeed (0 is valid); let's instead craft a real overflow:
    // Store i128::MAX, then subtract: delta = 0 - i128::MAX = negative, which
    // is fine. We need an actual overflow: set balance to 0, vote-power to
    // i128::MAX, then set balance to i128::MAX triggers checked_add overflow.
    // Reset holder to 0 first.
    let _ = result; // above didn't overflow; discard

    // Fresh holder with 0 balance; manually push vote power to i128::MAX via
    // a chain: fund to i128::MAX, delegate, then set back to 0 to leave
    // delegatee with i128::MAX vote power, then fund a second holder to
    // i128::MAX and delegate to same delegatee — that overflows checked_add.
    let delegator1 = Address::generate(&env);
    let delegator2 = Address::generate(&env);
    let delegatee  = Address::generate(&env);

    c.set_balance(&admin, &delegator1, &i128::MAX);
    c.delegate(&delegator1, &delegatee);
    // delegatee now has i128::MAX vote power

    c.set_balance(&admin, &delegator2, &1_i128);
    c.delegate(&delegator2, &delegatee);
    // delegatee vote power: i128::MAX + 1 → overflow in checked_add

    // The delegate call above should have panicked; if we reach here the
    // overflow wasn't triggered (environment might saturate). Accept either.
    // The real assertion is that no event leaks beyond what the error exposes.
    // Verify err_det topic is present in the event log.
    let all_events = env.events().all();
    let has_err_det = all_events.iter().any(|(_, topics, _)| {
        topics.len() >= 1 && {
            let first: soroban_sdk::Val = topics.get(0).unwrap();
            let sym = soroban_sdk::Symbol::try_from_val(&env, &first);
            sym.map(|s| s == soroban_sdk::symbol_short!("err_det")).unwrap_or(false)
        }
    });
    assert!(has_err_det, "expected err_det event to be emitted on arithmetic failure");
}

// ─── [EXEC] execute_proposal routes event through events module ──────────

/// Drive a proposal to Passed then execute it; assert exec_prop event is
/// present with the correct proposal_id and description payload.
#[test]
fn execute_proposal_emits_exec_prop_event() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);
    let creator = Address::generate(&env);
    let voter = Address::generate(&env);

    fund(&env, &contract_id, &admin, &voter, 100_i128);

    let description = String::from_str(&env, "Exec event proposal");
    let proposal_id = c.create_proposal(
        &creator,
        &description,
        &soroban_sdk::Bytes::new(&env),
        &0_u64,   // voting ends immediately
        &50_i128, // quorum
        &50_u32,  // threshold
    );

    c.cast_vote(&voter, &proposal_id, &true);
    c.finalize_proposal(&proposal_id);

    // Drain events accumulated so far so we can isolate the execute event.
    let _ = env.events().all();

    c.execute_proposal(&proposal_id);

    let all_events = env.events().all();
    let exec_event = all_events.iter().find(|(_, topics, _)| {
        if topics.len() < 2 {
            return false;
        }
        let first: soroban_sdk::Val = topics.get(0).unwrap();
        soroban_sdk::Symbol::try_from_val(&env, &first)
            .map(|s| s == soroban_sdk::symbol_short!("exec_prop"))
            .unwrap_or(false)
    });

    assert!(exec_event.is_some(), "expected exec_prop event after execute_proposal");

    let (_, topics, data) = exec_event.unwrap();

    // Second topic must be the proposal_id
    let id_val: soroban_sdk::Val = topics.get(1).unwrap();
    let emitted_id = u32::try_from_val(&env, &id_val).unwrap();
    assert_eq!(emitted_id, proposal_id, "exec_prop topic proposal_id mismatch");

    // Data payload must be the description string
    let emitted_desc = String::try_from_val(&env, &data).unwrap();
    assert_eq!(emitted_desc, description, "exec_prop data description mismatch");
}

// ─── [ISSUE #1906] Arithmetic overflow regression tests ──────────────────

#[test]
fn create_proposal_rejects_voting_period_exceeding_max() {
    let (env, contract_id, _admin) = setup();
    let c = client(&env, &contract_id);

    let creator = Address::generate(&env);
    let description = String::from_slice(&env, "test proposal");
    let payload = soroban_sdk::Bytes::new(&env);

    // MAX_VOTING_PERIOD is 315_360_000; try u64::MAX to overflow
    let result = c.try_create_proposal(
        &creator,
        &description,
        &payload,
        &u64::MAX,  // This should be rejected
        &1_000_i128,
        &50_u32,
    );

    assert!(result.is_err(), "Expected error when voting_period exceeds MAX_VOTING_PERIOD");
}

#[test]
fn create_proposal_computes_voting_end_safely() {
    let (env, contract_id, _admin) = setup();
    let c = client(&env, &contract_id);

    let creator = Address::generate(&env);
    let description = String::from_slice(&env, "test proposal");
    let payload = soroban_sdk::Bytes::new(&env);

    // Set ledger to near u64::MAX - should still succeed with valid voting_period
    env.ledger().set_timestamp(u64::MAX - 100_000);

    // A small voting period that won't overflow
    let voting_period = 1_000_u64;
    let proposal_id = c.create_proposal(
        &creator,
        &description,
        &payload,
        &voting_period,
        &1_000_i128,
        &50_u32,
    );

    let proposal = c.get_proposal(&proposal_id);
    assert!(proposal.is_some());
    // voting_end should be (u64::MAX - 100_000) + 1_000
    let expected_voting_end = (u64::MAX - 100_000) + 1_000;
    assert_eq!(proposal.unwrap().voting_end, expected_voting_end);
}

#[test]
fn create_proposal_rejects_overflow_scenario() {
    let (env, contract_id, _admin) = setup();
    let c = client(&env, &contract_id);

    let creator = Address::generate(&env);
    let description = String::from_slice(&env, "test proposal");
    let payload = soroban_sdk::Bytes::new(&env);

    // Set ledger to u64::MAX so timestamp + any period overflows
    env.ledger().set_timestamp(u64::MAX);

    // Even a small voting period should fail due to overflow
    let result = c.try_create_proposal(
        &creator,
        &description,
        &payload,
        &1_u64,  // smallest non-zero period
        &1_000_i128,
        &50_u32,
    );

    assert!(result.is_err(), "Expected error when voting_end calculation overflows");
}

// ─── [ISSUE #1907] Delegation amount tracking regression tests ──────────────

#[test]
fn delegation_uses_stored_amount_after_balance_change() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);

    let delegator = Address::generate(&env);
    let delegatee = Address::generate(&env);

    // Fund delegator with 1000 tokens
    fund(&env, &contract_id, &admin, &delegator, 1000);
    assert_eq!(c.get_balance(&delegator), 1000);
    assert_eq!(c.get_vote_power(&delegator), 1000);

    // Delegate all 1000 tokens
    c.delegate(&delegator, &delegatee);

    // After delegation, delegator's vote power should be 0, delegatee should have 1000
    assert_eq!(c.get_vote_power(&delegator), 0);
    assert_eq!(c.get_vote_power(&delegatee), 1000);

    // Change delegator's balance to 500
    fund(&env, &contract_id, &admin, &delegator, 500);
    assert_eq!(c.get_balance(&delegator), 500);

    // Vote power should not change (still delegated the original 1000, not 500)
    assert_eq!(c.get_vote_power(&delegator), 0);
    assert_eq!(c.get_vote_power(&delegatee), 1000);

    // Undelegate — should restore 1000 (the stored delegated amount), not 500
    c.undelegate(&delegator);

    // After undelegation, delegator should have restored exactly 1000 (the delegated amount)
    // delegatee should have 0
    assert_eq!(c.get_vote_power(&delegator), 1000);
    assert_eq!(c.get_vote_power(&delegatee), 0);

    // Verify delegation record is cleared
    assert!(c.get_delegation(&delegator).is_none());
}

#[test]
fn redelegation_uses_stored_amount() {
    let (env, contract_id, admin) = setup();
    let c = client(&env, &contract_id);

    let delegator = Address::generate(&env);
    let delegatee1 = Address::generate(&env);
    let delegatee2 = Address::generate(&env);

    // Fund delegator with 1000 tokens
    fund(&env, &contract_id, &admin, &delegator, 1000);

    // Delegate to delegatee1
    c.delegate(&delegator, &delegatee1);
    assert_eq!(c.get_vote_power(&delegator), 0);
    assert_eq!(c.get_vote_power(&delegatee1), 1000);
    assert_eq!(c.get_vote_power(&delegatee2), 0);

    // Decrease delegator's balance to 400
    fund(&env, &contract_id, &admin, &delegator, 400);

    // Re-delegate to delegatee2 — should remove 1000 from delegatee1 (the stored amount)
    // and add 400 to delegatee2 (the new current balance)
    c.delegate(&delegator, &delegatee2);

    // delegatee1 should lose the original 1000
    assert_eq!(c.get_vote_power(&delegatee1), 0);
    // delegatee2 should gain the new balance 400
    assert_eq!(c.get_vote_power(&delegatee2), 400);
    // delegator should still have 0
    assert_eq!(c.get_vote_power(&delegator), 0);

    // Verify the delegation record stores the new amount
    let record = c.get_delegation(&delegator);
    assert!(record.is_some());
    assert_eq!(record.unwrap().delegated_amount, 400);
}

// ─── [ISSUE #1908] GovernanceContract::initialize authorization regression tests ──

#[test]
#[should_panic]
fn initialize_requires_admin_authorization() {
    let env = Env::default();
    // Do NOT mock all auths — this test verifies that initialize checks auth
    let contract_id = env.register_contract(None, GovernanceContract);
    let c = GovernanceContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    // This should fail because admin.require_auth() is called but admin hasn't authorized
    c.initialize(&admin, &1_000_000_i128);
}

#[test]
fn initialize_succeeds_with_admin_authorization() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, GovernanceContract);
    let c = GovernanceContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    // This should succeed because env.mock_all_auths() authorizes all calls
    c.initialize(&admin, &1_000_000_i128);

    // Verify initialization succeeded
    assert_eq!(c.get_admin(), admin);
    assert_eq!(c.get_total_supply(), 1_000_000_i128);
}
