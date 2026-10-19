//! Treasury withdrawal timelock (Issue #2235).
//!
//! Withdrawals are queued, wait for a delay, and can be executed by the admin
//! at or after `executable_at` (`now >= executable_at`). The admin can cancel a
//! queued withdrawal at any time before execution. Execution re-applies the
//! treasury policy (allowlist and daily cap) and records the withdrawal.
//!
//! Events: `tw_queue`, `tw_cancel`, `tw_exec` (topics `(name, id)`), and
//! `tw_delay` when the delay changes.
//!
//! New errors: `TimelockedWithdrawalNotFound = 410`, `TimelockNotElapsed = 411`,
//! `InvalidTimelockDelay = 412`.

use crate::storage;
use crate::treasury::{record_withdrawal, validate_withdrawal};
use crate::types::Error;
use soroban_sdk::{contracttype, symbol_short, token, Address, Env};

#[allow(non_upper_case_globals)]
impl Error {
    pub const TimelockedWithdrawalNotFound: Self = Self(410);
    pub const TimelockNotElapsed: Self = Self(411);
    pub const InvalidTimelockDelay: Self = Self(412);
}

/// Default delay: 48 hours.
pub const DEFAULT_WITHDRAWAL_DELAY: u64 = 172_800;
/// Minimum configurable delay: 1 hour.
pub const MIN_WITHDRAWAL_DELAY: u64 = 3_600;
/// Maximum configurable delay: 30 days.
pub const MAX_WITHDRAWAL_DELAY: u64 = 2_592_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum TreasuryTimelockKey {
    Delay,
    NextId,
    Queued(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedWithdrawal {
    pub id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub queued_at: u64,
    pub executable_at: u64,
}

fn require_admin(env: &Env, admin: &Address) -> Result<(), Error> {
    admin.require_auth();
    let current = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != current {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

pub fn get_withdrawal_delay(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&TreasuryTimelockKey::Delay)
        .unwrap_or(DEFAULT_WITHDRAWAL_DELAY)
}

/// Set the delay applied to newly queued withdrawals.
pub fn set_withdrawal_delay(env: &Env, admin: &Address, delay: u64) -> Result<(), Error> {
    require_admin(env, admin)?;
    if delay < MIN_WITHDRAWAL_DELAY || delay > MAX_WITHDRAWAL_DELAY {
        return Err(Error::InvalidTimelockDelay);
    }
    env.storage().instance().set(&TreasuryTimelockKey::Delay, &delay);
    env.events().publish((symbol_short!("tw_delay"),), (admin.clone(), delay));
    Ok(())
}

/// Queue a withdrawal; returns its id.
pub fn queue_withdrawal(
    env: &Env,
    admin: &Address,
    recipient: &Address,
    amount: i128,
) -> Result<u64, Error> {
    require_admin(env, admin)?;
    // Fail fast on obviously invalid requests (re-checked at execution).
    validate_withdrawal(env, recipient, amount)?;

    let id: u64 = env
        .storage()
        .instance()
        .get(&TreasuryTimelockKey::NextId)
        .unwrap_or(0u64);
    env.storage()
        .instance()
        .set(&TreasuryTimelockKey::NextId, &(id + 1));

    let now: u64 = env.ledger().timestamp();
    let executable_at: u64 = now
        .checked_add(get_withdrawal_delay(env))
        .ok_or(Error::ArithmeticError)?;
    let item = QueuedWithdrawal {
        id,
        recipient: recipient.clone(),
        amount,
        queued_at: now,
        executable_at,
    };
    env.storage()
        .persistent()
        .set(&TreasuryTimelockKey::Queued(id), &item);
    env.events().publish(
        (symbol_short!("tw_queue"), id),
        (recipient.clone(), amount, executable_at),
    );
    Ok(id)
}

pub fn get_queued_withdrawal(env: &Env, id: u64) -> Result<QueuedWithdrawal, Error> {
    env.storage()
        .persistent()
        .get(&TreasuryTimelockKey::Queued(id))
        .ok_or(Error::TimelockedWithdrawalNotFound)
}

/// Cancel a queued withdrawal.
pub fn cancel_withdrawal(env: &Env, admin: &Address, id: u64) -> Result<(), Error> {
    require_admin(env, admin)?;
    let item = get_queued_withdrawal(env, id)?;
    env.storage()
        .persistent()
        .remove(&TreasuryTimelockKey::Queued(id));
    env.events()
        .publish((symbol_short!("tw_cancel"), id), (item.recipient, item.amount));
    Ok(())
}

/// Execute a queued withdrawal once its delay has elapsed.
pub fn execute_withdrawal(env: &Env, admin: &Address, id: u64) -> Result<(), Error> {
    require_admin(env, admin)?;
    let item = get_queued_withdrawal(env, id)?;
    if env.ledger().timestamp() < item.executable_at {
        return Err(Error::TimelockNotElapsed);
    }

    validate_withdrawal(env, &item.recipient, item.amount)?;
    record_withdrawal(env, item.amount)?;
    env.storage()
        .persistent()
        .remove(&TreasuryTimelockKey::Queued(id));

    let fee_token = storage::get_fee_token(env).ok_or(Error::MissingTreasury)?;
    token::Client::new(env, &fee_token).transfer(
        &env.current_contract_address(),
        &item.recipient,
        &item.amount,
    );
    env.events()
        .publish((symbol_short!("tw_exec"), id), (item.recipient, item.amount));
    Ok(())
}
