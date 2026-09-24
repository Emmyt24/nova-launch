//! Per-type FIFO execution queue for governance proposals (#1366).
//!
//! Time-locked proposals that mutate the *same* piece of state (for example two
//! consecutive fee-update proposals) must execute in a deterministic order,
//! otherwise the final state depends on the order in which `execute_proposal`
//! happens to be called. To guarantee determinism this module keeps one
//! ordered list of proposal ids per [`ActionType`]:
//!
//! - Proposals of the **same** type execute strictly in the order they were
//!   enqueued (FIFO). `execute_proposal` only permits the proposal at the front
//!   of its type queue to run.
//! - Proposals of **different** types live in independent queues and can be
//!   executed in any relative order — they touch disjoint state.
//!
//! # Storage layout
//! - [`DataKey::ProposalTypeQueue(action_type)`] → `Vec<u64>` ordered list of
//!   queued proposal ids; index `0` is the front (next to execute).
//!
//! # Relationship to [`crate::timelock`]
//! Enqueueing is a separate, explicit step performed after a proposal reaches
//! the [`ProposalState::Queued`] state (mirroring the existing
//! `proposal_queue` priority-queue design). A proposal that is never enqueued
//! into its type queue is unconstrained by FIFO ordering, which keeps purely
//! time-based execution paths unaffected.

use crate::events;
use crate::storage;
use crate::types::{ActionType, DataKey, Error, ProposalState};
use soroban_sdk::{Env, Vec};

pub const MAX_TYPE_QUEUE_LENGTH: u32 = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Return the FIFO queue (ordered list of proposal ids) for `action_type`.
///
/// Returns an empty vector if nothing of this type has been enqueued.
pub fn queue_for(env: &Env, action_type: ActionType) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&DataKey::ProposalTypeQueue(action_type))
        .unwrap_or_else(|| Vec::new(env))
}

fn set_queue(env: &Env, action_type: ActionType, queue: &Vec<u64>) {
    let key = DataKey::ProposalTypeQueue(action_type);
    if queue.is_empty() {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, queue);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/// Append a queued proposal to the FIFO execution queue for its action type.
///
/// The proposal must already be in [`ProposalState::Queued`] state (i.e.
/// `timelock::queue_proposal` must have been called first).
///
/// # Returns
/// The 0-based position the proposal occupies in its type queue. A return value
/// of `0` means the proposal is at the front and may be executed immediately
/// once its timelock (`eta`) has elapsed.
///
/// # Errors
/// * [`Error::ProposalNotFound`]  – proposal does not exist
/// * [`Error::InvalidParameters`] – proposal is not in `Queued` state, or it is
///   already present in its type queue (duplicate)
pub fn enqueue(env: &Env, proposal_id: u64) -> Result<u32, Error> {
    let proposal = storage::get_proposal(env, proposal_id).ok_or(Error::ProposalNotFound)?;

    if proposal.state != ProposalState::Queued {
        return Err(Error::InvalidParameters);
    }

    let action_type = proposal.action_type;
    let mut queue = queue_for(env, action_type);

    // Check queue length limit.
    if queue.len() >= MAX_TYPE_QUEUE_LENGTH {
        return Err(Error::InvalidParameters);
    }

    // Guard against duplicate entries.
    for id in queue.iter() {
        if id == proposal_id {
            return Err(Error::InvalidParameters);
        }
    }

    queue.push_back(proposal_id);
    let position = queue.len() - 1;
    set_queue(env, action_type, &queue);

    events::emit_type_queue_entry_added(env, proposal_id, action_type, position);

    Ok(position)
}

/// Return the front (next-to-execute) proposal id for `action_type`, if any.
pub fn front(env: &Env, action_type: ActionType) -> Option<u64> {
    queue_for(env, action_type).get(0)
}

/// Return the 0-based position of `proposal_id` within its type queue.
///
/// Returns `None` if the proposal does not exist or is not currently enqueued.
pub fn position(env: &Env, proposal_id: u64) -> Option<u32> {
    let proposal = storage::get_proposal(env, proposal_id)?;
    let queue = queue_for(env, proposal.action_type);
    for (i, id) in queue.iter().enumerate() {
        if id == proposal_id {
            return Some(i as u32);
        }
    }
    None
}

/// Enforce the FIFO invariant for `proposal_id` ahead of execution.
///
/// If the proposal is enqueued in its type queue it must be at the front
/// (index 0); otherwise execution is rejected. A proposal that is *not*
/// enqueued is unconstrained and passes this check, leaving non-FIFO execution
/// paths unaffected.
///
/// # Errors
/// * [`Error::ProposalNotAtQueueFront`] – proposal is enqueued but not at front
pub fn enforce_front(env: &Env, proposal_id: u64) -> Result<(), Error> {
    match position(env, proposal_id) {
        Some(0) => Ok(()),
        Some(_) => Err(Error::ProposalNotAtQueueFront),
        None => Ok(()), // not enqueued → no FIFO constraint
    }
}

/// Remove `proposal_id` from its type queue, regardless of position.
///
/// Called when a proposal is executed (it is always the front entry at that
/// point) or cancelled. A no-op if the proposal is not enqueued.
pub fn remove(env: &Env, proposal_id: u64) {
    let proposal = match storage::get_proposal(env, proposal_id) {
        Some(p) => p,
        None => return,
    };
    let action_type = proposal.action_type;
    let queue = queue_for(env, action_type);

    let mut next: Vec<u64> = Vec::new(env);
    let mut removed = false;
    for id in queue.iter() {
        if id == proposal_id && !removed {
            removed = true;
            continue;
        }
        next.push_back(id);
    }

    if removed {
        set_queue(env, action_type, &next);
        events::emit_type_queue_entry_removed(env, proposal_id, action_type);
    }
}

/// Number of proposals currently enqueued for `action_type`.
pub fn queue_len(env: &Env, action_type: ActionType) -> u32 {
    queue_for(env, action_type).len()
}
