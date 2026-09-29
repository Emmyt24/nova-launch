//! Token deployment history, replay, and pruning.
//!
//! This module is the factory's append-only **deployment log**. Every
//! successful token creation appends a [`DeploymentRecord`] keyed by a
//! monotonically increasing history index, capturing a point-in-time snapshot
//! of the token's metadata (creator, name, symbol, initial supply, and the
//! ledger timestamp of deployment).
//!
//! # Relationship to `TokenInfo`
//!
//! The canonical, mutable token state lives in [`crate::storage`] and is
//! written via `storage::set_token_info`. `game_history` does **not** replace
//! or duplicate that state: it stores an immutable copy of the fields that
//! matter for historical queries at the moment of deployment. The two can
//! diverge over time — for example, if a token's metadata is later updated in
//! `TokenInfo`, the corresponding [`DeploymentRecord`] still reflects the
//! values as they were at deployment. Consumers that need current state should
//! read `TokenInfo`; consumers that need the deployment-time snapshot or an
//! ordered event log should read this module.
//!
//! # Consumers
//!
//! These records are intended to be read by off-chain consumers — primarily a
//! backend indexer that reconstructs deployment history and feeds
//! leaderboards/gamification, and any on-chain query path that needs an ordered
//! view of deployments (e.g. [`query_by_creator`], [`query_by_time_range`],
//! [`replay`]). The log is not consulted by the token-creation path itself
//! beyond appending a record.
//!
//! # Deliberate exceptions
//!
//! - Records are **not** a permanent audit trail: [`prune`] removes records
//!   below a given index to reclaim ledger storage, and pruned records are no
//!   longer retrievable. The history count is not decremented, so indices
//!   remain stable and new records continue from where they left off.
//! - The log only covers tokens created through the factory's creation paths
//!   (`create_token` / `batch_reveal`). Tokens that exist in `TokenInfo` but
//!   were not created through those paths will have no corresponding record.
use soroban_sdk::{Address, Env, Vec};

use crate::storage;
use crate::types::{DataKey, Error, TokenInfo};

// ── Types ─────────────────────────────────────────────────────────────────────

/// A single token-deployment history entry.
#[soroban_sdk::contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeploymentRecord {
    /// Sequential history index (0-based, monotonically increasing).
    pub history_index: u64,
    /// On-chain token index in the factory registry.
    pub token_index: u32,
    /// Creator address.
    pub creator: Address,
    /// Token name at deployment time.
    pub name: soroban_sdk::String,
    /// Token symbol at deployment time.
    pub symbol: soroban_sdk::String,
    /// Initial supply minted to the creator.
    pub initial_supply: i128,
    /// Ledger timestamp of the deployment.
    pub deployed_at: u64,
}

/// Snapshot used by the replay engine to reconstruct factory state.
#[soroban_sdk::contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistorySnapshot {
    /// Total number of tokens deployed up to (and including) this record.
    pub token_count: u32,
    /// Cumulative initial supply across all tokens in the snapshot.
    pub cumulative_supply: i128,
    /// Timestamp of the last event in the snapshot.
    pub as_of: u64,
}

// ── Storage helpers ───────────────────────────────────────────────────────────

/// Storage key for the global history record count.
const HISTORY_COUNT_KEY: DataKey = DataKey::HistoryCount;

/// Storage key for the oldest unpruned history index.
const FIRST_LIVE_INDEX_KEY: DataKey = DataKey::HistoryFirstLiveIndex;

fn get_history_count(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&HISTORY_COUNT_KEY)
        .unwrap_or(0u64)
}

fn set_history_count(env: &Env, count: u64) {
    env.storage().persistent().set(&HISTORY_COUNT_KEY, &count);
}

/// Index of the oldest record that hasn't been pruned yet. Everything below
/// this index is guaranteed to be pruned (`get_record` returns `None`), so
/// query functions can safely start scanning here instead of from 0.
fn get_first_live_index(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&FIRST_LIVE_INDEX_KEY)
        .unwrap_or(0u64)
}

fn set_first_live_index(env: &Env, index: u64) {
    env.storage()
        .persistent()
        .set(&FIRST_LIVE_INDEX_KEY, &index);
}

fn get_record(env: &Env, index: u64) -> Option<DeploymentRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::HistoryRecord(index))
}

fn set_record(env: &Env, index: u64, record: &DeploymentRecord) {
    env.storage()
        .persistent()
        .set(&DataKey::HistoryRecord(index), record);
}

fn remove_record(env: &Env, index: u64) {
    env.storage()
        .persistent()
        .remove(&DataKey::HistoryRecord(index));
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Record a new deployment in the history log.
///
/// Called internally by `create_token` / `batch_reveal` after a token is
/// successfully created.
pub fn record_deployment(env: &Env, token_index: u32, token_info: &TokenInfo) {
    let history_index = get_history_count(env);
    let record = DeploymentRecord {
        history_index,
        token_index,
        creator: token_info.creator.clone(),
        name: token_info.name.clone(),
        symbol: token_info.symbol.clone(),
        initial_supply: token_info.initial_supply,
        deployed_at: token_info.created_at,
    };
    set_record(env, history_index, &record);
    set_history_count(env, history_index + 1);

    crate::events::emit_deployment_recorded(env, history_index, token_index, &token_info.creator);
}

/// Retrieve a single history record by its history index.
///
/// Returns `None` if the index is out of range or has been pruned.
pub fn get_history_record(env: &Env, history_index: u64) -> Option<DeploymentRecord> {
    get_record(env, history_index)
}

/// Query deployment history for a specific creator.
///
/// Returns up to `limit` records (max 100) starting from `offset`, filtered
/// to those whose `creator` matches `creator`.
///
/// # Errors
/// * `InvalidParameters` – `limit` is 0 or > 100.
pub fn query_by_creator(
    env: &Env,
    creator: &Address,
    offset: u64,
    limit: u32,
) -> Result<Vec<DeploymentRecord>, Error> {
    if limit == 0 || limit > 100 {
        return Err(Error::InvalidParameters);
    }

    let total = get_history_count(env);
    let mut results = Vec::new(env);
    let mut skipped: u64 = 0;

    for i in get_first_live_index(env)..total {
        if let Some(record) = get_record(env, i) {
            if record.creator == *creator {
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                results.push_back(record);
                if results.len() >= limit {
                    break;
                }
            }
        }
    }

    Ok(results)
}

/// Query deployment history within a time range `[from, to]` (inclusive).
///
/// Returns up to `limit` records (max 100).
///
/// # Errors
/// * `InvalidParameters` – `from > to`, `limit` is 0, or `limit > 100`.
pub fn query_by_time_range(
    env: &Env,
    from: u64,
    to: u64,
    limit: u32,
) -> Result<Vec<DeploymentRecord>, Error> {
    if from > to || limit == 0 || limit > 100 {
        return Err(Error::InvalidParameters);
    }

    let total = get_history_count(env);
    let mut results = Vec::new(env);

    for i in get_first_live_index(env)..total {
        if let Some(record) = get_record(env, i) {
            if record.deployed_at >= from && record.deployed_at <= to {
                results.push_back(record);
                if results.len() >= limit {
                    break;
                }
            }
        }
    }

    Ok(results)
}

/// Replay history up to (and including) `up_to_index` to produce a
/// `HistorySnapshot` representing cumulative factory state at that point.
///
/// Useful for verification and auditing — callers can confirm that the
/// on-chain state matches the replayed snapshot.
///
/// # Errors
/// * `InvalidParameters` – `up_to_index` is beyond the current history count.
pub fn replay(env: &Env, up_to_index: u64) -> Result<HistorySnapshot, Error> {
    let total = get_history_count(env);
    if up_to_index >= total {
        return Err(Error::InvalidParameters);
    }

    let mut token_count: u32 = 0;
    let mut cumulative_supply: i128 = 0;
    let mut as_of: u64 = 0;

    for i in get_first_live_index(env)..=up_to_index {
        if let Some(record) = get_record(env, i) {
            token_count = token_count.checked_add(1).ok_or(Error::ArithmeticError)?;
            cumulative_supply = cumulative_supply
                .checked_add(record.initial_supply)
                .ok_or(Error::ArithmeticError)?;
            as_of = record.deployed_at;
        }
    }

    Ok(HistorySnapshot {
        token_count,
        cumulative_supply,
        as_of,
    })
}

/// Prune history records with index < `before_index`.
///
/// Removes records from persistent storage to reclaim ledger space. Pruned
/// records are no longer retrievable. The history count is NOT decremented —
/// new records continue from where they left off.
///
/// Only the factory admin may call this function.
///
/// # Arguments
/// * `admin`        – Factory admin (must auth).
/// * `before_index` – All records with `history_index < before_index` are removed.
///
/// # Returns
/// Number of records pruned.
///
/// # Errors
/// * `Unauthorized`      – Caller is not the factory admin.
/// * `InvalidParameters` – `before_index` is beyond the current history count.
pub fn prune(env: &Env, admin: &Address, before_index: u64) -> Result<u64, Error> {
    admin.require_auth();

    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::Unauthorized)?;
    if stored_admin != *admin {
        return Err(Error::Unauthorized);
    }

    let total = get_history_count(env);
    if before_index > total {
        return Err(Error::InvalidParameters);
    }

    let first_live = get_first_live_index(env);
    let mut pruned: u64 = 0;

    for i in first_live..before_index {
        if get_record(env, i).is_some() {
            remove_record(env, i);
            pruned += 1;
        }
    }

    if before_index > first_live {
        set_first_live_index(env, before_index);
    }

    Ok(pruned)
}
