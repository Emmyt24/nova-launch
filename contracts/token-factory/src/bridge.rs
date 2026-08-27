//! Cross-Chain Bridge Module (lock/release primitive)
//!
//! Implements the on-chain half of a lock-and-release bridge:
//!
//! ```text
//! Source chain:  caller -> lock_tokens    -> emits "bridge/initiated" (brg_lck1)
//! Destination:   admin  -> release_tokens -> emits "bridge/completed" (brg_rel1)
//! ```
//!
//! This module is deliberately narrow in scope: it is the locking and
//! replay-protection primitive, not an off-chain relayer. `lock_tokens` and
//! `release_tokens` are independent operations — a real deployment would run
//! this contract once on the source chain and once on the destination chain,
//! and nothing here assumes both are the same instance. `release_tokens`
//! does **not** look up or validate against a local `BridgeLock` record; on
//! the destination chain, no such record would exist. Replay protection
//! comes entirely from the nonce, which must be supplied verbatim (obtained
//! off-chain from the source-chain `lock_tokens` call/event) and can only be
//! consumed once.
//!
//! `release_tokens` is admin-gated in this version: the admin is trusted to
//! have verified the corresponding source-chain lock before calling it.
//! Hardening this — e.g. requiring multisig approval, or verifying a signed
//! attestation of the source-chain lock — is a legitimate scope expansion
//! left to a follow-up; see the issue notes for implementers.

use crate::{
    events, storage,
    types::{BridgeLock, Error},
};
use soroban_sdk::{Address, Bytes, Env, String};

/// Maximum length (bytes) accepted for `destination_chain`.
pub const MAX_DESTINATION_CHAIN_LEN: u32 = 64;
/// Maximum length (bytes) accepted for `destination_address`.
pub const MAX_DESTINATION_ADDRESS_LEN: u32 = 128;

/// Lock `amount` of `token`, escrowing it in contract custody, and assign it
/// a fresh monotonic nonce.
///
/// # Safety Guarantees
/// - `caller` must authorize the call.
/// - `amount` must be strictly positive.
/// - `destination_chain` / `destination_address` must be non-empty and within
///   the length bounds above.
/// - The nonce is assigned by the contract (`storage::get_next_bridge_nonce`)
///   and is never reused, even across a failed transfer (the counter still
///   advances only after the transfer above succeeds, since the transfer is
///   attempted before any state is written).
///
/// Returns the assigned nonce, to be relayed off-chain and supplied verbatim
/// to `release_tokens` on the destination deployment.
pub fn lock_tokens(
    env: &Env,
    caller: &Address,
    token: &Address,
    amount: i128,
    destination_chain: String,
    destination_address: Bytes,
) -> Result<u64, Error> {
    caller.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    if destination_chain.is_empty() || destination_chain.len() > MAX_DESTINATION_CHAIN_LEN {
        return Err(Error::InvalidBridgeDestination);
    }
    if destination_address.is_empty() || destination_address.len() > MAX_DESTINATION_ADDRESS_LEN {
        return Err(Error::InvalidBridgeDestination);
    }

    // Escrow the tokens before writing any bridge state: if the transfer
    // fails (insufficient balance/allowance), the whole call aborts and no
    // nonce is consumed.
    let token_client = soroban_sdk::token::Client::new(env, token);
    token_client.transfer(caller, &env.current_contract_address(), &amount);

    let nonce = storage::get_next_bridge_nonce(env)?;

    let lock = BridgeLock {
        nonce,
        sender: caller.clone(),
        token: token.clone(),
        amount,
        destination_chain: destination_chain.clone(),
        destination_address,
        locked_at: env.ledger().timestamp(),
    };
    storage::set_bridge_lock(env, &lock);
    storage::add_bridge_locked_total(env, token, amount)?;

    events::emit_bridge_lock(env, nonce, caller, token, amount, &destination_chain);

    Ok(nonce)
}

/// Release `amount` of `token` to `recipient`, authorizing with `nonce`.
///
/// `nonce` must not have been released before (replay protection); it is
/// otherwise not cross-checked against any local `BridgeLock` — see the
/// module docs above for why.
///
/// # Safety Guarantees
/// - `admin` must authorize the call and must match the configured factory admin.
/// - `amount` must be strictly positive.
/// - `nonce` can only be released once (double-release and replay rejected).
/// - State (the released-nonce flag) is committed before the external token
///   transfer (CEI pattern), so a reentrant call during the transfer still
///   sees the nonce as consumed.
pub fn release_tokens(
    env: &Env,
    admin: &Address,
    nonce: u64,
    token: &Address,
    recipient: &Address,
    amount: i128,
) -> Result<(), Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    if storage::is_bridge_nonce_released(env, nonce) {
        return Err(Error::BridgeNonceAlreadyReleased);
    }

    // State update before the external call (CEI pattern).
    storage::set_bridge_nonce_released(env, nonce);

    let token_client = soroban_sdk::token::Client::new(env, token);
    token_client.transfer(&env.current_contract_address(), recipient, &amount);

    events::emit_bridge_release(env, nonce, admin, token, recipient, amount);

    Ok(())
}

/// Look up a bridge lock record by nonce (source-side query).
pub fn get_bridge_lock(env: &Env, nonce: u64) -> Option<BridgeLock> {
    storage::get_bridge_lock(env, nonce)
}

/// Whether `nonce` has already been consumed by `release_tokens` (destination-side query).
pub fn is_nonce_released(env: &Env, nonce: u64) -> bool {
    storage::is_bridge_nonce_released(env, nonce)
}
