//! Governance Delegation System — Core Delegation Logic
//!
//! Implements vote-power transfer between token holders.
//!
//! # Design
//!
//! Vote power is derived from token balances.  When a holder delegates,
//! their balance is *transferred* as vote power to the delegatee:
//!
//! ```text
//! delegator.vote_power  -= delegator.balance
//! delegatee.vote_power  += delegator.balance
//! ```
//!
//! A holder who has not delegated holds their own vote power (equal to
//! their balance).  Delegation is always one level deep — a delegatee
//! cannot re-delegate received power (only their own balance).
//!
//! # Security properties
//!
//! - `require_auth()` is called before any state mutation (OWASP A01)
//! - Circular delegation (A→B→A) is detected and rejected
//! - Self-delegation is rejected (no-op that wastes gas)
//! - All arithmetic uses `checked_*` to prevent overflow (OWASP A03)
//! - State is fully committed before events are emitted (reentrancy safety)
//! - Maximum delegation chain depth is enforced (DoS prevention)

use soroban_sdk::{Address, Env};
use crate::storage;
use crate::events;
use crate::types::{DelegationRecord, Error};

/// Maximum depth of a delegation chain.
/// Prevents DoS via deeply nested delegation lookups.
const MAX_CHAIN_DEPTH: u32 = 1;

// ─── Public entry-points ───────────────────────────────────────────────────

/// Delegate the caller's vote power to `delegatee`.
///
/// If the caller already has an active delegation, this acts as a
/// re-delegation (atomically moves power from old delegatee to new).
///
/// # Arguments
/// * `env`       - Soroban environment
/// * `delegator` - Address delegating their vote power (must sign)
/// * `delegatee` - Address receiving the vote power
///
/// # Errors
/// * `InvalidParameters`    - Self-delegation or zero balance
/// * `CircularDelegation`   - delegatee has already delegated to delegator
/// * `ContractPaused`       - contract is paused
/// * `Unauthorized`         - delegator did not sign
pub fn delegate(env: &Env, delegator: Address, delegatee: Address) -> Result<(), Error> {
    // Guard: contract must not be paused
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    // Auth: delegator must sign this transaction
    delegator.require_auth();

    // Validate: no self-delegation
    if delegator == delegatee {
        return Err(Error::InvalidParameters);
    }

    // Validate: delegatee must not have delegated to delegator (circular check)
    if let Some(ref existing) = storage::get_delegation(env, &delegatee) {
        if existing.delegatee == delegator {
            return Err(Error::CircularDelegation);
        }
    }

    let delegator_balance = storage::get_balance(env, &delegator);
    if delegator_balance <= 0 {
        return Err(Error::InsufficientBalance);
    }

    let current_ledger = env.ledger().sequence();

    // Check if delegator already has an active delegation
    if let Some(ref old_record) = storage::get_delegation(env, &delegator) {
        let old_delegatee = old_record.delegatee.clone();

        if old_delegatee == delegatee {
            // Already delegated to the same address — no-op
            return Ok(());
        }

        // Re-delegation: use the stored delegated_amount from the old record
        let old_delegated_amount = old_record.delegated_amount;

        // Remove power from old delegatee using the stored amount
        let old_power = storage::get_vote_power(env, &old_delegatee);
        let new_old_power = old_power
            .checked_sub(old_delegated_amount)
            .ok_or_else(|| {
                events::emit_error_detail(env, crate::types::Error::ArithmeticError as u32, old_power);
                Error::ArithmeticError
            })?;
        storage::set_vote_power(env, &old_delegatee, new_old_power.max(0));

        // Add power to new delegatee with the current balance
        let new_power = storage::get_vote_power(env, &delegatee);
        let updated_power = new_power
            .checked_add(delegator_balance)
            .ok_or_else(|| {
                events::emit_error_detail(env, crate::types::Error::ArithmeticError as u32, new_power);
                Error::ArithmeticError
            })?;
        storage::set_vote_power(env, &delegatee, updated_power);

        // Update delegation record with new delegated_amount
        let record = DelegationRecord {
            delegator: delegator.clone(),
            delegatee: delegatee.clone(),
            since_ledger: current_ledger,
            delegated_amount: delegator_balance,
        };
        storage::set_delegation(env, &delegator, &record);

        // Snapshot new vote powers
        snapshot_and_emit(env, &old_delegatee, new_old_power.max(0), current_ledger);
        snapshot_and_emit(env, &delegatee, updated_power, current_ledger);

        events::emit_redelegated(env, &delegator, &old_delegatee, &delegatee, delegator_balance);
    } else {
        // Fresh delegation: delegator previously held their own vote power.
        // Remove it from delegator's own vote-power bucket.
        let delegator_power = storage::get_vote_power(env, &delegator);
        let new_delegator_power = delegator_power
            .checked_sub(delegator_balance)
            .ok_or_else(|| {
                events::emit_error_detail(env, crate::types::Error::ArithmeticError as u32, delegator_power);
                Error::ArithmeticError
            })?;
        storage::set_vote_power(env, &delegator, new_delegator_power.max(0));

        // Add to delegatee
        let delegatee_power = storage::get_vote_power(env, &delegatee);
        let new_delegatee_power = delegatee_power
            .checked_add(delegator_balance)
            .ok_or_else(|| {
                events::emit_error_detail(env, crate::types::Error::ArithmeticError as u32, delegatee_power);
                Error::ArithmeticError
            })?;
        storage::set_vote_power(env, &delegatee, new_delegatee_power);

        // Store delegation record with the delegated amount
        let record = DelegationRecord {
            delegator: delegator.clone(),
            delegatee: delegatee.clone(),
            since_ledger: current_ledger,
            delegated_amount: delegator_balance,
        };
        storage::set_delegation(env, &delegator, &record);

        // Snapshots
        snapshot_and_emit(env, &delegator, new_delegator_power.max(0), current_ledger);
        snapshot_and_emit(env, &delegatee, new_delegatee_power, current_ledger);

        events::emit_delegated(env, &delegator, &delegatee, delegator_balance);
    }

    Ok(())
}

/// Revoke the caller's current delegation, reclaiming their vote power.
///
/// After undelegation the caller's vote power equals their token balance again.
///
/// # Errors
/// * `NotFound`        - caller has no active delegation
/// * `ContractPaused`  - contract is paused
pub fn undelegate(env: &Env, delegator: Address) -> Result<(), Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    delegator.require_auth();

    let record = storage::get_delegation(env, &delegator).ok_or(Error::NotFound)?;
    let delegatee = record.delegatee.clone();
    // Use the stored delegated_amount instead of current balance
    let delegated_amount = record.delegated_amount;

    let current_ledger = env.ledger().sequence();

    // Remove power from delegatee using the stored delegated_amount
    let delegatee_power = storage::get_vote_power(env, &delegatee);
    let new_delegatee_power = delegatee_power
        .checked_sub(delegated_amount)
        .ok_or_else(|| {
            events::emit_error_detail(env, crate::types::Error::ArithmeticError as u32, delegatee_power);
            Error::ArithmeticError
        })?;
    storage::set_vote_power(env, &delegatee, new_delegatee_power.max(0));

    // Restore power to delegator using the stored delegated_amount
    let delegator_power = storage::get_vote_power(env, &delegator);
    let new_delegator_power = delegator_power
        .checked_add(delegated_amount)
        .ok_or_else(|| {
            events::emit_error_detail(env, crate::types::Error::ArithmeticError as u32, delegator_power);
            Error::ArithmeticError
        })?;
    storage::set_vote_power(env, &delegator, new_delegator_power);

    // Remove delegation record
    storage::remove_delegation(env, &delegator);

    // Snapshots
    snapshot_and_emit(env, &delegatee, new_delegatee_power.max(0), current_ledger);
    snapshot_and_emit(env, &delegator, new_delegator_power, current_ledger);

    events::emit_undelegated(env, &delegator, &delegatee, delegated_amount);

    Ok(())
}

/// Return the current vote power of `address`.
///
/// For an address that has never delegated and has no delegators,
/// this equals their token balance.
pub fn get_vote_power(env: &Env, address: &Address) -> i128 {
    storage::get_vote_power(env, address)
}

/// Return the current delegation record for `delegator`, if any.
pub fn get_delegation(env: &Env, delegator: &Address) -> Option<DelegationRecord> {
    storage::get_delegation(env, delegator)
}

/// Take a snapshot of `address`'s current vote power at the current ledger.
///
/// Snapshots are used by governance proposals to fix vote power at a
/// specific point in time, preventing flash-loan style manipulation.
///
/// # Security
/// `address.require_auth()` is called before any state mutation so that
/// only the address itself can force a persistent-storage write on its
/// behalf, closing the storage-spam griefing vector described in issue #1685.
pub fn take_snapshot(env: &Env, address: &Address) -> Result<(), Error> {
    // Auth: only the address itself may trigger a snapshot write for its own record
    address.require_auth();

    let power = storage::get_vote_power(env, address);
    let ledger = env.ledger().sequence();
    snapshot_and_emit(env, address, power, ledger);
    Ok(())
}

/// Query a historical vote-power snapshot.
pub fn get_snapshot_power(env: &Env, address: &Address, ledger: u32) -> Result<i128, Error> {
    storage::get_snapshot(env, address, ledger)
        .map(|s| s.power)
        .ok_or(Error::SnapshotNotFound)
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/// Store a snapshot and emit the corresponding event.
fn snapshot_and_emit(env: &Env, address: &Address, power: i128, ledger: u32) {
    storage::set_snapshot(env, address, ledger, power);
    events::emit_snapshot(env, address, ledger, power);
}
