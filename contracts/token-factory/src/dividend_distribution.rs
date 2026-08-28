//! Pull-Model Dividend Distribution Module (#1759)
//!
//! Admin calls [`initiate_distribution`] to open a new distribution round: it
//! takes an atomic snapshot of the token's total supply, funds the pool by
//! transferring `total_amount` of `asset` from the admin into contract-held
//! escrow, and opens a claim window that stays open until
//! `claim_deadline_ledger`.
//!
//! Each holder independently calls [`claim_dividend`] to pull their pro-rata
//! share, computed from their own balance snapshot at the distribution's
//! `snapshot_ledger` (via the existing `snapshot` module — no holder
//! enumeration is required at initiation time, so opening a round is O(1)
//! regardless of holder count). A claim is settled exactly once per holder
//! per distribution (double-claim prevention).
//!
//! After `claim_deadline_ledger` passes, the admin calls
//! [`reclaim_unclaimed`] exactly once to recover the unclaimed remainder
//! (`total_amount - claimed_total`) back to treasury.

use soroban_sdk::{Address, Env};

use crate::{
    events, snapshot, storage,
    types::{DistributionRecord, Error},
};

/// Admin-only: open a new dividend distribution round.
///
/// Transfers `total_amount` of `asset` from `admin` into the contract's own
/// balance up front, so that `claim_dividend` and `reclaim_unclaimed` never
/// depend on the admin still holding funds later. The supply snapshot is
/// implicit and atomic: it is simply the current ledger, since per-holder
/// balances are queried lazily at claim time via
/// `snapshot::get_balance_at_ledger`.
///
/// # Errors
/// * `Error::ContractPaused` – contract is paused
/// * `Error::Unauthorized` – caller is not the current admin
/// * `Error::TokenNotFound` – `token_index` does not reference a registered token
/// * `Error::InvalidAmount` – `total_amount <= 0`
/// * `Error::InvalidParameters` – `claim_deadline_ledger` is not in the future
/// * `Error::DistributionZeroSupply` – the token has zero total supply, so no
///   holder could ever claim a share
pub fn initiate_distribution(
    env: &Env,
    admin: &Address,
    token_index: u32,
    asset: &Address,
    total_amount: i128,
    claim_deadline_ledger: u32,
) -> Result<u32, Error> {
    admin.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    if storage::get_token_info(env, token_index).is_none() {
        return Err(Error::TokenNotFound);
    }

    if total_amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let current_ledger = env.ledger().sequence();
    if claim_deadline_ledger <= current_ledger {
        return Err(Error::InvalidParameters);
    }

    let total_supply_at_snapshot =
        snapshot::get_supply_at_ledger(env, token_index, current_ledger)?;
    if total_supply_at_snapshot <= 0 {
        return Err(Error::DistributionZeroSupply);
    }

    let distribution_id = storage::increment_distribution_count(env)?;

    let record = DistributionRecord {
        id: distribution_id,
        token_index,
        asset: asset.clone(),
        total_amount,
        snapshot_ledger: current_ledger,
        total_supply_at_snapshot,
        claim_deadline_ledger,
        reclaimed: false,
        created_at: env.ledger().timestamp(),
    };

    // State committed before the external call (CEI pattern).
    storage::set_distribution(env, &record);

    let token_client = soroban_sdk::token::Client::new(env, asset);
    token_client.transfer(admin, &env.current_contract_address(), &total_amount);

    events::emit_distribution_initiated(
        env,
        distribution_id,
        admin,
        token_index,
        asset,
        total_amount,
        current_ledger,
        claim_deadline_ledger,
    );

    Ok(distribution_id)
}

/// Claim `holder`'s pro-rata share of `distribution_id`.
///
/// Share = `holder_balance_at_snapshot * total_amount / total_supply_at_snapshot`,
/// using the holder's balance as of the distribution's `snapshot_ledger`.
///
/// # Errors
/// * `Error::ContractPaused` – contract is paused
/// * `Error::DistributionNotFound` – no distribution with this id
/// * `Error::DistributionWindowClosed` – `claim_deadline_ledger` has passed
/// * `Error::DistributionAlreadyClaimed` – `holder` already claimed this round
/// * `Error::NothingToClaim` – `holder` held zero balance at the snapshot, or
///   their computed share rounds down to zero
/// * `Error::ArithmeticError` – overflow while computing the share
pub fn claim_dividend(env: &Env, holder: &Address, distribution_id: u32) -> Result<i128, Error> {
    holder.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let record =
        storage::get_distribution(env, distribution_id).ok_or(Error::DistributionNotFound)?;

    let current_ledger = env.ledger().sequence();
    if current_ledger > record.claim_deadline_ledger {
        return Err(Error::DistributionWindowClosed);
    }

    if storage::get_distribution_claimed(env, distribution_id, holder) {
        return Err(Error::DistributionAlreadyClaimed);
    }

    let holder_balance =
        snapshot::get_balance_at_ledger(env, record.token_index, holder, record.snapshot_ledger)?;
    if holder_balance <= 0 {
        return Err(Error::NothingToClaim);
    }

    let share = holder_balance
        .checked_mul(record.total_amount)
        .ok_or(Error::ArithmeticError)?
        .checked_div(record.total_supply_at_snapshot)
        .ok_or(Error::ArithmeticError)?;

    if share <= 0 {
        return Err(Error::NothingToClaim);
    }

    let new_claimed_total = storage::get_distribution_claimed_total(env, distribution_id)
        .checked_add(share)
        .ok_or(Error::ArithmeticError)?;

    // State committed before the external call (CEI pattern) — marking the
    // claim settled here is what makes double-claiming impossible even if
    // the transfer below were to somehow re-enter.
    storage::set_distribution_claimed(env, distribution_id, holder);
    storage::set_distribution_claimed_total(env, distribution_id, new_claimed_total);

    let token_client = soroban_sdk::token::Client::new(env, &record.asset);
    token_client.transfer(&env.current_contract_address(), holder, &share);

    events::emit_dividend_claimed(env, distribution_id, holder, share);

    Ok(share)
}

/// Admin-only: recover the unclaimed remainder of `distribution_id` to treasury.
///
/// May only be called once `claim_deadline_ledger` has passed, and only once
/// per distribution — a second call returns `DistributionAlreadyReclaimed`
/// rather than transferring funds again.
///
/// # Errors
/// * `Error::Unauthorized` – caller is not the current admin
/// * `Error::DistributionNotFound` – no distribution with this id
/// * `Error::DistributionWindowOpen` – `claim_deadline_ledger` has not passed yet
/// * `Error::DistributionAlreadyReclaimed` – the remainder was already reclaimed
/// * `Error::MissingTreasury` – factory treasury is not configured
pub fn reclaim_unclaimed(env: &Env, admin: &Address, distribution_id: u32) -> Result<i128, Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    let mut record =
        storage::get_distribution(env, distribution_id).ok_or(Error::DistributionNotFound)?;

    let current_ledger = env.ledger().sequence();
    if current_ledger <= record.claim_deadline_ledger {
        return Err(Error::DistributionWindowOpen);
    }

    if record.reclaimed {
        return Err(Error::DistributionAlreadyReclaimed);
    }

    let claimed_total = storage::get_distribution_claimed_total(env, distribution_id);
    let remainder = record
        .total_amount
        .checked_sub(claimed_total)
        .ok_or(Error::ArithmeticError)?;

    let treasury = storage::get_treasury(env).ok_or(Error::MissingTreasury)?;

    // State committed before the external call (CEI pattern) — flipping
    // `reclaimed` here is what makes double-reclaiming impossible.
    record.reclaimed = true;
    storage::set_distribution(env, &record);

    if remainder > 0 {
        let token_client = soroban_sdk::token::Client::new(env, &record.asset);
        token_client.transfer(&env.current_contract_address(), &treasury, &remainder);
    }

    events::emit_dividend_reclaimed(env, distribution_id, admin, remainder);

    Ok(remainder)
}

/// Look up a distribution record by id.
pub fn get_distribution(env: &Env, distribution_id: u32) -> Result<DistributionRecord, Error> {
    storage::get_distribution(env, distribution_id).ok_or(Error::DistributionNotFound)
}

/// Whether `holder` has already claimed their share of `distribution_id`.
pub fn has_claimed(env: &Env, distribution_id: u32, holder: &Address) -> bool {
    storage::get_distribution_claimed(env, distribution_id, holder)
}

/// Running total of amounts claimed so far for `distribution_id`.
pub fn get_claimed_total(env: &Env, distribution_id: u32) -> i128 {
    storage::get_distribution_claimed_total(env, distribution_id)
}
