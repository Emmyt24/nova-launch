//! Governance Delegation System — Event Emission
//!
//! All events follow the same pattern as the token-factory contract:
//! - Topic tuple: (symbol, primary_key)
//! - Data tuple: remaining fields
//!
//! Keeping events lean reduces gas costs (fewer bytes serialised).

use soroban_sdk::{symbol_short, Address, Env, String};

/// Emitted when a delegator assigns their vote power to a delegatee.
///
/// Topic: ("delegated",)
/// Data:  (delegator, delegatee, amount)
pub fn emit_delegated(env: &Env, delegator: &Address, delegatee: &Address, amount: i128) {
    env.events().publish(
        (symbol_short!("delegated"),),
        (delegator.clone(), delegatee.clone(), amount),
    );
}

/// Emitted when a delegator revokes their current delegation.
///
/// Topic: ("undelegated",)
/// Data:  (delegator, former_delegatee, amount_returned)
pub fn emit_undelegated(
    env: &Env,
    delegator: &Address,
    former_delegatee: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("undlgtd"),),
        (delegator.clone(), former_delegatee.clone(), amount),
    );
}

/// Emitted when a delegator changes their delegatee.
///
/// Topic: ("redelegated",)
/// Data:  (delegator, old_delegatee, new_delegatee, amount)
pub fn emit_redelegated(
    env: &Env,
    delegator: &Address,
    old_delegatee: &Address,
    new_delegatee: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("redlgtd"),),
        (
            delegator.clone(),
            old_delegatee.clone(),
            new_delegatee.clone(),
            amount,
        ),
    );
}

/// Emitted when a vote-power snapshot is taken.
///
/// Topic: ("snapshot",)
/// Data:  (address, ledger, power)
pub fn emit_snapshot(env: &Env, address: &Address, ledger: u32, power: i128) {
    env.events().publish(
        (symbol_short!("snapshot"),),
        (address.clone(), ledger, power),
    );
}

/// Emitted when the admin transfers administrative control.
pub fn emit_admin_transfer(env: &Env, old_admin: &Address, new_admin: &Address) {
    env.events().publish(
        (symbol_short!("adm_xfer"),),
        (old_admin.clone(), new_admin.clone()),
    );
}

/// Emitted when the contract is paused or unpaused.
pub fn emit_pause_changed(env: &Env, admin: &Address, paused: bool) {
    env.events().publish(
        (symbol_short!("pause"),),
        (admin.clone(), paused),
    );
}

/// Emit enriched error detail event
/// 
/// **Event Name**: err_det
/// 
/// **Topics** (indexed):
/// - Event name: "err_det"
/// - error_code: u32 - Numerical representation of the error
/// 
/// **Payload** (non-indexed):
/// - context: i128 - Additional context (e.g. proposal_id, amount)
/// 
/// Emitted when a high-value data path fails to provide structured diagnostic data.
pub fn emit_error_detail(env: &Env, error_code: u32, context: i128) {
    env.events().publish(
        (symbol_short!("err_det"), error_code),
        (context,),
    );
}

/// Emitted when a governance proposal is executed.
///
/// Routed through this module so the event shape is discoverable and
/// testable in the same way as every other governance event.  The on-chain
/// topic (`exec_prop`) and data payload are **identical** to the inline
/// `env.events().publish(...)` call that previously appeared in
/// `execute_proposal` — this is a pure internal refactor; no ABI change.
///
/// Topic: ("exec_prop", proposal_id)
/// Data:  description
pub fn emit_proposal_executed(env: &Env, proposal_id: u32, description: &String) {
    env.events().publish(
        (symbol_short!("exec_prop"), proposal_id),
        description.clone(),
    );
}
