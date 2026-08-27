/// Gas-bounded batch execution scheduler with fair cross-tenant scheduling. (#1625)
///
/// `batch_operations::batch_reveal` / `batch_settle` execute a whole batch
/// atomically in one call, sized to fit comfortably under a single ledger's
/// gas envelope (`MAX_BATCH_SIZE` = 50). This module adds a second, additive
/// entry point for batches that may be *larger* than one ledger should be
/// asked to absorb, and for ledgers that are shared by multiple tenants:
///
/// - Each batch item has an estimated gas (CPU instruction) cost. A batch is
///   only ever executed up to a configurable **per-ledger gas budget** —
///   never partially through an item, only ever at an item boundary.
/// - Work that doesn't fit in the current ledger's budget is persisted as a
///   **continuation** and must be resumed with `resume_batch_reveal` /
///   `resume_batch_settle` on a *later* ledger.
/// - When more than one tenant has pending work in the same ledger, the
///   ledger's gas budget is split evenly across all pending tenants (a
///   "fair share"), so one tenant's oversized batch cannot consume the
///   entire budget while another tenant's queued batch starves.
///
/// ## Gas estimate calibration
/// Per-item costs are calibrated against the measured CPU-instruction
/// thresholds already established for comparable single-item operations in
/// `gas_compute_thresholds.rs` (which the project's `gas_benchmark_*` suite
/// exists to keep honest):
/// - `THRESHOLD_CREATE_TOKEN` = 6_000_000 CPU instructions — a `batch_reveal`
///   item performs exactly one `create_token_internal` call, so
///   `REVEAL_ITEM_GAS_ESTIMATE` is set equal to it.
/// - `THRESHOLD_PAUSE_TOKEN` / `THRESHOLD_GET_TOKEN_INFO` (2_000_000 /
///   1_500_000) bracket the cost of a single storage read-modify-write plus
///   snapshot recording that a `batch_settle` item performs, so
///   `SETTLE_ITEM_GAS_ESTIMATE` is set above that bracket to also cover the
///   mint event and snapshot overhead unique to settle.
///
/// These are deliberately conservative (over-, not under-, estimates): a
/// scheduler that occasionally splits a chunk one item smaller than strictly
/// necessary is safe, one that lets a chunk exceed the real ledger budget is
/// not.
use soroban_sdk::{Address, Env, Vec};

use crate::events;
use crate::storage;
use crate::types::{
    BatchScheduleResult, Error, RevealBatchContinuation, SettleBatchContinuation,
    TokenCreationParams,
};

/// Default per-ledger gas budget (CPU instructions), used until an admin
/// calls `set_ledger_gas_budget`. Sized for roughly 6 reveal items or 16
/// settle items per ledger at the calibrated per-item estimates below.
pub const DEFAULT_LEDGER_GAS_BUDGET: u64 = 40_000_000;

/// Estimated CPU-instruction cost of a single `batch_reveal` item.
/// Calibrated to `THRESHOLD_CREATE_TOKEN` in `gas_compute_thresholds.rs`.
pub const REVEAL_ITEM_GAS_ESTIMATE: u64 = 6_000_000;

/// Estimated CPU-instruction cost of a single `batch_settle` item.
/// Calibrated above the `THRESHOLD_PAUSE_TOKEN` / `THRESHOLD_GET_TOKEN_INFO`
/// bracket in `gas_compute_thresholds.rs` to also cover mint-event and
/// balance/supply snapshot overhead.
pub const SETTLE_ITEM_GAS_ESTIMATE: u64 = 2_500_000;

/// Maximum items accepted by a single `schedule_batch_*` call. Much larger
/// than `batch_operations::MAX_BATCH_SIZE` since the scheduler is explicitly
/// designed to spread oversized batches across multiple ledgers.
pub const MAX_SCHEDULED_BATCH_SIZE: u32 = 2000;

/// Gas cost estimate for `item_count` `batch_reveal` items.
pub fn estimate_reveal_batch_gas(item_count: u32) -> u64 {
    REVEAL_ITEM_GAS_ESTIMATE.saturating_mul(item_count as u64)
}

/// Gas cost estimate for `item_count` `batch_settle` items.
pub fn estimate_settle_batch_gas(item_count: u32) -> u64 {
    SETTLE_ITEM_GAS_ESTIMATE.saturating_mul(item_count as u64)
}

// ── Admin configuration ──────────────────────────────────────────────────────

/// Current per-ledger gas budget.
pub fn get_ledger_gas_budget(env: &Env) -> u64 {
    storage::get_ledger_gas_budget(env)
}

/// Admin-only: set the per-ledger gas budget shared by the fair-share scheduler.
pub fn set_ledger_gas_budget(env: &Env, admin: Address, budget: u64) -> Result<(), Error> {
    admin.require_auth();
    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if admin != current_admin {
        return Err(Error::Unauthorized);
    }
    if budget == 0 {
        return Err(Error::InvalidParameters);
    }
    storage::set_ledger_gas_budget(env, budget);
    Ok(())
}

/// Tenants currently holding a pending continuation (queued for fair-share allocation).
pub fn pending_tenants(env: &Env) -> Vec<Address> {
    storage::get_fair_share_queue(env)
}

// ── Fair-share budget accounting ─────────────────────────────────────────────

fn queue_contains(queue: &Vec<Address>, addr: &Address) -> bool {
    for t in queue.iter() {
        if t == *addr {
            return true;
        }
    }
    false
}

/// How many items (bounded by `requested_items`) `tenant` may execute right
/// now, given the ledger-wide gas budget, this tenant's fair share of it
/// (the budget divided across every tenant currently queued with pending
/// work, counting `tenant` itself even if not yet queued), and what both
/// the tenant and the ledger as a whole have already spent this ledger.
fn compute_allowed_items(
    env: &Env,
    tenant: &Address,
    ledger_seq: u32,
    per_item_gas: u64,
    requested_items: u32,
) -> u32 {
    if requested_items == 0 {
        return 0;
    }

    let ledger_budget = storage::get_ledger_gas_budget(env);
    let queue = storage::get_fair_share_queue(env);
    let cohort_size: u64 = if queue_contains(&queue, tenant) {
        (queue.len() as u64).max(1)
    } else {
        queue.len() as u64 + 1
    };
    let fair_share = ledger_budget / cohort_size;

    let tenant_used = storage::get_tenant_ledger_gas_used(env, tenant, ledger_seq);
    let tenant_remaining = fair_share.saturating_sub(tenant_used);

    let ledger_used = storage::get_ledger_gas_used(env, ledger_seq);
    let ledger_remaining = ledger_budget.saturating_sub(ledger_used);

    let effective_budget = tenant_remaining.min(ledger_remaining);
    if per_item_gas == 0 {
        return requested_items;
    }
    let max_items = (effective_budget / per_item_gas) as u32;
    max_items.min(requested_items)
}

// ── batch_reveal scheduling ──────────────────────────────────────────────────

/// Stage-and-commit exactly `chunk` reveal items (no partial items). Mirrors
/// `batch_operations::batch_reveal`'s two-phase atomicity for the slice only.
fn execute_reveal_chunk(
    env: &Env,
    creator: &Address,
    chunk: &Vec<TokenCreationParams>,
    fee_payment: i128,
) -> Result<(Vec<u32>, i128), Error> {
    let base_fee = storage::get_base_fee(env).ok_or(Error::InvalidBaseFee)?;
    let metadata_fee = storage::get_metadata_fee(env).ok_or(Error::InvalidMetadataFee)?;
    let start_index = storage::get_token_count(env);

    // Phase 1 (stage): validate every item and compute its fee + index.
    let mut required_fee: i128 = 0;
    let mut staged_indices: Vec<u32> = Vec::new(env);
    for (i, token) in chunk.iter().enumerate() {
        crate::batch_operations::validate_token_params(env, &token)?;

        let token_fee = if token.metadata_uri.is_some() {
            base_fee
                .checked_add(metadata_fee)
                .ok_or(Error::ArithmeticError)?
        } else {
            base_fee
        };
        required_fee = required_fee
            .checked_add(token_fee)
            .ok_or(Error::ArithmeticError)?;

        let token_index = start_index
            .checked_add(i as u32)
            .ok_or(Error::ArithmeticError)?;
        staged_indices.push_back(token_index);
    }

    if fee_payment < required_fee {
        return Err(Error::InsufficientFee);
    }

    // Phase 2 (commit): every value here was already validated above.
    let mut indices = Vec::new(env);
    for (token, token_index) in chunk.iter().zip(staged_indices.iter()) {
        crate::token_creation::create_token_internal(env, creator, &token, token_index)
            .unwrap_or_else(|e| panic!("schedule_batch_reveal: chunk commit failed after validation passed: {:?}", e));
        indices.push_back(token_index);
    }

    let new_count = start_index
        .checked_add(chunk.len())
        .ok_or(Error::ArithmeticError)?;
    env.storage()
        .instance()
        .set(&crate::types::DataKey::TokenCount, &new_count);

    Ok((indices, required_fee))
}

/// Gas-bounded, fair-share-scheduled version of `batch_reveal`.
///
/// Executes as many leading items of `tokens` as fit in this ledger's
/// remaining gas budget (and this tenant's fair share of it). Any remainder
/// is persisted as a continuation and must be finished with
/// `resume_batch_reveal` on a later ledger. Only one reveal continuation may
/// be pending per tenant at a time.
pub fn schedule_batch_reveal(
    env: &Env,
    creator: Address,
    tokens: Vec<TokenCreationParams>,
    total_fee_payment: i128,
) -> Result<BatchScheduleResult, Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }
    creator.require_auth();

    let batch_len = tokens.len();
    if batch_len == 0 {
        return Err(Error::InvalidParameters);
    }
    if batch_len > MAX_SCHEDULED_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }
    if storage::get_reveal_continuation(env, &creator).is_some() {
        return Err(Error::ContinuationAlreadyPending);
    }

    let ledger_seq = env.ledger().sequence();
    let chunk_len = compute_allowed_items(env, &creator, ledger_seq, REVEAL_ITEM_GAS_ESTIMATE, batch_len);

    let chunk: Vec<TokenCreationParams> = tokens.slice(0..chunk_len);
    let fee_used = if chunk_len > 0 {
        let (_, fee_used) = execute_reveal_chunk(env, &creator, &chunk, total_fee_payment)?;
        storage::record_gas_used(
            env,
            &creator,
            ledger_seq,
            REVEAL_ITEM_GAS_ESTIMATE.saturating_mul(chunk_len as u64),
        );
        events::emit_batch_tokens_created(env, &creator, chunk_len);
        fee_used
    } else {
        0
    };

    let remaining_count = batch_len - chunk_len;
    if remaining_count > 0 {
        let remaining_tokens: Vec<TokenCreationParams> = tokens.slice(chunk_len..batch_len);
        let continuation = RevealBatchContinuation {
            creator: creator.clone(),
            remaining_tokens,
            remaining_fee_payment: total_fee_payment - fee_used,
            last_activity_ledger: ledger_seq,
        };
        storage::set_reveal_continuation(env, &creator, &continuation);
        storage::enqueue_tenant(env, &creator);
        events::emit_batch_scheduled(env, &creator, chunk_len, remaining_count);
    }

    Ok(BatchScheduleResult {
        executed_count: chunk_len,
        remaining_count,
        continuation_pending: remaining_count > 0,
    })
}

/// Resume a pending `batch_reveal` continuation for `creator`. Must be
/// called on a ledger after the one the continuation last made progress on.
pub fn resume_batch_reveal(env: &Env, creator: Address) -> Result<BatchScheduleResult, Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }
    creator.require_auth();

    let continuation = storage::get_reveal_continuation(env, &creator).ok_or(Error::NoContinuationPending)?;

    let ledger_seq = env.ledger().sequence();
    if ledger_seq <= continuation.last_activity_ledger {
        return Err(Error::ContinuationNotYetEligible);
    }

    let remaining = continuation.remaining_tokens.clone();
    let batch_len = remaining.len();
    let chunk_len = compute_allowed_items(env, &creator, ledger_seq, REVEAL_ITEM_GAS_ESTIMATE, batch_len);

    let chunk: Vec<TokenCreationParams> = remaining.slice(0..chunk_len);
    let fee_used = if chunk_len > 0 {
        let (_, fee_used) = execute_reveal_chunk(env, &creator, &chunk, continuation.remaining_fee_payment)?;
        storage::record_gas_used(
            env,
            &creator,
            ledger_seq,
            REVEAL_ITEM_GAS_ESTIMATE.saturating_mul(chunk_len as u64),
        );
        events::emit_batch_tokens_created(env, &creator, chunk_len);
        fee_used
    } else {
        0
    };

    let remaining_count = batch_len - chunk_len;
    if remaining_count > 0 {
        let remaining_tokens: Vec<TokenCreationParams> = remaining.slice(chunk_len..batch_len);
        let updated = RevealBatchContinuation {
            creator: creator.clone(),
            remaining_tokens,
            remaining_fee_payment: continuation.remaining_fee_payment - fee_used,
            last_activity_ledger: ledger_seq,
        };
        storage::set_reveal_continuation(env, &creator, &updated);
        storage::rotate_tenant_to_back(env, &creator);
        events::emit_batch_scheduled(env, &creator, chunk_len, remaining_count);
    } else {
        storage::clear_reveal_continuation(env, &creator);
        storage::dequeue_tenant(env, &creator);
        events::emit_batch_continuation_completed(env, &creator);
    }

    Ok(BatchScheduleResult {
        executed_count: chunk_len,
        remaining_count,
        continuation_pending: remaining_count > 0,
    })
}

// ── batch_settle scheduling ──────────────────────────────────────────────────

/// Stage-and-commit exactly `chunk` (recipient, amount) mints against
/// `token_index` (no partial items). Mirrors `batch_operations::batch_settle`'s
/// two-phase atomicity for the slice only.
fn execute_settle_chunk(
    env: &Env,
    token_index: u32,
    chunk: &Vec<(Address, i128)>,
) -> Result<i128, Error> {
    use soroban_sdk::Map;

    let token_info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;

    // Phase 1 (stage).
    let mut total_mint: i128 = 0;
    let mut deltas: Map<Address, i128> = Map::new(env);
    for (recipient, amount) in chunk.iter() {
        if amount <= 0 {
            return Err(Error::InvalidParameters);
        }
        total_mint = total_mint
            .checked_add(amount)
            .ok_or(Error::ArithmeticError)?;

        let prior = deltas.get(recipient.clone()).unwrap_or(0);
        let combined = prior.checked_add(amount).ok_or(Error::ArithmeticError)?;
        deltas.set(recipient.clone(), combined);
    }

    let new_supply = token_info
        .total_supply
        .checked_add(total_mint)
        .ok_or(Error::ArithmeticError)?;
    if let Some(max) = token_info.max_supply {
        if new_supply > max {
            return Err(Error::MaxSupplyExceeded);
        }
    }

    let mut staged_balances: Map<Address, i128> = Map::new(env);
    for (recipient, delta) in deltas.iter() {
        let current_balance = storage::get_balance(env, token_index, &recipient);
        let new_balance = current_balance
            .checked_add(delta)
            .ok_or(Error::ArithmeticError)?;
        staged_balances.set(recipient, new_balance);
    }

    // Phase 2 (commit).
    let mut updated_info = token_info;
    updated_info.total_supply = new_supply;
    storage::set_token_info(env, token_index, &updated_info);

    for (recipient, _) in deltas.iter() {
        let new_balance = staged_balances
            .get(recipient.clone())
            .unwrap_or_else(|| panic!("schedule_batch_settle: chunk commit missing staged balance"));
        storage::set_balance(env, token_index, &recipient, new_balance);
        let _ = crate::snapshot::record_balance_snapshot(env, token_index, &recipient, new_balance);
    }
    let _ = crate::snapshot::record_supply_snapshot(env, token_index, new_supply);

    for (recipient, amount) in chunk.iter() {
        events::emit_mint(env, token_index, &recipient, amount);
    }

    Ok(total_mint)
}

/// Gas-bounded, fair-share-scheduled version of `batch_settle`.
///
/// Executes as many leading `(recipient, amount)` pairs of `recipients` as
/// fit in this ledger's remaining gas budget (and this tenant's fair
/// share of it). Any remainder is persisted as a continuation and must be
/// finished with `resume_batch_settle` on a later ledger. Only one settle
/// continuation may be pending per tenant at a time.
pub fn schedule_batch_settle(
    env: &Env,
    creator: Address,
    token_index: u32,
    recipients: Vec<(Address, i128)>,
) -> Result<BatchScheduleResult, Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }
    creator.require_auth();

    let batch_len = recipients.len();
    if batch_len == 0 {
        return Err(Error::InvalidParameters);
    }
    if batch_len > MAX_SCHEDULED_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }
    if storage::get_settle_continuation(env, &creator).is_some() {
        return Err(Error::ContinuationAlreadyPending);
    }

    let token_info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;
    if token_info.creator != creator {
        return Err(Error::Unauthorized);
    }
    if storage::is_token_paused(env, token_index) {
        return Err(Error::TokenPaused);
    }

    let ledger_seq = env.ledger().sequence();
    let chunk_len = compute_allowed_items(env, &creator, ledger_seq, SETTLE_ITEM_GAS_ESTIMATE, batch_len);

    let chunk: Vec<(Address, i128)> = recipients.slice(0..chunk_len);
    let minted_so_far = if chunk_len > 0 {
        let minted = execute_settle_chunk(env, token_index, &chunk)?;
        storage::record_gas_used(
            env,
            &creator,
            ledger_seq,
            SETTLE_ITEM_GAS_ESTIMATE.saturating_mul(chunk_len as u64),
        );
        events::emit_batch_settle(env, token_index, &creator, chunk_len, minted);
        minted
    } else {
        0
    };

    let remaining_count = batch_len - chunk_len;
    if remaining_count > 0 {
        let remaining_recipients: Vec<(Address, i128)> = recipients.slice(chunk_len..batch_len);
        let continuation = SettleBatchContinuation {
            creator: creator.clone(),
            token_index,
            remaining_recipients,
            minted_so_far,
            last_activity_ledger: ledger_seq,
        };
        storage::set_settle_continuation(env, &creator, &continuation);
        storage::enqueue_tenant(env, &creator);
        events::emit_batch_scheduled(env, &creator, chunk_len, remaining_count);
    }

    Ok(BatchScheduleResult {
        executed_count: chunk_len,
        remaining_count,
        continuation_pending: remaining_count > 0,
    })
}

/// Resume a pending `batch_settle` continuation for `creator`. Must be
/// called on a ledger after the one the continuation last made progress on.
/// Returns the total minted by this resume call (not the running total).
pub fn resume_batch_settle(env: &Env, creator: Address) -> Result<BatchScheduleResult, Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }
    creator.require_auth();

    let continuation = storage::get_settle_continuation(env, &creator).ok_or(Error::NoContinuationPending)?;

    let ledger_seq = env.ledger().sequence();
    if ledger_seq <= continuation.last_activity_ledger {
        return Err(Error::ContinuationNotYetEligible);
    }

    if storage::is_token_paused(env, continuation.token_index) {
        return Err(Error::TokenPaused);
    }

    let remaining = continuation.remaining_recipients.clone();
    let batch_len = remaining.len();
    let chunk_len = compute_allowed_items(env, &creator, ledger_seq, SETTLE_ITEM_GAS_ESTIMATE, batch_len);

    let chunk: Vec<(Address, i128)> = remaining.slice(0..chunk_len);
    let minted_this_chunk = if chunk_len > 0 {
        let minted = execute_settle_chunk(env, continuation.token_index, &chunk)?;
        storage::record_gas_used(
            env,
            &creator,
            ledger_seq,
            SETTLE_ITEM_GAS_ESTIMATE.saturating_mul(chunk_len as u64),
        );
        events::emit_batch_settle(env, continuation.token_index, &creator, chunk_len, minted);
        minted
    } else {
        0
    };

    let remaining_count = batch_len - chunk_len;
    if remaining_count > 0 {
        let remaining_recipients: Vec<(Address, i128)> = remaining.slice(chunk_len..batch_len);
        let updated = SettleBatchContinuation {
            creator: creator.clone(),
            token_index: continuation.token_index,
            remaining_recipients,
            minted_so_far: continuation.minted_so_far + minted_this_chunk,
            last_activity_ledger: ledger_seq,
        };
        storage::set_settle_continuation(env, &creator, &updated);
        storage::rotate_tenant_to_back(env, &creator);
        events::emit_batch_scheduled(env, &creator, chunk_len, remaining_count);
    } else {
        storage::clear_settle_continuation(env, &creator);
        storage::dequeue_tenant(env, &creator);
        events::emit_batch_continuation_completed(env, &creator);
    }

    Ok(BatchScheduleResult {
        executed_count: chunk_len,
        remaining_count,
        continuation_pending: remaining_count > 0,
    })
}
