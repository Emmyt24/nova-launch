//! Optional expiry for delegations (#2238).
//!
//! A delegator may attach an expiry timestamp (ledger seconds) to a delegation.
//! Once `now >= expires_at` the delegation is ignored: the delegated amount is
//! moved back from the delegatee to the delegator before vote weight is
//! resolved in `cast_vote`, or when anyone calls `expire_delegation`.

use soroban_sdk::{contracttype, symbol_short, Address, Env, Vec};

use crate::delegation;
use crate::events;
use crate::storage;
use crate::types::Error;

/// Storage keys private to the delegation-expiry feature.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExpiryKey {
    /// Expiry timestamp for a delegator's delegation.
    Expiry(Address),
    /// Delegators that registered an expiring delegation to this delegatee.
    Delegators(Address),
}

/// Return the expiry timestamp of `delegator`'s delegation, if any.
pub fn get_expiry(env: &Env, delegator: &Address) -> Option<u64> {
    env.storage()
        .persistent()
        .get(&ExpiryKey::Expiry(delegator.clone()))
}

/// Remove any expiry attached to `delegator`'s delegation.
pub fn clear_expiry(env: &Env, delegator: &Address) {
    env.storage()
        .persistent()
        .remove(&ExpiryKey::Expiry(delegator.clone()));
}

fn get_delegators(env: &Env, delegatee: &Address) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&ExpiryKey::Delegators(delegatee.clone()))
        .unwrap_or(Vec::new(env))
}

fn set_delegators(env: &Env, delegatee: &Address, list: &Vec<Address>) {
    env.storage()
        .persistent()
        .set(&ExpiryKey::Delegators(delegatee.clone()), list);
}

/// Delegate to `delegatee` until `expires_at` (must be in the future).
pub fn delegate_with_expiry(
    env: &Env,
    delegator: Address,
    delegatee: Address,
    expires_at: u64,
) -> Result<(), Error> {
    if expires_at <= env.ledger().timestamp() {
        return Err(Error::InvalidParameters);
    }
    delegation::delegate(env, delegator.clone(), delegatee.clone())?;

    env.storage()
        .persistent()
        .set(&ExpiryKey::Expiry(delegator.clone()), &expires_at);

    let mut list = get_delegators(env, &delegatee);
    if !list.contains(&delegator) {
        list.push_back(delegator.clone());
        set_delegators(env, &delegatee, &list);
    }

    env.events().publish(
        (symbol_short!("dlg_exp"),),
        (delegator, delegatee, expires_at),
    );
    Ok(())
}

/// Permissionless: undo `delegator`'s delegation if its expiry has passed.
/// Returns `Ok(true)` if the delegation was expired by this call.
pub fn expire_delegation(env: &Env, delegator: &Address) -> Result<bool, Error> {
    let expires_at = match get_expiry(env, delegator) {
        Some(t) => t,
        None => return Ok(false),
    };
    if env.ledger().timestamp() < expires_at {
        return Ok(false);
    }
    clear_expiry(env, delegator);

    let record = match storage::get_delegation(env, delegator) {
        Some(r) => r,
        None => return Ok(false),
    };
    let delegatee = record.delegatee.clone();
    let amount = record.delegated_amount;
    let ledger = env.ledger().sequence();

    let delegatee_power = storage::get_vote_power(env, &delegatee);
    let new_delegatee_power = delegatee_power.checked_sub(amount).ok_or_else(|| {
        events::emit_error_detail(env, Error::ArithmeticError as u32, delegatee_power);
        Error::ArithmeticError
    })?;
    storage::set_vote_power(env, &delegatee, new_delegatee_power.max(0));

    let delegator_power = storage::get_vote_power(env, delegator);
    let new_delegator_power = delegator_power.checked_add(amount).ok_or_else(|| {
        events::emit_error_detail(env, Error::ArithmeticError as u32, delegator_power);
        Error::ArithmeticError
    })?;
    storage::set_vote_power(env, delegator, new_delegator_power);

    storage::remove_delegation(env, delegator);

    storage::set_snapshot(env, &delegatee, ledger, new_delegatee_power.max(0));
    events::emit_snapshot(env, &delegatee, ledger, new_delegatee_power.max(0));
    storage::set_snapshot(env, delegator, ledger, new_delegator_power);
    events::emit_snapshot(env, delegator, ledger, new_delegator_power);

    env.events().publish(
        (symbol_short!("dlg_end"),),
        (delegator.clone(), delegatee, amount),
    );
    Ok(true)
}

/// Expire every lapsed delegation that affects `voter`'s weight: the voter's
/// own delegation and any expiring delegations made to the voter.
pub fn sweep_for_voter(env: &Env, voter: &Address) -> Result<(), Error> {
    expire_delegation(env, voter)?;

    let list = get_delegators(env, voter);
    if list.is_empty() {
        return Ok(());
    }
    let mut remaining: Vec<Address> = Vec::new(env);
    for delegator in list.iter() {
        let still_delegating = match storage::get_delegation(env, &delegator) {
            Some(r) => r.delegatee == *voter,
            None => false,
        };
        if !still_delegating {
            continue;
        }
        if expire_delegation(env, &delegator)? {
            continue;
        }
        remaining.push_back(delegator);
    }
    set_delegators(env, voter, &remaining);
    Ok(())
}
