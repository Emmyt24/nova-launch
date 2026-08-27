//! Buyback-and-burn step execution (issue #1764)
//!
//! A campaign is created here and then advanced one *step* at a time. Each
//! step spends a slice of the campaign's treasury budget on the target token
//! and burns everything it acquires, so the token's circulating supply falls
//! by exactly what the step bought.
//!
//! ## Why steps
//!
//! Spending a whole budget in one transaction hands the entire position to a
//! single price point and a single slippage event. Splitting it into capped
//! steps bounds the damage of any one bad fill to `max_spend_per_step`, which
//! is validated against the budget at creation time and re-checked on every
//! execution.
//!
//! ## Accounting invariants
//!
//! Every step must preserve all of these, and any violation aborts the step
//! before a single field is written:
//!
//! 1. `spent <= budget`                — a campaign can never overspend
//! 2. `spent`, `tokens_bought`, `tokens_burned` are monotonically non-decreasing
//! 3. `tokens_burned <= tokens_bought` — you cannot burn what you did not buy
//!
//! [`crate::campaign`] owns the campaign *state machine*; this module owns the
//! campaign *record* and the money movement. Steps only execute while the
//! campaign is `Active`, so pausing is an immediate, effective kill switch.

use crate::campaign_validation;
use crate::events;
use crate::storage;
use crate::types::{BuybackCampaign, CampaignStatus, Error};
use soroban_sdk::{contracttype, Address, Env};

/// Basis-point denominator (100% = 10_000 bps).
const BPS_DENOMINATOR: i128 = 10_000;

/// Outcome of a single [`execute_buyback_step`] call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionResult {
    /// Budget spent by this step (not the campaign total).
    pub spent: i128,
    /// Target tokens acquired by this step.
    pub bought: i128,
    /// Target tokens burned by this step.
    pub burned: i128,
    /// 1-based index of this step within the campaign.
    pub step_number: u32,
    /// Campaign budget still unspent after this step.
    pub budget_remaining: i128,
}

/// Expected-vs-realized burn comparison for a single step.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReconciliationReport {
    pub expected_burn: i128,
    pub realized_burn: i128,
    /// `realized_burn - expected_burn`; negative means the burn under-delivered.
    pub delta: i128,
    pub reconciled: bool,
}

/// Create a buyback campaign in the `Active` state.
///
/// All parameters are validated by [`campaign_validation::validate_campaign_config`]
/// before anything is persisted, so a stored campaign is always within bounds.
///
/// # Errors
/// * `Unauthorized`   - caller is neither the contract admin nor the target token's creator
/// * `TokenNotFound`  - `token_index` does not exist
/// * `InvalidBudget` / `InvalidAmount` / `InvalidParameters` / `InvalidTimeWindow`
///   - see [`campaign_validation`]
#[allow(clippy::too_many_arguments)]
pub fn create_campaign(
    env: &Env,
    creator: &Address,
    token_index: u32,
    budget: i128,
    max_spend_per_step: i128,
    start_time: u64,
    end_time: u64,
    min_interval: u64,
    max_slippage_bps: u32,
    source_token: &Address,
) -> Result<u64, Error> {
    creator.require_auth();

    let token = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;

    // Only the contract admin or the token's own creator may commit treasury
    // funds to buying that token back.
    let admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if creator != &admin && creator != &token.creator {
        return Err(Error::Unauthorized);
    }

    campaign_validation::validate_campaign_config(
        env,
        budget,
        max_spend_per_step,
        start_time,
        end_time,
        min_interval,
        max_slippage_bps,
        source_token,
        &token.address,
    )?;

    let campaign_id = storage::increment_campaign_count(env)?;
    let owner_index = storage::increment_owner_campaign_count(env, creator)?
        .checked_sub(1)
        .ok_or(Error::ArithmeticError)?;
    storage::set_campaign_by_owner(env, creator, owner_index, campaign_id);
    storage::increment_active_campaign_count(env)?;

    let now = env.ledger().timestamp();
    let campaign = BuybackCampaign {
        id: campaign_id,
        token_index,
        budget,
        spent: 0,
        tokens_bought: 0,
        tokens_burned: 0,
        max_spend_per_step,
        execution_count: 0,
        start_time,
        end_time,
        min_interval,
        max_slippage_bps,
        source_token: source_token.clone(),
        target_token: token.address.clone(),
        owner: creator.clone(),
        status: CampaignStatus::Active,
        created_at: now,
        updated_at: now,
        trigger_price: 0,
        last_executed_at: 0,
    };

    storage::set_campaign(env, campaign_id, &campaign);
    events::emit_campaign_created(env, campaign_id, creator, token_index, budget);

    Ok(campaign_id)
}

/// Read a campaign record.
///
/// # Errors
/// * `CampaignNotFound` - no campaign with `campaign_id`
pub fn get_campaign(env: &Env, campaign_id: u64) -> Result<BuybackCampaign, Error> {
    storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)
}

/// Execute one buyback step: spend budget, acquire the target token, burn it.
///
/// `quoted_tokens_out` is what the off-chain router quoted for `quote_amount`;
/// `min_tokens_out` is the caller's own floor. The step settles only if the
/// venue delivers at least both the caller's floor and the campaign's
/// slippage-adjusted floor, so a stale or manipulated quote cannot drain the
/// budget at a bad price.
///
/// The campaign record is written once, after every check has passed, so a
/// rejected step leaves no partial state behind and is safe to retry.
///
/// # Errors
/// * `CampaignNotFound`   - no campaign with `campaign_id`
/// * `Unauthorized`       - caller is neither campaign owner nor contract admin
/// * `CampaignInactive`   - campaign is paused, completed, cancelled or expired
/// * `CampaignExpiredError` - the ledger is outside the campaign's time window
/// * `IntervalNotElapsed` - `min_interval` has not passed since the last step
/// * `InvalidAmount`      - `quote_amount` or the quote is not positive
/// * `ExceedsStepLimit`   - `quote_amount` exceeds `max_spend_per_step`
/// * `InsufficientBudget` - `quote_amount` exceeds the unspent budget
/// * `SlippageExceeded`   - the venue delivered below the slippage floor
/// * `ReconciliationFailed` - the realized burn did not match the acquired amount
/// * `InvariantViolation` - an accounting invariant would break
pub fn execute_buyback_step(
    env: &Env,
    caller: &Address,
    campaign_id: u64,
    quote_amount: i128,
    quoted_tokens_out: i128,
    min_tokens_out: i128,
) -> Result<ExecutionResult, Error> {
    caller.require_auth();

    let mut campaign = storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;

    // Authorization mirrors the state machine: owner or contract admin.
    if caller != &campaign.owner {
        let admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
        if caller != &admin {
            return Err(Error::Unauthorized);
        }
    }

    // Only Active campaigns execute. Pause is therefore a real kill switch,
    // not an advisory flag.
    if campaign.status != CampaignStatus::Active {
        return Err(Error::CampaignInactive);
    }

    let now = env.ledger().timestamp();
    if now < campaign.start_time || now > campaign.end_time {
        return Err(Error::CampaignExpiredError);
    }

    // Rate limit: enforce the configured gap between steps. `last_executed_at`
    // is 0 for a campaign that has never executed, which always passes.
    if campaign.last_executed_at != 0 {
        let earliest_next = campaign
            .last_executed_at
            .checked_add(campaign.min_interval)
            .ok_or(Error::ArithmeticError)?;
        if now < earliest_next {
            return Err(Error::IntervalNotElapsed);
        }
    }

    if quote_amount <= 0 || quoted_tokens_out <= 0 || min_tokens_out <= 0 {
        return Err(Error::InvalidAmount);
    }

    // Per-step cap, checked before the budget so an oversized request reports
    // the more specific of the two failures.
    if quote_amount > campaign.max_spend_per_step {
        return Err(Error::ExceedsStepLimit);
    }

    let remaining = campaign
        .budget
        .checked_sub(campaign.spent)
        .ok_or(Error::ArithmeticError)?;
    if quote_amount > remaining {
        return Err(Error::InsufficientBudget);
    }

    // ── Interaction: acquire the target token ────────────────────────────
    let tokens_received = execute_swap(env, quote_amount, quoted_tokens_out)?;

    // Slippage floor: the campaign's tolerance applied to the router's quote.
    let slippage_floor = apply_slippage_tolerance(quoted_tokens_out, campaign.max_slippage_bps)?;
    if tokens_received < slippage_floor || tokens_received < min_tokens_out {
        return Err(Error::SlippageExceeded);
    }

    // ── Burn everything acquired ─────────────────────────────────────────
    let realized_burn = burn_acquired(env, campaign.token_index, tokens_received)?;
    let reconciliation = reconcile_burn(tokens_received, realized_burn);
    if !reconciliation.reconciled {
        return Err(Error::ReconciliationFailed);
    }

    // ── Effects: compute the whole next state, then commit it at once ────
    let new_spent = campaign
        .spent
        .checked_add(quote_amount)
        .ok_or(Error::ArithmeticError)?;
    let new_bought = campaign
        .tokens_bought
        .checked_add(tokens_received)
        .ok_or(Error::ArithmeticError)?;
    let new_burned = campaign
        .tokens_burned
        .checked_add(realized_burn)
        .ok_or(Error::ArithmeticError)?;
    let new_execution_count = campaign
        .execution_count
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;

    check_invariants(&campaign, new_spent, new_bought, new_burned)?;

    campaign.spent = new_spent;
    campaign.tokens_bought = new_bought;
    campaign.tokens_burned = new_burned;
    campaign.execution_count = new_execution_count;
    campaign.last_executed_at = now;
    campaign.updated_at = now;
    storage::set_campaign(env, campaign_id, &campaign);

    let budget_remaining = campaign
        .budget
        .checked_sub(campaign.spent)
        .ok_or(Error::ArithmeticError)?;

    events::emit_buyback_step_settled(
        env,
        campaign_id,
        caller,
        quote_amount,
        tokens_received,
        realized_burn,
        new_execution_count,
    );

    Ok(ExecutionResult {
        spent: quote_amount,
        bought: tokens_received,
        burned: realized_burn,
        step_number: new_execution_count,
        budget_remaining,
    })
}

/// Lower bound on an acceptable fill for `quoted_out` at `slippage_bps`.
///
/// `floor = quoted_out * (10_000 - slippage_bps) / 10_000`, rounded down, so
/// rounding never loosens the bound. A tolerance at or above 100% is rejected
/// rather than allowed to produce a zero floor, which would disable the check
/// entirely.
///
/// # Errors
/// * `InvalidParameters` - `slippage_bps` is 100% or more
/// * `ArithmeticError`   - the intermediate product overflows
pub fn apply_slippage_tolerance(quoted_out: i128, slippage_bps: u32) -> Result<i128, Error> {
    let bps = slippage_bps as i128;
    if bps >= BPS_DENOMINATOR {
        return Err(Error::InvalidParameters);
    }
    quoted_out
        .checked_mul(BPS_DENOMINATOR - bps)
        .ok_or(Error::ArithmeticError)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(Error::ArithmeticError)
}

/// Compare the burn the contract asked for against the burn it got.
///
/// Kept separate from the step so the comparison is exercisable on its own and
/// so a future partial-burn policy has one place to change.
pub fn reconcile_burn(expected: i128, realized: i128) -> ReconciliationReport {
    ReconciliationReport {
        expected_burn: expected,
        realized_burn: realized,
        delta: realized - expected,
        reconciled: realized == expected,
    }
}

/// Swap `quote_amount` of the source token for the target token.
///
/// This is the DEX integration seam. There is no AMM wired into the factory
/// yet, so the venue settles at exactly the router's quote; slippage is still
/// enforced by the caller against [`apply_slippage_tolerance`], which is what
/// makes the check meaningful once a real venue replaces this body.
///
/// # Errors
/// * `InvalidAmount` - either argument is not positive
fn execute_swap(_env: &Env, quote_amount: i128, quoted_tokens_out: i128) -> Result<i128, Error> {
    if quote_amount <= 0 || quoted_tokens_out <= 0 {
        return Err(Error::InvalidAmount);
    }
    Ok(quoted_tokens_out)
}

/// Burn `amount` of the factory-issued token at `token_index`.
///
/// The acquired tokens are never credited to a holder balance — they are
/// retired straight out of circulating supply — so this adjusts supply and
/// burn totals only, and returns the amount actually burned.
///
/// # Errors
/// * `TokenNotFound`      - `token_index` does not exist
/// * `TokenPaused`        - the token is paused; a paused token cannot be burned
/// * `InsufficientBalance` - the burn would drive total supply negative
/// * `ArithmeticError`    - a total would overflow
fn burn_acquired(env: &Env, token_index: u32, amount: i128) -> Result<i128, Error> {
    let mut info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;

    if storage::is_token_paused(env, token_index) {
        return Err(Error::TokenPaused);
    }

    if amount > info.total_supply {
        return Err(Error::InsufficientBalance);
    }

    info.total_supply = info
        .total_supply
        .checked_sub(amount)
        .ok_or(Error::ArithmeticError)?;
    info.total_burned = info
        .total_burned
        .checked_add(amount)
        .ok_or(Error::ArithmeticError)?;
    info.burn_count = info
        .burn_count
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;

    storage::set_token_info(env, token_index, &info);
    let _ = crate::snapshot::record_supply_snapshot(env, token_index, info.total_supply);

    Ok(amount)
}

/// Assert the campaign accounting invariants for a proposed next state.
///
/// Runs before any field is written, so a violation aborts the step rather
/// than persisting an inconsistent campaign.
///
/// # Errors
/// * `InvariantViolation` - spend would exceed budget, a total would move
///   backwards, or burned would exceed bought
fn check_invariants(
    campaign: &BuybackCampaign,
    new_spent: i128,
    new_bought: i128,
    new_burned: i128,
) -> Result<(), Error> {
    if new_spent > campaign.budget {
        return Err(Error::InvariantViolation);
    }
    if new_spent < campaign.spent
        || new_bought < campaign.tokens_bought
        || new_burned < campaign.tokens_burned
    {
        return Err(Error::InvariantViolation);
    }
    if new_burned > new_bought {
        return Err(Error::InvariantViolation);
    }
    Ok(())
}
