use crate::events;
use crate::storage;
use crate::types::{
    DynamicQuorumConfig, Error, GovernanceConfig, ParticipationRecord, ProposalState,
};
use soroban_sdk::{Address, Env};

/// Default quorum percentage (30%)
const DEFAULT_QUORUM_PERCENT: u32 = 30;

/// Default approval percentage (51%)
const DEFAULT_APPROVAL_PERCENT: u32 = 51;

/// Number of ledgers between automatic `ProposalStateSnapshot` events for a
/// given active proposal (#1383). Off-chain analytics indexers use these
/// periodic snapshots as fast-forward checkpoints so they don't have to
/// replay every event from genesis to reconstruct current proposal state.
pub const SNAPSHOT_INTERVAL_LEDGERS: u32 = 1000;

/// Initialize governance configuration
///
/// Sets up quorum and approval thresholds for governance operations.
///
/// # Arguments
/// * `env` - The contract environment
/// * `quorum_percent` - Minimum participation percentage (0-100)
/// * `approval_percent` - Minimum approval percentage (0-100)
///
/// # Errors
/// * `Error::InvalidParameters` - Percentages out of valid range
pub fn initialize_governance(
    env: &Env,
    quorum_percent: Option<u32>,
    approval_percent: Option<u32>,
) -> Result<(), Error> {
    let quorum = quorum_percent.unwrap_or(DEFAULT_QUORUM_PERCENT);
    let approval = approval_percent.unwrap_or(DEFAULT_APPROVAL_PERCENT);

    validate_percentages(quorum, approval)?;

    let config = GovernanceConfig {
        quorum_percent: quorum,
        approval_percent: approval,
        voting_period: 86400, // Default 24 hours
    };

    storage::set_governance_config(env, &config);
    events::emit_governance_configured(env, quorum, approval);

    Ok(())
}

/// Update governance configuration
///
/// Updates quorum and/or approval thresholds.
///
/// # Arguments
/// * `env` - The contract environment
/// * `admin` - Admin address (must authorize)
/// * `quorum_percent` - Optional new quorum percentage
/// * `approval_percent` - Optional new approval percentage
///
/// # Errors
/// * `Error::Unauthorized` - Caller is not the admin
/// * `Error::InvalidParameters` - Percentages out of valid range or both None
pub fn update_governance_config(
    env: &Env,
    admin: &Address,
    quorum_percent: Option<u32>,
    approval_percent: Option<u32>,
) -> Result<(), Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    if quorum_percent.is_none() && approval_percent.is_none() {
        return Err(Error::InvalidParameters);
    }

    let mut config = storage::get_governance_config(env);

    if let Some(quorum) = quorum_percent {
        config.quorum_percent = quorum;
    }

    if let Some(approval) = approval_percent {
        config.approval_percent = approval;
    }

    validate_percentages(config.quorum_percent, config.approval_percent)?;

    storage::set_governance_config(env, &config);
    events::emit_governance_updated(env, config.quorum_percent, config.approval_percent);

    Ok(())
}

/// Get current governance configuration
///
/// # Arguments
/// * `env` - The contract environment
///
/// # Returns
/// Returns the current GovernanceConfig
pub fn get_governance_config(env: &Env) -> GovernanceConfig {
    storage::get_governance_config(env)
}

/// Check if quorum is met
///
/// # Arguments
/// * `total_votes` - Total number of votes cast
/// * `total_eligible` - Total number of eligible voters
/// * `quorum_percent` - Required quorum percentage
///
/// # Returns
/// Returns true if quorum is met
pub fn is_quorum_met(total_votes: u32, total_eligible: u32, quorum_percent: u32) -> bool {
    if total_eligible == 0 {
        return false;
    }

    let votes_required = (total_eligible as u64 * quorum_percent as u64) / 100;
    total_votes as u64 >= votes_required
}

/// Check if approval threshold is met
///
/// # Arguments
/// * `yes_votes` - Number of yes votes
/// * `total_votes` - Total number of votes cast
/// * `approval_percent` - Required approval percentage
///
/// # Returns
/// Returns true if approval threshold is met
pub fn is_approval_met(yes_votes: u32, total_votes: u32, approval_percent: u32) -> bool {
    if total_votes == 0 {
        return false;
    }

    let yes_required = (total_votes as u64 * approval_percent as u64) / 100;
    yes_votes as u64 >= yes_required
}

/// Validate percentage values
///
/// # Arguments
/// * `quorum_percent` - Quorum percentage to validate
/// * `approval_percent` - Approval percentage to validate
///
/// # Errors
/// * `Error::InvalidParameters` - Percentages exceed 100
fn validate_percentages(quorum_percent: u32, approval_percent: u32) -> Result<(), Error> {
    if quorum_percent > 100 || approval_percent > 100 {
        return Err(Error::InvalidParameters);
    }

    Ok(())
}

// ── Dynamic quorum ────────────────────────────────────────────────────────────

/// Configure dynamic quorum adjustment.
///
/// Only the admin may call this. Setting `enabled = false` disables dynamic
/// adjustment without erasing the configuration.
///
/// # Validation
/// * `min_quorum_percent` ≤ `max_quorum_percent`
/// * Both bounds must be ≤ 100
/// * `target_participation` must be ≤ 100
/// * `window_size` must be ≥ 1
///
/// # Errors
/// * `Error::Unauthorized`        – Caller is not the admin.
/// * `Error::InvalidQuorumBounds` – Bounds are invalid.
/// * `Error::InvalidParameters`   – Other parameter violations.
pub fn configure_dynamic_quorum(
    env: &Env,
    admin: &Address,
    config: DynamicQuorumConfig,
) -> Result<(), Error> {
    admin.require_auth();
    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    validate_dynamic_quorum_config(&config)?;

    storage::set_dynamic_quorum_config(env, &config);
    events::emit_dynamic_quorum_configured(
        env,
        admin,
        config.enabled,
        config.min_quorum_percent,
        config.max_quorum_percent,
    );
    Ok(())
}

/// Get the current dynamic quorum configuration.
pub fn get_dynamic_quorum_config(env: &Env) -> DynamicQuorumConfig {
    storage::get_dynamic_quorum_config(env)
}

/// Record participation data for a concluded proposal and, if dynamic quorum
/// is enabled, recompute and persist the effective quorum.
///
/// This should be called once per proposal after voting closes.
///
/// # Arguments
/// * `env`            – Contract environment.
/// * `proposal_id`    – ID of the concluded proposal.
/// * `total_votes`    – Votes cast during the proposal.
/// * `total_eligible` – Eligible voters at the time of the proposal.
///
/// # Returns
/// The new effective quorum percent (unchanged if dynamic quorum is disabled).
///
/// # Errors
/// * `Error::InvalidParameters` – `total_eligible` is zero.
/// * `Error::ArithmeticError`   – Overflow in participation calculation.
pub fn record_participation_and_adjust(
    env: &Env,
    proposal_id: u64,
    total_votes: u32,
    total_eligible: u32,
) -> Result<u32, Error> {
    if total_eligible == 0 {
        return Err(Error::InvalidParameters);
    }

    // Compute participation in basis points (0–10 000) to preserve precision.
    let participation_bps = (total_votes as u64)
        .checked_mul(10_000)
        .and_then(|v| v.checked_div(total_eligible as u64))
        .ok_or(Error::ArithmeticError)? as u32;

    let record = ParticipationRecord {
        proposal_id,
        total_votes,
        total_eligible,
        participation_bps,
        recorded_at: env.ledger().timestamp(),
    };
    storage::set_participation_record(env, proposal_id, &record);

    let dq_config = storage::get_dynamic_quorum_config(env);
    if !dq_config.enabled {
        return Ok(storage::get_governance_config(env).quorum_percent);
    }

    let new_quorum = compute_adjusted_quorum(env, proposal_id, &dq_config)?;
    let mut gov_config = storage::get_governance_config(env);
    let old_quorum = gov_config.quorum_percent;

    gov_config.quorum_percent = new_quorum;
    storage::set_governance_config(env, &gov_config);

    // Compute rolling average for the event payload.
    let avg_bps = rolling_average_participation_bps(env, proposal_id, dq_config.window_size);
    events::emit_dynamic_quorum_adjusted(env, proposal_id, old_quorum, new_quorum, avg_bps);

    Ok(new_quorum)
}

/// Compute the effective quorum percent from recent participation history.
///
/// Formula:
///   avg_participation_percent = rolling_avg_bps / 100   (integer, floor)
///   adjusted = clamp(avg_participation_percent, min, max)
///
/// The intuition: if recent participation has been high, the quorum can be
/// raised toward `max_quorum_percent`; if participation has been low, it
/// relaxes toward `min_quorum_percent`.  The `target_participation` field is
/// reserved for future weighted formulas and is not used in this version.
///
/// # Errors
/// * `Error::InsufficientParticipationHistory` – No records exist yet.
fn compute_adjusted_quorum(
    env: &Env,
    latest_proposal_id: u64,
    config: &DynamicQuorumConfig,
) -> Result<u32, Error> {
    let avg_bps = rolling_average_participation_bps(env, latest_proposal_id, config.window_size);
    if avg_bps == u32::MAX {
        // Sentinel: no history available.
        return Err(Error::InsufficientParticipationHistory);
    }

    // Convert BPS to percent (floor division).
    let avg_percent = avg_bps / 100;

    // Clamp to configured bounds.
    let adjusted = avg_percent.max(config.min_quorum_percent).min(config.max_quorum_percent);
    Ok(adjusted)
}

/// Compute the rolling average participation in basis points over the last
/// `window_size` proposals ending at `latest_proposal_id`.
///
/// Returns `u32::MAX` as a sentinel when no records are found.
fn rolling_average_participation_bps(env: &Env, latest_proposal_id: u64, window_size: u32) -> u32 {
    let mut sum: u64 = 0;
    let mut count: u32 = 0;

    // Walk backwards from latest_proposal_id, collecting up to window_size records.
    let mut id = latest_proposal_id;
    loop {
        if let Some(record) = storage::get_participation_record(env, id) {
            sum = sum.saturating_add(record.participation_bps as u64);
            count += 1;
        }
        if count >= window_size {
            break;
        }
        if id == 0 {
            break;
        }
        id -= 1;
    }

    if count == 0 {
        return u32::MAX; // sentinel: no history
    }

    (sum / count as u64) as u32
}

/// Validate a `DynamicQuorumConfig` before persisting.
fn validate_dynamic_quorum_config(config: &DynamicQuorumConfig) -> Result<(), Error> {
    if config.min_quorum_percent > config.max_quorum_percent {
        return Err(Error::InvalidQuorumBounds);
    }
    if config.max_quorum_percent > 100 {
        return Err(Error::InvalidQuorumBounds);
    }
    if config.target_participation > 100 {
        return Err(Error::InvalidParameters);
    }
    if config.window_size == 0 {
        return Err(Error::InvalidParameters);
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════
// Governance Proposal State Snapshots (#1383)
// ═══════════════════════════════════════════════════════════════════════
//
// Off-chain indexers reconstruct proposal state by replaying
// `prop_cr` / `prop_vote` / proposal-state-transition events from genesis.
// As the event log grows this becomes increasingly expensive. To let
// indexers "fast-forward" to a recent checkpoint, the contract periodically
// (and on-demand) emits a `prop_snap` (`ProposalStateSnapshot`) event per
// active proposal containing the fully accumulated vote tallies and status
// as of a specific ledger. A consumer can load the latest snapshot for a
// proposal and only replay events emitted after `snapshot.ledger`, while
// still landing on state identical to a full replay from genesis.

/// Compute the vote weight required to meet quorum for `proposal`, using the
/// same token-supply-weighted formula as `timelock::finalize_proposal` so
/// snapshots never diverge from the contract's actual quorum determination.
///
/// Eligible weight is the sum of all deployed tokens' total supply; if no
/// tokens have been deployed yet this falls back to the proposal's current
/// total vote count (matching `finalize_proposal`'s fallback).
pub fn compute_quorum_required(env: &Env, proposal: &crate::types::Proposal) -> i128 {
    let config = storage::get_governance_config(env);
    let total_votes = proposal.votes_for + proposal.votes_against + proposal.votes_abstain;

    let token_count = storage::get_token_count(env);
    let mut supply_sum: i128 = 0;
    for i in 0..token_count {
        if let Some(info) = storage::get_token_info(env, i) {
            supply_sum = supply_sum.saturating_add(info.total_supply);
        }
    }
    let total_eligible: i128 = if supply_sum > 0 {
        supply_sum
    } else {
        total_votes.max(1)
    };

    total_eligible.saturating_mul(config.quorum_percent as i128) / 100
}

/// Returns true if `proposal_id` is currently "active" for snapshot purposes,
/// i.e. it has not reached a terminal state (Succeeded, Defeated, Queued,
/// Executed, Cancelled, Expired, Failed all stop receiving snapshots once
/// they leave Created/Active).
fn is_snapshot_eligible(state: ProposalState) -> bool {
    matches!(state, ProposalState::Created | ProposalState::Active)
}

/// Emit a single `ProposalStateSnapshot` event for `proposal_id` using its
/// current persisted vote tallies, and record the ledger at which the
/// snapshot was taken.
fn snapshot_one_proposal(env: &Env, proposal_id: u64, proposal: &crate::types::Proposal) {
    let ledger = env.ledger().sequence();
    let quorum_required = compute_quorum_required(env, proposal);

    events::emit_proposal_state_snapshot(
        env,
        proposal_id,
        proposal.state,
        proposal.votes_for,
        proposal.votes_against,
        quorum_required,
        ledger,
    );

    storage::set_proposal_last_snapshot_ledger(env, proposal_id, ledger);
}

/// Emit a full `ProposalStateSnapshot` event for every currently active
/// governance proposal.
///
/// This is the manual/administrative entry point (`snapshot_proposals` in
/// `TokenFactory`). It always emits a snapshot for every active proposal
/// regardless of how many ledgers have elapsed since the last snapshot,
/// which is useful for on-demand indexer bootstrapping.
///
/// # Arguments
/// * `env`   – Contract environment.
/// * `admin` – Admin address (must authorize and match stored admin).
///
/// # Returns
/// The number of proposals snapshotted.
///
/// # Errors
/// * `Error::Unauthorized` – Caller is not the admin.
pub fn snapshot_proposals(env: &Env, admin: &Address) -> Result<u32, Error> {
    admin.require_auth();
    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    let mut snapshotted = 0u32;
    let proposal_count = storage::get_proposal_count(env);
    for id in 0..proposal_count as u64 {
        if let Some(proposal) = storage::get_proposal(env, id) {
            if is_snapshot_eligible(proposal.state) {
                snapshot_one_proposal(env, id, &proposal);
                snapshotted += 1;
            }
        }
    }

    Ok(snapshotted)
}

/// Automatic ledger-based snapshot trigger (#1383).
///
/// Called opportunistically from proposal lifecycle entry points
/// (`create_proposal`, `vote_proposal`) so that snapshots are emitted
/// roughly every `SNAPSHOT_INTERVAL_LEDGERS` ledgers without requiring an
/// external cron-like service. Soroban contracts have no native scheduler,
/// so "automatic" here means: any transaction that touches a proposal will
/// check whether enough ledgers have elapsed since that proposal's last
/// snapshot and, if so, emit a fresh one before returning.
///
/// This is a no-op (and cheap: one storage read) if the proposal is not
/// snapshot-eligible or the interval has not yet elapsed, so it is safe to
/// call unconditionally from any proposal-mutating code path.
pub fn maybe_auto_snapshot(env: &Env, proposal_id: u64, proposal: &crate::types::Proposal) {
    if !is_snapshot_eligible(proposal.state) {
        return;
    }

    let current_ledger = env.ledger().sequence();
    let last_snapshot = storage::get_proposal_last_snapshot_ledger(env, proposal_id);

    if current_ledger.saturating_sub(last_snapshot) >= SNAPSHOT_INTERVAL_LEDGERS {
        snapshot_one_proposal(env, proposal_id, proposal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup() -> (Env, Address, soroban_sdk::Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);

        let admin = Address::generate(&env);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
        });

        (env, admin, contract_id)
    }

    #[test]
    fn test_initialize_governance_defaults() {
        let (env, _, contract_id) = setup();

        env.as_contract(&contract_id, || {
            initialize_governance(&env, None, None).unwrap();
        });

        let config = env.as_contract(&contract_id, || get_governance_config(&env));
        assert_eq!(config.quorum_percent, 30);
        assert_eq!(config.approval_percent, 51);
    }

    #[test]
    fn test_initialize_governance_custom() {
        let (env, _, contract_id) = setup();

        env.as_contract(&contract_id, || {
            initialize_governance(&env, Some(40), Some(60)).unwrap();
        });

        let config = env.as_contract(&contract_id, || get_governance_config(&env));
        assert_eq!(config.quorum_percent, 40);
        assert_eq!(config.approval_percent, 60);
    }

    #[test]
    fn test_initialize_governance_zero_percent() {
        let (env, _, contract_id) = setup();

        env.as_contract(&contract_id, || {
            initialize_governance(&env, Some(0), Some(0)).unwrap();
        });

        let config = env.as_contract(&contract_id, || get_governance_config(&env));
        assert_eq!(config.quorum_percent, 0);
        assert_eq!(config.approval_percent, 0);
    }

    #[test]
    fn test_initialize_governance_hundred_percent() {
        let (env, _, contract_id) = setup();

        env.as_contract(&contract_id, || {
            initialize_governance(&env, Some(100), Some(100)).unwrap();
        });

        let config = env.as_contract(&contract_id, || get_governance_config(&env));
        assert_eq!(config.quorum_percent, 100);
        assert_eq!(config.approval_percent, 100);
    }

    #[test]
    fn test_initialize_governance_invalid_quorum() {
        let (env, _, contract_id) = setup();

        let result = env.as_contract(&contract_id, || initialize_governance(&env, Some(101), Some(50)));
        assert_eq!(result, Err(Error::InvalidParameters));
    }

    #[test]
    fn test_initialize_governance_invalid_approval() {
        let (env, _, contract_id) = setup();

        let result = env.as_contract(&contract_id, || initialize_governance(&env, Some(50), Some(101)));
        assert_eq!(result, Err(Error::InvalidParameters));
    }

    #[test]
    fn test_update_governance_config() {
        let (env, admin, contract_id) = setup();

        env.as_contract(&contract_id, || {
            initialize_governance(&env, Some(30), Some(51)).unwrap();
        });

        env.as_contract(&contract_id, || {
            update_governance_config(&env, &admin, Some(50), Some(75)).unwrap();
        });

        let config = env.as_contract(&contract_id, || get_governance_config(&env));
        assert_eq!(config.quorum_percent, 50);
        assert_eq!(config.approval_percent, 75);
    }

    #[test]
    fn test_update_governance_partial() {
        let (env, admin, contract_id) = setup();

        env.as_contract(&contract_id, || {
            initialize_governance(&env, Some(30), Some(51)).unwrap();
        });

        env.as_contract(&contract_id, || {
            update_governance_config(&env, &admin, Some(40), None).unwrap();
        });

        let config = env.as_contract(&contract_id, || get_governance_config(&env));
        assert_eq!(config.quorum_percent, 40);
        assert_eq!(config.approval_percent, 51);
    }

    #[test]
    fn test_update_governance_unauthorized() {
        let (env, _admin, contract_id) = setup();

        env.as_contract(&contract_id, || {
            initialize_governance(&env, Some(30), Some(51)).unwrap();
        });

        let non_admin = Address::generate(&env);
        let result = env.as_contract(&contract_id, || {
            update_governance_config(&env, &non_admin, Some(50), None)
        });
        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_update_governance_both_none() {
        let (env, admin, contract_id) = setup();

        env.as_contract(&contract_id, || {
            initialize_governance(&env, Some(30), Some(51)).unwrap();
        });

        let result = env.as_contract(&contract_id, || {
            update_governance_config(&env, &admin, None, None)
        });
        assert_eq!(result, Err(Error::InvalidParameters));
    }

    #[test]
    fn test_is_quorum_met_exact() {
        assert!(is_quorum_met(30, 100, 30));
    }

    #[test]
    fn test_is_quorum_met_above() {
        assert!(is_quorum_met(31, 100, 30));
    }

    #[test]
    fn test_is_quorum_met_below() {
        assert!(!is_quorum_met(29, 100, 30));
    }

    #[test]
    fn test_is_quorum_met_zero_eligible() {
        assert!(!is_quorum_met(10, 0, 30));
    }

    #[test]
    fn test_is_quorum_met_zero_percent() {
        assert!(is_quorum_met(0, 100, 0));
    }

    #[test]
    fn test_is_quorum_met_hundred_percent() {
        assert!(is_quorum_met(100, 100, 100));
        assert!(!is_quorum_met(99, 100, 100));
    }

    #[test]
    fn test_is_quorum_met_fifty_percent() {
        assert!(is_quorum_met(50, 100, 50));
        assert!(is_quorum_met(51, 100, 50));
        assert!(!is_quorum_met(49, 100, 50));
    }

    #[test]
    fn test_is_approval_met_exact() {
        assert!(is_approval_met(51, 100, 51));
    }

    #[test]
    fn test_is_approval_met_above() {
        assert!(is_approval_met(52, 100, 51));
    }

    #[test]
    fn test_is_approval_met_below() {
        assert!(!is_approval_met(50, 100, 51));
    }

    #[test]
    fn test_is_approval_met_zero_votes() {
        assert!(!is_approval_met(10, 0, 51));
    }

    #[test]
    fn test_is_approval_met_zero_percent() {
        assert!(is_approval_met(0, 100, 0));
    }

    #[test]
    fn test_is_approval_met_hundred_percent() {
        assert!(is_approval_met(100, 100, 100));
        assert!(!is_approval_met(99, 100, 100));
    }

    #[test]
    fn test_is_approval_met_fifty_percent() {
        assert!(is_approval_met(50, 100, 50));
        assert!(is_approval_met(51, 100, 50));
        assert!(!is_approval_met(49, 100, 50));
    }

    #[test]
    fn test_rounding_behavior() {
        // 33% of 100 = 33 votes required
        assert!(is_quorum_met(33, 100, 33));
        assert!(!is_quorum_met(32, 100, 33));

        // 33% of 99 = 32.67 -> 32 votes required (floor)
        assert!(is_quorum_met(32, 99, 33));
        assert!(!is_quorum_met(31, 99, 33));
    }
}
