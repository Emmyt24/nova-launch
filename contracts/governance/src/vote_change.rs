//! Optional vote-change window (#2240).
//!
//! When the admin enables a window of `N` seconds, a voter may flip an existing
//! vote until `voting_end - N` (saturating). The originally recorded weight is
//! moved between the for/against tallies, so totals stay consistent.
//! Disabled by default.

use soroban_sdk::{contracterror, contracttype, symbol_short, Address, Env};

use crate::storage;
use crate::types::{Error, ProposalStatus};

/// Storage key private to the vote-change feature.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoteChangeKey {
    /// Seconds before `voting_end` at which vote changes close.
    Window,
}

/// Errors returned by `change_vote`.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VoteChangeError {
    /// No proposal with the given id.
    ProposalNotFound = 1,
    /// Proposal is not active.
    ProposalNotActive = 2,
    /// Vote changes are not enabled.
    ChangesDisabled = 3,
    /// The change deadline has passed.
    WindowClosed = 4,
    /// The voter has not voted on this proposal.
    NoExistingVote = 5,
    /// The new choice equals the existing one.
    SameVote = 6,
    /// Tally arithmetic failed.
    Overflow = 7,
}

/// Return the configured window (seconds before voting end), if enabled.
pub fn get_window(env: &Env) -> Option<u64> {
    env.storage().instance().get(&VoteChangeKey::Window)
}

/// Admin-only: enable (`Some(secs)`) or disable (`None`) vote changes.
pub fn set_window(env: &Env, admin: Address, window: Option<u64>) -> Result<(), Error> {
    admin.require_auth();
    if admin != storage::get_admin(env) {
        return Err(Error::Unauthorized);
    }
    match window {
        Some(w) => env.storage().instance().set(&VoteChangeKey::Window, &w),
        None => env.storage().instance().remove(&VoteChangeKey::Window),
    }
    Ok(())
}

/// Change `voter`'s existing vote on `proposal_id` to `in_favor`.
pub fn change_vote(
    env: &Env,
    voter: Address,
    proposal_id: u32,
    in_favor: bool,
) -> Result<(), VoteChangeError> {
    voter.require_auth();
    let mut proposal =
        storage::get_proposal(env, proposal_id).ok_or(VoteChangeError::ProposalNotFound)?;
    if proposal.status != ProposalStatus::Active {
        return Err(VoteChangeError::ProposalNotActive);
    }
    let window = get_window(env).ok_or(VoteChangeError::ChangesDisabled)?;
    let deadline = proposal.voting_end.saturating_sub(window);
    if env.ledger().timestamp() > deadline {
        return Err(VoteChangeError::WindowClosed);
    }
    let mut vote =
        storage::get_vote(env, proposal_id, &voter).ok_or(VoteChangeError::NoExistingVote)?;
    if vote.in_favor == in_favor {
        return Err(VoteChangeError::SameVote);
    }
    let weight = vote.weight;
    if in_favor {
        proposal.votes_against = proposal
            .votes_against
            .checked_sub(weight)
            .ok_or(VoteChangeError::Overflow)?;
        proposal.votes_for = proposal
            .votes_for
            .checked_add(weight)
            .ok_or(VoteChangeError::Overflow)?;
    } else {
        proposal.votes_for = proposal
            .votes_for
            .checked_sub(weight)
            .ok_or(VoteChangeError::Overflow)?;
        proposal.votes_against = proposal
            .votes_against
            .checked_add(weight)
            .ok_or(VoteChangeError::Overflow)?;
    }
    vote.in_favor = in_favor;
    storage::set_vote(env, proposal_id, &voter, &vote);
    storage::set_proposal(env, proposal_id, &proposal);
    env.events().publish(
        (symbol_short!("vote_chg"),),
        (proposal_id, voter, in_favor, weight),
    );
    Ok(())
}
