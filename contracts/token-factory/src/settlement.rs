/// Cross-contract atomic settlement protocol. (#1624)
///
/// Governance treasury payouts must never be lost: previously, a governance
/// proposal calling into token-factory to disburse tokens had no atomicity
/// guarantee — if the token-factory call failed after governance already
/// marked the proposal executed, the disbursement was silently lost with no
/// compensating mechanism.
///
/// This module implements the token-factory side of a two-phase commit
/// protocol, callable only by the configured governance contract
/// (`storage::get_governance`):
///
/// - `prepare` reserves `amount` of `token_index` against the token's
///   max-supply headroom and records a `Reservation`, without minting
///   anything yet.
/// - `commit` finalizes a `Prepared` reservation by minting to the
///   recipient. On success the reservation is marked `Committed`; on
///   failure the reservation is left `Prepared` (untouched) so the caller
///   can explicitly release it via `abort`.
/// - `abort` releases a `Prepared` reservation's hold on max-supply
///   headroom without minting anything, marking it `Aborted`.
/// - `cleanup_stuck_reservation` is a permissionless watchdog: once a
///   `Prepared` reservation has sat unresolved past the configured timeout
///   (e.g. because the caller's transaction reverted between `prepare` and
///   `commit`/`abort`), anyone may force-release it the same way `abort`
///   would.
use soroban_sdk::{Address, Env};

use crate::events;
use crate::storage;
use crate::types::{Error, Reservation, ReservationStatus};

fn assert_governance_caller(env: &Env, caller: &Address) -> Result<(), Error> {
    caller.require_auth();
    let governance = storage::get_governance(env).ok_or(Error::Unauthorized)?;
    if *caller != governance {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

fn release_hold(env: &Env, reservation: &Reservation) {
    let current = storage::get_reserved_total(env, reservation.token_index);
    storage::set_reserved_total(env, reservation.token_index, current.saturating_sub(reservation.amount));
}

/// Phase 1: reserve `amount` of `token_index` for `proposal_id`, without
/// minting anything yet. Callable only by the configured governance
/// contract. Returns the new reservation's id.
///
/// # Errors
/// * `Unauthorized`      – `governance` isn't the configured governance address.
/// * `ContractPaused`    – Factory is paused.
/// * `TokenPaused`       – Token is individually paused.
/// * `TokenNotFound`     – `token_index` does not exist.
/// * `InvalidAmount`     – `amount <= 0`.
/// * `MaxSupplyExceeded` – `amount`, combined with already-reserved and
///   already-minted supply, would exceed the token's max supply.
/// * `ArithmeticError`   – Overflow computing projected supply.
pub fn prepare(
    env: &Env,
    governance: Address,
    proposal_id: u64,
    recipient: Address,
    token_index: u32,
    amount: i128,
) -> Result<u64, Error> {
    assert_governance_caller(env, &governance)?;

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }
    if storage::is_token_paused(env, token_index) {
        return Err(Error::TokenPaused);
    }
    let token_info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;

    // Reserve against max-supply headroom so concurrent prepares can't
    // collectively over-commit beyond the cap.
    let reserved_total = storage::get_reserved_total(env, token_index);
    if let Some(max) = token_info.max_supply {
        let projected = token_info
            .total_supply
            .checked_add(reserved_total)
            .ok_or(Error::ArithmeticError)?
            .checked_add(amount)
            .ok_or(Error::ArithmeticError)?;
        if projected > max {
            return Err(Error::MaxSupplyExceeded);
        }
    }

    let id = storage::next_reservation_id(env);
    let reservation = Reservation {
        id,
        proposal_id,
        recipient: recipient.clone(),
        token_index,
        amount,
        status: ReservationStatus::Prepared,
        created_ledger: env.ledger().sequence(),
    };
    storage::set_reservation(env, id, &reservation);
    storage::set_reserved_total(
        env,
        token_index,
        reserved_total.checked_add(amount).ok_or(Error::ArithmeticError)?,
    );

    events::emit_settlement_prepared(env, id, proposal_id, token_index, &recipient, amount);

    Ok(id)
}

/// Phase 2 (success path): finalize a `Prepared` reservation by minting
/// `amount` of `token_index` to its recipient, marking it `Committed`.
///
/// If the mint itself fails (e.g. the token was paused after `prepare`, or a
/// concurrent commit consumed shared max-supply headroom first), the
/// reservation is left `Prepared` — untouched — so the caller can decide to
/// retry or explicitly release it via `abort`. It is never silently dropped.
///
/// # Errors
/// * `Unauthorized`           – `governance` isn't the configured governance address.
/// * `ReservationNotFound`    – No reservation with this id.
/// * `ReservationNotPending`  – Reservation already committed or aborted.
/// * (mint errors)            – `TokenPaused`, `MaxSupplyExceeded`, `ArithmeticError`, etc.
pub fn commit(env: &Env, governance: Address, reservation_id: u64) -> Result<(), Error> {
    assert_governance_caller(env, &governance)?;

    let mut reservation =
        storage::get_reservation(env, reservation_id).ok_or(Error::ReservationNotFound)?;
    if reservation.status != ReservationStatus::Prepared {
        return Err(Error::ReservationNotPending);
    }

    crate::mint::mint(env, reservation.token_index, &reservation.recipient, reservation.amount)?;

    // The hold is only released once real supply has taken its place —
    // never before the mint has actually succeeded.
    release_hold(env, &reservation);
    reservation.status = ReservationStatus::Committed;
    storage::set_reservation(env, reservation_id, &reservation);

    events::emit_settlement_committed(env, reservation_id, reservation.proposal_id);

    Ok(())
}

/// Release a `Prepared` reservation's hold on max-supply headroom without
/// minting anything, marking it `Aborted`. Safe to call after a failed
/// `commit` (which leaves the reservation `Prepared`) to guarantee no
/// reservation is ever left stuck indefinitely.
///
/// # Errors
/// * `Unauthorized`          – `governance` isn't the configured governance address.
/// * `ReservationNotFound`   – No reservation with this id.
/// * `ReservationNotPending` – Reservation already committed or aborted.
pub fn abort(env: &Env, governance: Address, reservation_id: u64) -> Result<(), Error> {
    assert_governance_caller(env, &governance)?;
    abort_internal(env, reservation_id, 0)
}

fn abort_internal(env: &Env, reservation_id: u64, reason_code: u32) -> Result<(), Error> {
    let mut reservation =
        storage::get_reservation(env, reservation_id).ok_or(Error::ReservationNotFound)?;
    if reservation.status != ReservationStatus::Prepared {
        return Err(Error::ReservationNotPending);
    }

    release_hold(env, &reservation);
    reservation.status = ReservationStatus::Aborted;
    storage::set_reservation(env, reservation_id, &reservation);

    events::emit_settlement_aborted(env, reservation_id, reservation.proposal_id, reason_code);

    Ok(())
}

/// Permissionless watchdog: force-release a reservation that has sat
/// `Prepared` past the configured timeout window (see
/// `set_reservation_timeout_ledgers`), guaranteeing no reservation is stuck
/// forever even if the contract that prepared it never follows up with a
/// `commit` or `abort` call.
///
/// # Errors
/// * `ReservationNotFound`    – No reservation with this id.
/// * `ReservationNotPending`  – Reservation already committed or aborted.
/// * `ReservationNotYetStuck` – The timeout window hasn't elapsed yet.
pub fn cleanup_stuck_reservation(env: &Env, reservation_id: u64) -> Result<(), Error> {
    let reservation =
        storage::get_reservation(env, reservation_id).ok_or(Error::ReservationNotFound)?;
    if reservation.status != ReservationStatus::Prepared {
        return Err(Error::ReservationNotPending);
    }

    let timeout = storage::get_reservation_timeout_ledgers(env);
    let current_ledger = env.ledger().sequence();
    if current_ledger < reservation.created_ledger.saturating_add(timeout) {
        return Err(Error::ReservationNotYetStuck);
    }

    abort_internal(env, reservation_id, 0)?;
    events::emit_settlement_timeout_cleanup(env, reservation_id, reservation.proposal_id);
    Ok(())
}
