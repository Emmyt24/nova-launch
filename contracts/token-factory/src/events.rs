/// Optimized Event Module
/// 
/// This module provides optimized event emission functions that reduce
/// gas costs by approximately 400-500 CPU instructions per event.
/// 
/// Optimizations applied:
/// - Removed redundant timestamp parameters (ledger provides this)
/// - Reduced indexed parameters where not needed for filtering
/// - Optimized payload sizes
/// 
/// Issue: #232 - Gas Usage Analysis and Optimization Report
/// Status: Phase 1 - Quick Wins

use soroban_sdk::{symbol_short, Address, Env};

/// Emit admin transfer event with optimized payload
/// 
/// Reduces bytes from 121 to ~95 by removing redundant timestamp
/// The ledger automatically records transaction timestamps.
pub fn emit_admin_transfer(env: &Env, old_admin: &Address, new_admin: &Address) {
    env.events().publish(
        (symbol_short!("adm_xfer"),),
        (old_admin, new_admin),
    );
}

/// Emit pause event with optimized payload
pub fn emit_pause(env: &Env, admin: &Address) {
    env.events().publish(
        (symbol_short!("pause"),),
        (admin,),
    );
}

/// Emit unpause event with optimized payload
pub fn emit_unpause(env: &Env, admin: &Address) {
    env.events().publish(
        (symbol_short!("unpause"),),
        (admin,),
    );
}

/// Emit fees updated event with optimized payload
pub fn emit_fees_updated(env: &Env, base_fee: i128, metadata_fee: i128) {
    env.events().publish(
        (symbol_short!("fees_upd"),),
        (base_fee, metadata_fee),
    );
}

/// Emit admin burn event with optimized payload
/// 
/// Combines primary indexed parameters for efficient filtering
pub fn emit_admin_burn(
    env: &Env,
    token_address: &Address,
    admin: &Address,
    from: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("adm_burn"), token_address.clone()),
        (admin, from, amount),
    );
}

/// Emit clawback toggled event with optimized payload
pub fn emit_clawback_toggled(
    env: &Env,
    token_address: &Address,
    admin: &Address,
    enabled: bool,
) {
    env.events().publish(
        (symbol_short!("clawback"), token_address.clone()),
        (admin, enabled),
    );
}

/// Emit token burned event for batch operations
/// 
/// Used when multiple tokens are burned in a batch operation
pub fn emit_token_burned(env: &Env, token_address: &Address, amount: i128) {
    env.events().publish(
        (symbol_short!("tkn_burn"), token_address.clone()),
        (amount,),
    );
}

/// Emit token created event
/// 
/// Published when a new token is successfully created
pub fn emit_token_created(
    env: &Env,
    token_address: &Address,
    creator: &Address,
) {
    env.events().publish(
        (symbol_short!("tkn_crtd"), token_address.clone()),
        creator,
    );
}

/// Emit batch tokens created event
/// 
/// Published when multiple tokens are created in a batch operation
pub fn emit_batch_tokens_created(
    env: &Env,
    creator: &Address,
    count: u32,
) {
    env.events().publish(
        (symbol_short!("batch_tkn"),),
        (creator, count),
    );
}
