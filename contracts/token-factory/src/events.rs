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

use soroban_sdk::{symbol_short, Address, Env, String};

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
pub fn emit_initialized(env: &Env, admin: &Address, treasury: &Address, base_fee: i128, metadata_fee: i128) {
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
        (creator.clone(), name.clone(), symbol.clone(), decimals, initial_supply),
    );
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
    env.events().publish(
        (symbol_short!("adm_xf_v1"),),
        (old_admin, new_admin),
    );
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
    env.events().publish(
        (symbol_short!("pause_v1"),),
        (admin,),
    );
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
    env.events().publish(
        (symbol_short!("unpaus_v1"),),
        (admin,),
    );
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
    env.events().publish(
        (symbol_short!("fee_up_v1"),),
        (base_fee, metadata_fee),
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
pub fn emit_clawback_toggled(
    env: &Env,
    token_address: &Address,
    admin: &Address,
    enabled: bool,
) {
    env.events().publish(
        (symbol_short!("clwbck_v1"), token_address.clone()),
        (admin, enabled),
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
    env.events().publish(
        (symbol_short!("tl_cfg"),),
        (delay_seconds,),
    );
}

/// Emit change scheduled event
///
/// Emitted when a sensitive change is scheduled with timelock
pub fn emit_change_scheduled(env: &Env, change_id: u64, change_type: crate::types::ChangeType, execute_at: u64) {
    env.events().publish(
        (symbol_short!("ch_sched"), change_id),
        (change_type, execute_at),
    );
}

/// Emit change executed event
///
/// Emitted when a pending change is successfully executed
pub fn emit_change_executed(env: &Env, change_id: u64, change_type: crate::types::ChangeType) {
    env.events().publish(
        (symbol_short!("ch_exec"), change_id),
        (change_type,),
    );
}

/// Emit change cancelled event
///
/// Emitted when a pending change is cancelled before execution
pub fn emit_change_cancelled(env: &Env, change_id: u64, change_type: crate::types::ChangeType) {
    env.events().publish(
        (symbol_short!("ch_cncl"), change_id),
        (change_type,),
    );
}

/// Emit treasury updated event
///
/// Emitted when treasury address is changed
pub fn emit_treasury_updated(env: &Env, new_treasury: &Address) {
    env.events().publish(
        (symbol_short!("trs_upd"),),
        (new_treasury,),
    );
}


/// Emit mint event
///
/// Emitted when tokens are minted
pub fn emit_mint(env: &Env, token_index: u32, to: &Address, amount: i128) {
    env.events().publish(
        (symbol_short!("mint"), token_index),
        (to, amount),
    );
}


// ── Treasury events ─────────────────────────────────────────

/// Emit treasury withdrawal event
///
/// Emitted when fees are withdrawn from treasury
pub fn emit_treasury_withdrawal(env: &Env, recipient: &Address, amount: i128) {
    env.events().publish(
        (symbol_short!("trs_wdrw"),),
        (recipient, amount),
    );
}

/// Emit recipient added event
///
/// Emitted when an address is added to the withdrawal allowlist
pub fn emit_recipient_added(env: &Env, recipient: &Address) {
    env.events().publish(
        (symbol_short!("rec_add"),),
        (recipient,),
    );
}

/// Emit recipient removed event
///
/// Emitted when an address is removed from the withdrawal allowlist
pub fn emit_recipient_removed(env: &Env, recipient: &Address) {
    env.events().publish(
        (symbol_short!("rec_rem"),),
        (recipient,),
    );
}

/// Emit treasury policy updated event
///
/// Emitted when treasury withdrawal policy is changed
pub fn emit_treasury_policy_updated(env: &Env, daily_cap: i128, allowlist_enabled: bool) {
    env.events().publish(
        (symbol_short!("trs_pol"),),
        (daily_cap, allowlist_enabled),
    );
}

/// Emit stream metadata updated event (v1)
/// 
/// **Schema Version**: 1
/// **Event Name**: strm_md
/// 
/// **Topics** (indexed):
/// - Event name: "strm_md"
/// - stream_id: u32 - The stream ID being updated
/// 
/// **Payload** (non-indexed):
/// - updater: Address - The address that updated the metadata (creator/admin)
/// - has_metadata: bool - Whether metadata is now present (true) or cleared (false)
/// 
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
/// 
/// Emitted when stream metadata is successfully updated
pub fn emit_stream_metadata_updated(
    env: &Env,
    stream_id: u32,
    updater: &Address,
    has_metadata: bool,
) {
    env.events().publish(
        (symbol_short!("strm_md"), stream_id),
        (updater, has_metadata),
    );
}

/// Emit stream created event (v1)
/// 
/// **Schema Version**: 1
/// **Event Name**: strm_crt
/// 
/// **Topics** (indexed):
/// - Event name: "strm_crt"
/// - stream_id: u32 - The newly created stream ID
/// 
/// **Payload** (non-indexed):
/// - creator: Address - The stream creator
/// - recipient: Address - The stream recipient
/// - amount: i128 - The stream amount
/// - has_metadata: bool - Whether metadata is present
/// 
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
/// 
/// Emitted when a new stream is created
pub fn emit_stream_created(
    env: &Env,
    stream_id: u32,
    creator: &Address,
    recipient: &Address,
    amount: i128,
    has_metadata: bool,
) {
    env.events().publish(
        (symbol_short!("strm_crt"), stream_id),
        (creator, recipient, amount, has_metadata),
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

/// Emit stream created event
///
/// Published when a new payment stream is created
pub fn emit_stream_created(
    env: &Env,
    stream_id: u64,
    creator: &Address,
    recipient: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("strm_cr"),),
        (stream_id, creator, recipient, amount),
    );
}

/// Emit batch streams created event
///
/// Published when multiple streams are created in a batch
pub fn emit_batch_streams_created(
    env: &Env,
    creator: &Address,
    count: u32,
) {
    env.events().publish(
        (symbol_short!("bch_strm"),),
        (creator, count),
    );
}

/// Emit stream claimed event
///
/// Published when tokens are claimed from a stream
pub fn emit_stream_claimed(
    env: &Env,
    stream_id: u64,
    recipient: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("strm_clm"),),
        (stream_id, recipient, amount),
    );
}

/// Emit stream cancelled event
///
/// Published when a stream is cancelled by creator
pub fn emit_stream_cancelled(
    env: &Env,
    stream_id: u64,
    creator: &Address,
) {
    env.events().publish(
        (symbol_short!("strm_cnl"),),
        (stream_id, creator),
    );
}


// ── Governance events ─────────────────────────────────────────

/// Emit proposal created event (v1)
/// 
/// **Schema Version**: 1
/// **Event Name**: prop_crt
/// 
/// **Topics** (indexed):
/// - Event name: "prop_crt"
/// - proposal_id: u64 - The newly created proposal ID
/// 
/// **Payload** (non-indexed):
/// - proposer: Address - The address that created the proposal
/// - action_type: ActionType - The type of action being proposed
/// - start_time: u64 - Voting start timestamp
/// - end_time: u64 - Voting end timestamp
/// - eta: u64 - Estimated execution time
/// 
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
/// 
/// Emitted when a new governance proposal is created
pub fn emit_proposal_created(
    env: &Env,
    proposal_id: u64,
    proposer: &Address,
    action_type: crate::types::ActionType,
    start_time: u64,
    end_time: u64,
    eta: u64,
) {
    env.events().publish(
        (symbol_short!("prop_crt"), proposal_id),
        (proposer, action_type, start_time, end_time, eta),
    );
}


/// Emit proposal voted event (v1)
/// 
/// **Schema Version**: 1
/// **Event Name**: prop_vot
/// 
/// **Topics** (indexed):
/// - Event name: "prop_vot"
/// - proposal_id: u64 - The proposal being voted on
/// 
/// **Payload** (non-indexed):
/// - voter: Address - The address that cast the vote
/// - vote_choice: VoteChoice - The vote choice (For, Against, Abstain)
/// 
/// **Schema Stability**: This schema is immutable. Any changes require a new version.
/// 
/// Emitted when a vote is cast on a governance proposal
pub fn emit_proposal_voted(
    env: &Env,
    proposal_id: u64,
    voter: &Address,
    vote_choice: crate::types::VoteChoice,
) {
    env.events().publish(
        (symbol_short!("prop_vot"), proposal_id),
        (voter, vote_choice),
    );
}
