/// Optimized Event Module with Versioned Schemas
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
///
/// # Event Versioning
///
/// All events include version identifiers (e.g., "_v1") to support stable backend indexers
/// as the contract evolves. Event schemas are immutable once deployed - any changes require
/// creating a new version with an incremented version number.
///
/// ## Event Name Mapping
///
/// The following table documents the mapping between original event names and their
/// versioned counterparts. Some names are abbreviated to fit within the 10-character
/// `symbol_short!` limit.
///
/// | Original Name | Versioned Name | Character Count | Rationale                          |
/// |---------------|----------------|-----------------|-------------------------------------|
/// | init          | init_v1        | 7               | Fits within limit                   |
/// | tok_reg       | tok_rg_v1      | 9               | Removed 'e' to fit limit            |
/// | adm_xfer      | adm_xf_v1      | 9               | Removed 'er' to fit limit           |
/// | pause         | pause_v1       | 8               | Fits within limit                   |
/// | unpause       | unpaus_v1      | 9               | Removed 'e' to fit limit            |
/// | fee_upd       | fee_up_v1      | 9               | Removed 'd' to fit limit            |
/// | adm_burn      | adm_br_v1      | 9               | Removed 'urn' to fit limit          |
/// | clawback      | clwbck_v1      | 9               | Removed 'a' to fit limit            |
/// | tok_burn      | tok_br_v1      | 9               | Removed 'urn' to fit limit          |
/// | burn          | burn_v1        | 7               | Fits within limit                   |
/// | admin_burn    | adm_bn_v1      | 9               | Removed 'r' to fit limit            |
/// | batch_burn    | bch_bn_v1      | 9               | Removed 'at' and 'r' to fit limit   |
///
/// ## Schema Stability
///
/// Once an event version is deployed, its schema MUST NOT be modified:
/// - Topic structure (indexed parameters) must remain unchanged
/// - Payload structure (non-indexed data) must remain unchanged
/// - Data types for all parameters must remain unchanged
///
/// Any schema changes require creating a new version (e.g., init_v2).

use soroban_sdk::{symbol_short, Address, BytesN, Env, String, Symbol};

/// Emit initialized event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: init_v1
///
/// **Topics** (indexed):
/// - Event name: "init_v1"
///
/// **Payload** (non-indexed):
/// - admin: Address - The administrator address
/// - treasury: Address - The treasury address
/// - base_fee: i128 - Base fee amount in stroops
/// - metadata_fee: i128 - Metadata fee amount in stroops
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
///
/// Emitted when the factory is first initialized
pub fn emit_initialized(
    env: &Env,
    admin: &Address,
    treasury: &Address,
    base_fee: i128,
    metadata_fee: i128,
) {
    env.events().publish(
        (symbol_short!("init_v1"),),
        (admin, treasury, base_fee, metadata_fee),
    );
}

/// Emit token registered event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: tok_rg_v1
///
/// **Topics** (indexed):
/// - Event name: "tok_rg_v1"
/// - token_address: Address - The newly created token contract address
///
/// **Payload** (non-indexed):
/// - creator: Address - The address that created the token
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
///
/// Emitted when a new token is created and registered
pub fn emit_token_registered(env: &Env, token_address: &Address, creator: &Address) {
    env.events().publish(
        (symbol_short!("tok_rg_v1"), token_address.clone()),
        (creator,),
    );
}

/// Emit token created event with full details
///
/// **Event Name**: tok_crt
///
/// **Topics** (indexed):
/// - Event name: "tok_crt"
/// - token_address: Address - The newly created token's address
///
/// **Payload** (non-indexed):
/// - creator: Address - The token creator
/// - name: String - Token name
/// - symbol: String - Token symbol
/// - decimals: u32 - Decimal places
/// - initial_supply: i128 - Initial token supply
///
/// Emitted when a new token is created with full metadata
pub fn emit_token_created(
    env: &Env,
    token_address: &Address,
    creator: &Address,
    name: &String,
    symbol: &String,
    decimals: u32,
    initial_supply: i128,
) {
    env.events().publish(
        (symbol_short!("tok_crt"), token_address.clone()),
        (
            creator.clone(),
            name.clone(),
            symbol.clone(),
            decimals,
            initial_supply,
        ),
    );
}

/// Emitted when multiple tokens are created in a single batch.
pub fn emit_batch_tokens_created(env: &Env, creator: &Address, count: u32) {
    env.events()
        .publish((symbol_short!("bch_tkn"),), (creator.clone(), count));
}

/// Emit admin transfer event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: adm_xf_v1
///
/// **Topics** (indexed):
/// - Event name: "adm_xf_v1"
///
/// **Payload** (non-indexed):
/// - old_admin: Address - The previous administrator address
/// - new_admin: Address - The new administrator address
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
///
/// Reduces bytes from 121 to ~95 by removing redundant timestamp.
/// The ledger automatically records transaction timestamps.
pub fn emit_admin_transfer(env: &Env, old_admin: &Address, new_admin: &Address) {
    env.events()
        .publish((symbol_short!("adm_xf_v1"),), (old_admin, new_admin));
}

/// Emit admin proposed event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: adm_prop_v1
///
/// **Topics** (indexed):
/// - Event name: "adm_prop_v1"
///
/// **Payload** (non-indexed):
/// - current_admin: Address - The current admin proposing the transfer
/// - proposed_admin: Address - The proposed new admin
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_admin_proposed(env: &Env, current_admin: &Address, proposed_admin: &Address) {
    env.events()
        .publish((symbol_short!("adprp_v1"),), (current_admin, proposed_admin));
}

/// Emit pause event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: pause_v1
///
/// **Topics** (indexed):
/// - Event name: "pause_v1"
///
/// **Payload** (non-indexed):
/// - admin: Address - The administrator who paused the contract
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_pause(env: &Env, admin: &Address) {
    env.events().publish((symbol_short!("pause_v1"),), (admin,));
}

/// Emit unpause event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: unpaus_v1
///
/// **Topics** (indexed):
/// - Event name: "unpaus_v1"
///
/// **Payload** (non-indexed):
/// - admin: Address - The administrator who unpaused the contract
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_unpause(env: &Env, admin: &Address) {
    env.events()
        .publish((symbol_short!("unpaus_v1"),), (admin,));
}

/// Emit fees updated event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: fee_up_v1
///
/// **Topics** (indexed):
/// - Event name: "fee_up_v1"
///
/// **Payload** (non-indexed):
/// - base_fee: i128 - New base fee amount in stroops
/// - metadata_fee: i128 - New metadata fee amount in stroops
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_fees_updated(env: &Env, base_fee: i128, metadata_fee: i128) {
    env.events()
        .publish((symbol_short!("fee_up_v1"),), (base_fee, metadata_fee));
}

/// Emit fees updated event (v2) — includes acting admin
///
/// **Schema Version**: 2
/// **Event Name**: fee_up_v2
///
/// **Topics** (indexed):
/// - Event name: "fee_up_v2"
///
/// **Payload** (non-indexed):
/// - admin: Address - The admin who performed the fee update
/// - base_fee: i128 - New base fee amount in stroops
/// - metadata_fee: i128 - New metadata fee amount in stroops
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_fees_updated_v2(env: &Env, admin: &Address, base_fee: i128, metadata_fee: i128) {
    env.events()
        .publish((symbol_short!("fee_up_v2"),), (admin.clone(), base_fee, metadata_fee));
}

// ═══════════════════════════════════════════════════════════════════════
// Fee Update Governance Events (#1385)
// ═══════════════════════════════════════════════════════════════════════
//
// Direct admin fee updates have been removed. Fee changes must now flow
// through the governance proposal system (propose -> vote -> quorum check
// -> queue -> timelock -> execute). These events are emitted specifically
// for `ActionType::FeeChange` proposals, in addition to the generic
// proposal lifecycle events, so downstream indexers can track fee
// governance without having to decode the generic payload.

/// Emit fee update proposed event (v1)
///
/// Published when a governance proposal of type `FeeChange` is created.
///
/// **Schema Version**: 1
/// **Event Name**: fe_pr_v1
///
/// **Topics** (indexed):
/// - Event name: "fe_pr_v1"
/// - proposal_id: u64
///
/// **Payload** (non-indexed):
/// - proposer: Address - Address that created the proposal
/// - base_fee: i128 - Proposed new base fee in stroops
/// - metadata_fee: i128 - Proposed new metadata fee in stroops
/// - eta: u64 - Earliest timestamp at which the proposal may execute (post-timelock)
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_fee_update_proposed(
    env: &Env,
    proposal_id: u64,
    proposer: &Address,
    base_fee: i128,
    metadata_fee: i128,
    eta: u64,
) {
    env.events().publish(
        (symbol_short!("fe_pr_v1"), proposal_id),
        (proposer.clone(), base_fee, metadata_fee, eta),
    );
}

/// Emit fee update queued event (v1)
///
/// Published when a `FeeChange` proposal passes quorum/approval and is
/// queued into the timelock, awaiting `eta` before it can execute.
///
/// **Schema Version**: 1
/// **Event Name**: fe_qu_v1
///
/// **Topics** (indexed):
/// - Event name: "fe_qu_v1"
/// - proposal_id: u64
///
/// **Payload** (non-indexed):
/// - eta: u64 - Earliest timestamp at which the proposal may execute
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_fee_update_queued(env: &Env, proposal_id: u64, eta: u64) {
    env.events()
        .publish((symbol_short!("fe_qu_v1"), proposal_id), (eta,));
}

/// Emit fee update executed event (v1)
///
/// Published when a queued `FeeChange` proposal's timelock has elapsed and
/// the fee change has been applied to contract storage.
///
/// **Schema Version**: 1
/// **Event Name**: fe_ex_v1
///
/// **Topics** (indexed):
/// - Event name: "fe_ex_v1"
/// - proposal_id: u64
///
/// **Payload** (non-indexed):
/// - executor: Address - Address that triggered execution (the original proposer)
/// - base_fee: i128 - New base fee now in effect, in stroops
/// - metadata_fee: i128 - New metadata fee now in effect, in stroops
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_fee_update_executed(
    env: &Env,
    proposal_id: u64,
    executor: &Address,
    base_fee: i128,
    metadata_fee: i128,
) {
    env.events().publish(
        (symbol_short!("fe_ex_v1"), proposal_id),
        (executor.clone(), base_fee, metadata_fee),
    );
}

/// Emit admin burn event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: adm_br_v1
///
/// **Topics** (indexed):
/// - Event name: "adm_br_v1"
/// - token_address: Address - The token contract address
///
/// **Payload** (non-indexed):
/// - admin: Address - The administrator who initiated the burn
/// - from: Address - The address whose tokens were burned
/// - amount: i128 - The amount of tokens burned
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
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
        (symbol_short!("adm_br_v1"), token_address.clone()),
        (admin, from, amount),
    );
}

/// Emit clawback toggled event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: clwbck_v1
///
/// **Topics** (indexed):
/// - Event name: "clwbck_v1"
/// - token_address: Address - The token contract address
///
/// **Payload** (non-indexed):
/// - admin: Address - The administrator who toggled clawback
/// - enabled: bool - Whether clawback is now enabled (true) or disabled (false)
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_clawback_toggled(env: &Env, token_address: &Address, admin: &Address, enabled: bool) {
    env.events().publish(
        (symbol_short!("clwbck_v1"), token_address.clone()),
        (admin, enabled),
    );
}

/// Emit clawback audit event (v1) - #1149
///
/// **Schema Version**: 1
/// **Event Name**: clawb_au1
///
/// **Topics** (indexed):
/// - Event name: "clawb_au1"
/// - token_address: Address - The token contract address
///
/// **Payload** (non-indexed):
/// - actor: Address - The admin who performed the clawback
/// - target: Address - The address whose tokens were clawed back
/// - amount: i128 - The amount of tokens clawed back
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
///
/// Emitted when admin performs a clawback operation with full audit trail
pub fn emit_clawback_audit(
    env: &Env,
    token_address: &Address,
    actor: &Address,
    target: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("clwb_au1"), token_address.clone()),
        (actor.clone(), target.clone(), amount),
    );
}

/// Emit token burned event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: tok_br_v1
///
/// **Topics** (indexed):
/// - Event name: "tok_br_v1"
/// - token_address: Address - The token contract address
///
/// **Payload** (non-indexed):
/// - amount: i128 - The amount of tokens burned
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
///
/// Used when multiple tokens are burned in a batch operation
pub fn emit_token_burned(env: &Env, token_address: &Address, amount: i128) {
    env.events().publish(
        (symbol_short!("tok_br_v1"), token_address.clone()),
        (amount,),
    );
}

// ── Timelock events ─────────────────────────────────────────

/// Emit timelock configured event
///
/// Emitted when timelock is initialized or updated
pub fn emit_timelock_configured(env: &Env, delay_seconds: u64) {
    env.events()
        .publish((symbol_short!("tl_cfg"),), (delay_seconds,));
}

/// Emit change scheduled event
///
/// Emitted when a sensitive change is scheduled with timelock
pub fn emit_change_scheduled(
    env: &Env,
    change_id: u64,
    change_type: crate::types::ChangeType,
    execute_at: u64,
) {
    env.events().publish(
        (symbol_short!("ch_sched"), change_id),
        (change_type.clone(), execute_at),
    );
}

/// Emit change executed event
///
/// Emitted when a pending change is successfully executed
pub fn emit_change_executed(env: &Env, change_id: u64, change_type: crate::types::ChangeType) {
    env.events().publish(
        (symbol_short!("ch_exec"), change_id),
        (change_type.clone(),),
    );
}

/// Emit change cancelled event
///
/// Emitted when a pending change is cancelled before execution
pub fn emit_change_cancelled(env: &Env, change_id: u64, change_type: crate::types::ChangeType) {
    env.events().publish(
        (symbol_short!("ch_cncl"), change_id),
        (change_type.clone(),),
    );
}

/// Emit treasury updated event
///
/// Emitted when treasury address is changed
pub fn emit_treasury_updated(env: &Env, new_treasury: &Address) {
    env.events()
        .publish((symbol_short!("trs_upd"),), (new_treasury,));
}

/// Emit mint event
///
/// Emitted when tokens are minted
pub fn emit_mint(env: &Env, token_index: u32, to: &Address, amount: i128) {
    env.events()
        .publish((symbol_short!("mint"), token_index), (to, amount));
}

/// Emit a per-item success event for an isolated batch mint (#1360).
///
/// Topic `mnt_ok` corresponds to a `MintSucceeded` outcome. `index` is the
/// item's position in the input batch.
pub fn emit_mint_succeeded(
    env: &Env,
    token_index: u32,
    index: u32,
    to: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("mnt_ok"), token_index),
        (index, to, amount),
    );
}

/// Emit a per-item failure event for an isolated batch mint (#1360).
///
/// Topic `mnt_fail` corresponds to a `MintFailed` outcome. `error_code` is the
/// contract error code that caused this item to be isolated out of the batch.
pub fn emit_mint_failed(
    env: &Env,
    token_index: u32,
    index: u32,
    to: &Address,
    amount: i128,
    error_code: u32,
) {
    env.events().publish(
        (symbol_short!("mnt_fail"), token_index),
        (index, to, amount, error_code),
    );
}

// ── Treasury events ─────────────────────────────────────────

/// Emit treasury withdrawal event
///
/// Emitted when fees are withdrawn from treasury
pub fn emit_treasury_withdrawal(env: &Env, recipient: &Address, amount: i128) {
    env.events()
        .publish((symbol_short!("trs_wdrw"),), (recipient, amount));
}

/// Emit recipient added event
///
/// Emitted when an address is added to the withdrawal allowlist
pub fn emit_recipient_added(env: &Env, recipient: &Address) {
    env.events()
        .publish((symbol_short!("rec_add"),), (recipient,));
}

/// Emit recipient removed event
///
/// Emitted when an address is removed from the withdrawal allowlist
pub fn emit_recipient_removed(env: &Env, recipient: &Address) {
    env.events()
        .publish((symbol_short!("rec_rem"),), (recipient,));
}

/// Emit treasury policy updated event
///
/// Emitted when treasury withdrawal policy is changed
pub fn emit_treasury_policy_updated(env: &Env, daily_cap: i128, allowlist_enabled: bool) {
    env.events()
        .publish((symbol_short!("trs_pol"),), (daily_cap, allowlist_enabled));
}

/// Emit governance configured event
///
/// Emitted when governance parameters are initialized
pub fn emit_governance_configured(env: &Env, quorum_percent: u32, approval_percent: u32) {
    env.events().publish(
        (symbol_short!("gov_cfg"),),
        (quorum_percent, approval_percent),
    );
}

/// Emit governance updated event
///
/// Emitted when governance parameters are changed
pub fn emit_governance_updated(env: &Env, quorum_percent: u32, approval_percent: u32) {
    env.events().publish(
        (symbol_short!("gov_upd"),),
        (quorum_percent, approval_percent),
    );
}

/// Emit token paused event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: tok_paus
///
/// **Topics** (indexed):
/// - Event name: "tok_paus"
/// - token_index: u32 - The token index
///
/// **Payload** (non-indexed):
/// - admin: Address - The admin who paused the token
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
///
/// Emitted when a specific token is paused via `pause_token`
pub fn emit_token_paused(env: &Env, token_index: u32, admin: &Address) {
    env.events().publish(
        (symbol_short!("tok_paus"), token_index),
        (admin,),
    );
}

/// Emit token unpaused event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: tok_unpaus
///
/// **Topics** (indexed):
/// - Event name: "tok_unpaus"
/// - token_index: u32 - The token index
///
/// **Payload** (non-indexed):
/// - admin: Address - The admin who unpaused the token
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
///
/// Emitted when a specific token is unpaused via `unpause_token`
pub fn emit_token_unpaused(env: &Env, token_index: u32, admin: &Address) {
    env.events().publish(
        (symbol_short!("tok_unpas"), token_index),
        (admin,),
    );
}

/// Emit dynamic quorum adjusted event
///
/// **Event Name**: dyn_qrm
///
/// **Topics** (indexed):
/// - Event name: "dyn_qrm"
///
/// **Payload** (non-indexed):
/// - proposal_id: u64 - The proposal whose participation triggered the adjustment
/// - old_quorum: u32 - Previous effective quorum percent
/// - new_quorum: u32 - New effective quorum percent
/// - avg_participation_bps: u32 - Rolling average participation in basis points
///
/// Emitted when the dynamic quorum is recalculated after a proposal concludes.
pub fn emit_dynamic_quorum_adjusted(
    env: &Env,
    proposal_id: u64,
    old_quorum: u32,
    new_quorum: u32,
    avg_participation_bps: u32,
) {
    env.events().publish(
        (symbol_short!("dyn_qrm"),),
        (proposal_id, old_quorum, new_quorum, avg_participation_bps),
    );
}

/// Emit metadata set event
///
/// **Event Name**: meta_set
///
/// **Topics** (indexed):
/// - Event name: "meta_set"
/// - token_address: Address - The token address
///
/// **Payload** (non-indexed):
/// - admin: Address - The admin who set the metadata
/// - metadata_uri: String - The metadata URI
///
/// Emitted when token metadata is set
pub fn emit_metadata_set(
    env: &Env,
    token_address: &Address,
    admin: &Address,
    metadata_uri: &String,
) {
    env.events().publish(
        (symbol_short!("meta_set"), token_address.clone()),
        (admin.clone(), metadata_uri.clone()),
    );
}

/// Emit metadata updated event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: meta_upd
///
/// **Topics** (indexed):
/// - Event name: "meta_upd"
/// - token_address: Address - The token address
///
/// **Payload** (non-indexed):
/// - admin: Address - The admin who updated the metadata
/// - metadata_uri: String - The new metadata URI
/// - version: u32 - The new metadata version number
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
///
/// Emitted when token metadata is updated via `update_metadata`
pub fn emit_metadata_updated(
    env: &Env,
    token_address: &Address,
    admin: &Address,
    metadata_uri: &String,
    version: u32,
) {
    env.events().publish(
        (symbol_short!("meta_upd"), token_address.clone()),
        (admin.clone(), metadata_uri.clone(), version),
    );
}

/// Emit batch streams created event
///
/// Published when multiple streams are created in a batch
pub fn emit_batch_streams_created(env: &Env, creator: &Address, count: u32) {
    env.events()
        .publish((symbol_short!("bch_strm"),), (creator, count));
}

// ═══════════════════════════════════════════════════════════════════════
// Vault/Stream Events (v1)
// ═══════════════════════════════════════════════════════════════════════

/// Emit vault/stream created event (v1)
/// 
/// **Schema Version**: 1
/// **Event Name**: vlt_cr_v1
/// 
/// **Topics** (indexed):
/// - Event name: "vlt_cr_v1"
/// - stream_id: u32 - The unique identifier for the created stream
/// 
/// **Payload** (non-indexed):
/// - creator: Address - The address that created the stream
/// - recipient: Address - The address that will receive the vested tokens
/// - amount: i128 - Total amount of tokens to be vested
/// - has_metadata: bool - Whether metadata was provided
/// 
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
/// 
/// Emitted when a new vesting stream is created
pub fn emit_stream_created(
    env: &Env,
    stream_id: u32,
    creator: &Address,
    recipient: &Address,
    amount: i128,
    has_metadata: bool,
) {
    env.events().publish(
        (symbol_short!("vlt_cr_v1"), stream_id),
        (creator, recipient, amount, has_metadata),
    );
}

/// Emit vault/stream funded event (v1)
/// 
/// **Schema Version**: 1
/// **Event Name**: vlt_fd_v1
/// 
/// **Topics** (indexed):
/// - Event name: "vlt_fd_v1"
/// - stream_id: u32 - The stream identifier
/// 
/// **Payload** (non-indexed):
/// - funder: Address - The address that funded the stream
/// - amount: i128 - Amount of tokens funded
/// 
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
/// 
/// Emitted when a stream is funded with tokens
pub fn emit_stream_funded(
    env: &Env,
    stream_id: u32,
    funder: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("vlt_fd_v1"), stream_id),
        (funder, amount),
    );
}

/// Emit vault/stream claimed event (v1)
/// 
/// **Schema Version**: 1
/// **Event Name**: vlt_cl_v1
/// 
/// **Topics** (indexed):
/// - Event name: "vlt_cl_v1"
/// - stream_id: u32 - The stream identifier
/// 
/// **Payload** (non-indexed):
/// - recipient: Address - The address that claimed tokens
/// - amount: i128 - Amount of tokens claimed
/// 
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
/// 
/// Emitted when tokens are claimed from a stream
pub fn emit_stream_claimed(
    env: &Env,
    stream_id: u32,
    recipient: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("vlt_cl_v1"), stream_id),
        (recipient, amount),
    );
}

/// Emit vault/stream cancelled event (v1)
/// 
/// **Schema Version**: 1
/// **Event Name**: vlt_cn_v1
/// 
/// **Topics** (indexed):
/// - Event name: "vlt_cn_v1"
/// - stream_id: u32 - The stream identifier
/// 
/// **Payload** (non-indexed):
/// - canceller: Address - The address that cancelled the stream
/// - remaining_amount: i128 - Amount of unvested tokens returned
/// 
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
/// 
/// Emitted when a stream is cancelled before completion
pub fn emit_stream_cancelled(
    env: &Env,
    stream_id: u32,
    canceller: &Address,
    remaining_amount: i128,
) {
    env.events().publish(
        (symbol_short!("vlt_cn_v1"), stream_id),
        (canceller, remaining_amount),
    );
}

/// Emit stream cancelled with settlement event
///
/// Emitted when a stream is cancelled and the vested portion is settled to the recipient.
pub fn emit_stream_cancelled_with_settlement(
    env: &Env,
    stream_id: u32,
    canceller: &Address,
    vested_to_recipient: i128,
    unvested_to_creator: i128,
) {
    env.events().publish(
        (symbol_short!("strm_cxs"), stream_id),
        (canceller, vested_to_recipient, unvested_to_creator),
    );
}

/// Emit stream dispute raised event
pub fn emit_stream_dispute_raised(env: &Env, stream_id: u32, caller: &Address) {
    env.events().publish(
        (symbol_short!("strm_disp"), stream_id),
        (caller,),
    );
}

/// Emit stream dispute resolved event
pub fn emit_stream_dispute_resolved(env: &Env, stream_id: u32, admin: &Address) {
    env.events().publish(
        (symbol_short!("strm_rslv"), stream_id),
        (admin,),
    );
}

/// Emit stream metadata updated event (v1)
/// 
/// **Schema Version**: 1
/// **Event Name**: vlt_md_v1
/// 
/// **Topics** (indexed):
/// - Event name: "vlt_md_v1"
/// - stream_id: u32 - The stream identifier
/// 
/// **Payload** (non-indexed):
/// - updater: Address - The address that updated the metadata
/// - has_metadata: bool - Whether metadata is now present
/// 
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
/// 
/// Emitted when stream metadata is updated
pub fn emit_stream_metadata_updated(
    env: &Env,
    stream_id: u32,
    updater: &Address,
    has_metadata: bool,
) {
    env.events().publish(
        (symbol_short!("vlt_md_v1"), stream_id),
        (updater, has_metadata),
    );
}

// ═══════════════════════════════════════════════════════════════════════
// Recurring Stream Events (Issue #1765)
// ═══════════════════════════════════════════════════════════════════════

/// Emit recurring stream created event.
///
/// Topics: ("rstrm_cr", recurring_stream_id). Payload: (creator, recipient,
/// amount_per_period, first_child_stream_id).
pub fn emit_recurring_stream_created(
    env: &Env,
    recurring_stream_id: u64,
    creator: &Address,
    recipient: &Address,
    amount_per_period: i128,
    first_child_stream_id: u64,
) {
    env.events().publish(
        (symbol_short!("rstrm_cr"), recurring_stream_id),
        (creator, recipient, amount_per_period, first_child_stream_id),
    );
}

/// Emit recurring stream period-triggered event (a new child stream was created).
///
/// Topics: ("rstrm_trg", recurring_stream_id). Payload: (child_stream_id, period_index).
pub fn emit_recurring_period_triggered(
    env: &Env,
    recurring_stream_id: u64,
    child_stream_id: u64,
    period_index: u32,
) {
    env.events().publish(
        (symbol_short!("rstrm_trg"), recurring_stream_id),
        (child_stream_id, period_index),
    );
}

/// Emit recurring stream cancelled event.
///
/// Topics: ("rstrm_cxl", recurring_stream_id). Payload: (canceller,).
pub fn emit_recurring_stream_cancelled(env: &Env, recurring_stream_id: u64, canceller: &Address) {
    env.events().publish(
        (symbol_short!("rstrm_cxl"), recurring_stream_id),
        (canceller.clone(),),
    );
}

// ═══════════════════════════════════════════════════════════════════════
// Proposal/Governance Events
// ═══════════════════════════════════════════════════════════════════════

/// Emit proposal created event
///
/// Published when a new governance proposal is created
pub fn emit_proposal_created(
    env: &Env,
    proposal_id: u64,
    proposer: &Address,
    action_type: &crate::types::ActionType,
    start_time: u64,
    end_time: u64,
    eta: u64,
) {
    env.events().publish(
        (symbol_short!("prop_cr"), proposal_id),
        (proposer, action_type.clone(), start_time, end_time, eta),
    );
}

/// Emit proposal voted event
///
/// Published when a vote is cast on a proposal
pub fn emit_proposal_voted(
    env: &Env,
    proposal_id: u64,
    voter: &Address,
    support: crate::types::VoteChoice,
) {
    env.events().publish(
        (symbol_short!("prop_vote"), proposal_id),
        (voter, support),
    );
}

/// Emit proposal queued event
///
/// Published when a proposal is queued for execution
pub fn emit_proposal_queued(
    env: &Env,
    proposal_id: u64,
    eta: u64,
) {
    env.events().publish(
        (symbol_short!("prop_que"), proposal_id),
        (eta,),
    );
}

/// Emit proposal executed event
///
/// Published when a proposal is executed
pub fn emit_proposal_executed(
    env: &Env,
    proposal_id: u64,
    executor: &Address,
    success: bool,
) {
    env.events().publish(
        (symbol_short!("prop_exec"), proposal_id),
        (executor, success),
    );
}

/// Emit proposal executable event
///
/// Published when a proposal's timelock delay has elapsed and it is ready to execute.
/// Topics: ("prp_rdy1", proposal_id). Payload: (eta,).
pub fn emit_proposal_executable(env: &Env, proposal_id: u64, eta: u64) {
    env.events().publish(
        (symbol_short!("prp_rdy1"), proposal_id),
        (eta,),
    );
}

/// Emit proposal cancelled event
pub fn emit_proposal_cancelled(env: &Env, proposal_id: u64, cancelled_by: &Address) {
    env.events().publish(
        (symbol_short!("prop_cncl"), proposal_id),
        (cancelled_by,),
    );
}

/// Emit a governance proposal state snapshot event (#1383).
///
/// Published periodically (every `SNAPSHOT_INTERVAL_LEDGERS` ledgers, see
/// `governance::SNAPSHOT_INTERVAL_LEDGERS`) for every active proposal, and on
/// demand via the `snapshot_proposals` entry point. Off-chain indexers can
/// use these snapshots as checkpoints: instead of replaying every event from
/// genesis, a consumer can start from the most recent snapshot for a
/// proposal and only replay events emitted after it, while still arriving at
/// state that is fully consistent with the accumulated event stream.
///
/// **Schema Version**: 1
/// **Event Name**: prop_snap
///
/// **Topics** (indexed):
/// - Event name: "prop_snap"
/// - proposal_id: u64 - The proposal this snapshot describes
///
/// **Payload** (non-indexed):
/// - status: ProposalState - The proposal's state at snapshot time
/// - yes_votes: i128 - Accumulated "for" votes at snapshot time
/// - no_votes: i128 - Accumulated "against" votes at snapshot time
/// - quorum_required: i128 - The vote weight required to meet quorum at snapshot time
/// - ledger: u32 - The ledger sequence at which the snapshot was taken
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_proposal_state_snapshot(
    env: &Env,
    proposal_id: u64,
    status: crate::types::ProposalState,
    yes_votes: i128,
    no_votes: i128,
    quorum_required: i128,
    ledger: u32,
) {
    env.events().publish(
        (symbol_short!("prop_snap"), proposal_id),
        (status, yes_votes, no_votes, quorum_required, ledger),
    );
}

/// Emit queue entry added event
///
/// Published when a proposal is added to the priority execution queue.
pub fn emit_queue_entry_added(
    env: &Env,
    proposal_id: u64,
    priority: crate::types::ProposalPriority,
    eta: u64,
) {
    env.events().publish(
        (symbol_short!("q_add"), proposal_id),
        (priority as u32, eta),
    );
}

/// Emit queue entry removed event
///
/// Published when a proposal is dequeued (executed or cancelled).
pub fn emit_queue_entry_removed(
    env: &Env,
    proposal_id: u64,
    priority: crate::types::ProposalPriority,
) {
    env.events().publish(
        (symbol_short!("q_rem"), proposal_id),
        (priority as u32,),
    );
}

/// Emit a per-type FIFO queue entry-added event (#1366).
///
/// Published when a proposal is appended to its action-type FIFO execution
/// queue. Topics: ("tq_add", proposal_id). Payload: (action_type, position).
pub fn emit_type_queue_entry_added(
    env: &Env,
    proposal_id: u64,
    action_type: crate::types::ActionType,
    position: u32,
) {
    env.events().publish(
        (symbol_short!("tq_add"), proposal_id),
        (action_type, position),
    );
}

/// Emit a per-type FIFO queue entry-removed event (#1366).
///
/// Published when a proposal is removed from its action-type FIFO queue,
/// either because it executed or was cancelled.
/// Topics: ("tq_rem", proposal_id). Payload: (action_type,).
pub fn emit_type_queue_entry_removed(
    env: &Env,
    proposal_id: u64,
    action_type: crate::types::ActionType,
) {
    env.events().publish(
        (symbol_short!("tq_rem"), proposal_id),
        (action_type,),
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
/// - context: i128 - Additional context (e.g. token index, amount)
/// 
/// Emitted when a high-value data path fails to provide structured diagnostic data.
pub fn emit_error_detail(env: &Env, error_code: u32, context: i128) {
    env.events().publish(
        (symbol_short!("err_det"), error_code),
        (context,),
    );
}

/// Emit vault created event
///
/// Published when a new vault allocation is created
pub fn emit_vault_created(
    env: &Env,
    vault_id: u64,
    creator: &Address,
    owner: &Address,
    token: &Address,
    amount: i128,
    unlock_time: u64,
    milestone_hash: &soroban_sdk::BytesN<32>,
) {
    env.events().publish(
        (symbol_short!("vlt_crt"), vault_id),
        (
            creator.clone(),
            owner.clone(),
            token.clone(),
            amount,
            unlock_time,
            milestone_hash.clone(),
        ),
    );
}

/// Emit vault claimed event
///
/// Published when a vault is successfully claimed.
pub fn emit_vault_claimed(env: &Env, vault_id: u64, owner: &Address, amount: i128) {
    env.events().publish(
        (symbol_short!("vlt_clm"), vault_id),
        (owner.clone(), amount),
    );
}

/// Emit vault cancelled event
///
/// Published when a vault is cancelled.
pub fn emit_vault_cancelled(env: &Env, vault_id: u64, actor: &Address, remaining_amount: i128) {
    env.events().publish(
        (symbol_short!("vlt_cnl"), vault_id),
        (actor.clone(), remaining_amount),
    );
}

/// Emit a structured `OperationFailed` event for a rejected vault operation (#1384).
///
/// **Event Name**: vlt_fail
///
/// **Topics** (indexed):
/// - Event name: "vlt_fail"
/// - vault_id: u64 - The vault the failed operation targeted (`u64::MAX` if the
///   vault id was not yet known, e.g. on `create_vault` failures before a vault
///   is allocated).
///
/// **Payload** (non-indexed):
/// - error_code: u32 - The numeric `Error` discriminant returned to the caller.
///   This is the same code surfaced as the Wasm ABI contract error; Soroban's
///   on-chain error return path only supports a flat `u32`, so this event is
///   the mechanism by which richer diagnostic context travels off-chain.
/// - error_name: Symbol - Stable string representation of the error variant
///   (see `Error::name()`). Indexers should key off this name rather than the
///   numeric code where possible, since the name is documented to remain
///   stable for a given variant.
/// - amount: i128 - The amount affected by the failed operation (e.g. the
///   claim/fund/transfer amount). `0` when the operation has no associated
///   amount (e.g. milestone verification).
/// - condition: Symbol - Short machine-readable description of the specific
///   failing condition (e.g. "cliff_not_met", "not_owner"), distinct from the
///   error name so indexers can disambiguate the many call sites that share a
///   generic error code (e.g. `InvalidParameters`) by operation semantics.
///
/// **Schema Stability**: This schema is immutable once deployed. Any change
/// requires a new versioned event (e.g. `vlt_fail_v2`).
///
/// Emitted immediately before every vault entry point (`create_vault`,
/// `claim_vault`, `cancel_vault`, `verify_milestone`,
/// `propose_vault_owner_change`, `approve_vault_owner_change`) returns an
/// error, so off-chain indexers such as `vaultEventParser.ts` can build
/// rich, typed error messages without hardcoding numeric-to-meaning mappings.
pub fn emit_operation_failed(
    env: &Env,
    vault_id: u64,
    error: crate::types::Error,
    amount: i128,
    condition: &str,
) {
    let error_name = soroban_sdk::Symbol::new(env, error.name());
    let condition_sym = soroban_sdk::Symbol::new(env, condition);
    env.events().publish(
        (symbol_short!("vlt_fail"), vault_id),
        (error.0, error_name, amount, condition_sym),
    );
}

/// Emit campaign created event
///
/// **Event Name**: cmp_crt
///
/// **Topics** (indexed):
/// - Event name: "cmp_crt"
/// - campaign_id: u64 - The campaign identifier
///
/// **Payload** (non-indexed):
/// - owner: Address - Campaign owner
/// - token_index: u32 - Token being bought back
/// - budget_allocated: i128 - Total budget in stroops
///
/// Emitted when a new buyback campaign is created
pub fn emit_campaign_created(
    env: &Env,
    campaign_id: u64,
    owner: &Address,
    token_index: u32,
    budget_allocated: i128,
) {
    env.events().publish(
        (symbol_short!("cmp_crt"), campaign_id),
        (owner, token_index, budget_allocated),
    );
}

/// Emit campaign paused event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: cmp_ps_v1
///
/// **Topics** (indexed):
/// - Event name: "cmp_ps_v1"
/// - campaign_id: u64 - The campaign identifier
///
/// **Payload** (non-indexed):
/// - paused_by: Address - Address that paused the campaign
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
///
/// Emitted when a campaign is paused
pub fn emit_campaign_paused(env: &Env, campaign_id: u64, paused_by: &Address) {
    env.events().publish(
        (symbol_short!("cmp_ps_v1"), campaign_id),
        (paused_by,),
    );
}

/// Emit campaign resumed event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: cmp_rs_v1
///
/// **Topics** (indexed):
/// - Event name: "cmp_rs_v1"
/// - campaign_id: u64 - The campaign identifier
///
/// **Payload** (non-indexed):
/// - resumed_by: Address - Address that resumed the campaign
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
///
/// Emitted when a campaign is resumed from paused state
pub fn emit_campaign_resumed(env: &Env, campaign_id: u64, resumed_by: &Address) {
    env.events().publish(
        (symbol_short!("cmp_rs_v1"), campaign_id),
        (resumed_by,),
    );
}

/// Emit campaign completed event
///
/// **Event Name**: cmp_cmp
///
/// **Topics** (indexed):
/// - Event name: "cmp_cmp"
/// - campaign_id: u64 - The campaign identifier
///
/// **Payload** (non-indexed):
/// - tokens_burned: i128 - Total tokens burned
/// - budget_spent: i128 - Total budget spent
///
/// Emitted when a campaign completes successfully
pub fn emit_campaign_completed(env: &Env, campaign_id: u64, tokens_burned: i128, budget_spent: i128) {
    env.events().publish(
        (symbol_short!("cmp_cmp"), campaign_id),
        (tokens_burned, budget_spent),
    );
}

/// Emit campaign finalized event (admin/owner-triggered finalization)
pub fn emit_campaign_finalized(env: &Env, campaign_id: u64, caller: &Address) {
    env.events().publish(
        (symbol_short!("cmp_fin"), campaign_id),
        (caller,),
    );
}

/// Emit campaign cancelled event
///
/// **Event Name**: cmp_cnl
///
/// **Topics** (indexed):
/// - Event name: "cmp_cnl"
/// - campaign_id: u64 - The campaign identifier
///
/// **Payload** (non-indexed):
/// - cancelled_by: Address - Address that cancelled the campaign
/// - budget_remaining: i128 - Unspent budget returned
///
/// Emitted when a campaign is cancelled
pub fn emit_campaign_cancelled(
    env: &Env,
    campaign_id: u64,
    cancelled_by: &Address,
    budget_remaining: i128,
) {
    env.events().publish(
        (symbol_short!("cmp_cnl"), campaign_id),
        (cancelled_by, budget_remaining),
    );
}

/// Emit buyback step settled event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: bb_stp_v1
///
/// **Topics** (indexed):
/// - Event name: "bb_stp_v1"
/// - campaign_id: u64 - The campaign identifier
///
/// **Payload** (non-indexed):
/// - executor: Address   - Address that executed the step
/// - spent: i128         - Budget spent on this step, in stroops
/// - bought: i128        - Target tokens acquired by the swap
/// - burned: i128        - Target tokens actually burned
/// - step_number: u32    - 1-based index of this step within the campaign
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
///
/// Emitted once per successful `execute_buyback_step` call, after the campaign
/// record has been committed. `bought` and `burned` are reported separately so
/// off-chain consumers can detect a burn shortfall without re-deriving it.
pub fn emit_buyback_step_settled(
    env: &Env,
    campaign_id: u64,
    executor: &Address,
    spent: i128,
    bought: i128,
    burned: i128,
    step_number: u32,
) {
    env.events().publish(
        (symbol_short!("bb_stp_v1"), campaign_id),
        (executor, spent, bought, burned, step_number),
    );
}
/// Emit asset fractionalized event
pub fn emit_asset_fractionalized(
    env: &Env,
    vault_id: u64,
    asset_id: &BytesN<32>,
    asset_contract: &Address,
    owner: &Address,
    fractional_token: &Address,
    total_supply: i128,
) {
    let topics = (
        symbol_short!("frac_v1"),
        vault_id,
        asset_id.clone(),
        owner.clone(),
    );
    
    let data = (
        asset_contract.clone(),
        fractional_token.clone(),
        total_supply,
    );
    
    env.events().publish(topics, data);
}

/// Emit asset redeemed event
pub fn emit_asset_redeemed(
    env: &Env,
    vault_id: u64,
    asset_id: &BytesN<32>,
    asset_contract: &Address,
    redeemer: &Address,
    total_supply: i128,
) {
    let topics = (
        symbol_short!("redeem_v1"),
        vault_id,
        asset_id.clone(),
        redeemer.clone(),
    );
    
    let data = (
        asset_contract.clone(),
        total_supply,
    );
    
    env.events().publish(topics, data);
}

/// Emit batch settle (batch mint) event.
///
/// Published when `batch_settle` successfully mints tokens to multiple recipients.
pub fn emit_batch_settle(
    env: &Env,
    token_index: u32,
    creator: &Address,
    recipient_count: u32,
    total_minted: i128,
) {
    env.events().publish(
        (symbol_short!("bch_stl"),),
        (token_index, creator, recipient_count, total_minted),
    );
}

/// Emit deployment recorded event.
pub fn emit_deployment_recorded(
    env: &Env,
    history_index: u64,
    token_index: u32,
    creator: &Address,
) {
    env.events().publish(
        (symbol_short!("dep_rec"),),
        (history_index, token_index, creator),
    );
}

/// Emit history pruned event.
pub fn emit_history_pruned(env: &Env, admin: &Address, before_index: u64, pruned: u32) {
    env.events()
        .publish((symbol_short!("hist_prn"),), (admin, before_index, pruned));
}

/// Emit referral registered event.
pub fn emit_referral_registered(env: &Env, referee: &Address, referrer: &Address) {
    env.events()
        .publish((symbol_short!("ref_reg"),), (referee, referrer));
}

/// Emit referral commission paid event.
pub fn emit_commission_paid(env: &Env, referrer: &Address, token_index: u32, amount: i128) {
    env.events()
        .publish((symbol_short!("com_paid"),), (referrer, token_index, amount));
}

/// Emit role granted event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: role_gr1
///
/// **Topics** (indexed):
/// - Event name: "role_gr1"
/// - token_index: u32 - The token this role applies to
///
/// **Payload** (non-indexed):
/// - creator: Address - The token creator granting the role
/// - grantee: Address - The address receiving the role
/// - role: Role - The role being granted
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_role_granted(
    env: &Env,
    token_index: u32,
    creator: &Address,
    grantee: &Address,
    role: crate::types::Role,
) {
    env.events().publish(
        (symbol_short!("role_gr1"), token_index),
        (creator.clone(), grantee.clone(), role),
    );
}

/// Emit role revoked event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: role_rv1
///
/// **Topics** (indexed):
/// - Event name: "role_rv1"
/// - token_index: u32 - The token this role applies to
///
/// **Payload** (non-indexed):
/// - creator: Address - The token creator revoking the role
/// - revokee: Address - The address losing the role
/// - role: Role - The role being revoked
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_role_revoked(
    env: &Env,
    token_index: u32,
    creator: &Address,
    revokee: &Address,
    role: crate::types::Role,
) {
    env.events().publish(
        (symbol_short!("role_rv1"), token_index),
        (creator.clone(), revokee.clone(), role),
    );
}

/// Emit commission rate updated event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: com_rt_v1
///
/// **Topics** (indexed):
/// - Event name: "com_rt_v1"
///
/// **Payload** (non-indexed):
/// - admin: Address - The admin who updated the rate
/// - rate_bps: u32 - New commission rate in basis points
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_commission_rate_updated(env: &Env, admin: &Address, rate_bps: u32) {
    env.events()
        .publish((symbol_short!("com_rt_v1"),), (admin.clone(), rate_bps));
}

/// Emit treasury policy initialized event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: trs_ini1
///
/// **Topics** (indexed):
/// - Event name: "trs_ini1"
///
/// **Payload** (non-indexed):
/// - daily_cap: i128 - The daily withdrawal cap in stroops
/// - allowlist_enabled: bool - Whether the allowlist is active
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_treasury_policy_initialized(env: &Env, daily_cap: i128, allowlist_enabled: bool) {
    env.events()
        .publish((symbol_short!("trs_ini1"),), (daily_cap, allowlist_enabled));
}

/// Emit dynamic quorum configured event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: dq_cfg_v1
///
/// **Topics** (indexed):
/// - Event name: "dq_cfg_v1"
///
/// **Payload** (non-indexed):
/// - admin: Address - The admin who configured dynamic quorum
/// - enabled: bool - Whether dynamic quorum is enabled
/// - min_quorum_percent: u32 - Minimum quorum floor
/// - max_quorum_percent: u32 - Maximum quorum ceiling
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_dynamic_quorum_configured(
    env: &Env,
    admin: &Address,
    enabled: bool,
    min_quorum_percent: u32,
    max_quorum_percent: u32,
) {
    env.events().publish(
        (symbol_short!("dq_cfg_v1"),),
        (admin.clone(), enabled, min_quorum_percent, max_quorum_percent),
    );
}

/// Emit admin transfer cancelled event
pub fn emit_admin_cancelled(env: &Env, admin: &Address, cancelled_pending: &Address) {
    env.events()
        .publish((symbol_short!("adm_cxl"),), (admin.clone(), cancelled_pending.clone()));
}

/// Emit AdminTransferProposed event (two-step transfer - step 1)
///
/// **Schema Version**: 1
/// **Event Name**: adm_prp1
///
/// **Topics** (indexed):
/// - Event name: "adm_prp1"
///
/// **Payload** (non-indexed):
/// - current_admin: Address - The admin proposing the transfer
/// - new_admin: Address - The proposed new admin
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_admin_transfer_proposed(env: &Env, current_admin: &Address, new_admin: &Address) {
    env.events()
        .publish((symbol_short!("adm_prp1"),), (current_admin.clone(), new_admin.clone()));
}

/// Emit AdminTransferAccepted event (two-step transfer - step 2)
///
/// **Schema Version**: 1
/// **Event Name**: adm_acc1
///
/// **Topics** (indexed):
/// - Event name: "adm_acc1"
///
/// **Payload** (non-indexed):
/// - old_admin: Address - The previous admin
/// - new_admin: Address - The new admin who accepted
///
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
pub fn emit_admin_transfer_accepted(env: &Env, old_admin: &Address, new_admin: &Address) {
    env.events()
        .publish((symbol_short!("adm_acc1"),), (old_admin.clone(), new_admin.clone()));
}

/// Emit trusted caller registered event
pub fn emit_trusted_caller_added(env: &Env, admin: &Address, caller: &Address) {
    env.events()
        .publish((symbol_short!("tc_add"),), (admin.clone(), caller.clone()));
}

/// Emit trusted caller revoked event
pub fn emit_trusted_caller_removed(env: &Env, admin: &Address, caller: &Address) {
    env.events()
        .publish((symbol_short!("tc_rem"),), (admin.clone(), caller.clone()));
}

/// Emit authorized cross-contract call event
pub fn emit_cross_contract_call(env: &Env, caller: &Address) {
    env.events()
        .publish((symbol_short!("cc_auth"),), (caller.clone(),));
}

// ── Issue #1131: Metadata content hash events ─────────────────────────────

/// Emitted when a metadata content hash is stored alongside the URI.
pub fn emit_metadata_hash_set(
    env: &Env,
    token_index: u32,
    admin: &soroban_sdk::Address,
    content_hash: &soroban_sdk::BytesN<32>,
) {
    env.events().publish(
        (soroban_sdk::symbol_short!("meta_hash"), token_index),
        (admin.clone(), content_hash.clone()),
    );
}

// ── Issue #1133: Milestone verification events ────────────────────────────

/// Emitted when a milestone is verified by an authorized verifier.
pub fn emit_milestone_verified(
    env: &Env,
    vault_id: u64,
    verifier: &soroban_sdk::Address,
) {
    env.events().publish(
        (soroban_sdk::symbol_short!("ms_vrfd"), vault_id),
        (verifier.clone(),),
    );
}

// ── Issue #1134: Vault owner change events ────────────────────────────────

/// Emitted when a vault-owner change is proposed.
pub fn emit_vault_owner_change_proposed(
    env: &Env,
    vault_id: u64,
    proposer: &soroban_sdk::Address,
    new_owner: &soroban_sdk::Address,
) {
    env.events().publish(
        (soroban_sdk::symbol_short!("vlt_chg"), vault_id),
        (proposer.clone(), new_owner.clone()),
    );
}

/// Emitted when a vault-owner change is approved by one party.
pub fn emit_vault_owner_change_approved(
    env: &Env,
    vault_id: u64,
    approver: &soroban_sdk::Address,
) {
    env.events().publish(
        (soroban_sdk::symbol_short!("vlt_apr"), vault_id),
        (approver.clone(),),
    );
}

/// Emitted when a vault-owner change is executed (both parties approved).
pub fn emit_vault_owner_changed(
    env: &Env,
    vault_id: u64,
    old_owner: &soroban_sdk::Address,
    new_owner: &soroban_sdk::Address,
) {
    env.events().publish(
        (soroban_sdk::symbol_short!("vlt_own"), vault_id),
        (old_owner.clone(), new_owner.clone()),
    );
}

// ── Pull-model dividend distribution events (#1148) ───────────────────────

/// Emitted when a new distribution round is initiated.
///
/// **Schema Version**: 1
/// **Event Name**: div_ini1
///
/// **Topics** (indexed):
/// - distribution_id: u32
///
/// **Payload**:
/// - admin: Address
/// - token_index: u32
/// - asset: Address
/// - total_amount: i128
/// - snapshot_ledger: u32
/// - claim_deadline_ledger: u32
pub fn emit_distribution_initiated(
    env: &Env,
    distribution_id: u32,
    admin: &Address,
    token_index: u32,
    asset: &Address,
    total_amount: i128,
    snapshot_ledger: u32,
    claim_deadline_ledger: u32,
) {
    env.events().publish(
        (symbol_short!("div_ini1"), distribution_id),
        (admin, token_index, asset, total_amount, snapshot_ledger, claim_deadline_ledger),
    );
}

/// Emitted when a holder claims their dividend share.
///
/// **Schema Version**: 1
/// **Event Name**: div_clm1
///
/// **Topics** (indexed):
/// - distribution_id: u32
///
/// **Payload**:
/// - holder: Address
/// - amount: i128
pub fn emit_dividend_claimed(
    env: &Env,
    distribution_id: u32,
    holder: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("div_clm1"), distribution_id),
        (holder, amount),
    );
}

/// Emitted when the admin reclaims unclaimed dividends after the window closes.
///
/// **Schema Version**: 1
/// **Event Name**: div_rcl1
///
/// **Topics** (indexed):
/// - distribution_id: u32
///
/// **Payload**:
/// - admin: Address
/// - reclaimed_amount: i128
pub fn emit_dividend_reclaimed(
    env: &Env,
    distribution_id: u32,
    admin: &Address,
    reclaimed_amount: i128,
) {
    env.events().publish(
        (symbol_short!("div_rcl1"), distribution_id),
        (admin, reclaimed_amount),
    );
}

/// Emitted when the cross-contract multisig signer set/threshold is configured.
///
/// **Schema Version**: 1
/// **Event Name**: ms_cfg_v1
pub fn emit_multisig_configured(env: &Env, admin: &Address, threshold: u32, signer_count: u32) {
    env.events().publish(
        (symbol_short!("ms_cfg_v1"),),
        (admin, threshold, signer_count),
    );
}

/// Emitted when a new multisig proposal is created.
///
/// **Schema Version**: 1
/// **Event Name**: ms_prp_v1
pub fn emit_multisig_proposed(env: &Env, proposal_id: u64, proposer: &Address) {
    env.events()
        .publish((symbol_short!("ms_prp_v1"), proposal_id), (proposer,));
}

/// Emitted when a signer approves a multisig proposal.
///
/// **Schema Version**: 1
/// **Event Name**: ms_apr_v1
pub fn emit_multisig_approved(
    env: &Env,
    proposal_id: u64,
    approver: &Address,
    approval_count: u32,
) {
    env.events().publish(
        (symbol_short!("ms_apr_v1"), proposal_id),
        (approver, approval_count),
    );
}

/// Emitted when a multisig proposal is cancelled.
///
/// **Schema Version**: 1
/// **Event Name**: ms_cnl_v1
pub fn emit_multisig_cancelled(env: &Env, proposal_id: u64, canceller: &Address) {
    env.events()
        .publish((symbol_short!("ms_cnl_v1"), proposal_id), (canceller,));
}

/// Emitted when a multisig proposal is executed.
///
/// **Schema Version**: 1
/// **Event Name**: ms_exe_v1
pub fn emit_multisig_executed(env: &Env, proposal_id: u64, executor: &Address) {
    env.events()
        .publish((symbol_short!("ms_exe_v1"), proposal_id), (executor,));
}

// ── Gas-bounded batch scheduler (#1625) ─────────────────────────────────────

/// Emitted when a scheduled batch is split by the gas-bounded scheduler: a
/// chunk of `executed_count` items committed now, `remaining_count` deferred
/// to a continuation the tenant can resume on a later ledger.
///
/// **Schema Version**: 1
/// **Event Name**: bch_sch1
pub fn emit_batch_scheduled(env: &Env, tenant: &Address, executed_count: u32, remaining_count: u32) {
    env.events().publish(
        (symbol_short!("bch_sch1"), tenant.clone()),
        (executed_count, remaining_count),
    );
}

/// Emitted when a batch continuation finishes draining (its last chunk committed).
///
/// **Schema Version**: 1
/// **Event Name**: bch_don1
pub fn emit_batch_continuation_completed(env: &Env, tenant: &Address) {
    let ledger = env.ledger().sequence();
    env.events()
        .publish((symbol_short!("bch_don1"), tenant.clone()), (ledger,));
}

// ── Cross-contract atomic settlement (#1624) ────────────────────────────────

/// Emitted when a reservation is created by `prepare_settlement`.
///
/// **Schema Version**: 1
/// **Event Name**: stl_prep1
pub fn emit_settlement_prepared(
    env: &Env,
    reservation_id: u64,
    proposal_id: u64,
    token_index: u32,
    recipient: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("stl_prep1"), reservation_id),
        (proposal_id, token_index, recipient.clone(), amount),
    );
}

/// Emitted when a reservation is finalized (minted) by `commit_settlement`.
///
/// **Schema Version**: 1
/// **Event Name**: stl_cmt1
pub fn emit_settlement_committed(env: &Env, reservation_id: u64, proposal_id: u64) {
    env.events()
        .publish((symbol_short!("stl_cmt1"), reservation_id), (proposal_id,));
}

/// Emitted when a reservation is released without minting — via an explicit
/// `abort_settlement` call (`reason_code == 0`) or because
/// `commit_settlement` itself failed (`reason_code` is the mint error code).
///
/// **Schema Version**: 1
/// **Event Name**: stl_abrt1
pub fn emit_settlement_aborted(env: &Env, reservation_id: u64, proposal_id: u64, reason_code: u32) {
    env.events().publish(
        (symbol_short!("stl_abrt1"), reservation_id),
        (proposal_id, reason_code),
    );
}

/// Emitted when a stuck (never committed or aborted) reservation is
/// force-released by `cleanup_stuck_reservation` after its timeout window.
///
/// **Schema Version**: 1
/// **Event Name**: stl_tmo1
pub fn emit_settlement_timeout_cleanup(env: &Env, reservation_id: u64, proposal_id: u64) {
    env.events()
        .publish((symbol_short!("stl_tmo1"), reservation_id), (proposal_id,));
}

// ── Staking (#1757) ──────────────────────────────────────────────────────

/// Emitted when a new staking pool is created.
///
/// **Schema Version**: 1
/// **Event Name**: stk_crt1
pub fn emit_staking_pool_created(
    env: &Env,
    pool_id: u64,
    token_index: u32,
    reward_token_index: u32,
    reward_rate: i128,
) {
    env.events().publish(
        (symbol_short!("stk_crt1"), pool_id),
        (token_index, reward_token_index, reward_rate),
    );
}

/// Emitted when a user stakes into a pool.
///
/// **Schema Version**: 1
/// **Event Name**: stk_dep1
pub fn emit_staked(env: &Env, pool_id: u64, user: &Address, amount: i128) {
    env.events()
        .publish((symbol_short!("stk_dep1"), pool_id), (user.clone(), amount));
}

/// Emitted when a user unstakes from a pool.
///
/// **Schema Version**: 1
/// **Event Name**: stk_wd1
pub fn emit_unstaked(env: &Env, pool_id: u64, user: &Address, amount: i128) {
    env.events()
        .publish((symbol_short!("stk_wd1"), pool_id), (user.clone(), amount));
}

/// Emitted when a user claims accrued staking rewards.
///
/// **Schema Version**: 1
/// **Event Name**: stk_clm1
pub fn emit_reward_claimed(env: &Env, pool_id: u64, user: &Address, amount: i128) {
    env.events()
        .publish((symbol_short!("stk_clm1"), pool_id), (user.clone(), amount));
}
