//! Buyback Campaign Circuit Breaker & Emergency Halt (#577)
//!
//! A high-severity safety control that can halt buyback execution during
//! abnormal market or protocol conditions.
//!
//! Three automatic circuit-breaker triggers are evaluated from telemetry
//! reported by the execution engine / oracles:
//!
//! 1. **Volatility spikes** — consecutive price observations for a campaign
//!    moving further apart than `volatility_threshold_bps`.
//! 2. **Failed settlement streaks** — `max_consecutive_failures` consecutive
//!    failed settlement outcomes.
//! 3. **Oracle divergence** — two price sources diverging further than
//!    `divergence_threshold_bps`.
//!
//! In addition, governance can manually halt (`emergency_halt_campaign`) or
//! resume (`clear_emergency_halt`) a campaign at any time.
//!
//! Guarantees:
//! - Only the configured governance contract may halt/clear/configure.
//! - Halting twice preserves the original audit trail (first halt wins).
//! - While halted, all execution entry points must call
//!   [`ensure_execution_allowed`] and will be rejected with
//!   [`Error::CampaignEmergencyHalted`]; telemetry reports are also rejected
//!   so the forensic state is frozen until recovery.
//! - Read/query paths are never blocked: queries do not consult the breaker
//!   state except through the explicit `is_campaign_halted` accessor.

use crate::{
    events, storage,
    types::{CampaignBreakerConfig, CampaignBreakerState, CampaignHaltReason, Error},
};
use soroban_sdk::{Address, Env};

/// Default maximum tolerated price change between observations: 20% (2000 bps)
pub const DEFAULT_VOLATILITY_THRESHOLD_BPS: u32 = 2_000;
/// Default number of consecutive settlement failures that trips the breaker
pub const DEFAULT_MAX_CONSECUTIVE_FAILURES: u32 = 3;
/// Default maximum tolerated oracle divergence: 10% (1000 bps)
pub const DEFAULT_DIVERGENCE_THRESHOLD_BPS: u32 = 1_000;

/// Basis-points denominator used for ratio checks
const BPS_DENOMINATOR: i128 = 10_000;
/// Inclusive upper bound accepted for basis-point thresholds
const MAX_THRESHOLD_BPS: u32 = 100_000;
/// Inclusive upper bound accepted for the failure-streak limit
const MAX_CONSECUTIVE_FAILURES: u32 = 1_000;

// ── Configuration ────────────────────────────────────────────────────────────

/// Effective breaker configuration: stored overrides or documented defaults.
pub fn effective_config(env: &Env) -> CampaignBreakerConfig {
    storage::get_campaign_breaker_config(env).unwrap_or(CampaignBreakerConfig {
        volatility_threshold_bps: DEFAULT_VOLATILITY_THRESHOLD_BPS,
        max_consecutive_failures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
        divergence_threshold_bps: DEFAULT_DIVERGENCE_THRESHOLD_BPS,
    })
}

/// Validate a proposed configuration against the accepted ranges.
pub fn validate_config(config: &CampaignBreakerConfig) -> Result<(), Error> {
    let valid_bps = |bps: u32| bps >= 1 && bps <= MAX_THRESHOLD_BPS;
    if !valid_bps(config.volatility_threshold_bps) || !valid_bps(config.divergence_threshold_bps) {
        return Err(Error::InvalidBreakerConfig);
    }
    if config.max_consecutive_failures < 1
        || config.max_consecutive_failures > MAX_CONSECUTIVE_FAILURES
    {
        return Err(Error::InvalidBreakerConfig);
    }
    Ok(())
}

/// Set global breaker thresholds (governance only).
pub fn set_breaker_config(
    env: &Env,
    governance: &Address,
    config: &CampaignBreakerConfig,
) -> Result<(), Error> {
    assert_governance(env, governance)?;
    validate_config(config)?;
    storage::set_campaign_breaker_config(env, config);
    Ok(())
}

// ── Queries ──────────────────────────────────────────────────────────────────

/// Whether a campaign is currently under an emergency halt.
pub fn is_halted(env: &Env, campaign_id: u64) -> bool {
    storage::get_campaign_breaker_state(env, campaign_id)
        .map(|state| state.halted)
        .unwrap_or(false)
}

/// Full breaker/halt state for a campaign, if any state was ever recorded.
pub fn get_state(env: &Env, campaign_id: u64) -> Option<CampaignBreakerState> {
    storage::get_campaign_breaker_state(env, campaign_id)
}

// ── Execution guard ──────────────────────────────────────────────────────────

/// Reject buyback execution into `campaign_id` while an emergency halt or
/// automatic breaker trip is active.
///
/// Every buyback execution path MUST call this guard before mutating any
/// state. Query/read paths intentionally do NOT call it so that halted
/// campaigns remain fully inspectable.
pub fn ensure_execution_allowed(env: &Env, campaign_id: u64) -> Result<(), Error> {
    if is_halted(env, campaign_id) {
        return Err(Error::CampaignEmergencyHalted);
    }
    Ok(())
}

// ── Authorization ────────────────────────────────────────────────────────────

/// Require that `caller` is the configured governance contract.
fn assert_governance(env: &Env, caller: &Address) -> Result<(), Error> {
    caller.require_auth();
    let stored_governance = storage::get_governance(env).ok_or(Error::Unauthorized)?;
    if *caller != stored_governance {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

/// Require that `reporter` is allowed to feed telemetry for a campaign:
/// either the governance contract or the campaign owner.
fn assert_reporter(env: &Env, campaign_id: u64, reporter: &Address) -> Result<(), Error> {
    reporter.require_auth();
    let campaign = storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;
    let is_governance = storage::get_governance(env).map(|gov| gov == *reporter);
    if is_governance.unwrap_or(false) || campaign.owner == *reporter {
        return Ok(());
    }
    Err(Error::Unauthorized)
}

// ── Governance-controlled emergency path ─────────────────────────────────────

/// Emergency-halt a buyback campaign (governance only).
///
/// Re-halting an already-halted campaign fails with
/// [`Error::CampaignAlreadyPaused`] so the original halt's audit fields
/// (`halted_by`, `halted_at`, `reason`) can never be overwritten.
pub fn emergency_halt_campaign(
    env: &Env,
    governance: &Address,
    campaign_id: u64,
    reason: CampaignHaltReason,
) -> Result<(), Error> {
    assert_governance(env, governance)?;
    storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;

    let mut state = current_state(env, campaign_id);
    if state.halted {
        return Err(Error::CampaignAlreadyPaused);
    }

    state.halted = true;
    state.reason = reason;
    state.halted_at = env.ledger().timestamp();
    state.halted_by = Some(governance.clone());
    storage::set_campaign_breaker_state(env, campaign_id, &state);

    events::emit_campaign_emergency_halted(env, campaign_id, governance, reason as u32);
    Ok(())
}

/// Clear an emergency halt and restore normal execution (governance only).
///
/// Recovery resets the breaker counters to a clean baseline so stale streaks
/// cannot immediately re-trip the campaign after resumption.
pub fn clear_emergency_halt(
    env: &Env,
    governance: &Address,
    campaign_id: u64,
) -> Result<(), Error> {
    assert_governance(env, governance)?;
    storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;

    if !is_halted(env, campaign_id) {
        return Err(Error::CampaignNotPaused);
    }

    // Clean-slate recovery: drop the overlay entirely.
    storage::remove_campaign_breaker_state(env, campaign_id);

    events::emit_campaign_halt_cleared(env, campaign_id, governance);
    Ok(())
}

// ── Telemetry-driven circuit-breaker triggers ────────────────────────────────

/// Record a price observation for a campaign and trip the breaker on a
/// volatility spike (governance or campaign owner).
///
/// Volatility is measured in basis points between this observation and the
/// previous one: `|new - old| * 10_000 / old`. Returns `true` if the breaker
/// tripped as a result of this report.
pub fn report_price_observation(
    env: &Env,
    reporter: &Address,
    campaign_id: u64,
    price: i128,
) -> Result<bool, Error> {
    assert_reporter(env, campaign_id, reporter)?;
    reject_if_halted(env, campaign_id)?;
    if price <= 0 {
        return Err(Error::InvalidParameters);
    }

    let config = effective_config(env);
    let mut state = current_state(env, campaign_id);

    let mut tripped = false;
    if state.last_price > 0 {
        let delta_bps = change_bps(state.last_price, price)?;
        if delta_bps > config.volatility_threshold_bps {
            tripped = true;
        }
    }

    state.last_price = price;
    state.last_price_at = env.ledger().timestamp();
    storage::set_campaign_breaker_state(env, campaign_id, &state);

    if tripped {
        trip_breaker(env, campaign_id, CampaignHaltReason::VolatilitySpike);
    }
    Ok(tripped)
}

/// Compare two oracle price sources for a campaign and trip the breaker on
/// excessive divergence (governance or campaign owner).
///
/// Divergence is measured in basis points: `|a - b| * 10_000 / min(a, b)`.
/// The primary observation is also recorded as the latest known price so the
/// volatility tracker stays fed. Returns `true` if the breaker tripped.
pub fn report_oracle_prices(
    env: &Env,
    reporter: &Address,
    campaign_id: u64,
    primary_price: i128,
    secondary_price: i128,
) -> Result<bool, Error> {
    assert_reporter(env, campaign_id, reporter)?;
    reject_if_halted(env, campaign_id)?;
    if primary_price <= 0 || secondary_price <= 0 {
        return Err(Error::InvalidParameters);
    }

    let config = effective_config(env);
    let divergence_bps = change_bps(primary_price, secondary_price)?;

    let mut state = current_state(env, campaign_id);
    state.last_price = primary_price;
    state.last_price_at = env.ledger().timestamp();
    storage::set_campaign_breaker_state(env, campaign_id, &state);

    if divergence_bps > config.divergence_threshold_bps {
        trip_breaker(env, campaign_id, CampaignHaltReason::OracleDivergence);
        return Ok(true);
    }
    Ok(false)
}

/// Record a settlement outcome for a campaign and trip the breaker once too
/// many attempts fail in a row (governance or campaign owner).
///
/// A successful settlement resets the failure streak. Returns `true` if the
/// breaker tripped as a result of this outcome.
pub fn record_settlement_outcome(
    env: &Env,
    reporter: &Address,
    campaign_id: u64,
    success: bool,
) -> Result<bool, Error> {
    assert_reporter(env, campaign_id, reporter)?;
    reject_if_halted(env, campaign_id)?;

    let config = effective_config(env);
    let mut state = current_state(env, campaign_id);

    if success {
        state.consecutive_failures = 0;
        storage::set_campaign_breaker_state(env, campaign_id, &state);
        return Ok(false);
    }

    state.consecutive_failures = state
        .consecutive_failures
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    let tripped = state.consecutive_failures >= config.max_consecutive_failures;
    storage::set_campaign_breaker_state(env, campaign_id, &state);

    if tripped {
        trip_breaker(
            env,
            campaign_id,
            CampaignHaltReason::SettlementFailureStreak,
        );
    }
    Ok(tripped)
}

// ── Internals ────────────────────────────────────────────────────────────────

/// Load recorded state or a fresh default.
fn current_state(env: &Env, campaign_id: u64) -> CampaignBreakerState {
    storage::get_campaign_breaker_state(env, campaign_id).unwrap_or_default()
}

/// Reject telemetry while halted so the forensic halt state stays frozen.
fn reject_if_halted(env: &Env, campaign_id: u64) -> Result<(), Error> {
    ensure_execution_allowed(env, campaign_id)
}

/// Trip the breaker automatically. First cause wins: an already-tripped
/// breaker keeps its original reason/timestamp.
fn trip_breaker(env: &Env, campaign_id: u64, reason: CampaignHaltReason) {
    let mut state = current_state(env, campaign_id);
    if state.halted {
        return;
    }
    state.halted = true;
    state.reason = reason;
    state.halted_at = env.ledger().timestamp();
    state.halted_by = None;
    storage::set_campaign_breaker_state(env, campaign_id, &state);

    events::emit_campaign_breaker_tripped(env, campaign_id, reason as u32);
}

/// Absolute difference between two positive prices expressed in basis points
/// of the reference (smaller) price.
fn change_bps(reference: i128, other: i128) -> Result<u32, Error> {
    let denominator = reference.min(other);
    let diff = if reference > other {
        reference.checked_sub(other).ok_or(Error::ArithmeticError)?
    } else {
        other.checked_sub(reference).ok_or(Error::ArithmeticError)?
    };
    let bps = diff
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(Error::ArithmeticError)?
        .checked_div(denominator)
        .ok_or(Error::ArithmeticError)?;
    u32::try_from(bps).map_err(|_| Error::ArithmeticError)
}
