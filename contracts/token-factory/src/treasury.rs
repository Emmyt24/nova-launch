use crate::storage;
use crate::types::{Error, TreasuryPolicy, WithdrawalPeriod};
use soroban_sdk::{Address, Env};

/// Default daily withdrawal cap (100 XLM in stroops)
const DEFAULT_DAILY_CAP: i128 = 100_0000000;

/// Default period duration (24 hours in seconds)
const DEFAULT_PERIOD_DURATION: u64 = 86_400;

/// Initialize treasury policy
///
/// Sets up withdrawal limits and controls for the treasury.
///
/// # Arguments
/// * `env` - The contract environment
/// * `daily_cap` - Maximum withdrawal per day (in stroops)
/// * `allowlist_enabled` - Whether to enforce recipient allowlist
///
/// # Examples
/// ```
/// // 100 XLM daily cap with allowlist
/// initialize_treasury_policy(&env, 100_0000000, true)?;
/// ```
pub fn initialize_treasury_policy(
    env: &Env,
    daily_cap: Option<i128>,
    allowlist_enabled: bool,
) -> Result<(), Error> {
    let cap = daily_cap.unwrap_or(DEFAULT_DAILY_CAP);

    if cap < 0 {
        return Err(Error::InvalidParameters);
    }

    let policy = TreasuryPolicy {
        daily_cap: cap,
        allowlist_enabled,
        period_duration: DEFAULT_PERIOD_DURATION,
    };

    storage::set_treasury_policy(env, &policy);

    // Initialize withdrawal period
    let period = WithdrawalPeriod {
        period_start: env.ledger().timestamp(),
        amount_withdrawn: 0,
    };

    storage::set_withdrawal_period(env, &period);

    crate::events::emit_treasury_policy_initialized(env, cap, allowlist_enabled);

    Ok(())
}

/// Check if a new period should start
///
/// Returns true if the current period has expired and should be reset.
fn should_reset_period(env: &Env, period: &WithdrawalPeriod, policy: &TreasuryPolicy) -> bool {
    let current_time = env.ledger().timestamp();
    let period_end = period
        .period_start
        .checked_add(policy.period_duration)
        .unwrap_or(u64::MAX);
    current_time >= period_end
}

/// Reset withdrawal period
///
/// Starts a new withdrawal period with zero withdrawn amount.
fn reset_period(env: &Env) {
    let period = WithdrawalPeriod {
        period_start: env.ledger().timestamp(),
        amount_withdrawn: 0,
    };

    storage::set_withdrawal_period(env, &period);
}

/// Validate withdrawal against policy
///
/// Checks if a withdrawal is allowed based on:
/// - Daily cap limits
/// - Recipient allowlist (if enabled)
/// - Period reset logic
///
/// # Arguments
/// * `env` - The contract environment
/// * `recipient` - Address receiving the withdrawal
/// * `amount` - Amount to withdraw
///
/// # Returns
/// * `Ok(())` - Withdrawal is allowed
/// * `Err(Error::WithdrawalCapExceeded)` - Would exceed daily cap
/// * `Err(Error::RecipientNotAllowed)` - Recipient not in allowlist
/// * `Err(Error::InvalidAmount)` - Amount is zero or negative
pub fn validate_withdrawal(env: &Env, recipient: &Address, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let policy = storage::get_treasury_policy(env);

    // Check allowlist if enabled
    if policy.allowlist_enabled && !storage::is_allowed_recipient(env, recipient) {
        return Err(Error::RecipientNotAllowed);
    }

    let mut period = storage::get_withdrawal_period(env);

    // Reset period if expired
    if should_reset_period(env, &period, &policy) {
        reset_period(env);
        period = storage::get_withdrawal_period(env);
    }

    // Check daily cap
    let new_total = period
        .amount_withdrawn
        .checked_add(amount)
        .ok_or(Error::ArithmeticError)?;

    if new_total > policy.daily_cap {
        return Err(Error::WithdrawalCapExceeded);
    }

    Ok(())
}

/// Record withdrawal
///
/// Updates the withdrawal period tracking after a successful withdrawal.
///
/// # Arguments
/// * `env` - The contract environment
/// * `amount` - Amount withdrawn
pub fn record_withdrawal(env: &Env, amount: i128) -> Result<(), Error> {
    let mut period = storage::get_withdrawal_period(env);

    period.amount_withdrawn = period
        .amount_withdrawn
        .checked_add(amount)
        .ok_or(Error::ArithmeticError)?;

    storage::set_withdrawal_period(env, &period);

    Ok(())
}

/// Withdraw fees from treasury
///
/// Transfers accumulated fees to a recipient address.
/// Enforces withdrawal policy limits and allowlist.
///
/// # Arguments
/// * `env` - The contract environment
/// * `admin` - Admin address (must authorize)
/// * `recipient` - Address to receive the funds
/// * `amount` - Amount to withdraw
///
/// # Returns
/// * `Ok(())` - Withdrawal successful
/// * `Err(Error::Unauthorized)` - Caller is not admin
/// * `Err(Error::WithdrawalCapExceeded)` - Exceeds daily cap
/// * `Err(Error::RecipientNotAllowed)` - Recipient not allowed
/// * `Err(Error::InvalidAmount)` - Invalid amount
pub fn withdraw_fees(
    env: &Env,
    admin: &Address,
    recipient: &Address,
    amount: i128,
) -> Result<(), Error> {
    admin.require_auth();

    // Verify admin
    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    // Validate withdrawal
    validate_withdrawal(env, recipient, amount)?;

    // Record withdrawal
    record_withdrawal(env, amount)?;

    // Emit event
    crate::events::emit_treasury_withdrawal(env, recipient, amount);

    Ok(())
}

/// Add recipient to allowlist
///
/// Allows an address to receive treasury withdrawals.
/// Only admin can modify the allowlist.
///
/// # Arguments
/// * `env` - The contract environment
/// * `admin` - Admin address (must authorize)
/// * `recipient` - Address to add to allowlist
pub fn add_allowed_recipient(env: &Env, admin: &Address, recipient: &Address) -> Result<(), Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    storage::set_allowed_recipient(env, recipient, true);
    crate::events::emit_recipient_added(env, recipient);

    Ok(())
}

/// Remove recipient from allowlist
///
/// Revokes an address's ability to receive treasury withdrawals.
/// Only admin can modify the allowlist.
///
/// # Arguments
/// * `env` - The contract environment
/// * `admin` - Admin address (must authorize)
/// * `recipient` - Address to remove from allowlist
pub fn remove_allowed_recipient(
    env: &Env,
    admin: &Address,
    recipient: &Address,
) -> Result<(), Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    storage::set_allowed_recipient(env, recipient, false);
    crate::events::emit_recipient_removed(env, recipient);

    Ok(())
}

/// Update treasury policy
///
/// Changes the withdrawal limits and allowlist settings.
/// Only admin can update the policy.
///
/// # Arguments
/// * `env` - The contract environment
/// * `admin` - Admin address (must authorize)
/// * `daily_cap` - Optional new daily cap
/// * `allowlist_enabled` - Optional new allowlist setting
pub fn update_treasury_policy(
    env: &Env,
    admin: &Address,
    daily_cap: Option<i128>,
    allowlist_enabled: Option<bool>,
) -> Result<(), Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    let mut policy = storage::get_treasury_policy(env);

    if let Some(cap) = daily_cap {
        if cap < 0 {
            return Err(Error::InvalidParameters);
        }
        policy.daily_cap = cap;
    }

    if let Some(enabled) = allowlist_enabled {
        policy.allowlist_enabled = enabled;
    }

    storage::set_treasury_policy(env, &policy);
    crate::events::emit_treasury_policy_updated(env, policy.daily_cap, policy.allowlist_enabled);

    Ok(())
}

/// Get remaining withdrawal capacity for current period
///
/// Returns how much more can be withdrawn before hitting the daily cap.
///
/// # Arguments
/// * `env` - The contract environment
///
/// # Returns
/// Remaining withdrawal capacity in stroops
pub fn get_remaining_capacity(env: &Env) -> i128 {
    let policy = storage::get_treasury_policy(env);
    let period = storage::get_withdrawal_period(env);

    policy
        .daily_cap
        .saturating_sub(period.amount_withdrawn)
        .max(0)
}

/// Get treasury policy
///
/// Returns the current withdrawal policy settings.
pub fn get_treasury_policy(env: &Env) -> TreasuryPolicy {
    storage::get_treasury_policy(env)
}

/// Check if address is allowed recipient
///
/// Returns true if the address can receive treasury withdrawals.
pub fn is_allowed_recipient(env: &Env, recipient: &Address) -> bool {
    storage::is_allowed_recipient(env, recipient)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };

    fn install_contract(env: &Env) -> Address {
        let contract_id = Address::generate(env);
        env.register_contract(Some(&contract_id), crate::TokenFactory)
    }

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = install_contract(&env);

        let admin = Address::generate(&env);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            initialize_treasury_policy(&env, Some(100_0000000), false).unwrap();
        });

        (env, admin, contract_id)
    }

    #[test]
    fn test_initialize_treasury_policy() {
        let env = Env::default();
        let contract_id = install_contract(&env);

        env.as_contract(&contract_id, || {
            initialize_treasury_policy(&env, Some(50_0000000), true).unwrap();
        });

        let policy = env.as_contract(&contract_id, || storage::get_treasury_policy(&env));
        assert_eq!(policy.daily_cap, 50_0000000);
        assert!(policy.allowlist_enabled);
    }

    #[test]
    fn test_validate_withdrawal_within_cap() {
        let (env, _admin, contract_id) = setup();
        let recipient = Address::generate(&env);

        let result = env.as_contract(&contract_id, || validate_withdrawal(&env, &recipient, 50_0000000));
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_withdrawal_exceeds_cap() {
        let (env, _admin, contract_id) = setup();
        let recipient = Address::generate(&env);

        let result = env.as_contract(&contract_id, || validate_withdrawal(&env, &recipient, 150_0000000));
        assert_eq!(result, Err(Error::WithdrawalCapExceeded));
    }

    #[test]
    fn test_validate_withdrawal_exact_cap() {
        let (env, _admin, contract_id) = setup();
        let recipient = Address::generate(&env);

        let result = env.as_contract(&contract_id, || validate_withdrawal(&env, &recipient, 100_0000000));
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_withdrawal_allowlist_enforced() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = install_contract(&env);

        let admin = Address::generate(&env);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
        });

        // Enable allowlist
        env.as_contract(&contract_id, || {
            initialize_treasury_policy(&env, Some(100_0000000), true).unwrap();
        });

        let recipient = Address::generate(&env);

        // Should fail - not in allowlist
        let result = env.as_contract(&contract_id, || validate_withdrawal(&env, &recipient, 50_0000000));
        assert_eq!(result, Err(Error::RecipientNotAllowed));

        // Add to allowlist
        env.as_contract(&contract_id, || {
            storage::set_allowed_recipient(&env, &recipient, true);
        });

        // Should succeed now
        let result = env.as_contract(&contract_id, || validate_withdrawal(&env, &recipient, 50_0000000));
        assert!(result.is_ok());
    }

    #[test]
    fn test_record_withdrawal() {
        let (env, _admin, contract_id) = setup();

        env.as_contract(&contract_id, || {
            record_withdrawal(&env, 30_0000000).unwrap();
        });

        let period = env.as_contract(&contract_id, || storage::get_withdrawal_period(&env));
        assert_eq!(period.amount_withdrawn, 30_0000000);

        env.as_contract(&contract_id, || {
            record_withdrawal(&env, 20_0000000).unwrap();
        });

        let period = env.as_contract(&contract_id, || storage::get_withdrawal_period(&env));
        assert_eq!(period.amount_withdrawn, 50_0000000);
    }

    #[test]
    fn test_period_reset() {
        let (env, _admin, contract_id) = setup();
        let recipient = Address::generate(&env);

        // Withdraw 80 XLM
        env.as_contract(&contract_id, || {
            validate_withdrawal(&env, &recipient, 80_0000000).unwrap();
            record_withdrawal(&env, 80_0000000).unwrap();
        });

        // Try to withdraw 30 more - should fail
        let result = env.as_contract(&contract_id, || validate_withdrawal(&env, &recipient, 30_0000000));
        assert_eq!(result, Err(Error::WithdrawalCapExceeded));

        // Advance time by 24 hours + 1 second
        env.ledger().with_mut(|li| {
            li.timestamp = li.timestamp + 86_401;
        });

        // Should succeed now (new period)
        let result = env.as_contract(&contract_id, || validate_withdrawal(&env, &recipient, 30_0000000));
        assert!(result.is_ok());
    }

    #[test]
    fn test_get_remaining_capacity() {
        let (env, _admin, contract_id) = setup();

        // Initially full capacity
        assert_eq!(env.as_contract(&contract_id, || get_remaining_capacity(&env)), 100_0000000);

        // Withdraw 30 XLM
        env.as_contract(&contract_id, || {
            record_withdrawal(&env, 30_0000000).unwrap();
        });
        assert_eq!(env.as_contract(&contract_id, || get_remaining_capacity(&env)), 70_0000000);

        // Withdraw 50 more
        env.as_contract(&contract_id, || {
            record_withdrawal(&env, 50_0000000).unwrap();
        });
        assert_eq!(env.as_contract(&contract_id, || get_remaining_capacity(&env)), 20_0000000);
    }

    #[test]
    fn test_add_remove_allowed_recipient() {
        let (env, admin, contract_id) = setup();
        let recipient = Address::generate(&env);

        // Initially not allowed
        assert!(!env.as_contract(&contract_id, || is_allowed_recipient(&env, &recipient)));

        // Add to allowlist
        env.as_contract(&contract_id, || {
            add_allowed_recipient(&env, &admin, &recipient).unwrap();
        });
        assert!(env.as_contract(&contract_id, || is_allowed_recipient(&env, &recipient)));

        // Remove from allowlist
        env.as_contract(&contract_id, || {
            remove_allowed_recipient(&env, &admin, &recipient).unwrap();
        });
        assert!(!env.as_contract(&contract_id, || is_allowed_recipient(&env, &recipient)));
    }

    #[test]
    fn test_update_treasury_policy() {
        let (env, admin, contract_id) = setup();

        // Update daily cap
        env.as_contract(&contract_id, || {
            update_treasury_policy(&env, &admin, Some(200_0000000), None).unwrap();
        });

        let policy = env.as_contract(&contract_id, || storage::get_treasury_policy(&env));
        assert_eq!(policy.daily_cap, 200_0000000);

        // Update allowlist setting
        env.as_contract(&contract_id, || {
            update_treasury_policy(&env, &admin, None, Some(true)).unwrap();
        });

        let policy = env.as_contract(&contract_id, || storage::get_treasury_policy(&env));
        assert!(policy.allowlist_enabled);
    }

    #[test]
    fn test_withdraw_fees_full_flow() {
        let (env, admin, contract_id) = setup();
        let recipient = Address::generate(&env);

        // First withdrawal
        env.as_contract(&contract_id, || {
            withdraw_fees(&env, &admin, &recipient, 40_0000000).unwrap();
        });
        assert_eq!(env.as_contract(&contract_id, || get_remaining_capacity(&env)), 60_0000000);

        // Second withdrawal
        env.as_contract(&contract_id, || {
            withdraw_fees(&env, &admin, &recipient, 30_0000000).unwrap();
        });
        assert_eq!(env.as_contract(&contract_id, || get_remaining_capacity(&env)), 30_0000000);

        // Third withdrawal should fail (would exceed cap)
        let result =
            env.as_contract(&contract_id, || withdraw_fees(&env, &admin, &recipient, 40_0000000));
        assert_eq!(result, Err(Error::WithdrawalCapExceeded));
    }

    #[test]
    fn test_zero_amount_rejected() {
        let (env, _admin, contract_id) = setup();
        let recipient = Address::generate(&env);

        let result = env.as_contract(&contract_id, || validate_withdrawal(&env, &recipient, 0));
        assert_eq!(result, Err(Error::InvalidAmount));
    }

    #[test]
    fn test_negative_amount_rejected() {
        let (env, _admin, contract_id) = setup();
        let recipient = Address::generate(&env);

        let result = env.as_contract(&contract_id, || validate_withdrawal(&env, &recipient, -100));
        assert_eq!(result, Err(Error::InvalidAmount));
    }
}
