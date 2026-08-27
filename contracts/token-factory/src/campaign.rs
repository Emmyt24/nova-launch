//! Campaign Management Module (issue #1764)
//!
//! Operational control over treasury-driven buyback-and-burn campaigns.
//! Every transition is authorized (campaign owner or contract admin),
//! replay-resistant, and rejected with a dedicated error when illegal.
//!
//! ## State machine
//!
//! ```text
//!            pause                     resume
//!   Active ──────────▶ Paused ──────────────▶ Active
//!     │                  │
//!     │ finalize         │ finalize
//!     ▼                  ▼
//!  Completed ◀───────────┘        (terminal)
//!     ▲
//!     │ cancel              cancel
//!   Active ──────────▶ Cancelled ◀────────── Paused   (terminal)
//! ```
//!
//! Legal transitions:
//! - `Active   -> Paused`     ([`pause_campaign`])
//! - `Paused   -> Active`     ([`resume_campaign`])
//! - `Active   -> Completed`  ([`finalize_campaign`])
//! - `Paused   -> Completed`  ([`finalize_campaign`])
//! - `Active   -> Cancelled`  ([`cancel_campaign`])
//! - `Paused   -> Cancelled`  ([`cancel_campaign`])
//!
//! Everything else is rejected. Self-transitions are treated as replays and
//! return a dedicated error (`CampaignAlreadyPaused` / `CampaignNotPaused`)
//! rather than silently succeeding, so a re-submitted transaction cannot
//! double-apply. `Completed`, `Cancelled` and `Expired` are terminal.
//!
//! [`validate_state_transition`] is the single source of truth for the
//! transition table; the entry points below consult it and then translate the
//! rejection into the most specific error available for that starting state.

use crate::events;
use crate::storage;
use crate::types::{CampaignStatus, Error};
use soroban_sdk::{Address, Env};

/// Resolve the caller against the campaign's authorization set.
///
/// A transition is permitted for the campaign owner or the contract admin.
/// Returns `Unauthorized` for anyone else, and `MissingAdmin` if the contract
/// has not been initialized.
fn require_owner_or_admin(env: &Env, caller: &Address, owner: &Address) -> Result<(), Error> {
    if caller == owner {
        return Ok(());
    }
    let admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if caller == &admin {
        return Ok(());
    }
    Err(Error::Unauthorized)
}

/// Whether `status` is a state no transition can leave.
fn is_terminal(status: CampaignStatus) -> bool {
    matches!(
        status,
        CampaignStatus::Completed | CampaignStatus::Cancelled | CampaignStatus::Expired
    )
}

/// Map a rejected transition to the most specific error for `from`.
///
/// Terminal states get their own error so an operator can tell "already done"
/// apart from "not allowed from here".
fn reject(from: CampaignStatus) -> Error {
    match from {
        CampaignStatus::Completed => Error::CampaignCompleted,
        CampaignStatus::Cancelled => Error::CampaignCancelled,
        CampaignStatus::Expired => Error::CampaignExpiredError,
        _ => Error::InvalidStateTransition,
    }
}

/// The campaign state transition table.
///
/// This is the authoritative definition of which transitions are legal.
/// Self-transitions are absent by design: they are replays, not transitions.
///
/// # Returns
/// * `Ok(())` - transition is legal
/// * `Err(Error::InvalidStateTransition)` - transition is illegal
pub fn validate_state_transition(from: CampaignStatus, to: CampaignStatus) -> Result<(), Error> {
    match (from, to) {
        (CampaignStatus::Active, CampaignStatus::Paused) => Ok(()),
        (CampaignStatus::Paused, CampaignStatus::Active) => Ok(()),
        (CampaignStatus::Active, CampaignStatus::Completed) => Ok(()),
        (CampaignStatus::Paused, CampaignStatus::Completed) => Ok(()),
        (CampaignStatus::Active, CampaignStatus::Cancelled) => Ok(()),
        (CampaignStatus::Paused, CampaignStatus::Cancelled) => Ok(()),
        _ => Err(Error::InvalidStateTransition),
    }
}

/// Pause an active campaign (`Active -> Paused`).
///
/// Suspends step execution without releasing the remaining budget. Only the
/// campaign owner or the contract admin may pause.
///
/// # Errors
/// * `CampaignNotFound`      - no campaign with `campaign_id`
/// * `Unauthorized`          - caller is neither owner nor admin
/// * `CampaignAlreadyPaused` - replay: campaign is already paused
/// * `CampaignCompleted` / `CampaignCancelled` / `CampaignExpiredError` - terminal
pub fn pause_campaign(env: &Env, caller: &Address, campaign_id: u64) -> Result<(), Error> {
    caller.require_auth();

    let mut campaign = storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;
    require_owner_or_admin(env, caller, &campaign.owner)?;

    // Replay protection: pausing a paused campaign is not a no-op success.
    if campaign.status == CampaignStatus::Paused {
        return Err(Error::CampaignAlreadyPaused);
    }
    validate_state_transition(campaign.status, CampaignStatus::Paused)
        .map_err(|_| reject(campaign.status))?;

    campaign.status = CampaignStatus::Paused;
    campaign.updated_at = env.ledger().timestamp();
    storage::set_campaign(env, campaign_id, &campaign);

    // A paused campaign no longer counts toward the active-campaign gauge.
    storage::decrement_active_campaign_count(env)?;

    events::emit_campaign_paused(env, campaign_id, caller);
    Ok(())
}

/// Resume a paused campaign (`Paused -> Active`).
///
/// # Errors
/// * `CampaignNotFound`  - no campaign with `campaign_id`
/// * `Unauthorized`      - caller is neither owner nor admin
/// * `CampaignNotPaused` - replay: campaign is already active
/// * `CampaignCompleted` / `CampaignCancelled` / `CampaignExpiredError` - terminal
pub fn resume_campaign(env: &Env, caller: &Address, campaign_id: u64) -> Result<(), Error> {
    caller.require_auth();

    let mut campaign = storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;
    require_owner_or_admin(env, caller, &campaign.owner)?;

    // Replay protection: resuming an active campaign is rejected.
    if campaign.status == CampaignStatus::Active {
        return Err(Error::CampaignNotPaused);
    }
    validate_state_transition(campaign.status, CampaignStatus::Active)
        .map_err(|_| reject(campaign.status))?;

    campaign.status = CampaignStatus::Active;
    campaign.updated_at = env.ledger().timestamp();
    storage::set_campaign(env, campaign_id, &campaign);

    storage::increment_active_campaign_count(env)?;

    events::emit_campaign_resumed(env, campaign_id, caller);
    Ok(())
}

/// Cancel a campaign (`Active | Paused -> Cancelled`).
///
/// Terminal. The unspent budget is reported in the emitted event so the
/// treasury reconciliation can release it off-chain.
///
/// # Errors
/// * `CampaignNotFound` - no campaign with `campaign_id`
/// * `Unauthorized`     - caller is neither owner nor admin
/// * `CampaignCompleted` / `CampaignCancelled` / `CampaignExpiredError` - terminal
pub fn cancel_campaign(env: &Env, caller: &Address, campaign_id: u64) -> Result<(), Error> {
    caller.require_auth();

    let mut campaign = storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;
    require_owner_or_admin(env, caller, &campaign.owner)?;

    validate_state_transition(campaign.status, CampaignStatus::Cancelled)
        .map_err(|_| reject(campaign.status))?;

    let was_active = campaign.status == CampaignStatus::Active;
    let budget_remaining = campaign
        .budget
        .checked_sub(campaign.spent)
        .ok_or(Error::ArithmeticError)?;

    campaign.status = CampaignStatus::Cancelled;
    campaign.updated_at = env.ledger().timestamp();
    storage::set_campaign(env, campaign_id, &campaign);

    if was_active {
        storage::decrement_active_campaign_count(env)?;
    }

    events::emit_campaign_cancelled(env, campaign_id, caller, budget_remaining);
    Ok(())
}

/// Finalize a campaign (`Active | Paused -> Completed`).
///
/// Terminal. Emits two events: `cmp_cmp` carries the final accounting
/// (`tokens_burned`, `spent`) and `cmp_fin` records which address finalized it.
/// Off-chain projections take the status transition from `cmp_cmp` and treat
/// `cmp_fin` as an audit-trail entry only.
///
/// # Errors
/// * `CampaignNotFound` - no campaign with `campaign_id`
/// * `Unauthorized`     - caller is neither owner nor admin
/// * `CampaignCompleted` / `CampaignCancelled` / `CampaignExpiredError` - terminal
pub fn finalize_campaign(env: &Env, caller: &Address, campaign_id: u64) -> Result<(), Error> {
    caller.require_auth();

    let mut campaign = storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;
    require_owner_or_admin(env, caller, &campaign.owner)?;

    validate_state_transition(campaign.status, CampaignStatus::Completed)
        .map_err(|_| reject(campaign.status))?;

    let was_active = campaign.status == CampaignStatus::Active;

    campaign.status = CampaignStatus::Completed;
    campaign.updated_at = env.ledger().timestamp();
    storage::set_campaign(env, campaign_id, &campaign);

    if was_active {
        storage::decrement_active_campaign_count(env)?;
    }

    events::emit_campaign_completed(env, campaign_id, campaign.tokens_burned, campaign.spent);
    events::emit_campaign_finalized(env, campaign_id, caller);
    Ok(())
}

/// Idempotent retry of [`finalize_campaign`].
///
/// A finalization that already landed returns `Ok(())` instead of
/// `CampaignCompleted`, so a client that lost the response can retry safely
/// without first reading the campaign back. Cancelled and expired campaigns
/// still reject — those are not recoverable by retrying.
///
/// # Errors
/// * `CampaignNotFound`  - no campaign with `campaign_id`
/// * `Unauthorized`      - caller is neither owner nor admin
/// * `CampaignCancelled` / `CampaignExpiredError` - terminal, not finalizable
pub fn retry_finalize_campaign(env: &Env, caller: &Address, campaign_id: u64) -> Result<(), Error> {
    caller.require_auth();

    let campaign = storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;
    require_owner_or_admin(env, caller, &campaign.owner)?;

    if campaign.status == CampaignStatus::Completed {
        return Ok(());
    }
    if is_terminal(campaign.status) {
        return Err(reject(campaign.status));
    }

    finalize_campaign(env, caller, campaign_id)
}
