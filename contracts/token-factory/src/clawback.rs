//! Clawback — Pro-tier admin token reclamation
//!
//! Clawback allows the token creator (admin) to reclaim tokens from any holder's
//! balance. It is **opt-in** at token creation time via the `clawback_enabled`
//! flag on [`TokenInfo`][crate::types::TokenInfo] and **cannot be toggled** after
//! deployment (immutability invariant).
//!
//! ## Security model
//! - The caller must be the **current factory admin** (`storage::get_admin`).
//! - Authorization is enforced via `admin.require_auth()`.
//! - Clawback succeeds even if the target address is frozen; freezing controls
//!   voluntary transfers, not admin-initiated reclamation.
//!
//! ## Events
//! Emits a `clwbk_v1` event (see [`crate::events::emit_clawback`]) with
//! `from`, `amount`, `admin`, and `timestamp` so indexers have a full audit
//! trail.

use crate::{events, storage};
use crate::types::Error;
use soroban_sdk::{Address, Env};

/// Clawback `amount` tokens from `from`'s balance.
///
/// # Arguments
/// * `env`    – Contract environment
/// * `admin`  – Current factory admin address (must authorize)
/// * `token_index` – Registry index of the target token
/// * `from`   – Holder whose tokens are being reclaimed
/// * `amount` – Number of tokens to claw back (must be > 0)
///
/// # Errors
/// * [`Error::ContractPaused`]     – Factory is paused
/// * [`Error::Unauthorized`]       – Caller is not the current admin
/// * [`Error::TokenNotFound`]      – `token_index` does not exist
/// * [`Error::ClawbackDisabled`]   – Token was created without clawback enabled
/// * [`Error::InvalidAmount`]      – `amount` ≤ 0
/// * [`Error::InsufficientBalance`] – `from` holds fewer tokens than `amount`
/// * [`Error::ArithmeticError`]    – Numeric overflow
pub fn clawback(
    env: &Env,
    admin: Address,
    token_index: u32,
    from: Address,
    amount: i128,
) -> Result<(), Error> {
    // 1. Contract-level guard
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    // 2. Admin authentication — never accept a raw Address without require_auth()
    admin.require_auth();
    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if admin != current_admin {
        return Err(Error::Unauthorized);
    }

    // 3. Load token info
    let mut info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;

    // 4. Immutability guard: clawback must have been enabled at creation time
    if !info.clawback_enabled {
        return Err(Error::ClawbackDisabled);
    }

    // 5. Amount validation
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    // 6. Balance check
    let balance = storage::get_balance(env, token_index, &from);
    if balance < amount {
        return Err(Error::InsufficientBalance);
    }

    // 7. Checks-Effects-Interactions: compute new values, then commit
    let new_balance = balance.checked_sub(amount).ok_or(Error::ArithmeticError)?;
    let new_supply = info.total_supply.checked_sub(amount).ok_or(Error::ArithmeticError)?;
    let new_burned = info.total_burned.checked_add(amount).ok_or(Error::ArithmeticError)?;
    let new_burn_count = info.burn_count.checked_add(1).ok_or(Error::ArithmeticError)?;

    storage::set_balance(env, token_index, &from, new_balance);
    info.total_supply = new_supply;
    info.total_burned = new_burned;
    info.burn_count = new_burn_count;
    storage::set_token_info(env, token_index, &info);

    // 8. Emit auditable clawback event
    events::emit_clawback_audit(env, &info.address, &admin, &from, amount);

    Ok(())
}
