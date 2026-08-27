//! Linear vesting math with an optional cliff (Issue #1765).
//!
//! Pure computation only — no storage access — so it can be unit tested
//! exhaustively and reused by both `streaming::claim_stream` and any future
//! caller that needs to know how much of a schedule has vested at a given
//! ledger timestamp.

use crate::types::Error;

/// Compute the amount vested under a linear schedule with an optional cliff.
///
/// # Schedule semantics
/// * Before `cliff_time`: nothing is vested, regardless of `start_time`.
/// * At or after `end_time`: the full `total_amount` is vested.
/// * Between `cliff_time` and `end_time`: vested amount grows linearly from
///   `start_time` to `end_time` — i.e. the cliff only *gates* when vesting
///   becomes claimable, it does not change the linear slope. This matches
///   standard token-grant vesting: a 4-year grant with a 1-year cliff still
///   vests linearly over the full 4 years, it just can't be claimed at all
///   until the 1-year mark.
///
/// # Arguments
/// * `total_amount` - Total amount subject to vesting (must be >= 0)
/// * `start_time` - Ledger timestamp vesting begins accruing from
/// * `end_time` - Ledger timestamp at which vesting is 100% complete
/// * `cliff_time` - Ledger timestamp before which nothing is claimable
/// * `now` - Current ledger timestamp
///
/// # Errors
/// * `Error::InvalidStreamSchedule` - `end_time <= start_time`, or `cliff_time`
///   falls outside `[start_time, end_time]`
/// * `Error::ArithmeticError` - Overflow computing the vested amount
pub fn linear_vested_amount(
    total_amount: i128,
    start_time: u64,
    end_time: u64,
    cliff_time: u64,
    now: u64,
) -> Result<i128, Error> {
    if end_time <= start_time || cliff_time < start_time || cliff_time > end_time {
        return Err(Error::InvalidStreamSchedule);
    }

    if now < cliff_time {
        return Ok(0);
    }
    if now >= end_time {
        return Ok(total_amount);
    }

    let elapsed = (now - start_time) as i128;
    let duration = (end_time - start_time) as i128;

    total_amount
        .checked_mul(elapsed)
        .and_then(|v| v.checked_div(duration))
        .ok_or(Error::ArithmeticError)
}

/// Validate that a `(start_time, end_time, cliff_time)` triple describes a
/// well-formed vesting schedule, without computing a vested amount.
///
/// Shared by `streaming::create_stream` / `batch_create_streams` so schedule
/// validation happens before any storage write.
pub fn validate_schedule(start_time: u64, end_time: u64, cliff_time: u64) -> Result<(), Error> {
    if end_time <= start_time || cliff_time < start_time || cliff_time > end_time {
        return Err(Error::InvalidStreamSchedule);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn before_cliff_nothing_vested() {
        let result = linear_vested_amount(1_000, 100, 1_100, 400, 250).unwrap();
        assert_eq!(result, 0);
    }

    #[test]
    fn exactly_at_cliff_uses_linear_slope_not_zero() {
        // cliff at 400, start 100, end 1100 => elapsed 300/1000 of duration
        let result = linear_vested_amount(1_000, 100, 1_100, 400, 400).unwrap();
        assert_eq!(result, 300);
    }

    #[test]
    fn no_cliff_linear_from_start() {
        // cliff == start_time: vesting is claimable immediately, growing linearly
        let result = linear_vested_amount(1_000, 0, 1_000, 0, 250).unwrap();
        assert_eq!(result, 250);
    }

    #[test]
    fn mid_vest_linear_interpolation() {
        let result = linear_vested_amount(1_000_000, 0, 100, 0, 50).unwrap();
        assert_eq!(result, 500_000);
    }

    #[test]
    fn at_end_time_fully_vested() {
        let result = linear_vested_amount(1_000, 0, 1_000, 0, 1_000).unwrap();
        assert_eq!(result, 1_000);
    }

    #[test]
    fn after_end_time_fully_vested() {
        let result = linear_vested_amount(1_000, 0, 1_000, 0, 5_000).unwrap();
        assert_eq!(result, 1_000);
    }

    #[test]
    fn cliff_equal_to_end_time_all_or_nothing() {
        // cliff == end_time: 0 right up until end_time, then the full amount.
        assert_eq!(linear_vested_amount(500, 0, 1_000, 1_000, 999).unwrap(), 0);
        assert_eq!(
            linear_vested_amount(500, 0, 1_000, 1_000, 1_000).unwrap(),
            500
        );
    }

    #[test]
    fn invalid_schedule_end_before_start() {
        let result = linear_vested_amount(1_000, 500, 100, 200, 300);
        assert_eq!(result, Err(Error::InvalidStreamSchedule));
    }

    #[test]
    fn invalid_schedule_end_equal_start() {
        let result = linear_vested_amount(1_000, 500, 500, 500, 500);
        assert_eq!(result, Err(Error::InvalidStreamSchedule));
    }

    #[test]
    fn invalid_schedule_cliff_before_start() {
        let result = linear_vested_amount(1_000, 500, 1_000, 100, 600);
        assert_eq!(result, Err(Error::InvalidStreamSchedule));
    }

    #[test]
    fn invalid_schedule_cliff_after_end() {
        let result = linear_vested_amount(1_000, 0, 500, 600, 300);
        assert_eq!(result, Err(Error::InvalidStreamSchedule));
    }

    #[test]
    fn zero_total_amount_vests_zero_throughout() {
        assert_eq!(linear_vested_amount(0, 0, 1_000, 0, 500).unwrap(), 0);
        assert_eq!(linear_vested_amount(0, 0, 1_000, 0, 1_000).unwrap(), 0);
    }

    #[test]
    fn realistic_large_amount_no_overflow() {
        // A billion-token grant (7 decimals) vesting over ~4 years of seconds —
        // representative of real usage, and small enough that total * elapsed
        // fits in i128 well within bounds.
        let total = 1_000_000_000 * 10_000_000; // 1e9 tokens, 7 decimals
        let four_years = 4 * 365 * 24 * 60 * 60;
        let result = linear_vested_amount(total, 0, four_years, 0, four_years / 2).unwrap();
        assert_eq!(result, total / 2);
    }

    #[test]
    fn multiplication_overflow_returns_arithmetic_error_not_panic() {
        // An intentionally extreme total_amount where total * elapsed
        // overflows i128 — must be caught by checked arithmetic, not panic
        // or silently wrap.
        let result = linear_vested_amount(i128::MAX / 2, 0, 1_000_000, 0, 500_000);
        assert_eq!(result, Err(Error::ArithmeticError));
    }

    #[test]
    fn validate_schedule_accepts_well_formed() {
        assert!(validate_schedule(0, 1_000, 500).is_ok());
        assert!(validate_schedule(0, 1_000, 0).is_ok());
        assert!(validate_schedule(0, 1_000, 1_000).is_ok());
    }

    #[test]
    fn validate_schedule_rejects_malformed() {
        assert_eq!(
            validate_schedule(1_000, 0, 500),
            Err(Error::InvalidStreamSchedule)
        );
        assert_eq!(
            validate_schedule(0, 1_000, 1_001),
            Err(Error::InvalidStreamSchedule)
        );
        assert_eq!(
            validate_schedule(0, 0, 0),
            Err(Error::InvalidStreamSchedule)
        );
    }
}
