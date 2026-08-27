//! Cross-contract atomic settlement client. (#1624)
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

use soroban_sdk::{Address, Env, IntoVal, Symbol, Val, Vec};

use crate::types::{Disbursement, FinalizationError};

/// Local decode target for a token-factory contract error surfaced through
/// `try_invoke_contract`. token-factory's own `Error` type isn't available
/// here (different soroban-sdk major version), so only the raw numeric
/// error code is recovered — sufficient to know *that* commit failed.
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
pub fn execute_disbursement(
    env: &Env,
    token_factory: &Address,
    proposal_id: u32,
    disbursement: &Disbursement,
) -> Result<(), FinalizationError> {
    let this_contract = env.current_contract_address();

    let prepare_args: Vec<Val> = soroban_sdk::vec![
        env,
        this_contract.clone().into_val(env),
        (proposal_id as u64).into_val(env),
        disbursement.recipient.clone().into_val(env),
        disbursement.token_index.into_val(env),
        disbursement.amount.into_val(env),
    ];
    let reservation_id: u64 = env.invoke_contract(token_factory, &prepare_sym(env), prepare_args);

    let commit_args: Vec<Val> = soroban_sdk::vec![
        env,
        this_contract.clone().into_val(env),
        reservation_id.into_val(env),
    ];
    let commit_result =
        env.try_invoke_contract::<(), RemoteError>(token_factory, &commit_sym(env), commit_args);

    match commit_result {
        Ok(Ok(())) => Ok(()),
        _ => {
            let abort_args: Vec<Val> = soroban_sdk::vec![
                env,
                this_contract.into_val(env),
                reservation_id.into_val(env),
            ];
            let _: () = env.invoke_contract(token_factory, &abort_sym(env), abort_args);
            Err(FinalizationError::DisbursementFailed)
        }
    }
}
