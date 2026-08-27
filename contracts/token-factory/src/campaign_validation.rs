//! Campaign parameter validation (issue #1764)
//!
//! Strict bounds checks for buyback campaign configuration. These run at
//! creation time so an unsafe treasury or burn configuration can never be
//! persisted — every later step execution can then assume the stored config
//! is within bounds.

use crate::types::Error;
use soroban_sdk::{Address, Env};

/// Bounds for campaign parameters.
pub mod constants {
    /// Minimum campaign budget (1 XLM, in stroops).
    pub const MIN_BUDGET: i128 = 10_000_000;

    /// Maximum campaign budget (1 billion XLM, in stroops).
    pub const MAX_BUDGET: i128 = 10_000_000_000_000_000;

    /// Minimum campaign duration (1 hour).
    pub const MIN_DURATION: u64 = 3600;

    /// Maximum campaign duration (365 days).
    pub const MAX_DURATION: u64 = 365 * 24 * 3600;

    /// Minimum interval between step executions (5 minutes).
    pub const MIN_INTERVAL: u64 = 300;

    /// Maximum interval between step executions (7 days).
    pub const MAX_INTERVAL: u64 = 7 * 24 * 3600;

    /// Ceiling on any slippage tolerance (10000 bps = 100%).
    pub const MAX_SLIPPAGE_BPS: u32 = 10_000;

    /// Practical ceiling on slippage tolerance (500 bps = 5%). A campaign
    /// willing to accept more than this is almost certainly misconfigured,
    /// so creation is rejected rather than left to burn treasury funds.
    pub const REASONABLE_MAX_SLIPPAGE_BPS: u32 = 500;

    /// A campaign must start at least this far in the future, so a submitted
    /// creation transaction cannot become instantly executable on inclusion.
    pub const MIN_START_BUFFER: u64 = 60;

    /// Maximum byte length for a campaign metadata URI (IPFS CID / HTTPS URL).
    pub const MAX_METADATA_URI_LEN: u32 = 256;
}

/// Validate the total campaign budget.
///
/// # Errors
/// * `InvalidBudget` - not positive, or outside
///   [`constants::MIN_BUDGET`]..=[`constants::MAX_BUDGET`]
pub fn validate_budget(budget: i128) -> Result<(), Error> {
    if !(constants::MIN_BUDGET..=constants::MAX_BUDGET).contains(&budget) {
        return Err(Error::InvalidBudget);
    }
    Ok(())
}

/// Validate the per-step spend cap against the campaign budget.
///
/// The cap is what bounds the blast radius of a single execution, so it must
/// be positive and can never exceed the total budget.
///
/// # Errors
/// * `InvalidAmount`     - cap is not positive
/// * `InvalidParameters` - cap exceeds the total budget
pub fn validate_max_spend_per_step(max_spend_per_step: i128, budget: i128) -> Result<(), Error> {
    if max_spend_per_step <= 0 {
        return Err(Error::InvalidAmount);
    }
    if max_spend_per_step > budget {
        return Err(Error::InvalidParameters);
    }
    Ok(())
}

/// Validate the campaign's active time window.
///
/// # Errors
/// * `InvalidTimeWindow` - start is not far enough in the future, end is not
///   after start, or the duration is outside
///   [`constants::MIN_DURATION`]..=[`constants::MAX_DURATION`]
pub fn validate_time_window(env: &Env, start_time: u64, end_time: u64) -> Result<(), Error> {
    let current_time = env.ledger().timestamp();

    let earliest_start = current_time
        .checked_add(constants::MIN_START_BUFFER)
        .ok_or(Error::InvalidTimeWindow)?;
    if start_time < earliest_start {
        return Err(Error::InvalidTimeWindow);
    }

    if end_time <= start_time {
        return Err(Error::InvalidTimeWindow);
    }

    let duration = end_time - start_time;
    if !(constants::MIN_DURATION..=constants::MAX_DURATION).contains(&duration) {
        return Err(Error::InvalidTimeWindow);
    }

    Ok(())
}

/// Validate the minimum interval between step executions.
///
/// # Errors
/// * `InvalidParameters` - outside
///   [`constants::MIN_INTERVAL`]..=[`constants::MAX_INTERVAL`]
pub fn validate_min_interval(min_interval: u64) -> Result<(), Error> {
    if !(constants::MIN_INTERVAL..=constants::MAX_INTERVAL).contains(&min_interval) {
        return Err(Error::InvalidParameters);
    }
    Ok(())
}

/// Validate the slippage tolerance.
///
/// A zero tolerance is rejected: no real swap settles at exactly the quote,
/// so a zero-tolerance campaign could never execute a step.
///
/// # Errors
/// * `InvalidParameters` - zero, or above
///   [`constants::REASONABLE_MAX_SLIPPAGE_BPS`]
pub fn validate_slippage(max_slippage_bps: u32) -> Result<(), Error> {
    if max_slippage_bps == 0 || max_slippage_bps > constants::REASONABLE_MAX_SLIPPAGE_BPS {
        return Err(Error::InvalidParameters);
    }
    Ok(())
}

/// Validate the buyback token pair.
///
/// # Errors
/// * `InvalidParameters` - source and target are the same token, which would
///   make the "swap" a no-op that still spends budget
pub fn validate_token_pair(source_token: &Address, target_token: &Address) -> Result<(), Error> {
    if source_token == target_token {
        return Err(Error::InvalidParameters);
    }
    Ok(())
}

/// Validate the byte length of an optional campaign metadata URI.
///
/// An empty string is not a valid URI; callers that want no metadata should
/// omit it rather than pass `""`.
///
/// # Errors
/// * `InvalidParameters` - empty, or longer than
///   [`constants::MAX_METADATA_URI_LEN`]
pub fn validate_metadata_uri(uri_len: u32) -> Result<(), Error> {
    if uri_len == 0 || uri_len > constants::MAX_METADATA_URI_LEN {
        return Err(Error::InvalidParameters);
    }
    Ok(())
}

/// Run every campaign creation check, returning the first failure.
#[allow(clippy::too_many_arguments)]
pub fn validate_campaign_config(
    env: &Env,
    budget: i128,
    max_spend_per_step: i128,
    start_time: u64,
    end_time: u64,
    min_interval: u64,
    max_slippage_bps: u32,
    source_token: &Address,
    target_token: &Address,
) -> Result<(), Error> {
    validate_budget(budget)?;
    validate_max_spend_per_step(max_spend_per_step, budget)?;
    validate_time_window(env, start_time, end_time)?;
    validate_min_interval(min_interval)?;
    validate_slippage(max_slippage_bps)?;
    validate_token_pair(source_token, target_token)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::constants::*;
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn budget_bounds_are_inclusive() {
        assert!(validate_budget(MIN_BUDGET).is_ok());
        assert!(validate_budget(MAX_BUDGET).is_ok());
        assert_eq!(validate_budget(MIN_BUDGET - 1), Err(Error::InvalidBudget));
        assert_eq!(validate_budget(MAX_BUDGET + 1), Err(Error::InvalidBudget));
        assert_eq!(validate_budget(0), Err(Error::InvalidBudget));
        assert_eq!(validate_budget(-1), Err(Error::InvalidBudget));
    }

    #[test]
    fn step_cap_must_be_positive_and_within_budget() {
        assert!(validate_max_spend_per_step(1, MIN_BUDGET).is_ok());
        assert!(validate_max_spend_per_step(MIN_BUDGET, MIN_BUDGET).is_ok());
        assert_eq!(
            validate_max_spend_per_step(0, MIN_BUDGET),
            Err(Error::InvalidAmount)
        );
        assert_eq!(
            validate_max_spend_per_step(MIN_BUDGET + 1, MIN_BUDGET),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn time_window_rejects_immediate_start_and_bad_durations() {
        let env = Env::default();
        let now = env.ledger().timestamp();

        // Starts too soon.
        assert_eq!(
            validate_time_window(&env, now, now + MIN_DURATION * 2),
            Err(Error::InvalidTimeWindow)
        );

        let start = now + MIN_START_BUFFER;
        assert!(validate_time_window(&env, start, start + MIN_DURATION).is_ok());
        assert!(validate_time_window(&env, start, start + MAX_DURATION).is_ok());

        // End before start, too short, too long.
        assert_eq!(
            validate_time_window(&env, start, start),
            Err(Error::InvalidTimeWindow)
        );
        assert_eq!(
            validate_time_window(&env, start, start + MIN_DURATION - 1),
            Err(Error::InvalidTimeWindow)
        );
        assert_eq!(
            validate_time_window(&env, start, start + MAX_DURATION + 1),
            Err(Error::InvalidTimeWindow)
        );
    }

    #[test]
    fn interval_and_slippage_bounds() {
        assert!(validate_min_interval(MIN_INTERVAL).is_ok());
        assert!(validate_min_interval(MAX_INTERVAL).is_ok());
        assert_eq!(validate_min_interval(0), Err(Error::InvalidParameters));
        assert_eq!(
            validate_min_interval(MAX_INTERVAL + 1),
            Err(Error::InvalidParameters)
        );

        assert!(validate_slippage(1).is_ok());
        assert!(validate_slippage(REASONABLE_MAX_SLIPPAGE_BPS).is_ok());
        assert_eq!(validate_slippage(0), Err(Error::InvalidParameters));
        assert_eq!(
            validate_slippage(REASONABLE_MAX_SLIPPAGE_BPS + 1),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn token_pair_must_differ() {
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        assert!(validate_token_pair(&a, &b).is_ok());
        assert_eq!(validate_token_pair(&a, &a), Err(Error::InvalidParameters));
    }

    #[test]
    fn metadata_uri_length_bounds() {
        assert!(validate_metadata_uri(1).is_ok());
        assert!(validate_metadata_uri(MAX_METADATA_URI_LEN).is_ok());
        assert_eq!(validate_metadata_uri(0), Err(Error::InvalidParameters));
        assert_eq!(
            validate_metadata_uri(MAX_METADATA_URI_LEN + 1),
            Err(Error::InvalidParameters)
        );
    }
}
