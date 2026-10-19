//! Cliff + linear vesting schedules held in contract custody (Issue #2236).
//!
//! # Formula
//! Let `start`, `cliff = start + cliff_duration`, `end = start + duration`:
//! * `now < cliff`  -> `vested = 0`
//! * `now >= end`   -> `vested = total`
//! * otherwise      -> `vested = total * (now - start) / duration` (floor)
//!
//! `claimable = vested - claimed`. The cliff only gates when vesting becomes
//! claimable; the slope is measured from `start`. Math is delegated to
//! `crate::vesting::linear_vested_amount`.
//!
//! Errors (new): `InvalidVestingSchedule = 420`, `VestingScheduleNotFound = 421`.
//! Existing errors reused: `CliffNotReached`, `NothingToClaim`.

use crate::types::Error;
use crate::vesting::linear_vested_amount;
use soroban_sdk::{contracttype, symbol_short, token, Address, Env};

#[allow(non_upper_case_globals)]
impl Error {
    pub const InvalidVestingSchedule: Self = Self(420);
    pub const VestingScheduleNotFound: Self = Self(421);
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum VestingScheduleKey {
    NextId,
    Schedule(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub id: u64,
    pub token: Address,
    pub creator: Address,
    pub beneficiary: Address,
    pub total_amount: i128,
    pub claimed_amount: i128,
    pub start_time: u64,
    pub cliff_time: u64,
    pub end_time: u64,
}

/// Validate schedule parameters, returning `(cliff_time, end_time)`.
pub fn validate_schedule(
    amount: i128,
    start_time: u64,
    cliff_duration: u64,
    duration: u64,
) -> Result<(u64, u64), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if duration == 0 || cliff_duration > duration {
        return Err(Error::InvalidVestingSchedule);
    }
    let end_time = start_time
        .checked_add(duration)
        .ok_or(Error::InvalidVestingSchedule)?;
    let cliff_time = start_time
        .checked_add(cliff_duration)
        .ok_or(Error::InvalidVestingSchedule)?;
    Ok((cliff_time, end_time))
}

/// Escrow `amount` of `token` from `creator` and register a schedule.
pub fn create_vesting_schedule(
    env: &Env,
    creator: &Address,
    token_address: &Address,
    beneficiary: &Address,
    amount: i128,
    start_time: u64,
    cliff_duration: u64,
    duration: u64,
) -> Result<u64, Error> {
    creator.require_auth();
    let (cliff_time, end_time) = validate_schedule(amount, start_time, cliff_duration, duration)?;

    let id: u64 = env
        .storage()
        .instance()
        .get(&VestingScheduleKey::NextId)
        .unwrap_or(0u64);
    env.storage()
        .instance()
        .set(&VestingScheduleKey::NextId, &(id + 1));

    token::Client::new(env, token_address).transfer(
        creator,
        &env.current_contract_address(),
        &amount,
    );

    let schedule = VestingSchedule {
        id,
        token: token_address.clone(),
        creator: creator.clone(),
        beneficiary: beneficiary.clone(),
        total_amount: amount,
        claimed_amount: 0,
        start_time,
        cliff_time,
        end_time,
    };
    env.storage()
        .persistent()
        .set(&VestingScheduleKey::Schedule(id), &schedule);
    env.events().publish(
        (symbol_short!("vs_new"), id),
        (creator.clone(), beneficiary.clone(), amount, start_time, cliff_time, end_time),
    );
    Ok(id)
}

pub fn get_vesting_schedule(env: &Env, id: u64) -> Result<VestingSchedule, Error> {
    env.storage()
        .persistent()
        .get(&VestingScheduleKey::Schedule(id))
        .ok_or(Error::VestingScheduleNotFound)
}

/// Amount vested (claimed or not) at the current ledger time.
pub fn get_vested_amount(env: &Env, id: u64) -> Result<i128, Error> {
    let s = get_vesting_schedule(env, id)?;
    linear_vested_amount(
        s.total_amount,
        s.start_time,
        s.end_time,
        s.cliff_time,
        env.ledger().timestamp(),
    )
}

/// Amount currently claimable (`vested - claimed`).
pub fn get_claimable_amount(env: &Env, id: u64) -> Result<i128, Error> {
    let s = get_vesting_schedule(env, id)?;
    let vested = get_vested_amount(env, id)?;
    Ok(vested - s.claimed_amount)
}

/// Pay the beneficiary everything vested and not yet claimed.
pub fn claim_vesting_schedule(env: &Env, beneficiary: &Address, id: u64) -> Result<i128, Error> {
    beneficiary.require_auth();
    let mut s = get_vesting_schedule(env, id)?;
    if s.beneficiary != *beneficiary {
        return Err(Error::Unauthorized);
    }
    if env.ledger().timestamp() < s.cliff_time {
        return Err(Error::CliffNotReached);
    }
    let claimable = get_claimable_amount(env, id)?;
    if claimable <= 0 {
        return Err(Error::NothingToClaim);
    }

    s.claimed_amount += claimable;
    env.storage()
        .persistent()
        .set(&VestingScheduleKey::Schedule(id), &s);
    token::Client::new(env, &s.token).transfer(
        &env.current_contract_address(),
        beneficiary,
        &claimable,
    );
    env.events()
        .publish((symbol_short!("vs_claim"), id), (beneficiary.clone(), claimable));
    Ok(claimable)
}
