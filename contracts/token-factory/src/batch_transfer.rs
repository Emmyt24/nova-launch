//! Batch token transfer with per-item result events (Issue #2237).
//!
//! A single sender distributes a token to many recipients in one transaction.
//!
//! # Atomicity
//! The batch is all-or-nothing. All inputs are validated up front (size,
//! per-item amounts, aggregate overflow, sender balance). Any later failure
//! (for example a token-level error) aborts the whole transaction, so the host
//! rolls back every transfer and every event emitted so far.
//!
//! # Events
//! * `bt_item` - one per transfer; topics `(bt_item, index)`, data
//!   `(from, to, amount, success)`. `success` is always `true` because a failed
//!   item reverts the batch.
//! * `bt_done` - one summary; topics `(bt_done,)`, data
//!   `(from, token, count, total)`.

use crate::storage;
use crate::types::Error;
use soroban_sdk::{symbol_short, token, Address, Env, Vec};

/// Maximum number of transfers accepted in a single batch.
pub const MAX_BATCH_TRANSFER_SIZE: u32 = 50;

/// Transfer `token` from `from` to each `(recipient, amount)` entry.
///
/// Returns the number of transfers executed.
///
/// # Errors
/// * `Error::ContractPaused` - contract is paused
/// * `Error::InvalidParameters` - empty batch
/// * `Error::BatchTooLarge` - more than `MAX_BATCH_TRANSFER_SIZE` entries
/// * `Error::InvalidAmount` - an amount is zero or negative
/// * `Error::ArithmeticError` - aggregate amount overflows
/// * `Error::InsufficientBalance` - sender cannot cover the aggregate amount
pub fn batch_transfer(
    env: &Env,
    from: &Address,
    token_address: &Address,
    transfers: &Vec<(Address, i128)>,
) -> Result<u32, Error> {
    from.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let count: u32 = transfers.len();
    if count == 0 {
        return Err(Error::InvalidParameters);
    }
    if count > MAX_BATCH_TRANSFER_SIZE {
        return Err(Error::BatchTooLarge);
    }

    let mut total: i128 = 0;
    for item in transfers.iter() {
        let amount: i128 = item.1;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        total = total.checked_add(amount).ok_or(Error::ArithmeticError)?;
    }

    let token_client = token::Client::new(env, token_address);
    if token_client.balance(from) < total {
        return Err(Error::InsufficientBalance);
    }

    let mut index: u32 = 0;
    for item in transfers.iter() {
        let to: Address = item.0;
        let amount: i128 = item.1;
        token_client.transfer(from, &to, &amount);
        env.events()
            .publish((symbol_short!("bt_item"), index), (from.clone(), to, amount, true));
        index += 1;
    }

    env.events().publish(
        (symbol_short!("bt_done"),),
        (from.clone(), token_address.clone(), count, total),
    );

    Ok(count)
}
