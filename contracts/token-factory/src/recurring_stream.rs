//! Recurring payment streams (Issue #1765).
//!
//! Builds on top of [`crate::streaming`] to auto-create child streams at
//! fixed ledger intervals. Explicitly bounded — [`MAX_RECURRING_PERIODS`]
//! total periods and [`MAX_TRACKED_CHILD_STREAMS`] tracked child ids per
//! recurring stream — so a single `RecurringStream` record's storage cost
//! and the gas cost of triggering it stay predictable regardless of how long
//! the schedule has been running.
//!
//! Each period's child stream is an "instant vest": `start_time == cliff_time`
//! and `end_time == start_time + 1`, so it becomes fully claimable a moment
//! after creation rather than vesting linearly over the period. The period
//! *cadence* itself (gated by `period_ledgers`/`current_period_start_ledger`,
//! in ledger-sequence units) is what spaces the payments out — the child
//! stream is just the payout for that period, not a sub-schedule.

use soroban_sdk::{Address, Env, Vec};

use crate::stream_types::{MAX_RECURRING_PERIODS, MAX_TRACKED_CHILD_STREAMS};
use crate::types::{Error, RecurringStream, RecurringStreamParams, StreamParams};
use crate::{events, storage, streaming};

/// Create a recurring stream and its first child stream (period 0).
///
/// # Errors
/// * `Error::ContractPaused` - Factory is paused
/// * `Error::InvalidAmount` - `amount_per_period <= 0`
/// * `Error::InvalidParameters` - `period_ledgers == 0`, or `total_periods == 0` without `auto_renew`
/// * `Error::RecurringStreamLimitReached` - `total_periods > MAX_RECURRING_PERIODS`
/// * `Error::TokenNotFound` - `token_index` is not a registered token
pub fn create_recurring_stream(
    env: &Env,
    creator: &Address,
    params: &RecurringStreamParams,
    token_index: u32,
) -> Result<u64, Error> {
    creator.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }
    if params.amount_per_period <= 0 {
        return Err(Error::InvalidAmount);
    }
    if params.period_ledgers == 0 {
        return Err(Error::InvalidParameters);
    }
    if params.total_periods > MAX_RECURRING_PERIODS {
        return Err(Error::RecurringStreamLimitReached);
    }
    if params.total_periods == 0 && !params.auto_renew {
        return Err(Error::InvalidParameters);
    }
    if storage::get_token_info(env, token_index).is_none() {
        return Err(Error::TokenNotFound);
    }

    let recurring_id = storage::increment_recurring_stream_count(env)?;

    let now_ts = env.ledger().timestamp();
    let first_child_params = StreamParams {
        recipient: params.recipient.clone(),
        token_index,
        total_amount: params.amount_per_period,
        start_time: now_ts,
        end_time: now_ts.saturating_add(1),
        cliff_time: now_ts,
    };
    let first_child =
        streaming::mint_stream(env, creator, &first_child_params, None, Vec::new(env));

    let mut child_streams = Vec::new(env);
    child_streams.push_back(first_child);

    let recurring = RecurringStream {
        id: recurring_id,
        creator: creator.clone(),
        recipient: params.recipient.clone(),
        amount_per_period: params.amount_per_period,
        period_ledgers: params.period_ledgers,
        total_periods: params.total_periods,
        periods_created: 1,
        current_period_start_ledger: env.ledger().sequence() as u64,
        auto_renew: params.auto_renew,
        auto_renew_enabled: params.auto_renew,
        cancelled: false,
        child_streams,
    };
    storage::set_recurring_stream(env, &recurring);
    storage::add_creator_recurring_stream(env, creator, recurring_id);

    events::emit_recurring_stream_created(
        env,
        recurring_id,
        creator,
        &params.recipient,
        params.amount_per_period,
        first_child,
    );

    Ok(recurring_id)
}

/// Create the next period's child stream, if the period has elapsed and the
/// recurring stream hasn't hit its period/child-tracking bounds.
///
/// Anyone can call this (not just the creator) once a period is due — the
/// creator's authorization was already captured once, at
/// [`create_recurring_stream`] time; requiring it again on every period would
/// defeat the point of "recurring". The child stream is minted via
/// [`streaming::mint_stream`] rather than [`streaming::create_stream`] for
/// exactly this reason.
///
/// # Errors
/// * `Error::ContractPaused` - Factory is paused
/// * `Error::RecurringStreamNotFound` - No recurring stream with this id
/// * `Error::RecurringStreamCancelled` - Recurring stream was cancelled
/// * `Error::RecurringPeriodNotElapsed` - Current period hasn't elapsed yet
/// * `Error::RecurringStreamLimitReached` - Reached `total_periods` (without
///   auto-renew) or [`MAX_TRACKED_CHILD_STREAMS`]
pub fn trigger_recurring_period(
    env: &Env,
    caller: &Address,
    recurring_stream_id: u64,
) -> Result<u64, Error> {
    caller.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let mut recurring = storage::get_recurring_stream(env, recurring_stream_id)
        .ok_or(Error::RecurringStreamNotFound)?;

    if recurring.cancelled {
        return Err(Error::RecurringStreamCancelled);
    }

    let now_ledger = env.ledger().sequence() as u64;
    let due_at = recurring
        .current_period_start_ledger
        .checked_add(recurring.period_ledgers)
        .ok_or(Error::ArithmeticError)?;
    if now_ledger < due_at {
        return Err(Error::RecurringPeriodNotElapsed);
    }

    let within_total =
        recurring.total_periods == 0 || recurring.periods_created < recurring.total_periods;
    if !within_total && !recurring.auto_renew_enabled {
        return Err(Error::RecurringStreamLimitReached);
    }
    if recurring.child_streams.len() >= MAX_TRACKED_CHILD_STREAMS {
        return Err(Error::RecurringStreamLimitReached);
    }

    let first_child_id = recurring
        .child_streams
        .get(0)
        .ok_or(Error::RecurringStreamNotFound)?;
    let token_index = storage::get_stream(env, first_child_id)
        .ok_or(Error::RecurringStreamNotFound)?
        .token_index;

    let now_ts = env.ledger().timestamp();
    let child_params = StreamParams {
        recipient: recurring.recipient.clone(),
        token_index,
        total_amount: recurring.amount_per_period,
        start_time: now_ts,
        end_time: now_ts.saturating_add(1),
        cliff_time: now_ts,
    };
    let child_id =
        streaming::mint_stream(env, &recurring.creator, &child_params, None, Vec::new(env));

    recurring.child_streams.push_back(child_id);
    recurring.periods_created = recurring
        .periods_created
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    recurring.current_period_start_ledger = now_ledger;
    storage::set_recurring_stream(env, &recurring);

    events::emit_recurring_period_triggered(
        env,
        recurring_stream_id,
        child_id,
        recurring.periods_created,
    );

    Ok(child_id)
}

/// Cancel a recurring stream. Already-created child streams are unaffected —
/// this only stops future periods from being triggered.
///
/// # Errors
/// * `Error::ContractPaused` - Factory is paused
/// * `Error::RecurringStreamNotFound` - No recurring stream with this id
/// * `Error::Unauthorized` - Caller is neither the creator nor the contract admin
/// * `Error::RecurringStreamCancelled` - Already cancelled
pub fn cancel_recurring_stream(
    env: &Env,
    actor: &Address,
    recurring_stream_id: u64,
) -> Result<(), Error> {
    actor.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let mut recurring = storage::get_recurring_stream(env, recurring_stream_id)
        .ok_or(Error::RecurringStreamNotFound)?;

    let admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *actor != recurring.creator && *actor != admin {
        return Err(Error::Unauthorized);
    }
    if recurring.cancelled {
        return Err(Error::RecurringStreamCancelled);
    }

    recurring.cancelled = true;
    recurring.auto_renew_enabled = false;
    storage::set_recurring_stream(env, &recurring);

    events::emit_recurring_stream_cancelled(env, recurring_stream_id, actor);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    fn setup(env: &Env) -> u32 {
        let admin = Address::generate(env);
        storage::set_admin(env, &admin);
        let token = crate::types::TokenInfo {
            address: Address::generate(env),
            creator: admin.clone(),
            name: soroban_sdk::String::from_str(env, "Test"),
            symbol: soroban_sdk::String::from_str(env, "TST"),
            decimals: 7,
            total_supply: 1_000_000_000,
            initial_supply: 1_000_000_000,
            max_supply: None,
            total_burned: 0,
            burn_count: 0,
            metadata_uri: None,
            metadata_version: 0,
            created_at: 0,
            is_paused: false,
            clawback_enabled: false,
            freeze_enabled: false,
        };
        storage::set_token_info(env, 0, &token);
        0
    }

    fn recurring_params(recipient: &Address) -> RecurringStreamParams {
        RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 100,
            period_ledgers: 10,
            total_periods: 5,
            auto_renew: false,
        }
    }

    #[test]
    fn create_recurring_stream_rejects_zero_period_ledgers() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let token_index = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let mut p = recurring_params(&recipient);
            p.period_ledgers = 0;
            let result = create_recurring_stream(&env, &creator, &p, token_index);
            assert_eq!(result, Err(Error::InvalidParameters));
        });
    }

    #[test]
    fn create_recurring_stream_rejects_over_max_periods() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let token_index = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let mut p = recurring_params(&recipient);
            p.total_periods = MAX_RECURRING_PERIODS + 1;
            let result = create_recurring_stream(&env, &creator, &p, token_index);
            assert_eq!(result, Err(Error::RecurringStreamLimitReached));
        });
    }

    #[test]
    fn create_recurring_stream_creates_first_child() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let token_index = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = recurring_params(&recipient);
            let id = create_recurring_stream(&env, &creator, &p, token_index).unwrap();

            let recurring = storage::get_recurring_stream(&env, id).unwrap();
            assert_eq!(recurring.periods_created, 1);
            assert_eq!(recurring.child_streams.len(), 1);
        });
    }

    #[test]
    fn trigger_before_period_elapsed_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        // Each auth-requiring call gets its own `as_contract` frame — the
        // same address calling `require_auth()` twice within one frame
        // (even under `mock_all_auths`) trips this soroban-sdk version's
        // "frame is already authorized" guard.
        env.ledger().with_mut(|li| li.sequence_number = 100);
        let (creator, id) = env.as_contract(&contract_id, || {
            let token_index = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = recurring_params(&recipient);
            let id = create_recurring_stream(&env, &creator, &p, token_index).unwrap();
            (creator, id)
        });

        env.ledger().with_mut(|li| li.sequence_number = 105); // only 5 elapsed, period is 10
        let result = env.as_contract(&contract_id, || {
            trigger_recurring_period(&env, &creator, id)
        });
        assert_eq!(result, Err(Error::RecurringPeriodNotElapsed));
    }

    #[test]
    fn trigger_after_period_elapsed_succeeds_and_anyone_can_call() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            env.ledger().with_mut(|li| li.sequence_number = 100);
            let token_index = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = recurring_params(&recipient);
            let id = create_recurring_stream(&env, &creator, &p, token_index).unwrap();

            env.ledger().with_mut(|li| li.sequence_number = 110);
            // Recipient (not creator) triggers — should succeed without creator's
            // live signature, since mint_stream (not create_stream) is used.
            let child_id = trigger_recurring_period(&env, &recipient, id).unwrap();
            assert!(child_id > 0);

            let recurring = storage::get_recurring_stream(&env, id).unwrap();
            assert_eq!(recurring.periods_created, 2);
            assert_eq!(recurring.child_streams.len(), 2);
        });
    }

    #[test]
    fn trigger_stops_at_total_periods_without_auto_renew() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.ledger().with_mut(|li| li.sequence_number = 0);
        let (creator, id) = env.as_contract(&contract_id, || {
            let token_index = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let mut p = recurring_params(&recipient);
            p.total_periods = 2;
            let id = create_recurring_stream(&env, &creator, &p, token_index).unwrap();
            (creator, id)
        });

        env.ledger().with_mut(|li| li.sequence_number = 10);
        env.as_contract(&contract_id, || {
            trigger_recurring_period(&env, &creator, id).unwrap()
        }); // period 2 (of 2)

        env.ledger().with_mut(|li| li.sequence_number = 20);
        let result = env.as_contract(&contract_id, || {
            trigger_recurring_period(&env, &creator, id)
        });
        assert_eq!(result, Err(Error::RecurringStreamLimitReached));
    }

    #[test]
    fn trigger_after_cancel_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.ledger().with_mut(|li| li.sequence_number = 0);
        let (creator, id) = env.as_contract(&contract_id, || {
            let token_index = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = recurring_params(&recipient);
            let id = create_recurring_stream(&env, &creator, &p, token_index).unwrap();
            (creator, id)
        });

        env.as_contract(&contract_id, || {
            cancel_recurring_stream(&env, &creator, id).unwrap()
        });

        env.ledger().with_mut(|li| li.sequence_number = 10);
        let result = env.as_contract(&contract_id, || {
            trigger_recurring_period(&env, &creator, id)
        });
        assert_eq!(result, Err(Error::RecurringStreamCancelled));
    }

    #[test]
    fn cancel_requires_creator_or_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let token_index = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let attacker = Address::generate(&env);
            let p = recurring_params(&recipient);
            let id = create_recurring_stream(&env, &creator, &p, token_index).unwrap();

            let result = cancel_recurring_stream(&env, &attacker, id);
            assert_eq!(result, Err(Error::Unauthorized));
        });
    }

    #[test]
    fn cancel_twice_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        let (creator, id) = env.as_contract(&contract_id, || {
            let token_index = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = recurring_params(&recipient);
            let id = create_recurring_stream(&env, &creator, &p, token_index).unwrap();
            (creator, id)
        });

        env.as_contract(&contract_id, || {
            cancel_recurring_stream(&env, &creator, id).unwrap()
        });
        let result = env.as_contract(&contract_id, || cancel_recurring_stream(&env, &creator, id));
        assert_eq!(result, Err(Error::RecurringStreamCancelled));
    }
}
