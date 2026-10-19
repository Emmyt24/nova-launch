//! Proposal cancellation by the proposer before voting starts (#2239).
//!
//! A proposal is "pending" while it is `Active` and has not received any vote.
//! Only the proposer may cancel it, and only in that state.

use soroban_sdk::{contracterror, symbol_short, Address, Env};

use crate::storage;
use crate::types::ProposalStatus;

/// Errors returned by `cancel_proposal`.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum CancelError {
    /// No proposal with the given id.
    ProposalNotFound = 1,
    /// Caller is not the proposer.
    NotProposer = 2,
    /// Proposal already has votes or is no longer active.
    NotPending = 3,
}

/// Cancel `proposal_id` on behalf of `proposer`.
pub fn cancel_proposal(env: &Env, proposer: Address, proposal_id: u32) -> Result<(), CancelError> {
    proposer.require_auth();
    let mut proposal =
        storage::get_proposal(env, proposal_id).ok_or(CancelError::ProposalNotFound)?;
    if proposal.creator != proposer {
        return Err(CancelError::NotProposer);
    }
    if proposal.status != ProposalStatus::Active
        || proposal.votes_for != 0
        || proposal.votes_against != 0
    {
        return Err(CancelError::NotPending);
    }
    proposal.status = ProposalStatus::Cancelled;
    storage::set_proposal(env, proposal_id, &proposal);
    env.events()
        .publish((symbol_short!("prop_cxl"),), (proposal_id, proposer));
    Ok(())
}
