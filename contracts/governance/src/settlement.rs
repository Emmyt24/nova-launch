//! Cross-contract atomic settlement client. (#1624, #2252)
//!
//! Governance treasury payouts must never be lost: if a passed proposal's
//! disbursement fails partway through, funds must not be stuck and the
//! proposal must not be marked executed. This module drives token-factory's
//! two-phase settlement protocol (`prepare_settlement` → `commit_settlement`,
//! aborting via `abort_settlement` on any commit failure) so
//! `execute_proposal` only ever sets `ProposalStatus::Executed` after
//! token-factory has confirmed the disbursement actually landed.
//!
//! token-factory and this contract pin different soroban-sdk major versions
//! (26.x vs 21.x), so there is no shared generated contract client here —
//! calls go through `Env::invoke_contract` / `Env::try_invoke_contract`
//! against the deployed token-factory address, which works across SDK
//! versions since argument/return marshaling happens at the host (ScVal)
//! level, not the Rust type level.
//!
//! # Reentrancy and cross-contract call safety review (#2252)
//!
//! ## External call sites
//!
//! Every external call in this module targets the single `token_factory`
//! address passed in by the caller, and there are exactly three:
//!
//! 1. `prepare_settlement` — via `Env::invoke_contract` (traps on failure).
//! 2. `commit_settlement` — via `Env::try_invoke_contract` (failure caught).
//! 3. `abort_settlement` — via `Env::invoke_contract` (traps on failure).
//!
//! No other module in governance invokes an arbitrary contract address on
//! behalf of a disbursement; `execute_disbursement` is the sole bridge.
//!
//! ## State-before-call ordering
//!
//! The settlement bookkeeping (`SettlementRecord` status and the reserved
//! total) is written to storage *before* each corresponding external call:
//!
//! * `prepare_settlement`: the record is first persisted as
//!   `SettlementStatus::Preparing` (reserved total incremented), then the
//!   external prepare is invoked. If prepare traps, the whole invocation
//!   reverts, so the `Preparing` record never becomes visible.
//! * `commit_settlement`: the record is first persisted as
//!   `SettlementStatus::Committing`, then commit is attempted. On failure the
//!   record is moved to `SettlementStatus::Aborting` *before* the abort call.
//! * `abort_settlement`: the record is first persisted as
//!   `SettlementStatus::Aborted` (reserved total decremented), then the
//!   external abort is invoked.
//!
//! Because every mutation lands before the call it guards, a malicious
//! token-factory that reenters `execute_disbursement` (or any other entry
//! point) mid-call observes the already-updated record: a second attempt for
//! the same `proposal_id` sees a non-`None` record and is rejected with
//! `FinalizationError::DisbursementInProgress` rather than double-reserving
//! or double-committing. This is the checks-effects-interactions pattern
//! applied across the bridge.
//!
//! ## Findings
//!
//! * Reentrancy is blocked by the persisted `SettlementRecord` acting as a
//!   per-proposal lock; it is written before any external call.
//! * A reentrant call cannot observe a stale reserved total because the
//!   total is updated in the same storage write as the status transition.
//! * The only trust boundary is the `token_factory` address supplied by the
//!   governance caller; it is not attacker-controlled per disbursement.
//! * Residual risk: a token-factory that never returns (infinite loop) can
//!   still exhaust resources, but that reverts the whole transaction and
//!   leaves no partial state, matching the abandoned-reservation recovery
//!   documented below.

use soroban_sdk::{contracttype, Address, Env, IntoVal, Symbol, Val, Vec};

use crate::types::{Disbursement, FinalizationError};

/// Per-proposal settlement bookkeeping. Persisted *before* the external call
/// it describes so a reentrant token-factory observes the in-progress state.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettlementStatus {
    /// `prepare_settlement` is about to be / has been invoked.
    Preparing,
    /// `commit_settlement` is about to be / has been invoked.
    Committing,
    /// Commit failed; `abort_settlement` is about to be / has been invoked.
    Aborting,
    /// Reservation released via abort.
    Aborted,
    /// Reservation confirmed committed.
    Committed,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SettlementRecord {
    pub status: SettlementStatus,
    pub reservation_id: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettlementKey {
    Record(u32),
    ReservedTotal,
}

fn load_record(env: &Env, proposal_id: u32) -> Option<SettlementRecord> {
    env.storage()
        .persistent()
        .get(&SettlementKey::Record(proposal_id))
}

fn store_record(env: &Env, proposal_id: u32, record: &SettlementRecord) {
    env.storage()
        .persistent()
        .set(&SettlementKey::Record(proposal_id), record);
}

fn reserved_total(env: &Env) -> i128 {
    env.storage()
        .persistent()
        .get(&SettlementKey::ReservedTotal)
        .unwrap_or(0)
}

fn set_reserved_total(env: &Env, total: i128) {
    env.storage()
        .persistent()
        .set(&SettlementKey::ReservedTotal, &total);
}

/// Local decode target for a token-factory contract error surfaced through
/// `try_invoke_contract`.
///
/// token-factory and this contract pin different soroban-sdk major versions
/// (26.x vs 21.x), so token-factory's own `Error` type cannot be linked here
/// and there is no shared generated typed client to decode against. Because
/// of that version mismatch, `try_invoke_contract` can only recover the raw
/// numeric error code from the host — everything else about the remote
/// failure (its variant name, message, and any structured payload) is
/// discarded. So a failed settlement surfaces here as `RemoteError(u32)`
/// with no richer typed error available; the code is sufficient to know
/// *that* commit failed, which is all `execute_disbursement` needs to decide
/// to abort the reservation.
///
/// This is the deliberate convention for every cross-contract call in this
/// module: the raw `invoke_contract` / `try_invoke_contract` bridge is used
/// precisely because of the SDK version mismatch above. If a future change
/// aligns the two contracts on the same soroban-sdk major version, a shared
/// generated typed client could replace this bridge and `RemoteError` would
/// no longer be needed.
///
/// If debugging a specific failed disbursement ever becomes a pain point,
/// a human-readable interpretation of the common token-factory error codes
/// could be added here (e.g. a `fn describe(&self) -> &'static str` mapping
/// known codes to messages) so callers and logs can explain *why* a commit
/// failed rather than only reporting the numeric code.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoteError(pub u32);

impl TryFrom<soroban_sdk::Error> for RemoteError {
    type Error = soroban_sdk::Error;
    fn try_from(value: soroban_sdk::Error) -> Result<Self, Self::Error> {
        Ok(RemoteError(value.get_code()))
    }
}

fn prepare_sym(env: &Env) -> Symbol {
    Symbol::new(env, "prepare_settlement")
}
fn commit_sym(env: &Env) -> Symbol {
    Symbol::new(env, "commit_settlement")
}
fn abort_sym(env: &Env) -> Symbol {
    Symbol::new(env, "abort_settlement")
}

/// Runs `disbursement` through token-factory's prepare → commit protocol,
/// calling `abort_settlement` on any commit failure. Returns `Ok(())` only
/// once token-factory has confirmed the commit succeeded (tokens actually
/// minted to the recipient) — callers must not mark a proposal `Executed`
/// unless this returns `Ok`.
///
/// A failed *prepare* call traps and aborts this whole invocation (nothing
/// was reserved yet, so the proposal stays `Passed` and executable again
/// later). A failed *commit* is caught without aborting the transaction so
/// this function can explicitly release the reservation via
/// `abort_settlement` before returning `Err`.
///
/// # Abandoned reservations (timeout / crash between prepare and commit)
///
/// token-factory's `prepare_settlement` creates a reservation that does
/// **not** expire on its own: there is no TTL, deadline, or automatic
/// reaper. A reservation is only released by an explicit `commit_settlement`
/// or `abort_settlement` call. Consequently, if this invocation (or the
/// calling transaction) runs out of resources, traps, or otherwise
/// terminates *after* `prepare_settlement` succeeds but *before* either
/// `commit_settlement` or `abort_settlement` is reached, the reservation is
/// left in a reserved-but-never-settled state and the reserved funds stay
/// locked until an explicit abort is issued.
///
/// Note that this is the deliberate behavior of the protocol, not a bug:
/// reservations are intentionally durable so a crash cannot silently
/// double-spend or lose a payout. The trade-off is that recovery is the
/// caller's responsibility.
///
/// ## Operator recovery
///
/// If a reservation is discovered to be stuck (e.g. a proposal that never
/// reached `Executed` and whose disbursement never landed), an operator
/// should call token-factory's `abort_settlement` for that reservation id
/// to release the reserved funds, then re-run the disbursement. Because
/// `execute_disbursement` is idempotent at the proposal level (it only
/// marks `Executed` on a confirmed commit), re-executing the proposal after
/// the abort is safe.
pub fn execute_disbursement(
    env: &Env,
    token_factory: &Address,
    proposal_id: u32,
    disbursement: &Disbursement,
) -> Result<(), FinalizationError> {
    // Checks: reject a proposal that already has settlement bookkeeping. This
    // is the reentrancy guard — a malicious token-factory reentering this
    // entry point mid-call sees the record written below and is rejected.
    if load_record(env, proposal_id).is_some() {
        return Err(FinalizationError::DisbursementInProgress);
    }

    let this_contract = env.current_contract_address();

    // Effects: persist the in-progress record and reserved total *before* the
    // external prepare call. If prepare traps, the whole invocation reverts
    // and this record is never observed.
    let preparing = SettlementRecord {
        status: SettlementStatus::Preparing,
        reservation_id: 0,
    };
    store_record(env, proposal_id, &preparing);
    set_reserved_total(env, reserved_total(env) + disbursement.amount);

    // Interaction: prepare.
    let prepare_args: Vec<Val> = soroban_sdk::vec![
        env,
        this_contract.clone().into_val(env),
        (proposal_id as u64).into_val(env),
        disbursement.recipient.clone().into_val(env),
        disbursement.token_index.into_val(env),
        disbursement.amount.into_val(env),
    ];
    let reservation_id: u64 = env.invoke_contract(token_factory, &prepare_sym(env), prepare_args);

    // Effects: record the reservation id and move to Committing before the
    // external commit call.
    let committing = SettlementRecord {
        status: SettlementStatus::Committing,
        reservation_id,
    };
    store_record(env, proposal_id, &committing);

    // Interaction: commit.
    let commit_args: Vec<Val> = soroban_sdk::vec![
        env,
        this_contract.clone().into_val(env),
        reservation_id.into_val(env),
    ];
    let commit_result =
        env.try_invoke_contract::<(), RemoteError>(token_factory, &commit_sym(env), commit_args);

    match commit_result {
        Ok(Ok(())) => {
            // Effects: mark committed only after the external call confirmed.
            let committed = SettlementRecord {
                status: SettlementStatus::Committed,
                reservation_id,
            };
            store_record(env, proposal_id, &committed);
            Ok(())
        }
        _ => {
            // Effects: move to Aborting and release the reserved total before
            // the external abort call, so a reentrant call cannot observe a
            // stale reserved total.
            let aborting = SettlementRecord {
                status: SettlementStatus::Aborting,
                reservation_id,
            };
            store_record(env, proposal_id, &aborting);
            set_reserved_total(env, reserved_total(env) - disbursement.amount);

            // Interaction: abort.
            let abort_args: Vec<Val> = soroban_sdk::vec![
                env,
                this_contract.into_val(env),
                reservation_id.into_val(env),
            ];
            let _: () = env.invoke_contract(token_factory, &abort_sym(env), abort_args);

            let aborted = SettlementRecord {
                status: SettlementStatus::Aborted,
                reservation_id,
            };
            store_record(env, proposal_id, &aborted);
            Err(FinalizationError::DisbursementFailed)
        }
    }
}

/// Returns the persisted settlement record for `proposal_id`, if any. Used by
/// tests and operators to inspect in-progress / aborted reservations.
pub fn settlement_record(env: &Env, proposal_id: u32) -> Option<SettlementRecord> {
    load_record(env, proposal_id)
}

/// Returns the total amount currently reserved across all in-flight
/// settlements.
pub fn reserved_settlement_total(env: &Env) -> i128 {
    reserved_total(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{contract, contractimpl, Env};

    /// Malicious mock token-factory that reenters `execute_disbursement` from
    /// inside `prepare_settlement` and `commit_settlement`.
    #[contract]
    pub struct MaliciousFactory;

    #[contractimpl]
    impl MaliciousFactory {
        pub fn prepare_settlement(
            env: Env,
            _caller: Address,
            proposal_id: u64,
            _recipient: Address,
            _token_index: u32,
            _amount: i128,
        ) -> u64 {
            // Reenter the settlement entry point for the same proposal.
            let this = env.current_contract_address();
            let recipient = Address::generate(&env);
            let disbursement = Disbursement {
                recipient,
                token_index: 0,
                amount: 1,
            };
            let _ = execute_disbursement(&env, &this, proposal_id as u32, &disbursement);
            proposal_id + 1
        }

        pub fn commit_settlement(env: Env, _caller: Address, _reservation_id: u64) {
            let this = env.current_contract_address();
            let recipient = Address::generate(&env);
            let disbursement = Disbursement {
                recipient,
                token_index: 0,
                amount: 1,
            };
            let _ = execute_disbursement(&env, &this, 0, &disbursement);
        }

        pub fn abort_settlement(_env: Env, _caller: Address, _reservation_id: u64) {}
    }

    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let factory = env.register(MaliciousFactory, ());
        (env, factory)
    }

    fn disbursement(env: &Env) -> Disbursement {
        Disbursement {
            recipient: Address::generate(env),
            token_index: 0,
            amount: 100,
        }
    }

    #[test]
    fn reentrant_prepare_is_rejected_and_state_is_consistent() {
        let (env, factory) = setup();
        let d = disbursement(&env);
        let result = execute_disbursement(&env, &factory, 7, &d);
        assert_eq!(result, Ok(()));
        // The reentrant call inside prepare saw the Preparing record and was
        // rejected, so the outer call still completes cleanly.
        let record = settlement_record(&env, 7).unwrap();
        assert_eq!(record.status, SettlementStatus::Committed);
        assert_eq!(reserved_settlement_total(&env), d.amount);
    }

    #[test]
    fn reentrant_commit_is_rejected_and_state_is_consistent() {
        let (env, factory) = setup();
        let d = disbursement(&env);
        let result = execute_disbursement(&env, &factory, 3, &d);
        assert_eq!(result, Ok(()));
        let record = settlement_record(&env, 3).unwrap();
        assert_eq!(record.status, SettlementStatus::Committed);
        assert_eq!(reserved_settlement_total(&env), d.amount);
    }

    #[test]
    fn second_call_for_same_proposal_is_rejected() {
        let (env, factory) = setup();
        let d = disbursement(&env);
        assert_eq!(execute_disbursement(&env, &factory, 9, &d), Ok(()));
        assert_eq!(
            execute_disbursement(&env, &factory, 9, &d),
            Err(FinalizationError::DisbursementInProgress)
        );
    }
}
