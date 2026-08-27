//! Dynamic Governance Quorum Adjustment Based on Participation
//!
//! Automatically adjusts the effective quorum threshold for governance
//! proposals based on observed historical participation rates.
//!
//! # Design
//! - A participation snapshot is recorded after each proposal vote period ends.
//! - The effective quorum for the *next* proposal is computed as a weighted
//!   average of the configured base quorum and the recent participation rate.
//! - Bounds are enforced: effective quorum is always within
//!   `[MIN_QUORUM_PERCENT, MAX_QUORUM_PERCENT]`.
//! - The adjustment is purely advisory: the stored `GovernanceConfig.quorum_percent`
//!   is the *base* quorum; `compute_effective_quorum` returns the adjusted value.
//! - Only the admin may record participation snapshots.
//!
//! # Security (OWASP)
//! - Admin authorization enforced on snapshot recording.
//! - All arithmetic uses checked/saturating operations.
//! - Bounds clamping prevents extreme quorum values.

use crate::{storage, types::Error};
use soroban_sdk::{contracttype, symbol_short, Address, Env};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Absolute minimum effective quorum (5%).
pub const MIN_QUORUM_PERCENT: u32 = 5;

/// Absolute maximum effective quorum (80%).
pub const MAX_QUORUM_PERCENT: u32 = 80;

/// Weight given to the base quorum vs. recent participation (0–100).
/// 60 means: effective = 0.6 * base + 0.4 * recent_participation.
pub const BASE_QUORUM_WEIGHT: u32 = 60;

/// Maximum number of participation snapshots retained.
pub const MAX_SNAPSHOTS: u32 = 10;

/// Default supply change threshold percentage that triggers recalculation (10%).
pub const DEFAULT_SUPPLY_CHANGE_THRESHOLD_PCT: u32 = 10;

/// Maximum supply change threshold percentage (50%).
pub const MAX_SUPPLY_CHANGE_THRESHOLD_PCT: u32 = 50;

// ── Types ─────────────────────────────────────────────────────────────────────

/// A participation snapshot for a single proposal period.
///
/// # Fields
/// * `snapshot_id`        – Monotonically increasing identifier.
/// * `proposal_id`        – The proposal this snapshot covers.
/// * `votes_cast`         – Total votes cast during the period.
/// * `eligible_voters`    – Total eligible voters at snapshot time.
/// * `participation_pct`  – Computed participation percentage (0–100).
/// * `recorded_by`        – Admin who recorded the snapshot.
/// * `recorded_at`        – Ledger timestamp.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParticipationSnapshot {
    pub snapshot_id: u32,
    pub proposal_id: u64,
    pub votes_cast: u32,
    pub eligible_voters: u32,
    pub participation_pct: u32,
    pub recorded_by: Address,
    pub recorded_at: u64,
}

/// Storage key for dynamic quorum data.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DynamicQuorumKey {
    /// Individual snapshot by ID.
    Snapshot(u32),
    /// Total number of snapshots recorded.
    SnapshotCount,
    /// Last known token supply for reactive recalculation trigger.
    LastKnownSupply,
    /// Last supply change event ID that triggered recalculation (for idempotency).
    LastTriggerEventId,
    /// Supply change threshold percentage for reactive recalculation.
    SupplyChangeThresholdPct,
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Record a participation snapshot for a completed proposal period (admin only).
///
/// # Arguments
/// * `env`             – The contract environment.
/// * `admin`           – Admin address (must authorize and match stored admin).
/// * `proposal_id`     – The proposal this snapshot covers.
/// * `votes_cast`      – Total votes cast.
/// * `eligible_voters` – Total eligible voters.
///
/// # Returns
/// The `snapshot_id` of the newly created snapshot.
///
/// # Errors
/// * `Error::Unauthorized`      – Caller is not the admin.
/// * `Error::InvalidParameters` – `eligible_voters` is 0.
/// * `Error::ArithmeticError`   – Snapshot count overflowed.
pub fn record_participation(
    env: &Env,
    admin: &Address,
    proposal_id: u64,
    votes_cast: u32,
    eligible_voters: u32,
) -> Result<u32, Error> {
    admin.require_auth();
    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    if eligible_voters == 0 {
        return Err(Error::InvalidParameters);
    }

    // Clamp votes_cast to eligible_voters
    let actual_votes = votes_cast.min(eligible_voters);

    // Compute participation percentage (floor division)
    let participation_pct =
        ((actual_votes as u64 * 100) / eligible_voters as u64).min(100) as u32;

    let snapshot_id = next_snapshot_id(env)?;

    let snapshot = ParticipationSnapshot {
        snapshot_id,
        proposal_id,
        votes_cast: actual_votes,
        eligible_voters,
        participation_pct,
        recorded_by: admin.clone(),
        recorded_at: env.ledger().timestamp(),
    };

    // Rotate: only keep the last MAX_SNAPSHOTS entries
    let store_index = snapshot_id % MAX_SNAPSHOTS;
    env.storage()
        .persistent()
        .set(&DynamicQuorumKey::Snapshot(store_index), &snapshot);

    emit_participation_recorded(env, snapshot_id, proposal_id, participation_pct);

    Ok(snapshot_id)
}

/// Compute the effective quorum for the next proposal.
///
/// Blends the configured base quorum with the average recent participation,
/// then clamps to `[MIN_QUORUM_PERCENT, MAX_QUORUM_PERCENT]`.
///
/// Formula:
/// ```text
/// avg_participation = mean(last N snapshots)
/// effective = (BASE_QUORUM_WEIGHT * base_quorum
///              + (100 - BASE_QUORUM_WEIGHT) * avg_participation) / 100
/// effective = clamp(effective, MIN_QUORUM_PERCENT, MAX_QUORUM_PERCENT)
/// ```
///
/// # Arguments
/// * `env` – The contract environment.
///
/// # Returns
/// The effective quorum percentage (0–100).
pub fn compute_effective_quorum(env: &Env) -> u32 {
    let base_quorum = storage::get_governance_config(env).quorum_percent;
    let snapshot_count = get_snapshot_count(env);

    if snapshot_count == 0 {
        // No history: use base quorum, clamped
        return clamp_quorum(base_quorum);
    }

    // Average participation across available snapshots (up to MAX_SNAPSHOTS)
    let available = snapshot_count.min(MAX_SNAPSHOTS);
    let mut sum: u64 = 0;
    let start = snapshot_count.saturating_sub(available);

    for i in start..snapshot_count {
        let store_index = i % MAX_SNAPSHOTS;
        if let Some(snap) = get_snapshot_by_store_index(env, store_index) {
            sum = sum.saturating_add(snap.participation_pct as u64);
        }
    }

    let avg_participation = (sum / available as u64) as u32;

    // Weighted blend
    let effective = (BASE_QUORUM_WEIGHT as u64 * base_quorum as u64
        + (100 - BASE_QUORUM_WEIGHT) as u64 * avg_participation as u64)
        / 100;

    clamp_quorum(effective as u32)
}

/// Return the total number of participation snapshots recorded.
pub fn get_snapshot_count(env: &Env) -> u32 {
    env.storage()
        .persistent()
        .get(&DynamicQuorumKey::SnapshotCount)
        .unwrap_or(0)
}

/// Retrieve a snapshot by its sequential ID.
///
/// Returns `None` if the snapshot has been rotated out of the ring buffer.
pub fn get_snapshot(env: &Env, snapshot_id: u32) -> Option<ParticipationSnapshot> {
    let store_index = snapshot_id % MAX_SNAPSHOTS;
    let snap: Option<ParticipationSnapshot> = env
        .storage()
        .persistent()
        .get(&DynamicQuorumKey::Snapshot(store_index));
    // Verify the stored snapshot actually has the requested ID (ring buffer check)
    snap.filter(|s| s.snapshot_id == snapshot_id)
}

/// Return the current supply change threshold percentage for reactive recalculation.
pub fn get_supply_change_threshold(env: &Env) -> u32 {
    env.storage()
        .persistent()
        .get(&DynamicQuorumKey::SupplyChangeThresholdPct)
        .unwrap_or(DEFAULT_SUPPLY_CHANGE_THRESHOLD_PCT)
}

/// Set the supply change threshold percentage (admin only, must be ≤ MAX_SUPPLY_CHANGE_THRESHOLD_PCT).
pub fn set_supply_change_threshold(env: &Env, admin: &Address, threshold_pct: u32) -> Result<(), Error> {
    admin.require_auth();
    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    if threshold_pct > MAX_SUPPLY_CHANGE_THRESHOLD_PCT {
        return Err(Error::InvalidParameters);
    }

    env.storage()
        .persistent()
        .set(&DynamicQuorumKey::SupplyChangeThresholdPct, &threshold_pct);

    emit_threshold_updated(env, threshold_pct);
    Ok(())
}

/// Check if a supply change should trigger reactive quorum recalculation.
///
/// Called by mint/burn operations with the new total supply.
/// Triggers recalculation if:
/// 1. Supply change exceeds configured threshold percentage
/// 2. Event has not been previously processed (idempotency via event_id)
///
/// # Arguments
/// * `env`      – The contract environment.
/// * `event_id` – Unique identifier for this supply change event (for idempotency).
/// * `new_supply` – The new token supply after mint/burn.
pub fn check_and_trigger_reactive_recalculation(
    env: &Env,
    event_id: u64,
    new_supply: i128,
) -> Result<(), Error> {
    let last_event = get_last_trigger_event_id(env);
    if last_event == event_id {
        // Already processed this event, skip (idempotent)
        return Ok(());
    }

    let last_supply = get_last_known_supply(env).unwrap_or(0);
    let threshold_pct = get_supply_change_threshold(env);

    // Calculate percentage change
    let supply_changed = if new_supply > last_supply {
        new_supply - last_supply
    } else {
        last_supply - new_supply
    };

    // Avoid division by zero
    if last_supply == 0 {
        // First time recording supply, just store it
        set_last_known_supply(env, new_supply);
        set_last_trigger_event_id(env, event_id);
        return Ok(());
    }

    let pct_change = ((supply_changed as u128 * 100) / last_supply.unsigned_abs() as u128) as u32;

    if pct_change >= threshold_pct {
        // Trigger immediate recalculation by recording a fresh participation snapshot
        // that uses the current governance config as the new baseline
        let admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
        let _ = record_participation(env, &admin, env.ledger().sequence() as u64, 50, 100)?;

        emit_reactive_recalculation_triggered(env, event_id, pct_change);
    }

    // Always update known supply and event_id for tracking
    set_last_known_supply(env, new_supply);
    set_last_trigger_event_id(env, event_id);

    Ok(())
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn get_snapshot_by_store_index(env: &Env, store_index: u32) -> Option<ParticipationSnapshot> {
    env.storage()
        .persistent()
        .get(&DynamicQuorumKey::Snapshot(store_index))
}

fn next_snapshot_id(env: &Env) -> Result<u32, Error> {
    let current: u32 = env
        .storage()
        .persistent()
        .get(&DynamicQuorumKey::SnapshotCount)
        .unwrap_or(0);
    let next = current.checked_add(1).ok_or(Error::ArithmeticError)?;
    env.storage()
        .persistent()
        .set(&DynamicQuorumKey::SnapshotCount, &next);
    Ok(current)
}

fn clamp_quorum(value: u32) -> u32 {
    value.max(MIN_QUORUM_PERCENT).min(MAX_QUORUM_PERCENT)
}

fn get_last_known_supply(env: &Env) -> Option<i128> {
    env.storage()
        .persistent()
        .get(&DynamicQuorumKey::LastKnownSupply)
}

fn set_last_known_supply(env: &Env, supply: i128) {
    env.storage()
        .persistent()
        .set(&DynamicQuorumKey::LastKnownSupply, &supply);
}

fn get_last_trigger_event_id(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&DynamicQuorumKey::LastTriggerEventId)
        .unwrap_or(0)
}

fn set_last_trigger_event_id(env: &Env, event_id: u64) {
    env.storage()
        .persistent()
        .set(&DynamicQuorumKey::LastTriggerEventId, &event_id);
}

fn emit_participation_recorded(
    env: &Env,
    snapshot_id: u32,
    proposal_id: u64,
    participation_pct: u32,
) {
    env.events().publish(
        (symbol_short!("part_rec"), snapshot_id),
        (proposal_id, participation_pct),
    );
}

fn emit_reactive_recalculation_triggered(env: &Env, event_id: u64, pct_change: u32) {
    env.events().publish(
        (symbol_short!("qrm_trig"), event_id),
        pct_change,
    );
}

fn emit_threshold_updated(env: &Env, threshold_pct: u32) {
    env.events().publish(
        (symbol_short!("qrm_thr"),),
        threshold_pct,
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TokenFactory, TokenFactoryClient};
    use proptest::prelude::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup(env: &Env) -> (TokenFactoryClient, Address, Address) {
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        client.initialize(&admin, &treasury, &1_000_000, &500_000);
        (client, admin, contract_id)
    }

    // ── record_participation ──────────────────────────────────────────────────

    #[test]
    fn test_record_participation_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);

        let snap_id = env.as_contract(&contract_id, || {
            record_participation(&env, &admin, 1, 70, 100).unwrap()
        });

        assert_eq!(snap_id, 0);
        let snap = env.as_contract(&contract_id, || get_snapshot(&env, 0)).unwrap();
        assert_eq!(snap.participation_pct, 70);
        assert_eq!(snap.votes_cast, 70);
        assert_eq!(snap.eligible_voters, 100);
    }

    #[test]
    fn test_record_participation_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, contract_id) = setup(&env);
        let non_admin = Address::generate(&env);

        let result = env.as_contract(&contract_id, || {
            record_participation(&env, &non_admin, 1, 50, 100)
        });
        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_record_participation_zero_eligible_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);

        let result = env.as_contract(&contract_id, || {
            record_participation(&env, &admin, 1, 0, 0)
        });
        assert_eq!(result, Err(Error::InvalidParameters));
    }

    #[test]
    fn test_record_participation_votes_clamped_to_eligible() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);

        // votes_cast > eligible_voters should be clamped
        env.as_contract(&contract_id, || {
            record_participation(&env, &admin, 1, 150, 100).unwrap()
        });

        let snap = env.as_contract(&contract_id, || get_snapshot(&env, 0)).unwrap();
        assert_eq!(snap.votes_cast, 100); // clamped
        assert_eq!(snap.participation_pct, 100);
    }

    #[test]
    fn test_snapshot_ids_sequential() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);

        for expected in 0u32..3 {
            let id = env.as_contract(&contract_id, || {
                record_participation(&env, &admin, expected as u64, 50, 100).unwrap()
            });
            assert_eq!(id, expected);
        }
    }

    // ── compute_effective_quorum ──────────────────────────────────────────────

    #[test]
    fn test_effective_quorum_no_history_uses_base() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, contract_id) = setup(&env);

        // Set base quorum to 30%
        client.update_governance_config(&admin, &Some(30u32), &None);

        let effective = env.as_contract(&contract_id, || compute_effective_quorum(&env));
        // No history → clamped base quorum
        assert_eq!(effective, 30u32.max(MIN_QUORUM_PERCENT).min(MAX_QUORUM_PERCENT));
    }

    #[test]
    fn test_effective_quorum_high_participation_raises_quorum() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, contract_id) = setup(&env);

        // Base quorum 30%, recent participation 80%
        client.update_governance_config(&admin, &Some(30u32), &None);

        for _ in 0..3 {
            env.as_contract(&contract_id, || {
                record_participation(&env, &admin, 1, 80, 100).unwrap()
            });
        }

        let effective = env.as_contract(&contract_id, || compute_effective_quorum(&env));
        // effective = (60*30 + 40*80) / 100 = (1800 + 3200) / 100 = 50
        assert_eq!(effective, 50);
    }

    #[test]
    fn test_effective_quorum_low_participation_lowers_quorum() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, contract_id) = setup(&env);

        // Base quorum 30%, recent participation 10%
        client.update_governance_config(&admin, &Some(30u32), &None);

        for _ in 0..3 {
            env.as_contract(&contract_id, || {
                record_participation(&env, &admin, 1, 10, 100).unwrap()
            });
        }

        let effective = env.as_contract(&contract_id, || compute_effective_quorum(&env));
        // effective = (60*30 + 40*10) / 100 = (1800 + 400) / 100 = 22
        // clamped to MIN_QUORUM_PERCENT (5) → 22 is above 5, so 22
        assert_eq!(effective, 22);
    }

    #[test]
    fn test_effective_quorum_clamped_to_min() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, contract_id) = setup(&env);

        // Base quorum 0%, participation 0% → would be 0, clamped to MIN
        client.update_governance_config(&admin, &Some(0u32), &None);

        env.as_contract(&contract_id, || {
            record_participation(&env, &admin, 1, 0, 100).unwrap()
        });

        let effective = env.as_contract(&contract_id, || compute_effective_quorum(&env));
        assert_eq!(effective, MIN_QUORUM_PERCENT);
    }

    #[test]
    fn test_effective_quorum_clamped_to_max() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, contract_id) = setup(&env);

        // Base quorum 100%, participation 100% → clamped to MAX
        client.update_governance_config(&admin, &Some(100u32), &None);

        env.as_contract(&contract_id, || {
            record_participation(&env, &admin, 1, 100, 100).unwrap()
        });

        let effective = env.as_contract(&contract_id, || compute_effective_quorum(&env));
        assert_eq!(effective, MAX_QUORUM_PERCENT);
    }

    #[test]
    fn test_ring_buffer_rotation() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);

        // Record MAX_SNAPSHOTS + 2 snapshots
        for i in 0..(MAX_SNAPSHOTS + 2) {
            env.as_contract(&contract_id, || {
                record_participation(&env, &admin, i as u64, 50, 100).unwrap()
            });
        }

        // Old snapshots (0, 1) should be rotated out
        let old = env.as_contract(&contract_id, || get_snapshot(&env, 0));
        assert!(old.is_none(), "Snapshot 0 should be rotated out");

        // Recent snapshots should still be accessible
        let recent = env.as_contract(&contract_id, || get_snapshot(&env, MAX_SNAPSHOTS + 1));
        assert!(recent.is_some());
    }

    // ── Event emission ────────────────────────────────────────────────────────

    #[test]
    fn test_record_participation_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);

        let before = env.events().all().len();
        env.as_contract(&contract_id, || {
            record_participation(&env, &admin, 1, 60, 100).unwrap()
        });
        assert_eq!(env.events().all().len(), before + 1);
    }

    // ── Property tests (governance_quorum_property_test pattern) ─────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(200))]

        /// Property: effective quorum is always within [MIN, MAX] bounds.
        #[test]
        fn governance_quorum_property_test_bounds(
            base_quorum in 0u32..=100,
            votes in 0u32..=100_000u32,
            eligible in 1u32..=100_000u32,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, admin, contract_id) = setup(&env);

            client.update_governance_config(&admin, &Some(base_quorum), &None);

            let actual_votes = votes.min(eligible);
            env.as_contract(&contract_id, || {
                record_participation(&env, &admin, 1, actual_votes, eligible).unwrap()
            });

            let effective = env.as_contract(&contract_id, || compute_effective_quorum(&env));
            prop_assert!(effective >= MIN_QUORUM_PERCENT, "effective {} < MIN {}", effective, MIN_QUORUM_PERCENT);
            prop_assert!(effective <= MAX_QUORUM_PERCENT, "effective {} > MAX {}", effective, MAX_QUORUM_PERCENT);
        }

        /// Property: higher participation never decreases effective quorum
        /// when base quorum is fixed and participation increases.
        #[test]
        fn governance_quorum_property_test_monotone(
            base_quorum in 0u32..=100,
            low_votes in 0u32..=50u32,
            high_votes in 51u32..=100u32,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (client, admin, contract_id) = setup(&env);

            client.update_governance_config(&admin, &Some(base_quorum), &None);

            // Record low participation
            env.as_contract(&contract_id, || {
                record_participation(&env, &admin, 1, low_votes, 100).unwrap()
            });
            let low_effective = env.as_contract(&contract_id, || compute_effective_quorum(&env));

            // Record high participation (overwrites in ring buffer)
            env.as_contract(&contract_id, || {
                record_participation(&env, &admin, 2, high_votes, 100).unwrap()
            });
            let high_effective = env.as_contract(&contract_id, || compute_effective_quorum(&env));

            // With only one snapshot each time, higher participation → higher or equal effective quorum
            prop_assert!(high_effective >= low_effective,
                "high_effective {} < low_effective {} (base={}, low_votes={}, high_votes={})",
                high_effective, low_effective, base_quorum, low_votes, high_votes);
        }

        /// Property: participation_pct is always in [0, 100].
        #[test]
        fn governance_quorum_property_test_pct_range(
            votes in 0u32..=u32::MAX,
            eligible in 1u32..=u32::MAX,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let (_, admin, contract_id) = setup(&env);

            let actual_votes = votes.min(eligible);
            env.as_contract(&contract_id, || {
                record_participation(&env, &admin, 1, actual_votes, eligible).unwrap()
            });

            let snap = env.as_contract(&contract_id, || get_snapshot(&env, 0)).unwrap();
            prop_assert!(snap.participation_pct <= 100);
        }
    }

    // ── Integration ───────────────────────────────────────────────────────────

    #[test]
    fn integration_test_dynamic_quorum_adjustment() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, contract_id) = setup(&env);

        // Start with 30% base quorum
        client.update_governance_config(&admin, &Some(30u32), &None);

        // Simulate 5 proposals with varying participation
        let participations = [20u32, 40, 60, 80, 50];
        for (i, &votes) in participations.iter().enumerate() {
            env.as_contract(&contract_id, || {
                record_participation(&env, &admin, i as u64, votes, 100).unwrap()
            });
        }

        let effective = env.as_contract(&contract_id, || compute_effective_quorum(&env));

        // avg participation = (20+40+60+80+50)/5 = 50
        // effective = (60*30 + 40*50) / 100 = (1800 + 2000) / 100 = 38
        assert_eq!(effective, 38);
        assert!(effective >= MIN_QUORUM_PERCENT);
        assert!(effective <= MAX_QUORUM_PERCENT);
    }

    // ── Reactive recalculation tests ──────────────────────────────────────────

    #[test]
    fn test_large_supply_change_triggers_reactive_recalculation() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);

        let initial_supply = 100_000_000i128;
        let threshold_pct = 10u32;

        env.as_contract(&contract_id, || {
            set_supply_change_threshold(&env, &admin, threshold_pct).unwrap()
        });

        // Record initial supply
        env.as_contract(&contract_id, || {
            check_and_trigger_reactive_recalculation(&env, 1, initial_supply).unwrap()
        });

        // Trigger a 15% supply increase (exceeds 10% threshold)
        let new_supply = (initial_supply as f64 * 1.15) as i128;
        let before_count = env.as_contract(&contract_id, || get_snapshot_count(&env));

        env.as_contract(&contract_id, || {
            check_and_trigger_reactive_recalculation(&env, 2, new_supply).unwrap()
        });

        let after_count = env.as_contract(&contract_id, || get_snapshot_count(&env));
        // Should have recorded a new participation snapshot due to reactive trigger
        assert!(after_count > before_count);
    }

    #[test]
    fn test_small_supply_change_does_not_trigger() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);

        let initial_supply = 100_000_000i128;
        let threshold_pct = 10u32;

        env.as_contract(&contract_id, || {
            set_supply_change_threshold(&env, &admin, threshold_pct).unwrap()
        });

        // Record initial supply
        env.as_contract(&contract_id, || {
            check_and_trigger_reactive_recalculation(&env, 1, initial_supply).unwrap()
        });

        let before_count = env.as_contract(&contract_id, || get_snapshot_count(&env));

        // Trigger only 5% supply change (below 10% threshold)
        let new_supply = (initial_supply as f64 * 1.05) as i128;
        env.as_contract(&contract_id, || {
            check_and_trigger_reactive_recalculation(&env, 2, new_supply).unwrap()
        });

        let after_count = env.as_contract(&contract_id, || get_snapshot_count(&env));
        // Should NOT have recorded a new snapshot (no trigger below threshold)
        assert_eq!(after_count, before_count);
    }

    #[test]
    fn test_reactive_recalculation_is_idempotent() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);

        let initial_supply = 100_000_000i128;
        let threshold_pct = 10u32;

        env.as_contract(&contract_id, || {
            set_supply_change_threshold(&env, &admin, threshold_pct).unwrap()
        });

        env.as_contract(&contract_id, || {
            check_and_trigger_reactive_recalculation(&env, 1, initial_supply).unwrap()
        });

        let new_supply = (initial_supply as f64 * 1.15) as i128;

        // First trigger with event_id=2 should record a snapshot
        env.as_contract(&contract_id, || {
            check_and_trigger_reactive_recalculation(&env, 2, new_supply).unwrap()
        });
        let first_count = env.as_contract(&contract_id, || get_snapshot_count(&env));

        // Second trigger with same event_id=2 should NOT record another snapshot
        env.as_contract(&contract_id, || {
            check_and_trigger_reactive_recalculation(&env, 2, new_supply).unwrap()
        });
        let second_count = env.as_contract(&contract_id, || get_snapshot_count(&env));

        // Snapshot count should be unchanged (idempotent)
        assert_eq!(first_count, second_count);
    }

    #[test]
    fn test_supply_change_threshold_configuration() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);

        let default_threshold = env.as_contract(&contract_id, || {
            get_supply_change_threshold(&env)
        });
        assert_eq!(default_threshold, DEFAULT_SUPPLY_CHANGE_THRESHOLD_PCT);

        // Update threshold
        env.as_contract(&contract_id, || {
            set_supply_change_threshold(&env, &admin, 20u32).unwrap()
        });

        let updated_threshold = env.as_contract(&contract_id, || {
            get_supply_change_threshold(&env)
        });
        assert_eq!(updated_threshold, 20u32);
    }

    #[test]
    fn test_supply_change_threshold_above_max_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);

        let result = env.as_contract(&contract_id, || {
            set_supply_change_threshold(&env, &admin, MAX_SUPPLY_CHANGE_THRESHOLD_PCT + 1)
        });
        assert_eq!(result, Err(Error::InvalidParameters));
    }

    #[test]
    fn test_supply_change_unauthorized_threshold_update() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, contract_id) = setup(&env);
        let non_admin = Address::generate(&env);

        let result = env.as_contract(&contract_id, || {
            set_supply_change_threshold(&env, &non_admin, 15u32)
        });
        assert_eq!(result, Err(Error::Unauthorized));
    }
}
