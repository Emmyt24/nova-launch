//! Liquidity Mining Program
//!
//! Liquidity providers deposit a stake token into an admin-created mining
//! pool and earn a reward token over time, distributed proportionally to
//! their share of the pool's total deposits.
//!
//! ## Pool lifecycle
//!
//! Pools are an explicit state machine (see [`MiningPoolStatus`]):
//!
//! ```text
//! Active <──────> Paused
//!   │                │
//!   └──────┬─────────┘
//!          v
//!        Ended
//! ```
//!
//! * `Active -> Paused` via [`pause_mining_pool`]
//! * `Paused -> Active` via [`resume_mining_pool`]
//! * `Active -> Ended` or `Paused -> Ended` via [`end_mining_pool`] (terminal)
//!
//! Any other transition (e.g. pausing an already-paused pool, resuming an
//! `Ended` pool) is rejected with a dedicated error rather than silently
//! no-op'ing.
//!
//! ## Reward accrual
//!
//! Rewards use the standard reward-per-token accumulator pattern (as seen
//! in Synthetix-style staking rewards contracts), giving O(1) reward
//! calculation regardless of provider count:
//!
//! * `reward_per_token_stored` accumulates `elapsed * reward_rate * PRECISION / total_staked`
//!   every time the pool is checkpointed (on deposit, withdraw, claim, or an
//!   admin lifecycle/rate change).
//! * Accrual is capped at `pool.end_time` and freezes entirely while the
//!   pool is `Paused` — resuming resets the checkpoint clock to "now" so the
//!   paused interval is never rewarded.
//! * A provider's claimable amount is derived from the delta between the
//!   pool's current accumulator and the value it had at the provider's last
//!   checkpoint (`reward_per_token_paid`), scaled by their staked amount.
//!
//! ## Security
//!
//! * All arithmetic uses checked operations.
//! * State-changing entry points require the caller's `require_auth`.
//! * Admin-only operations additionally verify the caller against the
//!   contract's stored admin.
//! * Pool/position state is written before events are emitted.

use crate::events;
use crate::storage;
use crate::types::{Error, LiquidityMiningPool, MiningPoolStatus, ProviderStake};
use soroban_sdk::{Address, Env};

/// Fixed-point precision used for the reward-per-token accumulator.
const REWARD_PRECISION: i128 = 10_000_000;

/// Upper bound on the number of pools that may be created, to keep
/// pool-count storage bounded.
const MAX_POOLS: u64 = 1_000;

/// Upper bound on `reward_rate` (reward tokens per second, in stroops)
/// accepted for a pool, as a basic sanity guard against fat-fingered input.
const MAX_REWARD_RATE: i128 = 1_000_000_000;

// ─────────────────────────────────────────────────────────────────────────
// Pool management
// ─────────────────────────────────────────────────────────────────────────

/// Create a new liquidity mining pool.
///
/// Only the contract admin may create pools. The pool starts in the
/// `Active` state immediately.
///
/// # Errors
/// * [`Error::Unauthorized`] - caller is not the admin
/// * [`Error::ContractPaused`] - contract is globally paused
/// * [`Error::TokenNotFound`] - reward or stake token index does not exist
/// * [`Error::InvalidPoolTimeWindow`] - `start_time >= end_time`, or `end_time` already elapsed
/// * [`Error::InvalidRewardRate`] - `reward_rate <= 0` or exceeds the maximum
/// * [`Error::TooManyMiningPools`] - the pool cap has been reached
pub fn create_mining_pool(
    env: &Env,
    admin: &Address,
    reward_token_index: u32,
    stake_token_index: u32,
    reward_rate: i128,
    start_time: u64,
    end_time: u64,
) -> Result<u64, Error> {
    admin.require_auth();

    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    storage::get_token_info(env, reward_token_index).ok_or(Error::TokenNotFound)?;
    storage::get_token_info(env, stake_token_index).ok_or(Error::TokenNotFound)?;

    let now = env.ledger().timestamp();
    if start_time >= end_time || end_time <= now {
        return Err(Error::InvalidPoolTimeWindow);
    }

    if reward_rate <= 0 || reward_rate > MAX_REWARD_RATE {
        return Err(Error::InvalidRewardRate);
    }

    if storage::get_mining_pool_count(env) >= MAX_POOLS {
        return Err(Error::TooManyMiningPools);
    }

    let pool_id = storage::next_mining_pool_id(env)?;

    let pool = LiquidityMiningPool {
        id: pool_id,
        reward_token_index,
        stake_token_index,
        reward_rate,
        start_time,
        end_time,
        total_staked: 0,
        reward_per_token_stored: 0,
        last_update_time: start_time,
        status: MiningPoolStatus::Active,
        created_at: now,
    };

    storage::set_mining_pool(env, pool_id, &pool);

    events::emit_mining_pool_created(
        env,
        pool_id,
        admin,
        reward_token_index,
        stake_token_index,
        reward_rate,
        start_time,
        end_time,
    );

    Ok(pool_id)
}

/// Deposit stake tokens into a pool, updating the caller's position.
///
/// Pending rewards are checkpointed before the new deposit is applied so
/// that reward accrual is always attributed fairly across depositors.
///
/// # Errors
/// * [`Error::InvalidAmount`] - `amount <= 0`
/// * [`Error::MiningPoolNotFound`] - pool does not exist
/// * [`Error::MiningPoolNotActive`] - pool is not `Active`
/// * [`Error::InvalidPoolTimeWindow`] - pool has not started, or has already ended
/// * [`Error::ArithmeticError`] - overflow updating staked totals
pub fn deposit(env: &Env, provider: &Address, pool_id: u64, amount: i128) -> Result<(), Error> {
    provider.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut pool = storage::get_mining_pool(env, pool_id).ok_or(Error::MiningPoolNotFound)?;

    if pool.status != MiningPoolStatus::Active {
        return Err(Error::MiningPoolNotActive);
    }

    let now = env.ledger().timestamp();
    if now < pool.start_time || now >= pool.end_time {
        return Err(Error::InvalidPoolTimeWindow);
    }

    update_reward_per_token(env, &mut pool)?;

    let mut position =
        storage::get_mining_position(env, pool_id, provider).unwrap_or(ProviderStake {
            provider: provider.clone(),
            pool_id,
            staked_amount: 0,
            reward_per_token_paid: pool.reward_per_token_stored,
            pending_rewards: 0,
        });

    position.pending_rewards = calculate_earned(&pool, &position)?;
    position.reward_per_token_paid = pool.reward_per_token_stored;
    position.staked_amount = position
        .staked_amount
        .checked_add(amount)
        .ok_or(Error::ArithmeticError)?;

    pool.total_staked = pool
        .total_staked
        .checked_add(amount)
        .ok_or(Error::ArithmeticError)?;

    storage::set_mining_pool(env, pool_id, &pool);
    storage::set_mining_position(env, pool_id, provider, &position);

    events::emit_liquidity_deposited(env, pool_id, provider, amount, position.staked_amount);

    Ok(())
}

/// Withdraw staked tokens from a pool, updating the caller's position.
///
/// Pending rewards are checkpointed but *not* automatically claimed — call
/// [`claim_rewards`] separately to collect them. Withdrawal is allowed
/// regardless of pool status (including `Ended`) so providers can always
/// retrieve their principal.
///
/// # Errors
/// * [`Error::InvalidAmount`] - `amount <= 0`
/// * [`Error::MiningPoolNotFound`] - pool does not exist
/// * [`Error::NoMiningPosition`] - caller has no position in the pool
/// * [`Error::InsufficientStakedAmount`] - `amount` exceeds the caller's staked balance
/// * [`Error::ArithmeticError`] - overflow updating staked totals
pub fn withdraw(env: &Env, provider: &Address, pool_id: u64, amount: i128) -> Result<(), Error> {
    provider.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut pool = storage::get_mining_pool(env, pool_id).ok_or(Error::MiningPoolNotFound)?;
    let mut position =
        storage::get_mining_position(env, pool_id, provider).ok_or(Error::NoMiningPosition)?;

    if position.staked_amount < amount {
        return Err(Error::InsufficientStakedAmount);
    }

    update_reward_per_token(env, &mut pool)?;

    position.pending_rewards = calculate_earned(&pool, &position)?;
    position.reward_per_token_paid = pool.reward_per_token_stored;
    position.staked_amount = position
        .staked_amount
        .checked_sub(amount)
        .ok_or(Error::ArithmeticError)?;

    pool.total_staked = pool
        .total_staked
        .checked_sub(amount)
        .ok_or(Error::ArithmeticError)?;

    storage::set_mining_pool(env, pool_id, &pool);
    storage::set_mining_position(env, pool_id, provider, &position);

    events::emit_liquidity_withdrawn(env, pool_id, provider, amount, position.staked_amount);

    Ok(())
}

/// Claim all accumulated rewards for the caller from a pool.
///
/// # Errors
/// * [`Error::MiningPoolNotFound`] - pool does not exist
/// * [`Error::NoMiningPosition`] - caller has no position in the pool
/// * [`Error::NothingToClaim`] - claimable amount is zero
/// * [`Error::ArithmeticError`] - overflow computing the claimable amount
pub fn claim_rewards(env: &Env, provider: &Address, pool_id: u64) -> Result<i128, Error> {
    provider.require_auth();

    let mut pool = storage::get_mining_pool(env, pool_id).ok_or(Error::MiningPoolNotFound)?;
    let mut position =
        storage::get_mining_position(env, pool_id, provider).ok_or(Error::NoMiningPosition)?;

    update_reward_per_token(env, &mut pool)?;

    let earned = calculate_earned(&pool, &position)?;
    let claimable = earned
        .checked_add(position.pending_rewards)
        .ok_or(Error::ArithmeticError)?;

    if claimable <= 0 {
        return Err(Error::NothingToClaim);
    }

    position.pending_rewards = 0;
    position.reward_per_token_paid = pool.reward_per_token_stored;

    storage::set_mining_pool(env, pool_id, &pool);
    storage::set_mining_position(env, pool_id, provider, &position);

    events::emit_mining_rewards_claimed(env, pool_id, provider, claimable);

    Ok(claimable)
}

// ─────────────────────────────────────────────────────────────────────────
// Admin lifecycle controls
// ─────────────────────────────────────────────────────────────────────────

/// Pause an `Active` pool (admin only): halts new deposits and reward
/// accrual while preserving existing positions.
///
/// # Errors
/// * [`Error::Unauthorized`] - caller is not the admin
/// * [`Error::MiningPoolNotFound`] - pool does not exist
/// * [`Error::MiningPoolInvalidTransition`] - pool is not `Active`
pub fn pause_mining_pool(env: &Env, admin: &Address, pool_id: u64) -> Result<(), Error> {
    admin.require_auth();

    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    let mut pool = storage::get_mining_pool(env, pool_id).ok_or(Error::MiningPoolNotFound)?;

    if pool.status != MiningPoolStatus::Active {
        return Err(Error::MiningPoolInvalidTransition);
    }

    update_reward_per_token(env, &mut pool)?;
    pool.status = MiningPoolStatus::Paused;

    storage::set_mining_pool(env, pool_id, &pool);
    events::emit_mining_pool_paused(env, pool_id, admin);

    Ok(())
}

/// Resume a `Paused` pool (admin only). The checkpoint clock resets to
/// "now" so the paused interval accrues no reward.
///
/// # Errors
/// * [`Error::Unauthorized`] - caller is not the admin
/// * [`Error::MiningPoolNotFound`] - pool does not exist
/// * [`Error::MiningPoolInvalidTransition`] - pool is not `Paused`
pub fn resume_mining_pool(env: &Env, admin: &Address, pool_id: u64) -> Result<(), Error> {
    admin.require_auth();

    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    let mut pool = storage::get_mining_pool(env, pool_id).ok_or(Error::MiningPoolNotFound)?;

    if pool.status != MiningPoolStatus::Paused {
        return Err(Error::MiningPoolInvalidTransition);
    }

    pool.last_update_time = env.ledger().timestamp();
    pool.status = MiningPoolStatus::Active;

    storage::set_mining_pool(env, pool_id, &pool);
    events::emit_mining_pool_resumed(env, pool_id, admin);

    Ok(())
}

/// End a pool (admin only), permanently stopping reward accrual. Providers
/// can still withdraw principal and claim previously-earned rewards.
///
/// # Errors
/// * [`Error::Unauthorized`] - caller is not the admin
/// * [`Error::MiningPoolNotFound`] - pool does not exist
/// * [`Error::MiningPoolInvalidTransition`] - pool is already `Ended`
pub fn end_mining_pool(env: &Env, admin: &Address, pool_id: u64) -> Result<(), Error> {
    admin.require_auth();

    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    let mut pool = storage::get_mining_pool(env, pool_id).ok_or(Error::MiningPoolNotFound)?;

    if pool.status == MiningPoolStatus::Ended {
        return Err(Error::MiningPoolInvalidTransition);
    }

    update_reward_per_token(env, &mut pool)?;
    pool.status = MiningPoolStatus::Ended;

    storage::set_mining_pool(env, pool_id, &pool);
    events::emit_mining_pool_ended(env, pool_id, admin);

    Ok(())
}

/// Update the reward rate for an `Active` pool (admin only). Rewards are
/// checkpointed at the old rate before the new rate takes effect, so past
/// accrual is unaffected.
///
/// # Errors
/// * [`Error::Unauthorized`] - caller is not the admin
/// * [`Error::MiningPoolNotFound`] - pool does not exist
/// * [`Error::MiningPoolNotActive`] - pool is not `Active`
/// * [`Error::InvalidRewardRate`] - `new_reward_rate <= 0` or exceeds the maximum
pub fn update_reward_rate(
    env: &Env,
    admin: &Address,
    pool_id: u64,
    new_reward_rate: i128,
) -> Result<(), Error> {
    admin.require_auth();

    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    if new_reward_rate <= 0 || new_reward_rate > MAX_REWARD_RATE {
        return Err(Error::InvalidRewardRate);
    }

    let mut pool = storage::get_mining_pool(env, pool_id).ok_or(Error::MiningPoolNotFound)?;

    if pool.status != MiningPoolStatus::Active {
        return Err(Error::MiningPoolNotActive);
    }

    update_reward_per_token(env, &mut pool)?;

    let old_rate = pool.reward_rate;
    pool.reward_rate = new_reward_rate;

    storage::set_mining_pool(env, pool_id, &pool);
    events::emit_mining_reward_rate_updated(env, pool_id, admin, old_rate, new_reward_rate);

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────

/// Get a liquidity mining pool by id.
pub fn get_mining_pool(env: &Env, pool_id: u64) -> Option<LiquidityMiningPool> {
    storage::get_mining_pool(env, pool_id)
}

/// Get a provider's position (stake + reward checkpoint) in a pool.
pub fn get_provider_position(env: &Env, pool_id: u64, provider: &Address) -> Option<ProviderStake> {
    storage::get_mining_position(env, pool_id, provider)
}

/// Compute a provider's currently claimable reward amount without mutating
/// any state.
///
/// # Errors
/// * [`Error::MiningPoolNotFound`] - pool does not exist
pub fn get_claimable_rewards(env: &Env, pool_id: u64, provider: &Address) -> Result<i128, Error> {
    let pool = storage::get_mining_pool(env, pool_id).ok_or(Error::MiningPoolNotFound)?;

    let position = match storage::get_mining_position(env, pool_id, provider) {
        Some(p) => p,
        None => return Ok(0),
    };

    let current_rpt = current_reward_per_token(env, &pool)?;

    let newly_earned = position
        .staked_amount
        .checked_mul(
            current_rpt
                .checked_sub(position.reward_per_token_paid)
                .ok_or(Error::ArithmeticError)?,
        )
        .ok_or(Error::ArithmeticError)?
        .checked_div(REWARD_PRECISION)
        .ok_or(Error::ArithmeticError)?;

    position
        .pending_rewards
        .checked_add(newly_earned)
        .ok_or(Error::ArithmeticError)
}

/// Get the total number of liquidity mining pools created.
pub fn get_mining_pool_count(env: &Env) -> u64 {
    storage::get_mining_pool_count(env)
}

// ─────────────────────────────────────────────────────────────────────────
// Internal reward accumulator helpers
// ─────────────────────────────────────────────────────────────────────────

/// Compute the pool's up-to-date `reward_per_token_stored` without mutating
/// it. Accrual is capped at `end_time` and frozen while `Paused` or `Ended`.
fn current_reward_per_token(env: &Env, pool: &LiquidityMiningPool) -> Result<i128, Error> {
    if pool.total_staked == 0 || pool.status != MiningPoolStatus::Active {
        return Ok(pool.reward_per_token_stored);
    }

    let now = env.ledger().timestamp();
    let effective_time = if now > pool.end_time { pool.end_time } else { now };

    if effective_time <= pool.last_update_time {
        return Ok(pool.reward_per_token_stored);
    }

    let elapsed = effective_time
        .checked_sub(pool.last_update_time)
        .ok_or(Error::ArithmeticError)? as i128;

    let delta = elapsed
        .checked_mul(pool.reward_rate)
        .ok_or(Error::ArithmeticError)?
        .checked_mul(REWARD_PRECISION)
        .ok_or(Error::ArithmeticError)?
        .checked_div(pool.total_staked)
        .ok_or(Error::ArithmeticError)?;

    pool.reward_per_token_stored
        .checked_add(delta)
        .ok_or(Error::ArithmeticError)
}

/// Checkpoint `pool.reward_per_token_stored` and `pool.last_update_time` in place.
fn update_reward_per_token(env: &Env, pool: &mut LiquidityMiningPool) -> Result<(), Error> {
    pool.reward_per_token_stored = current_reward_per_token(env, pool)?;

    let now = env.ledger().timestamp();
    pool.last_update_time = if now > pool.end_time { pool.end_time } else { now };

    Ok(())
}

/// Compute rewards newly earned by a position since its last checkpoint,
/// against the pool's *current* `reward_per_token_stored` (caller is
/// expected to have already checkpointed the pool via
/// [`update_reward_per_token`]).
fn calculate_earned(pool: &LiquidityMiningPool, position: &ProviderStake) -> Result<i128, Error> {
    let rpt_delta = pool
        .reward_per_token_stored
        .checked_sub(position.reward_per_token_paid)
        .ok_or(Error::ArithmeticError)?;

    position
        .staked_amount
        .checked_mul(rpt_delta)
        .ok_or(Error::ArithmeticError)?
        .checked_div(REWARD_PRECISION)
        .ok_or(Error::ArithmeticError)
}
