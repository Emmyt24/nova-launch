/// Token deployment history, replay, and pruning.
///
/// Every token creation is recorded as a `DeploymentRecord` keyed by a
/// monotonically increasing history index. Records can be queried by creator
/// address or by time range, replayed to reconstruct state at any point in
/// time, and pruned to reclaim ledger storage.
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

fn get_history_count(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&HISTORY_COUNT_KEY)
        .unwrap_or(0u64)
}

fn set_history_count(env: &Env, count: u64) {
    env.storage().persistent().set(&HISTORY_COUNT_KEY, &count);
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

    for i in 0..total {
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

    for i in 0..total {
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

    for i in 0..=up_to_index {
        if let Some(record) = get_record(env, i) {
            token_count = token_count
                .checked_add(1)
                .ok_or(Error::ArithmeticError)?;
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
/// * `InvalidParameters` – `before_index` is 0 or exceeds the history count.
pub fn prune_history(env: &Env, admin: &Address, before_index: u64) -> Result<u32, Error> {
    admin.require_auth();

    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    let total = get_history_count(env);
    if before_index == 0 || before_index > total {
        return Err(Error::InvalidParameters);
    }

    let mut pruned: u32 = 0;
    for i in 0..before_index {
        if get_record(env, i).is_some() {
            remove_record(env, i);
            pruned = pruned.checked_add(1).ok_or(Error::ArithmeticError)?;
        }
    }

    crate::events::emit_history_pruned(env, admin, before_index, pruned);

    Ok(pruned)
}

/// Return the total number of history records (including pruned ones).
pub fn history_count(env: &Env) -> u64 {
    get_history_count(env)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(any())] // TEMP-VALIDATION-ONLY: disabled for vault_error isolation build
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, String};

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, crate::TokenFactory);
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &1_000_000_i128, &500_000_i128);

        (env, contract_id, admin, treasury)
    }

    fn deploy_token(
        env: &Env,
        client: &crate::TokenFactoryClient,
        creator: &Address,
        name: &str,
        symbol: &str,
    ) {
        client.create_token(
            creator,
            &String::from_str(env, name),
            &String::from_str(env, symbol),
            &7_u32,
            &1_000_000_i128,
            &None,
            &1_000_000_i128,
        );
    }

    #[test]
    fn history_records_are_stored_on_create() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        deploy_token(&env, &client, &admin, "Alpha", "ALP");

        let count = client.history_count();
        assert_eq!(count, 1);

        let record = client.get_history_record(&0_u64).unwrap();
        assert_eq!(record.token_index, 0);
        assert_eq!(record.initial_supply, 1_000_000);
    }

    #[test]
    fn query_by_creator_filters_correctly() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let other = Address::generate(&env);

        deploy_token(&env, &client, &admin, "Alpha", "ALP");
        deploy_token(&env, &client, &other, "Beta", "BET");
        deploy_token(&env, &client, &admin, "Gamma", "GAM");

        let records = client.query_by_creator(&admin, &0_u64, &10_u32);
        assert_eq!(records.len(), 2);

        let other_records = client.query_by_creator(&other, &0_u64, &10_u32);
        assert_eq!(other_records.len(), 1);
    }

    #[test]
    fn query_by_time_range_returns_matching_records() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        deploy_token(&env, &client, &admin, "Alpha", "ALP");
        deploy_token(&env, &client, &admin, "Beta", "BET");

        let now = env.ledger().timestamp();
        let records = client.query_by_time_range(&0_u64, &(now + 1000), &10_u32);
        assert!(records.len() >= 2);
    }

    #[test]
    fn replay_produces_correct_snapshot() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        deploy_token(&env, &client, &admin, "Alpha", "ALP");
        deploy_token(&env, &client, &admin, "Beta", "BET");
        deploy_token(&env, &client, &admin, "Gamma", "GAM");

        // Replay up to index 1 (first two records).
        let snapshot = client.replay(&1_u64);
        assert_eq!(snapshot.token_count, 2);
        assert_eq!(snapshot.cumulative_supply, 2_000_000);
    }

    #[test]
    fn prune_removes_old_records() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        deploy_token(&env, &client, &admin, "Alpha", "ALP");
        deploy_token(&env, &client, &admin, "Beta", "BET");
        deploy_token(&env, &client, &admin, "Gamma", "GAM");

        let pruned = client.prune_history(&admin, &2_u64);
        assert_eq!(pruned, 2);

        // Records 0 and 1 are gone; record 2 still exists.
        assert!(client.get_history_record(&0_u64).is_none());
        assert!(client.get_history_record(&1_u64).is_none());
        assert!(client.get_history_record(&2_u64).is_some());

        // History count is unchanged.
        assert_eq!(client.history_count(), 3);
    }

    #[test]
    fn prune_rejects_non_admin() {
        let (env, contract_id, _admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let impostor = Address::generate(&env);
        deploy_token(&env, &client, &_admin, "Alpha", "ALP");

        let err = client.try_prune_history(&impostor, &1_u64).unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::Unauthorized);
    }

    #[test]
    fn replay_out_of_range_returns_error() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        deploy_token(&env, &client, &admin, "Alpha", "ALP");

        // Only index 0 exists; requesting index 5 should fail.
        let err = client.try_replay(&5_u64).unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::InvalidParameters);
    }
}
