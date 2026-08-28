/// Snapshot Module
///
/// Records point-in-time balance and supply snapshots on every mint/burn,
/// enabling historical queries needed by the dividend distribution engine.
///
/// Storage layout:
/// - `BalanceSnapshotCount(token_index, holder)` → u32
/// - `BalanceSnapshot(token_index, holder, idx)` → BalanceSnapshot
/// - `SupplySnapshotCount(token_index)` → u32
/// - `SupplySnapshot(token_index, idx)` → SupplySnapshot
use soroban_sdk::{Address, Env};

use crate::{
    storage,
    types::{BalanceSnapshot, DataKey, Error, SupplySnapshot},
};

// ─────────────────────────────────────────────
// Balance snapshots
// ─────────────────────────────────────────────

/// Record the current balance for `holder` at the current ledger.
///
/// Called by mint/burn after updating storage.  Errors are swallowed by the
/// caller (`let _ = ...`) so a snapshot failure never reverts the primary op.
pub fn record_balance_snapshot(
    env: &Env,
    token_index: u32,
    holder: &Address,
    balance: i128,
) -> Result<(), Error> {
    let count_key = DataKey::BalanceSnapshotCount(token_index, holder.clone());
    let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);

    let snap = BalanceSnapshot {
        ledger: env.ledger().sequence(),
        timestamp: env.ledger().timestamp(),
        balance,
    };

    env.storage().persistent().set(
        &DataKey::BalanceSnapshot(token_index, holder.clone(), count),
        &snap,
    );
    env.storage().persistent().set(&count_key, &(count + 1));

    storage::bump_persistent(
        env,
        &DataKey::BalanceSnapshot(token_index, holder.clone(), count),
    );
    storage::bump_persistent(env, &count_key);

    Ok(())
}

/// Return the number of balance snapshots recorded for `holder`.
pub fn get_balance_snapshot_count(env: &Env, token_index: u32, holder: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::BalanceSnapshotCount(token_index, holder.clone()))
        .unwrap_or(0)
}

/// Return the snapshot at index `idx`, or `None` if out of bounds.
pub fn get_balance_snapshot(
    env: &Env,
    token_index: u32,
    holder: &Address,
    idx: u32,
) -> Option<BalanceSnapshot> {
    env.storage()
        .persistent()
        .get(&DataKey::BalanceSnapshot(token_index, holder.clone(), idx))
}

/// Return the holder's balance at or immediately before `target_ledger`.
///
/// Uses a linear scan from newest to oldest (snapshots are appended, so the
/// newest has the highest index).  For typical token holder histories (tens to
/// low-hundreds of snapshots) this is adequate; a binary-search optimisation
/// can be added if needed.
///
/// Returns `Ok(0)` when no snapshots exist (holder had no activity before
/// `target_ledger`).
///
/// # Errors
/// * `Error::InvalidParameters` – `target_ledger` is strictly in the future.
pub fn get_balance_at_ledger(
    env: &Env,
    token_index: u32,
    holder: &Address,
    target_ledger: u32,
) -> Result<i128, Error> {
    if target_ledger > env.ledger().sequence() {
        return Err(Error::InvalidParameters);
    }

    let count = get_balance_snapshot_count(env, token_index, holder);
    if count == 0 {
        return Ok(0);
    }

    // Walk backward: newest snapshot first
    let mut i = count;
    while i > 0 {
        i -= 1;
        if let Some(snap) = get_balance_snapshot(env, token_index, holder, i) {
            if snap.ledger <= target_ledger {
                return Ok(snap.balance);
            }
        }
    }

    Ok(0)
}

// ─────────────────────────────────────────────
// Supply snapshots
// ─────────────────────────────────────────────

/// Record the current total supply for `token_index` at the current ledger.
pub fn record_supply_snapshot(
    env: &Env,
    token_index: u32,
    total_supply: i128,
) -> Result<(), Error> {
    let count_key = DataKey::SupplySnapshotCount(token_index);
    let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);

    let snap = SupplySnapshot {
        ledger: env.ledger().sequence(),
        timestamp: env.ledger().timestamp(),
        total_supply,
    };

    env.storage()
        .persistent()
        .set(&DataKey::SupplySnapshot(token_index, count), &snap);
    env.storage().persistent().set(&count_key, &(count + 1));

    storage::bump_persistent(env, &DataKey::SupplySnapshot(token_index, count));
    storage::bump_persistent(env, &count_key);

    Ok(())
}

/// Return the number of supply snapshots recorded for `token_index`.
pub fn get_supply_snapshot_count(env: &Env, token_index: u32) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::SupplySnapshotCount(token_index))
        .unwrap_or(0)
}

/// Return the supply snapshot at index `idx`, or `None` if out of bounds.
pub fn get_supply_snapshot(env: &Env, token_index: u32, idx: u32) -> Option<SupplySnapshot> {
    env.storage()
        .persistent()
        .get(&DataKey::SupplySnapshot(token_index, idx))
}

/// Return the token's total supply at or immediately before `target_ledger`.
///
/// # Errors
/// * `Error::InvalidParameters` – `target_ledger` is strictly in the future.
pub fn get_supply_at_ledger(
    env: &Env,
    token_index: u32,
    target_ledger: u32,
) -> Result<i128, Error> {
    if target_ledger > env.ledger().sequence() {
        return Err(Error::InvalidParameters);
    }

    let count = get_supply_snapshot_count(env, token_index);
    if count == 0 {
        return Ok(0);
    }

    let mut i = count;
    while i > 0 {
        i -= 1;
        if let Some(snap) = get_supply_snapshot(env, token_index, i) {
            if snap.ledger <= target_ledger {
                return Ok(snap.total_supply);
            }
        }
    }

    Ok(0)
}

/// Take a balance snapshot at the CURRENT ledger for use in distribution.
///
/// Returns the current balance for `holder` after writing the snapshot.
pub fn snapshot_balance_now(env: &Env, token_index: u32, holder: &Address) -> i128 {
    let balance = storage::get_balance(env, token_index, holder);
    let _ = record_balance_snapshot(env, token_index, holder, balance);
    balance
}
