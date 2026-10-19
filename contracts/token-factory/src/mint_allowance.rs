//! Per-address mint allowance (#2228).
//!
//! The token creator can delegate limited minting to a spender address by
//! granting an allowance with an amount and an expiry timestamp. The spender
//! mints through `mint_with_allowance`, which consumes the allowance.
//!
//! Error discriminants (range 600-699 reserved for this module family):
//! * 600 `MintAllowanceInsufficient` - no allowance, or amount above remaining
//! * 601 `MintAllowanceExpired` - allowance expiry has passed
//!
//! Storage: `MintAllowanceKey::Allowance(token_index, spender)` -> `(remaining, expires_at)`.

use crate::storage;
use crate::types::Error;
use soroban_sdk::{contracttype, symbol_short, Address, Env};

#[allow(non_upper_case_globals)]
impl Error {
    pub const MintAllowanceInsufficient: Self = Self(600);
    pub const MintAllowanceExpired: Self = Self(601);
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum MintAllowanceKey {
    Allowance(u32, Address),
}

fn load(env: &Env, token_index: u32, spender: &Address) -> Option<(i128, u64)> {
    env.storage()
        .persistent()
        .get(&MintAllowanceKey::Allowance(token_index, spender.clone()))
}

fn require_creator(env: &Env, token_index: u32, creator: &Address) -> Result<(), Error> {
    creator.require_auth();
    let info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;
    if info.creator != *creator {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

/// Grant (or replace) a mint allowance. `expires_at` is a ledger timestamp and
/// must be in the future; `amount` must be positive.
pub fn set_allowance(
    env: &Env,
    creator: Address,
    token_index: u32,
    spender: Address,
    amount: i128,
    expires_at: u64,
) -> Result<(), Error> {
    require_creator(env, token_index, &creator)?;
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if expires_at <= env.ledger().timestamp() {
        return Err(Error::InvalidParameters);
    }

    env.storage().persistent().set(
        &MintAllowanceKey::Allowance(token_index, spender.clone()),
        &(amount, expires_at),
    );
    env.events().publish(
        (symbol_short!("mal_set"), token_index),
        (spender, amount, expires_at),
    );
    Ok(())
}

/// Revoke a mint allowance. Revoking a missing allowance is a no-op error.
pub fn revoke_allowance(
    env: &Env,
    creator: Address,
    token_index: u32,
    spender: Address,
) -> Result<(), Error> {
    require_creator(env, token_index, &creator)?;
    if load(env, token_index, &spender).is_none() {
        return Err(Error::MintAllowanceInsufficient);
    }
    env.storage()
        .persistent()
        .remove(&MintAllowanceKey::Allowance(token_index, spender.clone()));
    env.events()
        .publish((symbol_short!("mal_rev"), token_index), (spender,));
    Ok(())
}

/// Remaining, unexpired allowance for `spender` (0 when none or expired).
pub fn get_allowance(env: &Env, token_index: u32, spender: &Address) -> i128 {
    match load(env, token_index, spender) {
        Some((remaining, expires_at)) if env.ledger().timestamp() < expires_at => remaining,
        _ => 0,
    }
}

/// Mint on behalf of the creator using the spender's allowance.
pub fn mint_with_allowance(
    env: &Env,
    spender: Address,
    token_index: u32,
    to: Address,
    amount: i128,
) -> Result<(), Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }
    spender.require_auth();
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let (remaining, expires_at) =
        load(env, token_index, &spender).ok_or(Error::MintAllowanceInsufficient)?;
    if env.ledger().timestamp() >= expires_at {
        return Err(Error::MintAllowanceExpired);
    }
    if amount > remaining {
        return Err(Error::MintAllowanceInsufficient);
    }

    storage::acquire_reentrancy_lock(env)?;

    // Effects first: consume the allowance, then mint (max supply is enforced by mint).
    let key = MintAllowanceKey::Allowance(token_index, spender.clone());
    let left = remaining - amount;
    if left == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &(left, expires_at));
    }

    let result = crate::mint::mint(env, token_index, &to, amount);
    storage::release_reentrancy_lock(env);
    result
}
