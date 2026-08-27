//! Multi-pool staking (#1757).
//!
//! Users create staking pools for a given token and stake into them to earn
//! rewards in a (possibly different) reward token, accrued over time via a
//! precision-scaled reward-per-share accumulator — the standard "MasterChef"
//! checkpoint pattern.
//!
//! `stake` / `unstake` / `claim_rewards` all call [`update_pool`] first, which
//! rolls the pool's `acc_reward_per_share` forward to the current ledger
//! timestamp before touching the caller's position. This guarantees every
//! mutation is checkpointed against a consistent accumulator value:
//! - Rewards that accrue while a pool has zero stakers are simply not
//!   accrued (no elapsed-time reward is materialized into
//!   `acc_reward_per_share`), so they are never later attributed to a
//!   staker who wasn't there to earn them.
//! - A staker's `reward_debt` is always re-anchored to the accumulator value
//!   at the moment their `amount` changes, so reward accrued before they
//!   entered (or after they fully exited) is neither double-counted nor lost.

use crate::events;
use crate::storage;
use crate::types::{Error, StakeInfo, StakingPool};
use soroban_sdk::{Address, Env};

/// Fixed-point scaling factor for the reward-per-share accumulator.
const PRECISION: i128 = 1_000_000_000_000;

/// Create a new staking pool paying `reward_rate` units of the reward token
/// per second to stakers, proportional to their share of the pool.
///
/// Caller must be either the factory admin or the creator of `token_index`.
pub fn create_staking_pool(
    env: &Env,
    creator: Address,
    token_index: u32,
    reward_token_index: u32,
    reward_rate: i128,
) -> Result<u64, Error> {
    creator.require_auth();

    if reward_rate < 0 {
        return Err(Error::InvalidRewardRate);
    }

    let admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    let token = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;
    storage::get_token_info(env, reward_token_index).ok_or(Error::TokenNotFound)?;

    if creator != admin && creator != token.creator {
        return Err(Error::Unauthorized);
    }

    let pool_id = storage::increment_next_staking_pool_id(env);
    let pool = StakingPool {
        id: pool_id,
        token_index,
        reward_token_index,
        reward_rate,
        total_staked: 0,
        acc_reward_per_share: 0,
        last_reward_time: env.ledger().timestamp(),
        active: true,
        creator: creator.clone(),
    };

    storage::set_staking_pool(env, pool_id, &pool);
    storage::increment_staking_pool_count(env)?;

    events::emit_staking_pool_created(env, pool_id, token_index, reward_token_index, reward_rate);

    Ok(pool_id)
}

/// Roll a pool's `acc_reward_per_share` forward to the current ledger
/// timestamp. Must be called before reading or mutating any staker's
/// position so accrual is always computed against a consistent checkpoint.
fn update_pool(env: &Env, pool: &mut StakingPool) -> Result<(), Error> {
    let current_time = env.ledger().timestamp();
    if current_time <= pool.last_reward_time {
        return Ok(());
    }

    if pool.total_staked == 0 {
        // No stakers to attribute rewards to; skip accrual for this
        // interval entirely rather than letting it land on whoever stakes
        // next.
        pool.last_reward_time = current_time;
        return Ok(());
    }

    let time_delta = (current_time - pool.last_reward_time) as i128;
    let reward = time_delta
        .checked_mul(pool.reward_rate)
        .ok_or(Error::ArithmeticError)?;

    let reward_per_share_delta = reward
        .checked_mul(PRECISION)
        .ok_or(Error::ArithmeticError)?
        .checked_div(pool.total_staked)
        .ok_or(Error::ArithmeticError)?;

    pool.acc_reward_per_share = pool
        .acc_reward_per_share
        .checked_add(reward_per_share_delta)
        .ok_or(Error::ArithmeticError)?;

    pool.last_reward_time = current_time;
    Ok(())
}

/// Compute a staker's currently accrued (unclaimed) reward against `pool`'s
/// up-to-date `acc_reward_per_share`, without mutating anything.
fn accrued_reward(pool: &StakingPool, user_stake: &StakeInfo) -> Result<i128, Error> {
    user_stake
        .amount
        .checked_mul(pool.acc_reward_per_share)
        .ok_or(Error::ArithmeticError)?
        .checked_div(PRECISION)
        .ok_or(Error::ArithmeticError)?
        .checked_sub(user_stake.reward_debt)
        .ok_or(Error::ArithmeticError)
}

/// Re-anchor `user_stake.reward_debt` to `pool`'s current
/// `acc_reward_per_share`, marking all currently-accrued reward as settled.
fn checkpoint_debt(pool: &StakingPool, user_stake: &mut StakeInfo) -> Result<(), Error> {
    user_stake.reward_debt = user_stake
        .amount
        .checked_mul(pool.acc_reward_per_share)
        .ok_or(Error::ArithmeticError)?
        .checked_div(PRECISION)
        .ok_or(Error::ArithmeticError)?;
    Ok(())
}

/// Pay out `amount` of `pool.reward_token_index` to `user`, if positive, and
/// emit `stk_clm1`.
fn payout_reward(env: &Env, pool: &StakingPool, user: &Address, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Ok(());
    }
    let reward_balance = storage::get_balance(env, pool.reward_token_index, user);
    let new_reward_balance = reward_balance
        .checked_add(amount)
        .ok_or(Error::ArithmeticError)?;
    storage::set_balance(env, pool.reward_token_index, user, new_reward_balance);
    events::emit_reward_claimed(env, pool.id, user, amount);
    Ok(())
}

/// Stake `amount` of a pool's staking token. Settles any pending reward for
/// the caller first, against the checkpoint immediately before `amount` is
/// applied.
pub fn stake(env: &Env, caller: Address, pool_id: u64, amount: i128) -> Result<(), Error> {
    caller.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidParameters);
    }

    let mut pool = storage::get_staking_pool(env, pool_id).ok_or(Error::StakingPoolNotFound)?;
    if !pool.active {
        return Err(Error::StakingNotActive);
    }

    update_pool(env, &mut pool)?;

    let mut user_stake = storage::get_user_stake(env, pool_id, &caller).unwrap_or(StakeInfo {
        amount: 0,
        reward_debt: 0,
    });

    let pending = if user_stake.amount > 0 {
        accrued_reward(&pool, &user_stake)?
    } else {
        0
    };

    let balance = storage::get_balance(env, pool.token_index, &caller);
    if balance < amount {
        return Err(Error::InsufficientBalance);
    }
    let new_balance = balance.checked_sub(amount).ok_or(Error::ArithmeticError)?;
    storage::set_balance(env, pool.token_index, &caller, new_balance);

    user_stake.amount = user_stake
        .amount
        .checked_add(amount)
        .ok_or(Error::ArithmeticError)?;
    checkpoint_debt(&pool, &mut user_stake)?;

    pool.total_staked = pool
        .total_staked
        .checked_add(amount)
        .ok_or(Error::ArithmeticError)?;

    storage::set_staking_pool(env, pool_id, &pool);
    storage::set_user_stake(env, pool_id, &caller, &user_stake);

    events::emit_staked(env, pool_id, &caller, amount);
    payout_reward(env, &pool, &caller, pending)?;

    Ok(())
}

/// Unstake `amount` of a pool's staking token. Settles any pending reward
/// for the caller first, against the checkpoint immediately before `amount`
/// is applied.
pub fn unstake(env: &Env, caller: Address, pool_id: u64, amount: i128) -> Result<(), Error> {
    caller.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidParameters);
    }

    let mut pool = storage::get_staking_pool(env, pool_id).ok_or(Error::StakingPoolNotFound)?;
    update_pool(env, &mut pool)?;

    let mut user_stake =
        storage::get_user_stake(env, pool_id, &caller).ok_or(Error::InsufficientStake)?;
    if user_stake.amount < amount {
        return Err(Error::InsufficientStake);
    }

    let pending = accrued_reward(&pool, &user_stake)?;

    user_stake.amount = user_stake
        .amount
        .checked_sub(amount)
        .ok_or(Error::ArithmeticError)?;
    checkpoint_debt(&pool, &mut user_stake)?;

    pool.total_staked = pool
        .total_staked
        .checked_sub(amount)
        .ok_or(Error::ArithmeticError)?;

    let balance = storage::get_balance(env, pool.token_index, &caller);
    let new_balance = balance.checked_add(amount).ok_or(Error::ArithmeticError)?;
    storage::set_balance(env, pool.token_index, &caller, new_balance);

    storage::set_staking_pool(env, pool_id, &pool);
    storage::set_user_stake(env, pool_id, &caller, &user_stake);

    events::emit_unstaked(env, pool_id, &caller, amount);
    payout_reward(env, &pool, &caller, pending)?;

    Ok(())
}

/// Pay out a staker's currently accrued reward without unstaking.
pub fn claim_rewards(env: &Env, caller: Address, pool_id: u64) -> Result<(), Error> {
    caller.require_auth();

    let mut pool = storage::get_staking_pool(env, pool_id).ok_or(Error::StakingPoolNotFound)?;
    update_pool(env, &mut pool)?;

    let mut user_stake =
        storage::get_user_stake(env, pool_id, &caller).ok_or(Error::InsufficientStake)?;

    let pending = accrued_reward(&pool, &user_stake)?;
    if pending <= 0 {
        return Err(Error::NothingToClaim);
    }

    checkpoint_debt(&pool, &mut user_stake)?;
    storage::set_staking_pool(env, pool_id, &pool);
    storage::set_user_stake(env, pool_id, &caller, &user_stake);

    payout_reward(env, &pool, &caller, pending)?;

    Ok(())
}

/// Preview a staker's currently accrued (unclaimed) reward without
/// mutating any state.
pub fn pending_rewards(env: &Env, caller: Address, pool_id: u64) -> Result<i128, Error> {
    let pool = storage::get_staking_pool(env, pool_id).ok_or(Error::StakingPoolNotFound)?;
    let user_stake = match storage::get_user_stake(env, pool_id, &caller) {
        Some(s) if s.amount > 0 => s,
        _ => return Ok(0),
    };

    let mut acc_reward_per_share = pool.acc_reward_per_share;
    let current_time = env.ledger().timestamp();
    if current_time > pool.last_reward_time && pool.total_staked != 0 {
        let time_delta = (current_time - pool.last_reward_time) as i128;
        let reward = time_delta
            .checked_mul(pool.reward_rate)
            .ok_or(Error::ArithmeticError)?;
        let reward_per_share_delta = reward
            .checked_mul(PRECISION)
            .ok_or(Error::ArithmeticError)?
            .checked_div(pool.total_staked)
            .ok_or(Error::ArithmeticError)?;
        acc_reward_per_share = acc_reward_per_share
            .checked_add(reward_per_share_delta)
            .ok_or(Error::ArithmeticError)?;
    }

    let projected_pool = StakingPool {
        acc_reward_per_share,
        ..pool
    };
    accrued_reward(&projected_pool, &user_stake)
}
