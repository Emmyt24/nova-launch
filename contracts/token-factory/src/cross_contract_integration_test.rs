//! Cross-Contract Integration Tests: Token Factory ↔ Governance
//!
//! Verifies end-to-end workflows that span both the TokenFactory contract
//! (fee management, pause/unpause, treasury) and its built-in governance
//! system (proposal creation, voting, finalization, execution).
//!
//! # Scenarios covered
//! 1. Fee change via governance proposal (full lifecycle)
//! 2. Pause/unpause via governance proposal
//! 3. Treasury change via governance proposal
//! 4. Proposal fails when quorum not met
//! 5. Proposal defeated when approval threshold not met
//! 6. Double-vote prevention
//! 7. Governance config update affects subsequent proposals
//! 8. Concurrent proposals have independent vote tallies

#![cfg(test)]

use crate::{
    governance,
    storage,
    test_helpers::{fee_change_payload, pause_payload, treasury_change_payload},
    timelock::{
        create_proposal, execute_proposal, finalize_proposal, get_proposal,
        get_vote_counts, initialize_timelock, queue_proposal, vote_proposal,
    },
    types::{ActionType, Error, ProposalState, VoteChoice},
    TokenFactory,
};
use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env};

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

/// Registers the TokenFactory contract and initialises factory state plus
/// governance/timelock subsystems inside `env.as_contract`.
fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &admin);
        storage::set_treasury(&env, &treasury);
        storage::set_base_fee(&env, 1_000_000);
        storage::set_metadata_fee(&env, 500_000);
        initialize_timelock(&env, Some(3_600)).unwrap();
        governance::initialize_governance(&env, Some(30), Some(51)).unwrap();
    });

    (env, contract_id, admin, treasury)
}

/// Creates a proposal starting 100s from now, lasting 86 400s, ETA 3 600s
/// after voting ends.
fn make_proposal(
    env: &Env,
    contract_id: &Address,
    admin: &Address,
    action: ActionType,
    payload: soroban_sdk::Bytes,
) -> u64 {
    env.as_contract(contract_id, || {
        let now = env.ledger().timestamp();
        create_proposal(env, admin, action, payload, now + 100, now + 86_500, now + 90_100).unwrap()
    })
}

/// Advances ledger into the voting window and casts FOR/AGAINST votes.
fn vote_in_window(
    env: &Env,
    contract_id: &Address,
    proposal_id: u64,
    for_n: usize,
    against_n: usize,
) {
    let p = env.as_contract(contract_id, || get_proposal(env, proposal_id).unwrap());
    env.ledger().with_mut(|li| { li.timestamp = p.start_time + 1; });
    env.as_contract(contract_id, || {
        for _ in 0..for_n {
            vote_proposal(env, &Address::generate(env), proposal_id, VoteChoice::For).unwrap();
        }
        for _ in 0..against_n {
            vote_proposal(env, &Address::generate(env), proposal_id, VoteChoice::Against).unwrap();
        }
    });
}

/// Advances past voting end, finalizes, queues, advances past ETA, executes.
fn finalize_queue_execute(env: &Env, contract_id: &Address, proposal_id: u64) {
    let p = env.as_contract(contract_id, || get_proposal(env, proposal_id).unwrap());
    env.ledger().with_mut(|li| { li.timestamp = p.end_time + 1; });
    env.as_contract(contract_id, || {
        finalize_proposal(env, proposal_id).unwrap();
        queue_proposal(env, proposal_id).unwrap();
    });
    let p = env.as_contract(contract_id, || get_proposal(env, proposal_id).unwrap());
    env.ledger().with_mut(|li| { li.timestamp = p.eta + 1; });
    env.as_contract(contract_id, || {
        execute_proposal(env, proposal_id).unwrap();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fee change — full lifecycle
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn integration_test_fee_change_full_lifecycle() {
    let (env, cid, admin, _) = setup();

    let (base, meta) = env.as_contract(&cid, || {
        (storage::get_base_fee(&env), storage::get_metadata_fee(&env).unwrap())
    });
    assert_eq!(base, 1_000_000);
    assert_eq!(meta, 500_000);

    let payload = env.as_contract(&cid, || fee_change_payload(&env, 2_000_000, 750_000));
    let id = make_proposal(&env, &cid, &admin, ActionType::FeeChange, payload);

    vote_in_window(&env, &cid, id, 10, 2);
    finalize_queue_execute(&env, &cid, id);

    let (new_base, new_meta) = env.as_contract(&cid, || {
        (storage::get_base_fee(&env), storage::get_metadata_fee(&env).unwrap())
    });
    assert_eq!(new_base, 2_000_000);
    assert_eq!(new_meta, 750_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pause / unpause via governance
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn integration_test_pause_unpause_via_governance() {
    let (env, cid, admin, _) = setup();

    assert!(!env.as_contract(&cid, || storage::is_paused(&env)));

    let payload = env.as_contract(&cid, || pause_payload(&env));
    let id_pause = make_proposal(&env, &cid, &admin, ActionType::PauseContract, payload);
    vote_in_window(&env, &cid, id_pause, 8, 1);
    finalize_queue_execute(&env, &cid, id_pause);
    assert!(env.as_contract(&cid, || storage::is_paused(&env)));

    let payload2 = env.as_contract(&cid, || pause_payload(&env));
    let id_unpause = make_proposal(&env, &cid, &admin, ActionType::UnpauseContract, payload2);
    vote_in_window(&env, &cid, id_unpause, 8, 1);
    finalize_queue_execute(&env, &cid, id_unpause);
    assert!(!env.as_contract(&cid, || storage::is_paused(&env)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Treasury change via governance
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn integration_test_treasury_change_via_governance() {
    let (env, cid, admin, _) = setup();

    let new_treasury = Address::generate(&env);
    let payload = env.as_contract(&cid, || treasury_change_payload(&env, &new_treasury));
    let id = make_proposal(&env, &cid, &admin, ActionType::TreasuryChange, payload);

    vote_in_window(&env, &cid, id, 10, 3);
    finalize_queue_execute(&env, &cid, id);

    let treasury = env.as_contract(&cid, || storage::get_treasury(&env).unwrap());
    assert_eq!(treasury, new_treasury);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Proposal fails when quorum not met
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn integration_test_proposal_fails_quorum_not_met() {
    let (env, cid, admin, _) = setup();

    let payload = env.as_contract(&cid, || fee_change_payload(&env, 9_000_000, 9_000_000));
    let id = make_proposal(&env, &cid, &admin, ActionType::FeeChange, payload);

    // No votes — quorum not met.
    let p = env.as_contract(&cid, || get_proposal(&env, id).unwrap());
    env.ledger().with_mut(|li| { li.timestamp = p.end_time + 1; });
    env.as_contract(&cid, || { finalize_proposal(&env, id).unwrap(); });

    let state = env.as_contract(&cid, || get_proposal(&env, id).unwrap().state);
    assert_eq!(state, ProposalState::Failed);

    let queue_result = env.as_contract(&cid, || queue_proposal(&env, id));
    assert!(queue_result.is_err(), "cannot queue a failed proposal");

    let base = env.as_contract(&cid, || storage::get_base_fee(&env).unwrap());
    assert_eq!(base, 1_000_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Proposal defeated when approval threshold not met
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn integration_test_proposal_defeated_approval_not_met() {
    let (env, cid, admin, _) = setup();

    let payload = env.as_contract(&cid, || fee_change_payload(&env, 9_000_000, 9_000_000));
    let id = make_proposal(&env, &cid, &admin, ActionType::FeeChange, payload);

    // Quorum met (10 votes) but majority against (7 vs 3).
    vote_in_window(&env, &cid, id, 3, 7);

    let p = env.as_contract(&cid, || get_proposal(&env, id).unwrap());
    env.ledger().with_mut(|li| { li.timestamp = p.end_time + 1; });
    env.as_contract(&cid, || { finalize_proposal(&env, id).unwrap(); });

    let state = env.as_contract(&cid, || get_proposal(&env, id).unwrap().state);
    assert_eq!(state, ProposalState::Defeated);

    let queue_result = env.as_contract(&cid, || queue_proposal(&env, id));
    assert!(queue_result.is_err());

    let base = env.as_contract(&cid, || storage::get_base_fee(&env).unwrap());
    assert_eq!(base, 1_000_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Double-vote prevention
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn integration_test_double_vote_rejected() {
    let (env, cid, admin, _) = setup();

    let payload = env.as_contract(&cid, || pause_payload(&env));
    let id = make_proposal(&env, &cid, &admin, ActionType::PauseContract, payload);

    let voter = Address::generate(&env);
    let p = env.as_contract(&cid, || get_proposal(&env, id).unwrap());
    env.ledger().with_mut(|li| { li.timestamp = p.start_time + 1; });

    env.as_contract(&cid, || {
        vote_proposal(&env, &voter, id, VoteChoice::For).unwrap();
    });

    let second = env.as_contract(&cid, || vote_proposal(&env, &voter, id, VoteChoice::For));
    assert_eq!(second, Err(Error::AlreadyVoted));

    let (yes, no, _) = env.as_contract(&cid, || get_vote_counts(&env, id).unwrap());
    assert_eq!(yes, 1);
    assert_eq!(no, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Governance config update affects subsequent proposals
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn integration_test_governance_config_update_affects_proposals() {
    let (env, cid, admin, _) = setup();

    // Raise quorum to 80% — 5 votes will no longer meet quorum.
    env.as_contract(&cid, || {
        governance::update_governance_config(&env, &admin, Some(80), Some(51)).unwrap();
    });

    let payload = env.as_contract(&cid, || fee_change_payload(&env, 2_000_000, 750_000));
    let id = make_proposal(&env, &cid, &admin, ActionType::FeeChange, payload);

    vote_in_window(&env, &cid, id, 5, 0);

    let p = env.as_contract(&cid, || get_proposal(&env, id).unwrap());
    env.ledger().with_mut(|li| { li.timestamp = p.end_time + 1; });
    env.as_contract(&cid, || { finalize_proposal(&env, id).unwrap(); });

    let state = env.as_contract(&cid, || get_proposal(&env, id).unwrap().state);
    assert_eq!(state, ProposalState::Failed);

    let base = env.as_contract(&cid, || storage::get_base_fee(&env).unwrap());
    assert_eq!(base, 1_000_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Concurrent proposals have independent vote tallies
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn integration_test_concurrent_proposals_independent_tallies() {
    let (env, cid, admin, _) = setup();

    let payload_a = env.as_contract(&cid, || fee_change_payload(&env, 2_000_000, 750_000));
    let payload_b = env.as_contract(&cid, || pause_payload(&env));

    let id_a = make_proposal(&env, &cid, &admin, ActionType::FeeChange, payload_a);
    let id_b = make_proposal(&env, &cid, &admin, ActionType::PauseContract, payload_b);

    let p = env.as_contract(&cid, || get_proposal(&env, id_a).unwrap());
    env.ledger().with_mut(|li| { li.timestamp = p.start_time + 1; });

    env.as_contract(&cid, || {
        // A: 8 FOR, 2 AGAINST → Succeeded.
        for _ in 0..8 { vote_proposal(&env, &Address::generate(&env), id_a, VoteChoice::For).unwrap(); }
        for _ in 0..2 { vote_proposal(&env, &Address::generate(&env), id_a, VoteChoice::Against).unwrap(); }
        // B: 2 FOR, 8 AGAINST → Defeated.
        for _ in 0..2 { vote_proposal(&env, &Address::generate(&env), id_b, VoteChoice::For).unwrap(); }
        for _ in 0..8 { vote_proposal(&env, &Address::generate(&env), id_b, VoteChoice::Against).unwrap(); }
    });

    let p = env.as_contract(&cid, || get_proposal(&env, id_a).unwrap());
    env.ledger().with_mut(|li| { li.timestamp = p.end_time + 1; });

    env.as_contract(&cid, || {
        finalize_proposal(&env, id_a).unwrap();
        finalize_proposal(&env, id_b).unwrap();
    });

    let state_a = env.as_contract(&cid, || get_proposal(&env, id_a).unwrap().state);
    let state_b = env.as_contract(&cid, || get_proposal(&env, id_b).unwrap().state);
    assert_eq!(state_a, ProposalState::Succeeded);
    assert_eq!(state_b, ProposalState::Defeated);

    let (a_for, a_against, _) = env.as_contract(&cid, || get_vote_counts(&env, id_a).unwrap());
    let (b_for, b_against, _) = env.as_contract(&cid, || get_vote_counts(&env, id_b).unwrap());
    assert_eq!((a_for, a_against), (8, 2));
    assert_eq!((b_for, b_against), (2, 8));
}



