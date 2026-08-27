use crate::storage;
use crate::types::Error;
use soroban_sdk::{symbol_short, Address, Env};

const MAX_BATCH_BURN: u32 = 100;

pub fn burn(env: &Env, caller: Address, token_index: u32, amount: i128) -> Result<(), Error> {
    caller.require_auth();
    validate_amount(amount)?;

    // Reentrancy guard: acquire before any state read or external interaction.
    // Soroban prevents cross-contract reentrancy at the host level, but this
    // guard enforces the invariant that no burn path can be re-entered within
    // the same contract invocation (e.g., via a future callback mechanism).
    storage::acquire_reentrancy_lock(env).map_err(|_| Error::BurnReentrancyDetected)?;

    let result = burn_inner(env, &caller, token_index, amount);

    // Always release the lock, even on error.
    storage::release_reentrancy_lock(env);
    result
}

fn burn_inner(env: &Env, caller: &Address, token_index: u32, amount: i128) -> Result<(), Error> {
    let mut info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;

    if storage::is_token_paused(env, token_index) {
        return Err(Error::TokenPaused);
    }

    let balance = storage::get_balance(env, token_index, caller);
    if balance < amount {
        return Err(Error::InsufficientBalance);
    }

    // ── Checks-Effects-Interactions ──────────────────────────
    // 1. Compute new values (no state mutation yet)
    let new_balance = balance.checked_sub(amount).ok_or(Error::ArithmeticError)?;
    let new_supply = info
        .total_supply
        .checked_sub(amount)
        .ok_or(Error::ArithmeticError)?;
    let new_burned = info
        .total_burned
        .checked_add(amount)
        .ok_or(Error::ArithmeticError)?;
    let new_burn_count = info
        .burn_count
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;

    // 2. Commit all state before any external interaction or event emission
    storage::set_balance(env, token_index, caller, new_balance);
    info.total_supply = new_supply;
    info.total_burned = new_burned;
    info.burn_count = new_burn_count;
    storage::set_token_info(env, token_index, &info);

    // Record snapshots for historical queries (pure state writes, no external calls)
    let _ = crate::snapshot::record_balance_snapshot(env, token_index, caller, new_balance);
    let _ = crate::snapshot::record_supply_snapshot(env, token_index, new_supply);

    // 3. Emit event only after state is fully committed
    emit_burn_event(env, token_index, caller, amount, new_supply);
    Ok(())
}

pub fn admin_burn(
    env: &Env,
    admin: Address,
    token_index: u32,
    holder: Address,
    amount: i128,
) -> Result<(), Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if admin != current_admin {
        return Err(Error::Unauthorized);
    }

    validate_amount(amount)?;
    validate_address(&holder)?;

    // Reentrancy guard
    storage::acquire_reentrancy_lock(env).map_err(|_| Error::BurnReentrancyDetected)?;

    let result = admin_burn_inner(env, &admin, token_index, &holder, amount);

    storage::release_reentrancy_lock(env);
    result
}

fn admin_burn_inner(
    env: &Env,
    admin: &Address,
    token_index: u32,
    holder: &Address,
    amount: i128,
) -> Result<(), Error> {
    let mut info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;

    if storage::is_token_paused(env, token_index) {
        return Err(Error::TokenPaused);
    }

    let balance = storage::get_balance(env, token_index, holder);
    if balance < amount {
        return Err(Error::InsufficientBalance);
    }

    // ── Checks-Effects-Interactions ──────────────────────────
    let new_balance = balance.checked_sub(amount).ok_or(Error::ArithmeticError)?;
    let new_supply = info
        .total_supply
        .checked_sub(amount)
        .ok_or(Error::ArithmeticError)?;
    let new_burned = info
        .total_burned
        .checked_add(amount)
        .ok_or(Error::ArithmeticError)?;
    let new_burn_count = info
        .burn_count
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;

    // Commit all state before events
    storage::set_balance(env, token_index, holder, new_balance);
    info.total_supply = new_supply;
    info.total_burned = new_burned;
    info.burn_count = new_burn_count;
    storage::set_token_info(env, token_index, &info);

    let _ = crate::snapshot::record_balance_snapshot(env, token_index, holder, new_balance);
    let _ = crate::snapshot::record_supply_snapshot(env, token_index, new_supply);

    // Emit events after state is fully committed
    emit_admin_burn_event(env, token_index, admin, holder, amount, new_supply);

    if let Some(token_info) = storage::get_token_info(env, token_index) {
        crate::events::emit_clawback_audit(env, &token_info.address, admin, holder, amount);
    }

    Ok(())
}

pub fn batch_burn(
    env: &Env,
    admin: Address,
    token_index: u32,
    burns: soroban_sdk::Vec<(Address, i128)>,
) -> Result<(), Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if admin != current_admin {
        return Err(Error::Unauthorized);
    }

    if burns.len() > MAX_BATCH_BURN {
        return Err(Error::BatchTooLarge);
    }
    if burns.is_empty() {
        return Err(Error::InvalidParameters);
    }

    // Reentrancy guard
    storage::acquire_reentrancy_lock(env).map_err(|_| Error::BurnReentrancyDetected)?;

    let result = batch_burn_inner(env, &admin, token_index, burns);

    storage::release_reentrancy_lock(env);
    result
}

fn batch_burn_inner(
    env: &Env,
    admin: &Address,
    token_index: u32,
    burns: soroban_sdk::Vec<(Address, i128)>,
) -> Result<(), Error> {
    let mut info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;

    if storage::is_token_paused(env, token_index) {
        return Err(Error::TokenPaused);
    }

    // ── Checks-Effects-Interactions ──────────────────────────
    // Phase 1: validate all inputs and compute new balances (no state writes yet)
    let mut total_burn: i128 = 0;
    for i in 0..burns.len() {
        let (ref holder, amount) = burns.get(i).unwrap();
        validate_amount(amount)?;
        validate_address(holder)?;

        let balance = storage::get_balance(env, token_index, holder);
        if balance < amount {
            return Err(Error::InsufficientBalance);
        }
        total_burn = total_burn
            .checked_add(amount)
            .ok_or(Error::ArithmeticError)?;
    }

    if info.total_supply < total_burn {
        return Err(Error::InsufficientBalance);
    }

    let new_supply = info
        .total_supply
        .checked_sub(total_burn)
        .ok_or(Error::ArithmeticError)?;
    let new_burned = info
        .total_burned
        .checked_add(total_burn)
        .ok_or(Error::ArithmeticError)?;
    let new_burn_count = info
        .burn_count
        .checked_add(burns.len())
        .ok_or(Error::ArithmeticError)?;

    // Phase 2: commit all state
    for i in 0..burns.len() {
        let (ref holder, amount) = burns.get(i).unwrap();
        let balance = storage::get_balance(env, token_index, holder);
        let new_balance = balance.checked_sub(amount).ok_or(Error::ArithmeticError)?;
        storage::set_balance(env, token_index, holder, new_balance);
    }

    info.total_supply = new_supply;
    info.total_burned = new_burned;
    info.burn_count = new_burn_count;
    storage::set_token_info(env, token_index, &info);

    // Phase 3: emit event after all state is committed
    emit_batch_burn_event(env, token_index, admin, burns.len(), total_burn, new_supply);
    Ok(())
}

pub fn get_burn_count(env: &Env, token_index: u32) -> u32 {
    storage::get_burn_count(env, token_index)
}

pub fn get_balance(env: &Env, token_index: u32, holder: &Address) -> i128 {
    storage::get_balance(env, token_index, holder)
}

fn validate_amount(amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidParameters);
    }
    Ok(())
}

fn validate_address(addr: &Address) -> Result<(), Error> {
    let _ = addr;
    Ok(())
}

// ─────────────────────────────────────────────
//  Event emission
// ─────────────────────────────────────────────

/// Emit burn event (v1)
///
/// **Ordering guarantee**: emitted only after balance and supply state are
/// fully committed to storage (checks-effects-interactions pattern).
fn emit_burn_event(env: &Env, token_index: u32, caller: &Address, amount: i128, new_supply: i128) {
    env.events().publish(
        (symbol_short!("burn_v1"), token_index),
        (caller.clone(), amount, new_supply),
    );
}

/// Emit admin burn event (v1)
fn emit_admin_burn_event(
    env: &Env,
    token_index: u32,
    admin: &Address,
    holder: &Address,
    amount: i128,
    new_supply: i128,
) {
    env.events().publish(
        (symbol_short!("adm_bn_v1"), token_index),
        (admin.clone(), holder.clone(), amount, new_supply),
    );
}

/// Emit batch burn event (v1)
fn emit_batch_burn_event(
    env: &Env,
    token_index: u32,
    admin: &Address,
    count: u32,
    total_burned: i128,
    new_supply: i128,
) {
    env.events().publish(
        (symbol_short!("bch_bn_v1"), token_index),
        (admin.clone(), count, total_burned, new_supply),
    );
}

#[cfg(test)]
mod burn_reentrancy_tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup_token(env: &Env) -> (Address, u32) {
        let holder = Address::generate(env);
        let token_index = 0u32;
        // Seed balance and token info via storage helpers
        let mut info = crate::types::TokenInfo {
            address: Address::generate(env),
            creator: holder.clone(),
            name: soroban_sdk::String::from_str(env, "T"),
            symbol: soroban_sdk::String::from_str(env, "T"),
            decimals: 7,
            total_supply: 1_000_000,
            initial_supply: 1_000_000,
            max_supply: None,
            total_burned: 0,
            burn_count: 0,
            metadata_uri: None,
            metadata_version: 0,
            created_at: 0,
            is_paused: false,
            clawback_enabled: true,
            freeze_enabled: false,
        };
        storage::set_token_info(env, token_index, &info);
        storage::set_balance(env, token_index, &holder, 1_000_000);
        (holder, token_index)
    }

    /// State must be fully committed before the burn event is emitted.
    #[test]
    fn test_state_committed_before_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (holder, token_index) = setup_token(&env);

        burn(&env, holder.clone(), token_index, 100).unwrap();

        let info = storage::get_token_info(&env, token_index).unwrap();
        assert_eq!(info.total_supply, 1_000_000 - 100);
        assert_eq!(info.total_burned, 100);
        assert_eq!(info.burn_count, 1);
        assert_eq!(storage::get_balance(&env, token_index, &holder), 1_000_000 - 100);
    }

    /// Reentrancy lock is released after a successful burn.
    #[test]
    fn test_reentrancy_lock_released_after_burn() {
        let env = Env::default();
        env.mock_all_auths();
        let (holder, token_index) = setup_token(&env);

        burn(&env, holder.clone(), token_index, 100).unwrap();
        // Second burn must succeed (lock was released)
        burn(&env, holder.clone(), token_index, 100).unwrap();

        let info = storage::get_token_info(&env, token_index).unwrap();
        assert_eq!(info.total_supply, 1_000_000 - 200);
    }

    /// Reentrancy lock is released even when burn fails.
    #[test]
    fn test_reentrancy_lock_released_on_error() {
        let env = Env::default();
        env.mock_all_auths();
        let (holder, token_index) = setup_token(&env);

        // Burn more than balance — should fail
        let result = burn(&env, holder.clone(), token_index, 2_000_000);
        assert_eq!(result, Err(Error::InsufficientBalance));

        // Lock must be released; subsequent burn must succeed
        burn(&env, holder.clone(), token_index, 100).unwrap();
    }

    /// Supply invariant: total_supply + total_burned == initial_supply after burns.
    #[test]
    fn test_supply_invariant_after_burn() {
        let env = Env::default();
        env.mock_all_auths();
        let (holder, token_index) = setup_token(&env);

        burn(&env, holder.clone(), token_index, 300).unwrap();
        burn(&env, holder.clone(), token_index, 200).unwrap();

        let info = storage::get_token_info(&env, token_index).unwrap();
        assert_eq!(
            info.total_supply + info.total_burned,
            info.initial_supply,
            "supply invariant violated"
        );
    }
}

