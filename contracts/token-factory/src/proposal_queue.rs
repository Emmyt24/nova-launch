//! Proposal Execution Queue with Priority Ordering
//!
//! Implements a persistent priority queue for governance proposals.
//! Proposals are ordered by [`ProposalPriority`] (descending) and, within
//! the same priority, by `enqueued_at` timestamp (ascending — FIFO).
//!
//! # Storage layout
//! - `DataKey::QueueSize`      – monotonic counter; total entries ever added
//! - `DataKey::QueueEntry(i)`  – the [`QueueEntry`] at slot `i`
//!
//! Entries are never physically removed from storage; instead a slot is
//! cleared (removed) once the entry is dequeued or executed.  The queue
//! scan is O(n) over live slots, which is acceptable for governance queues
//! that are expected to hold at most a few dozen entries at any time.
//!
//! # Performance Characteristics
//! - `enqueue_proposal`: O(n) – scans queue to check for duplicates
//! - `peek_next`: O(n) – full scan to find highest-priority ready entry
//! - `dequeue_next`: O(n) – full scan to find and remove highest-priority ready entry
//! - `remove_from_queue`: O(n) – linear search by proposal_id
//! - `queue_len`: O(n) – counts live (non-cleared) slots
//!
//! The O(n) cost is acceptable because:
//! 1. Governance queues typically have ≤50 proposals pending at any time
//! 2. Timelock delays (hours/days) mean queue operations are infrequent
//! 3. Priority ordering requires comparing all ready entries anyway
//!
//! Future optimization opportunities (if queue size grows):
//! 1. Maintain a separate index mapping proposal_id → slot for O(1) duplicate detection
//! 2. Keep a "head" pointer for high-priority entries to skip full scans
//! 3. Use a binary heap-style structure (requires custom serialization)

use crate::events;
use crate::storage;
use crate::timelock::execute_proposal;
use crate::types::{DataKey, Error, ProposalPriority, ProposalState, QueueEntry};
use soroban_sdk::Env;

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Return the total number of slots ever allocated (not the live count).
fn queue_size(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::QueueSize)
        .unwrap_or(0u32)
}

fn set_queue_size(env: &Env, size: u32) {
    env.storage().instance().set(&DataKey::QueueSize, &size);
}

fn get_slot(env: &Env, index: u32) -> Option<QueueEntry> {
    env.storage()
        .persistent()
        .get(&DataKey::QueueEntry(index))
}

fn set_slot(env: &Env, index: u32, entry: &QueueEntry) {
    env.storage()
        .persistent()
        .set(&DataKey::QueueEntry(index), entry);
}

fn clear_slot(env: &Env, index: u32) {
    env.storage()
        .persistent()
        .remove(&DataKey::QueueEntry(index));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/// Add a queued proposal to the priority queue.
///
/// The proposal must already be in [`ProposalState::Queued`] state (i.e.
/// `queue_proposal` from `timelock.rs` must have been called first).
///
/// # Arguments
/// * `env`         – contract environment
/// * `proposal_id` – id of the proposal to enqueue
/// * `priority`    – execution priority for this proposal
///
/// # Returns
/// The slot index assigned to this entry.
///
/// # Errors
/// * [`Error::ProposalNotFound`]   – proposal does not exist
/// * [`Error::InvalidParameters`]  – proposal is not in `Queued` state, or
///                                   it is already present in the queue
pub fn enqueue_proposal(
    env: &Env,
    proposal_id: u64,
    priority: ProposalPriority,
) -> Result<u32, Error> {
    let proposal =
        storage::get_proposal(env, proposal_id).ok_or(Error::ProposalNotFound)?;

    if proposal.state != ProposalState::Queued {
        return Err(Error::InvalidParameters);
    }

    // Guard against duplicate entries
    let size = queue_size(env);
    for i in 0..size {
        if let Some(entry) = get_slot(env, i) {
            if entry.proposal_id == proposal_id {
                return Err(Error::InvalidParameters);
            }
        }
    }

    let slot = size;
    let entry = QueueEntry {
        proposal_id,
        priority,
        enqueued_at: env.ledger().timestamp(),
        eta: proposal.eta,
    };
    set_slot(env, slot, &entry);
    set_queue_size(env, size + 1);

    events::emit_queue_entry_added(env, proposal_id, priority, proposal.eta);

    Ok(slot)
}

/// Return the highest-priority entry that is ready to execute (eta ≤ now),
/// without removing it from the queue.
///
/// Among entries with equal priority the one with the smallest `enqueued_at`
/// is preferred (FIFO within a priority band).
///
/// Returns `None` if the queue is empty or no entry has reached its eta.
pub fn peek_next(env: &Env) -> Option<QueueEntry> {
    let now = env.ledger().timestamp();
    let size = queue_size(env);
    let mut best: Option<QueueEntry> = None;

    for i in 0..size {
        if let Some(entry) = get_slot(env, i) {
            if entry.eta > now {
                continue; // timelock not yet expired
            }
            best = Some(match best {
                None => entry,
                Some(ref b) => {
                    if entry.priority > b.priority
                        || (entry.priority == b.priority && entry.enqueued_at < b.enqueued_at)
                    {
                        entry
                    } else {
                        b.clone()
                    }
                }
            });
        }
    }
    best
}

/// Remove and return the highest-priority ready entry from the queue.
///
/// Same ordering semantics as [`peek_next`].
///
/// # Errors
/// * [`Error::NothingToClaim`] – queue is empty or no entry is ready yet
pub fn dequeue_next(env: &Env) -> Result<QueueEntry, Error> {
    let now = env.ledger().timestamp();
    let size = queue_size(env);

    let mut best_slot: Option<u32> = None;
    let mut best_entry: Option<QueueEntry> = None;

    for i in 0..size {
        if let Some(entry) = get_slot(env, i) {
            if entry.eta > now {
                continue;
            }
            let is_better = match best_entry {
                None => true,
                Some(ref b) => {
                    entry.priority > b.priority
                        || (entry.priority == b.priority && entry.enqueued_at < b.enqueued_at)
                }
            };
            if is_better {
                best_slot = Some(i);
                best_entry = Some(entry);
            }
        }
    }

    match (best_slot, best_entry) {
        (Some(slot), Some(entry)) => {
            clear_slot(env, slot);
            events::emit_queue_entry_removed(env, entry.proposal_id, entry.priority);
            Ok(entry)
        }
        _ => Err(Error::NothingToClaim),
    }
}

/// Execute the next highest-priority proposal whose timelock has expired.
///
/// Combines [`dequeue_next`] with [`execute_proposal`] from `timelock.rs`.
///
/// # Returns
/// The `proposal_id` that was executed.
///
/// # Errors
/// * [`Error::NothingToClaim`]    – no ready entry in the queue
/// * Any error propagated from `execute_proposal`
pub fn execute_next_in_queue(env: &Env) -> Result<u64, Error> {
    let entry = dequeue_next(env)?;
    execute_proposal(env, entry.proposal_id)?;
    Ok(entry.proposal_id)
}

/// Return the number of live (not yet executed) entries in the queue.
pub fn queue_len(env: &Env) -> u32 {
    let size = queue_size(env);
    let mut count = 0u32;
    for i in 0..size {
        if get_slot(env, i).is_some() {
            count += 1;
        }
    }
    count
}

/// Remove a specific proposal from the queue without executing it.
///
/// Used when a proposal is cancelled after being enqueued.
///
/// # Errors
/// * [`Error::ProposalNotFound`] – proposal is not in the queue
pub fn remove_from_queue(env: &Env, proposal_id: u64) -> Result<(), Error> {
    let size = queue_size(env);
    for i in 0..size {
        if let Some(entry) = get_slot(env, i) {
            if entry.proposal_id == proposal_id {
                clear_slot(env, i);
                events::emit_queue_entry_removed(env, proposal_id, entry.priority);
                return Ok(());
            }
        }
    }
    Err(Error::ProposalNotFound)
}
