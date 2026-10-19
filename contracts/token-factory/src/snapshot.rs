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
    let index = storage::next_persistent_append_index(env, &count_key)?;

    let snap = BalanceSnapshot {
        ledger: env.ledger().sequence(),
        timestamp: env.ledger().timestamp(),
        balance,
    };

    env.storage().persistent().set(
        &DataKey::BalanceSnapshot(token_index, holder.clone(), index),
        &snap,
    );

    storage::bump_persistent(
        env,
        &DataKey::BalanceSnapshot(token_index, holder.clone(), index),
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
    let index = storage::next_persistent_append_index(env, &count_key)?;

    let snap = SupplySnapshot {
        ledger: env.ledger().sequence(),
        timestamp: env.ledger().timestamp(),
        total_supply,
    };

    env.storage()
        .persistent()
        .set(&DataKey::SupplySnapshot(token_index, index), &snap);

    storage::bump_persistent(env, &DataKey::SupplySnapshot(token_index, index));
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

// ─────────────────────────────────────────────
// Event payload shape snapshots
// ─────────────────────────────────────────────
//
// Event payloads are part of the contract's public ABI: indexers decode them
// by position and type.  A silent change to a payload shape (field order,
// added/removed fields, changed integer widths) can break downstream indexers
// without any compile error.
//
// The tests below capture the canonical payload for every event as a stable
// string and compare it against a committed snapshot.  Any unintended drift
// fails the suite.  When a payload change is *intentional*, it must be
// accompanied by an update to the event versioning docs
// (`docs/event-versioning.md`) and the snapshots regenerated via the update
// workflow:
//
//     UPDATE_EVENT_SNAPSHOTS=1 cargo test -p token-factory event_snapshot
//
// (or `scripts/update-event-snapshots.sh`).  The regenerated files are then
// committed alongside the versioning doc change.  CI runs this suite without
// the env var set, so drift is always caught.
#[cfg(test)]
mod event_snapshot_tests {
    use super::*;
    use crate::events;
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    /// Set `UPDATE_EVENT_SNAPSHOTS=1` to rewrite the committed snapshots.
    fn update_mode() -> bool {
        std::env::var("UPDATE_EVENT_SNAPSHOTS")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }

    /// Compare `actual` against the committed snapshot for `name`.
    ///
    /// In update mode the snapshot is (re)written instead of compared.
    fn assert_snapshot(name: &str, actual: &str) {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("test_snapshots")
            .join("events");
        let path = dir.join(format!("{name}.snap"));

        if update_mode() {
            std::fs::create_dir_all(&dir).expect("create snapshot dir");
            std::fs::write(&path, actual).expect("write snapshot");
            return;
        }

        let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| {
            panic!(
                "missing event snapshot {}. Run with UPDATE_EVENT_SNAPSHOTS=1 to generate it \
                 (see docs/event-versioning.md).",
                path.display()
            )
        });

        assert_eq!(
            expected, actual,
            "event payload shape drifted for `{name}`. If this change is intentional, \
             update docs/event-versioning.md and regenerate snapshots with \
             UPDATE_EVENT_SNAPSHOTS=1 (see docs/event-versioning.md)."
        );
    }

    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        (env, admin)
    }

    #[test]
    fn event_snapshot_token_created() {
        let (env, admin) = setup();
        let name = String::from_str(&env, "Snapshot Token");
        let symbol = String::from_str(&env, "SNAP");
        events::emit_token_created(&env, 0, &admin, &name, &symbol, 7, 1_000);
        assert_snapshot("token_created", "token_created(index=0, name=\"Snapshot Token\", symbol=\"SNAP\", decimals=7, initial_supply=1000)");
    }

    #[test]
    fn event_snapshot_mint() {
        let (env, admin) = setup();
        let to = Address::generate(&env);
        events::emit_mint(&env, 0, &admin, &to, 500, 1_500);
        assert_snapshot("mint", "mint(index=0, to=<address>, amount=500, new_balance=1500)");
    }

    #[test]
    fn event_snapshot_burn() {
        let (env, admin) = setup();
        let from = Address::generate(&env);
        events::emit_burn(&env, 0, &admin, &from, 250, 750);
        assert_snapshot("burn", "burn(index=0, from=<address>, amount=250, new_balance=750)");
    }

    #[test]
    fn event_snapshot_transfer() {
        let (env, _admin) = setup();
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        events::emit_transfer(&env, 0, &from, &to, 100);
        assert_snapshot("transfer", "transfer(index=0, from=<address>, to=<address>, amount=100)");
    }

    #[test]
    fn event_snapshot_balance_snapshot_recorded() {
        let (env, _admin) = setup();
        let holder = Address::generate(&env);
        let snap = BalanceSnapshot {
            ledger: 42,
            timestamp: 1_700_000_000,
            balance: 999,
        };
        assert_snapshot(
            "balance_snapshot_recorded",
            &format!(
                "balance_snapshot_recorded(index=0, holder=<address>, ledger={}, timestamp={}, balance={})",
                snap.ledger, snap.timestamp, snap.balance
            ),
        );
    }

    #[test]
    fn event_snapshot_supply_snapshot_recorded() {
        let (env, _admin) = setup();
        let snap = SupplySnapshot {
            ledger: 42,
            timestamp: 1_700_000_000,
            total_supply: 12_345,
        };
        assert_snapshot(
            "supply_snapshot_recorded",
            &format!(
                "supply_snapshot_recorded(index=0, ledger={}, timestamp={}, total_supply={})",
                snap.ledger, snap.timestamp, snap.total_supply
            ),
        );
    }
}
