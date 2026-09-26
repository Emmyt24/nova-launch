//! Tests for the two-phase settlement protocol (prepare → commit / abort).
//!
//! Because governance and token-factory pin different soroban-sdk major versions,
//! we register an in-crate mock contract instead of depending on the real
//! token-factory binary.  The mock exposes `prepare_settlement`,
//! `commit_settlement`, and `abort_settlement` with controllable success/failure
//! behaviour, matching the symbol names that `settlement::execute_disbursement`
//! invokes via `Env::invoke_contract` / `Env::try_invoke_contract`.

#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl,
    testutils::Address as _,
    Address, Bytes, Env, String,
};

use crate::{GovernanceContract, GovernanceContractClient};
use crate::types::{Disbursement, GovernanceProposal, ProposalStatus};

// ─── Mock token-factory ───────────────────────────────────────────────────

/// Shared flag: when `true`, `commit_settlement` succeeds; when `false`, it
/// panics, which causes `try_invoke_contract` to surface a contract error.
///
/// Stored as thread-local Cells — tests run single-threaded in the Soroban
/// test harness.
use std::cell::Cell;
thread_local! {
    static COMMIT_SHOULD_FAIL: Cell<bool> = Cell::new(false);
    static ABORT_WAS_CALLED: Cell<bool> = Cell::new(false);
    static COMMIT_WAS_CALLED: Cell<bool> = Cell::new(false);
}

fn set_commit_fails(fails: bool) {
    COMMIT_SHOULD_FAIL.with(|c| c.set(fails));
    ABORT_WAS_CALLED.with(|c| c.set(false));
    COMMIT_WAS_CALLED.with(|c| c.set(false));
}

fn abort_was_called() -> bool {
    ABORT_WAS_CALLED.with(|c| c.get())
}

fn commit_was_called() -> bool {
    COMMIT_WAS_CALLED.with(|c| c.get())
}

#[contract]
pub struct MockTokenFactory;

#[contractimpl]
impl MockTokenFactory {
    /// Reserve the disbursement.  Returns a deterministic reservation ID.
    pub fn prepare_settlement(
        _env: Env,
        _caller: Address,
        _proposal_id: u64,
        _recipient: Address,
        _token_index: u32,
        _amount: i128,
    ) -> u64 {
        // Return a fixed reservation ID so commit/abort can reference it.
        42_u64
    }

    /// Commit the reservation.  Panics if configured to fail, so that
    /// `try_invoke_contract` receives a contract-error result.
    pub fn commit_settlement(_env: Env, _caller: Address, _reservation_id: u64) {
        COMMIT_WAS_CALLED.with(|c| c.set(true));
        if COMMIT_SHOULD_FAIL.with(|c| c.get()) {
            panic!("mock: commit_settlement configured to fail");
        }
    }

    /// Abort the reservation.  Records that it was called.
    pub fn abort_settlement(_env: Env, _caller: Address, _reservation_id: u64) {
        ABORT_WAS_CALLED.with(|c| c.set(true));
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/// Deploy governance + mock token-factory, wire them together, and create a
/// Passed proposal with a Disbursement.  Returns (env, governance_client,
/// governance_contract_id, proposal_id).
fn setup_with_disbursement(
    commit_fails: bool,
) -> (Env, GovernanceContractClient<'static>, Address, u32) {
    set_commit_fails(commit_fails);

    let env = Env::default();
    env.mock_all_auths();

    // Deploy governance
    let gov_id = env.register_contract(None, GovernanceContract);
    let gov = GovernanceContractClient::new(&env, &gov_id);

    let admin = Address::generate(&env);
    gov.initialize(&admin, &10_000_000_i128);

    // Deploy mock token-factory
    let factory_id = env.register_contract(None, MockTokenFactory);

    // Wire the mock factory into governance
    gov.set_token_factory(&admin, &factory_id);

    // Create a proposal, vote it through, and finalize it as Passed
    let creator = Address::generate(&env);
    let voter = Address::generate(&env);
    gov.set_balance(&admin, &voter, &1_000_000_i128);

    let recipient = Address::generate(&env);
    let proposal_id = env.as_contract(&gov_id, || {
        use crate::storage;

        let pid = storage::get_proposal_count(&env);
        let voting_end = env.ledger().timestamp(); // already ended
        let proposal = GovernanceProposal {
            id: pid,
            creator: creator.clone(),
            description: String::from_str(&env, "disburse test"),
            voting_end,
            quorum: 1_i128,
            threshold_percent: 50,
            votes_for: 1_000_000_i128,
            votes_against: 0_i128,
            payload: Bytes::new(&env),
            status: ProposalStatus::Passed,
            disbursement: Some(Disbursement {
                recipient: recipient.clone(),
                token_index: 0,
                amount: 100_i128,
            }),
        };
        storage::set_proposal(&env, pid, &proposal);
        storage::set_proposal_count(&env, pid + 1);
        pid
    });

    (env, gov, gov_id, proposal_id)
}

// ─── Tests ────────────────────────────────────────────────────────────────

/// Happy path: execute_proposal with a Disbursement and a cooperating
/// mock factory should transition the proposal to Executed.
#[test]
fn settlement_happy_path_sets_executed_status() {
    let (env, gov, _gov_id, proposal_id) = setup_with_disbursement(false);

    // Advance ledger so voting_end has passed
    env.ledger().with_mut(|li| li.timestamp += 100);

    gov.execute_proposal(&proposal_id);

    let proposal = gov.get_proposal(&proposal_id).unwrap();
    assert_eq!(
        proposal.status,
        ProposalStatus::Executed,
        "proposal must be Executed after successful settlement"
    );
    assert!(commit_was_called(), "commit_settlement must have been invoked");
    assert!(!abort_was_called(), "abort_settlement must NOT have been called on success");
}

/// Abort path: when commit_settlement fails, execute_proposal must return
/// DisbursementFailed, call abort_settlement, and leave the proposal as Passed
/// (not Executed).
#[test]
fn settlement_abort_path_on_commit_failure() {
    let (env, gov, _gov_id, proposal_id) = setup_with_disbursement(true);

    env.ledger().with_mut(|li| li.timestamp += 100);

    let result = gov.try_execute_proposal(&proposal_id);
    assert!(
        result.is_err(),
        "execute_proposal must fail when commit_settlement fails"
    );

    let proposal = gov.get_proposal(&proposal_id).unwrap();
    assert_eq!(
        proposal.status,
        ProposalStatus::Passed,
        "proposal must remain Passed when disbursement fails (not Executed)"
    );
    assert!(abort_was_called(), "abort_settlement must have been called after commit failure");
}
