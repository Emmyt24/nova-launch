/// Campaign Validation Module
///
/// Provides strict validation for buyback campaign parameters to prevent
/// unsafe treasury or burn configurations.

use crate::types::Error;
use soroban_sdk::{Address, Env};

/// Validation constants for campaign parameters
pub mod constants {
    /// Minimum campaign budget (1 XLM = 10_000_000 stroops)
    pub const MIN_BUDGET: i128 = 10_000_000;

    /// Maximum campaign budget (1 billion XLM)
    pub const MAX_BUDGET: i128 = 1_000_000_000_0000000;

    /// Minimum campaign duration (1 hour)
    pub const MIN_DURATION: u64 = 3600;

    /// Maximum campaign duration (365 days)
    pub const MAX_DURATION: u64 = 365 * 24 * 3600;

    /// Minimum interval between executions (5 minutes)
    pub const MIN_INTERVAL: u64 = 300;

    /// Maximum interval between executions (7 days)
    pub const MAX_INTERVAL: u64 = 7 * 24 * 3600;

    /// Maximum slippage in basis points (10000 = 100%)
    pub const MAX_SLIPPAGE_BPS: u32 = 10000;

    /// Reasonable maximum slippage (5% = 500 bps)
    pub const REASONABLE_MAX_SLIPPAGE_BPS: u32 = 500;

    /// Minimum time buffer for start time (1 minute from now)
    pub const MIN_START_BUFFER: u64 = 60;
}

/// Validate campaign budget
///
/// # Arguments
/// * `budget` - The proposed campaign budget
///
/// # Returns
/// * `Ok(())` if budget is valid
/// * `Err(Error)` with specific error code if invalid
///
/// # Validation Rules
/// - Budget must be positive
/// - Budget must be >= MIN_BUDGET
/// - Budget must be <= MAX_BUDGET
pub fn validate_budget(budget: i128) -> Result<(), Error> {
    if budget <= 0 {
        return Err(Error::InvalidBudget);
    }

    if budget < constants::MIN_BUDGET || budget > constants::MAX_BUDGET {
        return Err(Error::InvalidBudget);
    }

    Ok(())
}

/// Validate campaign time window
///
/// # Arguments
/// * `env` - The contract environment
/// * `start_time` - Campaign start timestamp
/// * `end_time` - Campaign end timestamp
///
/// # Returns
/// * `Ok(())` if time window is valid
/// * `Err(Error)` with specific error code if invalid
///
/// # Validation Rules
/// - Start time must be in the future (with buffer)
/// - End time must be after start time
/// - Duration must be >= MIN_DURATION
/// - Duration must be <= MAX_DURATION
pub fn validate_time_window(env: &Env, start_time: u64, end_time: u64) -> Result<(), Error> {
    let current_time = env.ledger().timestamp();

    // Start time must be in the future
    if start_time < current_time + constants::MIN_START_BUFFER {
        return Err(Error::InvalidTimeWindow);
    }

    // End time must be after start time
    if end_time <= start_time {
        return Err(Error::InvalidTimeWindow);
    }

    // Calculate duration
    let duration = end_time - start_time;

    // Duration must be within bounds
    if duration < constants::MIN_DURATION || duration > constants::MAX_DURATION {
        return Err(Error::InvalidTimeWindow);
    }

    Ok(())
}

/// Validate minimum interval between executions
///
/// # Arguments
/// * `min_interval` - Minimum seconds between executions
///
/// # Returns
/// * `Ok(())` if interval is valid
/// * `Err(Error)` with specific error code if invalid
///
/// # Validation Rules
/// - Interval must be >= MIN_INTERVAL
/// - Interval must be <= MAX_INTERVAL
pub fn validate_min_interval(min_interval: u64) -> Result<(), Error> {
    if min_interval == 0 || min_interval < constants::MIN_INTERVAL || min_interval > constants::MAX_INTERVAL {
        return Err(Error::InvalidParameters);
    }

    Ok(())
}

/// Validate slippage tolerance
///
/// # Arguments
/// * `max_slippage_bps` - Maximum slippage in basis points
///
/// # Returns
/// * `Ok(())` if slippage is valid
/// * `Err(Error)` with specific error code if invalid
///
/// # Validation Rules
/// - Slippage must be > 0
/// - Slippage must be <= MAX_SLIPPAGE_BPS (10000 = 100%)
/// - Slippage should be <= REASONABLE_MAX_SLIPPAGE_BPS (500 = 5%)
pub fn validate_slippage(max_slippage_bps: u32) -> Result<(), Error> {
    if max_slippage_bps == 0 || max_slippage_bps > constants::REASONABLE_MAX_SLIPPAGE_BPS {
        return Err(Error::InvalidParameters);
    }

    Ok(())
}

/// Validate token pair for buyback
///
/// # Arguments
/// * `source_token` - Token being spent (treasury token)
/// * `target_token` - Token being bought back
///
/// # Returns
/// * `Ok(())` if token pair is valid
/// * `Err(Error)` with specific error code if invalid
///
/// # Validation Rules
/// - Source and target must be different addresses
/// - Both addresses must be valid (non-zero)
pub fn validate_token_pair(source_token: &Address, target_token: &Address) -> Result<(), Error> {
    // Check if tokens are the same
    if source_token == target_token {
        return Err(Error::InvalidParameters);
    }

    Ok(())
}

/// Validate complete campaign configuration
///
/// Performs all validation checks in sequence.
///
/// # Arguments
/// * `env` - The contract environment
/// * `budget` - Campaign budget
/// * `start_time` - Campaign start timestamp
/// * `end_time` - Campaign end timestamp
/// * `min_interval` - Minimum seconds between executions
/// * `max_slippage_bps` - Maximum slippage in basis points
/// * `source_token` - Token being spent
/// * `target_token` - Token being bought back
///
/// # Returns
/// * `Ok(())` if all validations pass
/// * `Err(Error)` with the first validation error encountered
pub fn validate_campaign_config(
    env: &Env,
    budget: i128,
    start_time: u64,
    end_time: u64,
    min_interval: u64,
    max_slippage_bps: u32,
    source_token: &Address,
    target_token: &Address,
) -> Result<(), Error> {
    validate_budget(budget)?;
    validate_time_window(env, start_time, end_time)?;
    validate_min_interval(min_interval)?;
    validate_slippage(max_slippage_bps)?;
    validate_token_pair(source_token, target_token)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    #[test]
    fn test_validate_budget_success() {
        let budget = 100_000_000i128; // 10 XLM
        assert!(validate_budget(budget).is_ok());
    }

    #[test]
    fn test_validate_budget_zero() {
        assert_eq!(validate_budget(0), Err(Error::InvalidBudget));
    }

    #[test]
    fn test_validate_budget_negative() {
        assert_eq!(validate_budget(-1000), Err(Error::InvalidBudget));
    }

    #[test]
    fn test_validate_budget_below_minimum() {
        let budget = constants::MIN_BUDGET - 1;
        assert_eq!(validate_budget(budget), Err(Error::InvalidBudget));
    }

    #[test]
    fn test_validate_budget_at_minimum() {
        let budget = constants::MIN_BUDGET;
        assert!(validate_budget(budget).is_ok());
    }

    #[test]
    fn test_validate_budget_above_maximum() {
        let budget = constants::MAX_BUDGET + 1;
        assert_eq!(validate_budget(budget), Err(Error::InvalidBudget));
    }

    #[test]
    fn test_validate_budget_at_maximum() {
        let budget = constants::MAX_BUDGET;
        assert!(validate_budget(budget).is_ok());
    }

    #[test]
    fn test_validate_time_window_success() {
        let env = Env::default();
        let current = env.ledger().timestamp();
        let start = current + 3600; // 1 hour from now
        let end = start + 86400; // 1 day duration

        assert!(validate_time_window(&env, start, end).is_ok());
    }

    #[test]
    fn test_validate_time_window_start_in_past() {
        let env = Env::default();
        let current = env.ledger().timestamp();
        let start = current - 100; // In the past
        let end = start + 86400;

        assert_eq!(
            validate_time_window(&env, start, end),
            Err(Error::InvalidTimeWindow)
        );
    }

    #[test]
    fn test_validate_time_window_start_too_soon() {
        let env = Env::default();
        let current = env.ledger().timestamp();
        let start = current + 30; // Less than MIN_START_BUFFER
        let end = start + 86400;

        assert_eq!(
            validate_time_window(&env, start, end),
            Err(Error::InvalidTimeWindow)
        );
    }

    #[test]
    fn test_validate_time_window_end_before_start() {
        let env = Env::default();
        let current = env.ledger().timestamp();
        let start = current + 3600;
        let end = start - 100; // Before start

        assert_eq!(
            validate_time_window(&env, start, end),
            Err(Error::InvalidTimeWindow)
        );
    }

    #[test]
    fn test_validate_time_window_end_equals_start() {
        let env = Env::default();
        let current = env.ledger().timestamp();
        let start = current + 3600;
        let end = start; // Same as start

        assert_eq!(
            validate_time_window(&env, start, end),
            Err(Error::InvalidTimeWindow)
        );
    }

    #[test]
    fn test_validate_time_window_duration_too_short() {
        let env = Env::default();
        let current = env.ledger().timestamp();
        let start = current + 3600;
        let end = start + constants::MIN_DURATION - 1;

        assert_eq!(
            validate_time_window(&env, start, end),
            Err(Error::InvalidTimeWindow)
        );
    }

    #[test]
    fn test_validate_time_window_duration_at_minimum() {
        let env = Env::default();
        let current = env.ledger().timestamp();
        let start = current + 3600;
        let end = start + constants::MIN_DURATION;

        assert!(validate_time_window(&env, start, end).is_ok());
    }

    #[test]
    fn test_validate_time_window_duration_too_long() {
        let env = Env::default();
        let current = env.ledger().timestamp();
        let start = current + 3600;
        let end = start + constants::MAX_DURATION + 1;

        assert_eq!(
            validate_time_window(&env, start, end),
            Err(Error::InvalidTimeWindow)
        );
    }

    #[test]
    fn test_validate_time_window_duration_at_maximum() {
        let env = Env::default();
        let current = env.ledger().timestamp();
        let start = current + 3600;
        let end = start + constants::MAX_DURATION;

        assert!(validate_time_window(&env, start, end).is_ok());
    }

    #[test]
    fn test_validate_min_interval_success() {
        let interval = 600u64; // 10 minutes
        assert!(validate_min_interval(interval).is_ok());
    }

    #[test]
    fn test_validate_min_interval_zero() {
        assert_eq!(validate_min_interval(0), Err(Error::InvalidParameters));
    }

    #[test]
    fn test_validate_min_interval_too_short() {
        let interval = constants::MIN_INTERVAL - 1;
        assert_eq!(
            validate_min_interval(interval),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_validate_min_interval_at_minimum() {
        let interval = constants::MIN_INTERVAL;
        assert!(validate_min_interval(interval).is_ok());
    }

    #[test]
    fn test_validate_min_interval_too_long() {
        let interval = constants::MAX_INTERVAL + 1;
        assert_eq!(
            validate_min_interval(interval),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_validate_min_interval_at_maximum() {
        let interval = constants::MAX_INTERVAL;
        assert!(validate_min_interval(interval).is_ok());
    }

    #[test]
    fn test_validate_slippage_success() {
        let slippage = 100u32; // 1%
        assert!(validate_slippage(slippage).is_ok());
    }

    #[test]
    fn test_validate_slippage_zero() {
        assert_eq!(validate_slippage(0), Err(Error::InvalidParameters));
    }

    #[test]
    fn test_validate_slippage_at_reasonable_max() {
        let slippage = constants::REASONABLE_MAX_SLIPPAGE_BPS;
        assert!(validate_slippage(slippage).is_ok());
    }

    #[test]
    fn test_validate_slippage_above_reasonable_max() {
        let slippage = constants::REASONABLE_MAX_SLIPPAGE_BPS + 1;
        assert_eq!(validate_slippage(slippage), Err(Error::InvalidParameters));
    }

    #[test]
    fn test_validate_slippage_at_absolute_max() {
        let slippage = constants::MAX_SLIPPAGE_BPS;
        assert_eq!(validate_slippage(slippage), Err(Error::InvalidParameters));
    }

    #[test]
    fn test_validate_slippage_above_absolute_max() {
        let slippage = constants::MAX_SLIPPAGE_BPS + 1;
        assert_eq!(validate_slippage(slippage), Err(Error::InvalidParameters));
    }

    #[test]
    fn test_validate_token_pair_success() {
        let env = Env::default();
        let source = Address::generate(&env);
        let target = Address::generate(&env);

        assert!(validate_token_pair(&source, &target).is_ok());
    }

    #[test]
    fn test_validate_token_pair_same_address() {
        let env = Env::default();
        let token = Address::generate(&env);

        assert_eq!(
            validate_token_pair(&token, &token),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_validate_campaign_config_success() {
        let env = Env::default();
        let current = env.ledger().timestamp();

        let budget = 100_000_000i128;
        let start_time = current + 3600;
        let end_time = start_time + 86400;
        let min_interval = 600u64;
        let max_slippage_bps = 100u32;
        let source = Address::generate(&env);
        let target = Address::generate(&env);

        assert!(validate_campaign_config(
            &env,
            budget,
            start_time,
            end_time,
            min_interval,
            max_slippage_bps,
            &source,
            &target
        )
        .is_ok());
    }

    #[test]
    fn test_validate_campaign_config_fails_on_budget() {
        let env = Env::default();
        let current = env.ledger().timestamp();

        let budget = 0i128; // Invalid
        let start_time = current + 3600;
        let end_time = start_time + 86400;
        let min_interval = 600u64;
        let max_slippage_bps = 100u32;
        let source = Address::generate(&env);
        let target = Address::generate(&env);

        assert_eq!(
            validate_campaign_config(
                &env,
                budget,
                start_time,
                end_time,
                min_interval,
                max_slippage_bps,
                &source,
                &target
            ),
            Err(Error::InvalidBudget)
        );
    }

    #[test]
    fn test_validate_campaign_config_fails_on_time_window() {
        let env = Env::default();
        let current = env.ledger().timestamp();

        let budget = 100_000_000i128;
        let start_time = current - 100; // Invalid (past)
        let end_time = start_time + 86400;
        let min_interval = 600u64;
        let max_slippage_bps = 100u32;
        let source = Address::generate(&env);
        let target = Address::generate(&env);

        assert_eq!(
            validate_campaign_config(
                &env,
                budget,
                start_time,
                end_time,
                min_interval,
                max_slippage_bps,
                &source,
                &target
            ),
            Err(Error::InvalidTimeWindow)
        );
    }

    #[test]
    fn test_validate_campaign_config_fails_on_interval() {
        let env = Env::default();
        let current = env.ledger().timestamp();

        let budget = 100_000_000i128;
        let start_time = current + 3600;
        let end_time = start_time + 86400;
        let min_interval = 0u64; // Invalid
        let max_slippage_bps = 100u32;
        let source = Address::generate(&env);
        let target = Address::generate(&env);

        assert_eq!(
            validate_campaign_config(
                &env,
                budget,
                start_time,
                end_time,
                min_interval,
                max_slippage_bps,
                &source,
                &target
            ),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_validate_campaign_config_fails_on_slippage() {
        let env = Env::default();
        let current = env.ledger().timestamp();

        let budget = 100_000_000i128;
        let start_time = current + 3600;
        let end_time = start_time + 86400;
        let min_interval = 600u64;
        let max_slippage_bps = 0u32; // Invalid
        let source = Address::generate(&env);
        let target = Address::generate(&env);

        assert_eq!(
            validate_campaign_config(
                &env,
                budget,
                start_time,
                end_time,
                min_interval,
                max_slippage_bps,
                &source,
                &target
            ),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_validate_campaign_config_fails_on_token_pair() {
        let env = Env::default();
        let current = env.ledger().timestamp();

        let budget = 100_000_000i128;
        let start_time = current + 3600;
        let end_time = start_time + 86400;
        let min_interval = 600u64;
        let max_slippage_bps = 100u32;
        let token = Address::generate(&env);

        assert_eq!(
            validate_campaign_config(
                &env,
                budget,
                start_time,
                end_time,
                min_interval,
                max_slippage_bps,
                &token,
                &token // Same as source
            ),
            Err(Error::InvalidParameters)
        );
    }

    // Boundary tests for numeric constraints
    #[test]
    fn test_budget_boundary_min_minus_one() {
        assert_eq!(
            validate_budget(constants::MIN_BUDGET - 1),
            Err(Error::InvalidBudget)
        );
    }

    #[test]
    fn test_budget_boundary_max_plus_one() {
        assert_eq!(
            validate_budget(constants::MAX_BUDGET + 1),
            Err(Error::InvalidBudget)
        );
    }

    #[test]
    fn test_duration_boundary_min_minus_one() {
        let env = Env::default();
        let current = env.ledger().timestamp();
        let start = current + 3600;
        let end = start + constants::MIN_DURATION - 1;

        assert_eq!(
            validate_time_window(&env, start, end),
            Err(Error::InvalidTimeWindow)
        );
    }

    #[test]
    fn test_duration_boundary_max_plus_one() {
        let env = Env::default();
        let current = env.ledger().timestamp();
        let start = current + 3600;
        let end = start + constants::MAX_DURATION + 1;

        assert_eq!(
            validate_time_window(&env, start, end),
            Err(Error::InvalidTimeWindow)
        );
    }

    #[test]
    fn test_interval_boundary_min_minus_one() {
        assert_eq!(
            validate_min_interval(constants::MIN_INTERVAL - 1),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_interval_boundary_max_plus_one() {
        assert_eq!(
            validate_min_interval(constants::MAX_INTERVAL + 1),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_slippage_boundary_reasonable_max_plus_one() {
        assert_eq!(
            validate_slippage(constants::REASONABLE_MAX_SLIPPAGE_BPS + 1),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_slippage_boundary_absolute_max_plus_one() {
        assert_eq!(
            validate_slippage(constants::MAX_SLIPPAGE_BPS + 1),
            Err(Error::InvalidParameters)
        );
    }
}
