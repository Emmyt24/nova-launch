//! Optional per-token burn rate limit per ledger window (#2229).
//!
//! The admin may configure, per token, a window length in ledgers and a maximum
//! total amount that holder burns (`burn`) may burn within one window. Windows
//! are aligned: `window_id = ledger_sequence / window_ledgers`. A max of 0
//! removes the limit. Admin burns and batch burns are not rate limited.
//!
//! Error discriminants (range 600-699 reserved for this module family):
//! * 610 `BurnRateLimitExceeded` - burn would exceed the window cap
//! * 611 `InvalidBurnRateLimit` - zero window length or negative cap
//!
//! Storage: `BurnRateKey::Config(token_index)` -> `(window_ledgers, max_burn)`,
//! `BurnRateKey::Usage(token_index)` -> `(window_id, burned_in_window)`.

use crate::storage;
use crate::types::Error;
use soroban_sdk::{contracttype, symbol_short, Address, Env};

#[allow(non_upper_case_globals)]
impl Error {
    pub const BurnRateLimitExceeded: Self = Self(610);
    pub const InvalidBurnRateLimit: Self = Self(611);
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum BurnRateKey {
    Config(u32),
    Usage(u32),
}

/// Configure (or clear, with `max_burn == 0`) the burn cap for a token. Admin only.
pub fn set_limit(
    env: &Env,
    admin: Address,
    token_index: u32,
    window_ledgers: u32,
    max_burn: i128,
) -> Result<(), Error> {
    admin.require_auth();
    let stored = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if stored != admin {
        return Err(Error::Unauthorized);
    }
    if storage::get_token_info(env, token_index).is_none() {
        return Err(Error::TokenNotFound);
    }
    if max_burn < 0 || (max_burn > 0 && window_ledgers == 0) {
        return Err(Error::InvalidBurnRateLimit);
    }

    if max_burn == 0 {
        env.storage().persistent().remove(&BurnRateKey::Config(token_index));
        env.storage().persistent().remove(&BurnRateKey::Usage(token_index));
    } else {
        env.storage()
            .persistent()
            .set(&BurnRateKey::Config(token_index), &(window_ledgers, max_burn));
    }
    env.events().publish(
        (symbol_short!("brl_cfg"), token_index),
        (window_ledgers, max_burn),
    );
    Ok(())
}

/// Current configuration as `(window_ledgers, max_burn)`, if a limit is set.
pub fn get_limit(env: &Env, token_index: u32) -> Option<(u32, i128)> {
    env.storage().persistent().get(&BurnRateKey::Config(token_index))
}

/// Amount already burned in the current window (0 when no limit or new window).
pub fn get_window_usage(env: &Env, token_index: u32) -> i128 {
    match get_limit(env, token_index) {
        None => 0,
        Some((window_ledgers, _)) => {
            let window_id: u32 = env.ledger().sequence() / window_ledgers;
            match env
                .storage()
                .persistent()
                .get::<BurnRateKey, (u32, i128)>(&BurnRateKey::Usage(token_index))
            {
                Some((id, used)) if id == window_id => used,
                _ => 0,
            }
        }
    }
}

/// Record a burn against the window cap, rejecting it when over the cap.
/// No-op when no limit is configured or the amount is not positive (the burn
/// itself rejects invalid amounts).
pub fn enforce(env: &Env, token_index: u32, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Ok(());
    }
    let (window_ledgers, max_burn) = match get_limit(env, token_index) {
        Some(cfg) => cfg,
        None => return Ok(()),
    };

    let window_id: u32 = env.ledger().sequence() / window_ledgers;
    let used = get_window_usage(env, token_index);
    let new_used = used.checked_add(amount).ok_or(Error::ArithmeticError)?;
    if new_used > max_burn {
        return Err(Error::BurnRateLimitExceeded);
    }

    env.storage()
        .persistent()
        .set(&BurnRateKey::Usage(token_index), &(window_id, new_used));
    Ok(())
}
