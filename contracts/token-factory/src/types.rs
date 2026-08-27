#![allow(dead_code)]

use soroban_sdk::{self, contracttype, Address, Bytes, BytesN, String, Vec};

/// Factory state containing administrative configuration
///
/// Represents the current state of the token factory including
/// administrative addresses, fee structure, and operational status.
///
/// # Fields
/// * `admin` - Address with administrative privileges
/// * `treasury` - Address receiving deployment fees
/// * `base_fee` - Base fee for token deployment (in stroops)
/// * `metadata_fee` - Additional fee for metadata inclusion (in stroops)
/// * `paused` - Whether the contract is paused
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FactoryState {
    pub admin: Address,
    pub treasury: Address,
    pub base_fee: i128,
    pub metadata_fee: i128,
    pub paused: bool,
}

/// Contract metadata for factory identification
///
/// Contains descriptive information about the token factory contract.
///
/// # Fields
/// * `name` - Human-readable contract name
/// * `description` - Brief description of contract purpose
/// * `author` - Contract author or team name
/// * `license` - Software license identifier (e.g., "MIT")
/// * `version` - Semantic version string (e.g., "1.0.0")
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractMetadata {
    pub name: String,
    pub description: String,
    pub author: String,
    pub license: String,
    pub version: String,
}

/// Complete information about a deployed token
///
/// Contains all metadata and state for a token created by the factory.
///
/// # Fields
/// * `address` - The token's contract address
/// * `creator` - Address that deployed the token
/// * `name` - Token name (e.g., "My Token")
/// * `symbol` - Token symbol (e.g., "MTK")
/// * `decimals` - Number of decimal places (typically 7 for Stellar)
/// * `total_supply` - Current circulating supply after burns
/// * `initial_supply` - Initial supply at token creation
/// * `max_supply` - Optional maximum supply cap (None = unlimited)
/// * `metadata_uri` - Optional IPFS URI for additional metadata
/// * `metadata_version` - Current metadata version (0 = never set, 1+ = update count)
/// * `created_at` - Unix timestamp of token creation
/// * `total_burned` - Cumulative amount of tokens burned
/// * `burn_count` - Number of burn operations performed
/// * `clawback_enabled` - Whether admin can burn from any address
///
/// # Examples
/// ```
/// let token_info = factory.get_token_info(&env, 0)?;
/// assert_eq!(token_info.symbol, "MTK");
/// ```
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenInfo {
    pub address: Address,
    pub creator: Address,
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    pub total_supply: i128,
    pub initial_supply: i128,
    pub max_supply: Option<i128>,
    pub total_burned: i128,
    pub burn_count: u32,
    pub metadata_uri: Option<String>,
    /// Current metadata version. 0 = metadata never set; increments with each update.
    pub metadata_version: u32,
    pub created_at: u64,
    pub is_paused: bool,
    pub clawback_enabled: bool,
    pub freeze_enabled: bool,
}

/// A historical record of a single metadata update.
///
/// Stored per (token_index, version) so callers can reconstruct the full
/// update history for any token.
///
/// # Fields
/// * `uri` - The metadata URI that was set in this version
/// * `updated_at` - Ledger timestamp when the update was applied
/// * `updated_by` - Address that performed the update
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataRecord {
    pub uri: String,
    pub updated_at: u64,
    pub updated_by: Address,
}

/// A single milestone that gates a portion of a token stream.
///
/// The `oracle_address` must call `verify_stream_milestone` to unlock the
/// `unlock_amount`. Once verified, that amount becomes claimable by the
/// stream recipient on top of any time-vested balance.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    /// Human-readable description (max 256 chars).
    pub description: String,
    /// Address whose `require_auth` approval unlocks this milestone.
    pub oracle_address: Address,
    /// Token amount (smallest unit) unlocked when this milestone is verified.
    pub unlock_amount: i128,
    /// Whether this milestone has been verified by the oracle.
    pub verified: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamInfo {
    pub id: u64,
    pub creator: Address,
    pub recipient: Address,
    pub token_index: u32,
    pub total_amount: i128,
    pub claimed_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cliff_time: u64,
    pub metadata: Option<String>,
    pub cancelled: bool,
    pub paused: bool,
    pub disputed: bool,
    /// Optional list of milestones that gate additional unlock amounts.
    /// An empty Vec means this is a pure time-based stream (no milestones).
    pub milestones: Vec<Milestone>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamParams {
    pub recipient: Address,
    pub token_index: u32,
    pub total_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cliff_time: u64,
}

/// Token creation parameters
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenCreationParams {
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    pub initial_supply: i128,
    pub max_supply: Option<i128>,
    pub metadata_uri: Option<String>,
    /// Whether admin clawback is enabled for this token.
    /// This flag is **immutable after creation** — it cannot be toggled later.
    /// Set `true` only for regulated use-cases (e.g. stablecoins, tokenized securities).
    pub clawback_enabled: bool,
}

/// Outcome of validating a single item during a batch pre-flight dry-run.
///
/// `index` matches the item's position in the batch input vector.
/// `error_code` is `0` when the item is valid, otherwise the `Error` code
/// (see `Error`'s associated constants) it would fail with if executed.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PreflightItemResult {
    pub index: u32,
    pub error_code: u32,
}

/// Outcome of a single `schedule_batch_reveal` / `resume_batch_reveal` /
/// `schedule_batch_settle` / `resume_batch_settle` call.
///
/// A batch is only ever split at item boundaries — `executed_count` items
/// were fully committed to storage, `remaining_count` were not touched at
/// all. `continuation_pending` is `true` when `remaining_count > 0`, in
/// which case the tenant must call the matching `resume_*` entry point on a
/// later ledger to make further progress.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BatchScheduleResult {
    pub executed_count: u32,
    pub remaining_count: u32,
    pub continuation_pending: bool,
}

/// Pending, gas-budget-deferred continuation of a `batch_reveal` call.
///
/// Persists the still-unexecuted tail of the batch so it can resume on a
/// later ledger without re-validating or re-executing already-committed
/// items.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevealBatchContinuation {
    pub creator: Address,
    pub remaining_tokens: Vec<TokenCreationParams>,
    /// Fee payment remaining to cover `remaining_tokens`.
    pub remaining_fee_payment: i128,
    /// Ledger sequence this continuation last executed a chunk on.
    pub last_activity_ledger: u32,
}

/// Lifecycle state of a cross-contract settlement `Reservation` (#1624).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReservationStatus {
    /// Amount reserved against max-supply headroom; not yet minted.
    Prepared = 0,
    /// Reservation finalized — tokens minted to `recipient`.
    Committed = 1,
    /// Reservation released without minting (explicit abort, failed commit,
    /// or timeout cleanup).
    Aborted = 2,
}

/// A two-phase-commit reservation for a cross-contract treasury
/// disbursement, created by `prepare_settlement` and resolved by exactly one
/// of `commit_settlement`, `abort_settlement`, or `cleanup_stuck_reservation`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reservation {
    pub id: u64,
    /// Governance-side proposal id this reservation was created for.
    pub proposal_id: u64,
    pub recipient: Address,
    pub token_index: u32,
    pub amount: i128,
    pub status: ReservationStatus,
    /// Ledger sequence the reservation was created (`prepare`d) on.
    pub created_ledger: u32,
}

/// Pending, gas-budget-deferred continuation of a `batch_settle` call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettleBatchContinuation {
    pub creator: Address,
    pub token_index: u32,
    pub remaining_recipients: Vec<(Address, i128)>,
    pub minted_so_far: i128,
    /// Ledger sequence this continuation last executed a chunk on.
    pub last_activity_ledger: u32,
}

/// Timelock configuration
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockConfig {
    pub delay_seconds: u64,
    pub enabled: bool,
}

/// Per-proposal-type timelock delays (in ledgers).
///
/// Each field holds the mandatory delay for that proposal type.
/// Defaults: fee_change = 100, admin_transfer = 1000, upgrade = 5000.
/// All other types fall back to `default_delay`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockDelayConfig {
    /// Delay for FeeChange / PolicyUpdate proposals (ledgers)
    pub fee_change_delay: u64,
    /// Delay for TreasuryChange / admin-transfer proposals (ledgers)
    pub admin_transfer_delay: u64,
    /// Delay for ParameterChange (contract upgrade) proposals (ledgers)
    pub upgrade_delay: u64,
    /// Fallback delay for PauseContract / UnpauseContract (ledgers)
    pub default_delay: u64,
}

/// Configuration for governance voting thresholds
///
/// Defines the quorum and approval requirements for all governance proposals.
///
/// # Fields
/// * `quorum_percent` - Minimum participation percentage required (0-100)
/// * `approval_percent` - Minimum approval percentage required (0-100)
/// * `voting_period` - Duration in seconds that voting remains open after proposal creation
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceConfig {
    pub quorum_percent: u32,
    pub approval_percent: u32,
    pub voting_period: u64,
}

/// Configuration for dynamic quorum adjustment based on historical participation.
///
/// When enabled, the effective quorum for a proposal is computed from the
/// rolling average of recent participation rates, clamped to [min_quorum_percent,
/// max_quorum_percent].
///
/// # Fields
/// * `enabled`              – Whether dynamic adjustment is active.
/// * `min_quorum_percent`   – Floor for the adjusted quorum (0–100).
/// * `max_quorum_percent`   – Ceiling for the adjusted quorum (0–100, ≥ min).
/// * `target_participation` – Ideal participation rate (0–100) used as the
///                            reference point for the adjustment formula.
/// * `window_size`          – Number of recent proposals to average over (≥ 1).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DynamicQuorumConfig {
    pub enabled: bool,
    pub min_quorum_percent: u32,
    pub max_quorum_percent: u32,
    pub target_participation: u32,
    pub window_size: u32,
}

/// Participation snapshot recorded after each proposal concludes.
///
/// # Fields
/// * `proposal_id`       – The proposal this record belongs to.
/// * `total_votes`       – Votes cast during the proposal.
/// * `total_eligible`    – Eligible voters at the time of the proposal.
/// * `participation_bps` – Actual participation in basis points (0–10 000).
///                         Stored as BPS to avoid floating-point arithmetic.
/// * `recorded_at`       – Ledger timestamp when the record was written.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParticipationRecord {
    pub proposal_id: u64,
    pub total_votes: u32,
    pub total_eligible: u32,
    pub participation_bps: u32,
    pub recorded_at: u64,
}

/// Buyback campaign structure
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuybackCampaign {
    pub id: u64,
    pub token_index: u32,
    pub budget: i128,
    pub spent: i128,
    pub tokens_bought: i128,
    /// Tokens actually burned so far. Tracked separately from `tokens_bought`
    /// so a burn that under-delivers is visible rather than silently absorbed.
    pub tokens_burned: i128,
    /// Hard cap on the quote amount a single `execute_buyback_step` may spend.
    pub max_spend_per_step: i128,
    pub execution_count: u32,
    pub start_time: u64,
    pub end_time: u64,
    pub min_interval: u64,
    pub max_slippage_bps: u32,
    pub source_token: Address,
    pub target_token: Address,
    pub owner: Address,
    pub status: CampaignStatus,
    pub created_at: u64,
    pub updated_at: u64,
    /// Optional price trigger: execute only when price is at or below this value (0 = disabled)
    pub trigger_price: i128,
    /// Last execution timestamp for interval enforcement
    pub last_executed_at: u64,
}

/// Price trigger condition for buyback automation
///
/// Defines the condition under which a buyback should be triggered.
/// When the current price is at or below `trigger_price`, the buyback executes.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceTrigger {
    /// Price threshold in stroops; buyback fires when price <= this value
    pub trigger_price: i128,
    /// Maximum amount to spend per triggered execution
    pub max_spend_per_trigger: i128,
}

/// Governance proposal template for common actions
///
/// Templates pre-encode common governance actions so proposers don't
/// need to manually construct payloads.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalTemplate {
    pub id: u32,
    pub name: String,
    pub action_type: ActionType,
    pub description: String,
    pub created_at: u64,
}

/// Airdrop campaign with Merkle tree verification
///
/// Allows distributing tokens to a predefined set of recipients
/// verified via a Merkle root.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AirdropCampaign {
    pub id: u64,
    pub token_index: u32,
    pub merkle_root: BytesN<32>,
    pub total_amount: i128,
    pub claimed_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub owner: Address,
    pub status: CampaignStatus,
    pub created_at: u64,
}

/// Contract version info for upgrade/migration tracking
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub migrated_at: u64,
}

/// Campaign status enum
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CampaignStatus {
    Active = 0,
    Paused = 1,
    Completed = 2,
    Cancelled = 3,
    Expired = 4,
}

// ─────────────────────────────────────────────────────────────────────────────
// Liquidity Mining Types
// ─────────────────────────────────────────────────────────────────────────────

/// Status of a liquidity mining pool
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MiningPoolStatus {
    /// Pool is accepting stakes and distributing rewards
    Active = 0,
    /// Pool is temporarily suspended; no new stakes or reward accrual
    Paused = 1,
    /// Pool has ended; no new stakes, but claims are still allowed
    Ended = 2,
}

/// A liquidity mining pool that distributes reward tokens to stakers
///
/// Rewards are distributed proportionally based on each provider's share
/// of the total staked amount. Uses a reward-per-token accumulator pattern
/// for O(1) reward calculation regardless of the number of providers.
///
/// # Fields
/// * `id` - Unique pool identifier
/// * `reward_token_index` - Index of the token distributed as rewards
/// * `stake_token_index` - Index of the token providers must stake
/// * `reward_rate` - Reward tokens distributed per second per staked token (in stroops)
/// * `start_time` - Unix timestamp when the pool starts
/// * `end_time` - Unix timestamp when reward accrual stops
/// * `total_staked` - Current total amount staked across all providers
/// * `reward_per_token_stored` - Accumulated reward per token (scaled by REWARD_PRECISION)
/// * `last_update_time` - Timestamp of the last reward checkpoint
/// * `status` - Current pool lifecycle status
/// * `created_at` - Unix timestamp when the pool was created
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityMiningPool {
    pub id: u64,
    pub reward_token_index: u32,
    pub stake_token_index: u32,
    pub reward_rate: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub total_staked: i128,
    pub reward_per_token_stored: i128,
    pub last_update_time: u64,
    pub status: MiningPoolStatus,
    pub created_at: u64,
}

/// A liquidity provider's stake in a mining pool
///
/// Tracks the provider's staked amount and reward checkpoint data.
/// The `reward_per_token_paid` field is the pool's `reward_per_token_stored`
/// at the time of the last checkpoint for this provider.
///
/// # Fields
/// * `provider` - Address of the liquidity provider
/// * `pool_id` - ID of the pool this stake belongs to
/// * `staked_amount` - Current amount staked by this provider
/// * `reward_per_token_paid` - Pool's reward_per_token_stored at last checkpoint
/// * `pending_rewards` - Rewards accrued but not yet claimed
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderStake {
    pub provider: Address,
    pub pool_id: u64,
    pub staked_amount: i128,
    pub reward_per_token_paid: i128,
    pub pending_rewards: i128,
}

/// Individual buyback step
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuybackStep {
    pub step_number: u32,
    pub amount: i128,
    pub status: StepStatus,
    pub executed_at: Option<u64>,
    pub tx_hash: Option<String>,
}

/// Step execution status
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StepStatus {
    Pending = 0,
    Completed = 1,
    Failed = 2,
}

/// Current lifecycle state for a vault allocation.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VaultStatus {
    Active,
    Claimed,
    Cancelled,
}

/// Time-locked and milestone-gated token allocation vault.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vault {
    pub id: u64,
    pub token: Address,
    pub owner: Address,
    pub creator: Address,
    pub total_amount: i128,
    pub claimed_amount: i128,
    pub unlock_time: u64,
    pub milestone_hash: BytesN<32>,
    pub status: VaultStatus,
    pub created_at: u64,
    /// Authorized address that must approve milestone completion before funds
    /// are released. `None` means no milestone gating (time-only unlock).
    /// When set, `claim_vault` requires this address to have called
    /// `verify_milestone` for the vault before the claim is accepted.
    pub verifier: Option<Address>,
    /// Set to `true` once the authorized verifier has approved the milestone.
    pub milestone_verified: bool,
}

/// Pending multi-party vault-owner change request.
///
/// Both the current owner and the contract creator must approve before
/// the vault's `owner` field is updated.
///
/// # Fields
/// * `vault_id`   - The vault being modified
/// * `new_owner`  - Proposed new owner address
/// * `owner_approved`   - Whether the current vault owner has approved
/// * `creator_approved` - Whether the vault creator has approved
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingVaultOwnerChange {
    pub vault_id: u64,
    pub new_owner: Address,
    pub owner_approved: bool,
    pub creator_approved: bool,
}

/// Parameters for creating a recurring payment stream
///
/// Defines a stream that creates child streams automatically at fixed intervals.
/// Each period creates an independent, claimable child stream.
///
/// # Fields
/// * `recipient` - Payment recipient for each period
/// * `amount_per_period` - Amount streamed in each period
/// * `period_ledgers` - Duration of each period in ledgers
/// * `total_periods` - Number of periods to create (max 1000)
/// * `auto_renew` - Whether to continue creating periods after total_periods
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecurringStreamParams {
    pub recipient: Address,
    pub amount_per_period: i128,
    pub period_ledgers: u64,
    pub total_periods: u32,
    pub auto_renew: bool,
}

/// Recurring payment stream tracking state
///
/// Tracks a recurring payment schedule that creates child streams automatically.
/// When a period ends, a new child stream is created for the next period.
///
/// # Fields
/// * `id` - Unique recurring stream ID
/// * `creator` - Address that created this recurring stream (must authorize cancellations)
/// * `recipient` - Payment recipient for each period
/// * `amount_per_period` - Amount per period stream
/// * `period_ledgers` - Duration of each period in ledgers
/// * `total_periods` - Total periods requested (0 = unlimited if auto_renew true)
/// * `periods_created` - How many periods have been created so far
/// * `current_period_start_ledger` - Ledger when current period began
/// * `auto_renew` - Whether to continue after total_periods (if total_periods > 0)
/// * `auto_renew_enabled` - Current auto-renewal state (can be disabled by creator)
/// * `cancelled` - Whether the recurring stream has been cancelled
/// * `child_streams` - IDs of child streams created by this recurring stream
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecurringStream {
    pub id: u64,
    pub creator: Address,
    pub recipient: Address,
    pub amount_per_period: i128,
    pub period_ledgers: u64,
    pub total_periods: u32,
    pub periods_created: u32,
    pub current_period_start_ledger: u64,
    pub auto_renew: bool,
    pub auto_renew_enabled: bool,
    pub cancelled: bool,
    pub child_streams: Vec<u64>,
}

/// Staking Pool configuration and state
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakingPool {
    pub id: u64,
    pub token_index: u32,
    pub reward_token_index: u32,
    pub reward_rate: i128,
    pub total_staked: i128,
    pub acc_reward_per_share: i128,
    pub last_reward_time: u64,
    pub active: bool,
    pub creator: Address,
}

/// Individual user stake state
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeInfo {
    pub amount: i128,
    pub reward_debt: i128,
}

/// Compact read-only snapshot of a token's current state.
/// Returned by get_token_stats().
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenStats {
    pub current_supply: i128, // live circulating supply
    pub total_burned: i128,   // cumulative amount burned since creation
    pub burn_count: u32,
    pub is_paused: bool,
    pub clawback_enabled: bool,
    pub freeze_enabled: bool,
}

/// A single price observation submitted by an authorized oracle source.
///
/// # Fields
/// * `price` - Raw price value (must be > 0)
/// * `decimals` - Number of decimal places in `price` (e.g. 7 means price / 10^7)
/// * `timestamp` - Ledger timestamp when the price was recorded
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub decimals: u32,
    pub timestamp: u64,
}

/// Global oracle configuration stored in instance storage.
///
/// # Fields
/// * `max_age_seconds` - Maximum acceptable age of a price before it is considered stale
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleConfig {
    pub max_age_seconds: u64,
}

/// Batch fee update structure for Phase 2 optimization
///
/// Allows updating both fees in a single operation, providing
/// approximately 40% gas savings compared to separate updates.
///
/// # Fields
/// * `base_fee` - Optional new base fee (None = no change)
/// * `metadata_fee` - Optional new metadata fee (None = no change)
///
/// # Examples
/// ```
/// // Update both fees
/// let update = FeeUpdate {
///     base_fee: Some(1_000_000),
///     metadata_fee: Some(500_000),
/// };
/// ```
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeUpdate {
    pub base_fee: Option<i128>,
    pub metadata_fee: Option<i128>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Burn Auction Types
// ─────────────────────────────────────────────────────────────────────────────

/// Lifecycle status of a burn auction
///
/// Auctions start as `Open`, transition to `Settled` when a winning bid is
/// placed, or to `Cancelled` when cancelled by the admin or after expiry.
/// Both `Settled` and `Cancelled` are terminal states.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuctionStatus {
    /// Auction is accepting bids
    Open = 0,
    /// A winning bid was placed; tokens have been burned
    Settled = 1,
    /// Auction was cancelled before settlement
    Cancelled = 2,
}

/// A Dutch auction for token price discovery via burn
///
/// The price decreases linearly from `start_price` to `reserve_price` over
/// the auction window. The first bidder to meet the current price wins and
/// the `burn_amount` of tokens is burned.
///
/// # Fields
/// * `id` - Unique auction identifier
/// * `token_index` - Index of the token being auctioned for burn
/// * `burn_amount` - Number of tokens to burn on settlement
/// * `start_price` - Opening price in stroops (highest)
/// * `reserve_price` - Minimum price in stroops (floor)
/// * `start_time` - Unix timestamp when bidding opens
/// * `end_time` - Unix timestamp when the auction expires
/// * `winning_bid` - Settlement price (None until settled)
/// * `winner` - Address of the winning bidder (None until settled)
/// * `status` - Current auction lifecycle status
/// * `created_at` - Unix timestamp of auction creation
/// * `settled_at` - Unix timestamp of settlement (None until settled)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BurnAuction {
    pub id: u64,
    pub token_index: u32,
    pub burn_amount: i128,
    pub start_price: i128,
    pub reserve_price: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub winning_bid: Option<i128>,
    pub winner: Option<Address>,
    pub status: AuctionStatus,
    pub created_at: u64,
    pub settled_at: Option<u64>,
}

/// Constant-product AMM pool state.
///
/// Stores reserves and LP token supply for a (token_a, token_b) pair.
/// The pair ordering is determined by the first `add_liquidity` call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AmmPool {
    pub token_a: Address,
    pub token_b: Address,
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub total_lp: i128,
}

/// A record of tokens escrowed by `lock_tokens` for a cross-chain bridge
/// transfer, keyed by the contract-assigned `nonce`.
///
/// The nonce must be supplied verbatim to `release_tokens` (on the
/// destination-side deployment of this contract) to authorize release; the
/// lock record itself is not consulted by `release_tokens` — verifying that
/// a matching lock actually occurred on the source chain is an off-chain /
/// admin responsibility (see `bridge.rs` module docs).
///
/// # Fields
/// * `nonce` - Monotonically-assigned, single-use identifier for this lock
/// * `sender` - Address that authorized and funded the lock
/// * `token` - Token contract address that was locked
/// * `amount` - Amount of `token` escrowed (smallest unit)
/// * `destination_chain` - Free-form identifier of the target chain (e.g. "ethereum")
/// * `destination_address` - Raw destination-chain address bytes (format is chain-specific)
/// * `locked_at` - Ledger timestamp when the lock was created
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeLock {
    pub nonce: u64,
    pub sender: Address,
    pub token: Address,
    pub amount: i128,
    pub destination_chain: String,
    pub destination_address: Bytes,
    pub locked_at: u64,
}

/// Storage keys for contract data
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Treasury,
    BaseFee,
    MetadataFee,
    TokenCount,
    Token(u32),
    Balance(u32, Address),
    BurnCount(u32),
    TokenPaused(u32),
    TotalBurned(u32),
    TokenByAddress(Address),
    Paused,
    TimelockConfig,
    TimelockDelayConfig,
    PendingChange(u64),
    NextChangeId,
    CreatorTokens(Address),
    CreatorTokenCount(Address),
    TreasuryPolicy,
    WithdrawalPeriod,
    AllowedRecipient(Address),
    Proposal(u64),
    ProposalCount,
    NextProposalId,
    ProposalVote(u64, Address),
    /// Ledger sequence at which a per-proposal state snapshot was last emitted (#1383)
    ProposalLastSnapshotLedger(u64),
    StreamCount,
    Stream(u32),
    TokenStreams(u32),
    TokenStreamCount(u32),
    NextStreamId,
    // Keyset pagination index: ordered (created_ledger, stream_id) entries per owner
    CreatorStreamIndex(Address),
    GovernanceConfig,
    Vault(u64),
    VaultCount,
    VaultByOwner(Address, u32),
    OwnerVaultCount(Address),
    VaultByCreator(Address, u32),
    CreatorVaultCount(Address),
    /// Cumulative withdrawal volume for the current epoch (keyed by epoch number)
    EpochWithdrawVolume(u32),
    /// Admin-configured per-epoch withdrawal limit
    VaultWithdrawLimit,
    /// Whether vault withdrawals are paused by the circuit breaker
    VaultCircuitBreakerPaused,
    PendingAdmin,
    BuybackCampaign(u64),
    BuybackCampaignCount,
    CampaignByCreator(Address, u32),
    CreatorCampaignCount(Address),
    ActiveCampaigns,
    // Airdrop
    AirdropCampaign(u64),
    AirdropCampaignCount,
    AirdropClaimed(u64, Address),
    // Governance templates
    ProposalTemplate(u32),
    ProposalTemplateCount,
    // Contract upgrade
    ContractVersion,
    StorageVersion,
    // Dividend distribution (#1148)
    DividendDust(u32),
    DividendRecord(u64),
    DividendDistributionCount,
    // Dynamic quorum
    DynamicQuorumConfig,
    ParticipationRecord(u64), // keyed by proposal_id
    // Game / deployment history
    HistoryCount,
    HistoryRecord(u64),
    // Referral system
    ReferralInfo(Address),
    ReferralCommissionRate,
    ReferralTotalEarned(Address),
    // Token snapshot mechanism
    /// Number of balance snapshots for (token_index, holder)
    BalanceSnapshotCount(u32, Address),
    /// Individual balance snapshot: (token_index, holder, snapshot_index)
    BalanceSnapshot(u32, Address, u32),
    /// Number of supply snapshots for token_index
    SupplySnapshotCount(u32),
    /// Individual supply snapshot: (token_index, snapshot_index)
    SupplySnapshot(u32, u32),
    /// Index of the token used for fee payments
    FeeToken,
    /// Address of the governance contract authorized for restricted operations
    Governance,
    /// Metadata history record: (token_index, record_index)
    MetadataHistory(u32, u32),
    /// Burn schedules for a token: (token_index, schedule_index)
    BurnSchedulesByToken(u32, u32),
    /// Number of burn schedules for a token
    BurnScheduleCountByToken(u32),
    /// Reentrancy guard flag — set while a burn is in progress
    ReentrancyLock,
    /// Content hash for token metadata (token_index → BytesN<32>)
    MetadataContentHash(u32),
    /// Pending vault-owner change: vault_id → (new_owner, approvals_bitmap)
    PendingVaultOwnerChange(u64),
    // Pull-model dividend distribution (#1148)
    /// Distribution record keyed by distribution_id
    Distribution(u32),
    /// Total number of distributions initiated
    DistributionCount,
    /// Whether a holder has claimed for a distribution: (distribution_id, holder)
    DistributionClaimed(u32, Address),
    /// Running total of amounts claimed for a distribution
    DistributionClaimedTotal(u32),
    // ── Commit-reveal session storage (#1626) ──
    /// Commit-reveal session: session_id → CommitRevealSession
    CommitRevealSession(u64),
    /// Total number of commit-reveal sessions created
    CommitRevealSessionCount,
    /// Commitment record: (session_id, index) → CommitRecord
    CommitRecord(u64, u32),
    /// Bidder index within a session: (session_id, bidder) → u32
    CommitRevealBidderIndex(u64, Address),
    /// Whether the metadata identity lock has been engaged
    MetadataLocked,
    /// Ledger sequence at which the metadata identity lock was engaged
    MetadataLockedAt,
    /// Frozen/blacklist state for (token_address, address)
    FrozenAddress(Address, Address),
    /// Ledger timestamp at which (token_address, address) was frozen
    FreezeTimestamp(Address, Address),
    /// Unfreeze cooldown grace period (seconds) for a token
    FreezeCooldown(Address),
    /// RBAC role grant: (token_index, address, role_discriminant) → bool
    TokenRole(u32, Address, u32),
    /// Number of metadata history records for a token
    MetadataHistoryCount(u32),
    /// Multisig admin-change configuration (signers + threshold)
    MultiSigConfig,
    /// Total number of multisig proposals created
    MultiSigProposalCount,
    /// Multisig proposal record, keyed by proposal id
    MultiSigProposal(u64),
    /// Whether `approver` has approved multisig proposal `proposal_id`
    MultiSigApproval(u64, Address),
    /// Whether `caller` is a registered cross-contract trusted caller
    TrustedCaller(Address),
    /// FIFO execution queue of proposal ids per `ActionType`
    ProposalTypeQueue(ActionType),
    /// Current per-ledger gas budget for the batch scheduler (#1625)
    LedgerGasBudget,
    /// Tenants currently holding a pending batch-scheduler continuation
    FairShareQueue,
    /// Gas used by `tenant` on `ledger_seq`: (tenant, ledger_seq) → u64
    TenantLedgerGasUsed(Address, u32),
    /// Total gas used by all tenants on `ledger_seq`
    LedgerGasUsed(u32),
    /// Pending `schedule_batch_reveal` continuation for `creator`
    RevealContinuation(Address),
    /// Pending `schedule_batch_settle` continuation for `creator`
    SettleContinuation(Address),
    /// Total amount of `token_index` currently reserved (prepared but not
    /// yet committed/aborted) by the two-phase settlement protocol (#1624)
    ReservedTotal(u32),
    /// Total number of settlement reservations created
    ReservationCount,
    /// Settlement reservation record, keyed by reservation id
    Reservation(u64),
    /// Ledgers a reservation may sit `Prepared` before it can be force-released
    ReservationTimeoutLedgers,
    // ── Staking (#1757) ──
    /// Staking pool configuration and state, keyed by pool_id
    StakingPool(u64),
    /// Total number of staking pools created
    StakingPoolCount,
    /// Next available staking pool ID
    NextStakingPoolId,
    /// A user's stake within a pool: (pool_id, staker) → StakeInfo
    UserStake(u64, Address),
}

/// A point-in-time record of a token holder's balance.
///
/// Snapshots are taken automatically on every mint and burn that affects
/// a holder's balance, enabling historical balance queries at any ledger
/// sequence number.
///
/// # Fields
/// * `ledger` - Ledger sequence number when the snapshot was taken
/// * `timestamp` - Unix timestamp when the snapshot was taken
/// * `balance` - Token balance at this point in time
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BalanceSnapshot {
    pub ledger: u32,
    pub timestamp: u64,
    pub balance: i128,
}

/// A point-in-time record of a token's total supply.
///
/// Taken automatically on every mint and burn, enabling historical
/// supply queries at any ledger sequence number.
///
/// # Fields
/// * `ledger` - Ledger sequence number when the snapshot was taken
/// * `timestamp` - Unix timestamp when the snapshot was taken
/// * `total_supply` - Total circulating supply at this point in time
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupplySnapshot {
    pub ledger: u32,
    pub timestamp: u64,
    pub total_supply: i128,
}

/// Lifecycle status of a scheduled burn
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BurnScheduleStatus {
    /// Waiting for the unlock time to pass
    Pending = 0,
    /// Burn has been executed
    Executed = 1,
    /// Burn was cancelled before execution
    Cancelled = 2,
}

/// A time-locked token burn schedule
///
/// Created by the token admin; the burn cannot execute until
/// `unlock_time` has passed. Anyone may trigger execution after
/// the lock expires.
///
/// # Fields
/// * `id`           – Unique schedule identifier
/// * `token_index`  – Index of the token to burn
/// * `from`         – Address whose balance will be burned
/// * `amount`       – Amount to burn (in smallest unit)
/// * `unlock_time`  – Earliest ledger timestamp at which execution is allowed
/// * `created_at`   – Ledger timestamp when the schedule was created
/// * `executed_at`  – Ledger timestamp of execution (None until executed)
/// * `creator`      – Address that created the schedule (admin)
/// * `status`       – Current lifecycle status
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BurnSchedule {
    pub id: u64,
    pub token_index: u32,
    pub from: Address,
    pub amount: i128,
    pub unlock_time: u64,
    pub created_at: u64,
    pub executed_at: Option<u64>,
    pub creator: Address,
    pub status: BurnScheduleStatus,
}

/// Vesting schedule for token grants
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub recipient: Address,
    pub token_index: u32,
    pub total_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub cliff_time: u64,
    pub claimed_amount: i128,
    pub cancelled: bool,
}

/// Priority level for proposal execution queue
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalPriority {
    Low = 0,
    Normal = 1,
    High = 2,
    Critical = 3,
}

/// Entry in the proposal execution queue
///
/// Represents a proposal that is queued for execution after timelock expires.
/// Entries are sorted by priority (descending) and enqueue time (ascending, FIFO).
///
/// # Fields
/// * `proposal_id` - ID of the queued proposal
/// * `priority` - Execution priority (higher values execute first)
/// * `enqueued_at` - Ledger timestamp when entry was added to queue
/// * `eta` - Earliest timestamp when proposal can be executed (timelock expiry)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueueEntry {
    pub proposal_id: u64,
    pub priority: ProposalPriority,
    pub enqueued_at: u64,
    pub eta: u64,
}

/// Role-based access control roles for token operations
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    /// Can update token metadata URI
    MetadataManager,
    /// Can pause/unpause the token
    Pauser,
    /// Can mint new tokens
    Minter,
}

/// Multi-signature configuration
///
/// Defines the threshold and signers for multi-sig admin operations.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultiSigConfig {
    /// Addresses authorized to approve proposals
    pub signers: soroban_sdk::Vec<Address>,
    /// Number of approvals required to execute a proposal
    pub threshold: u32,
}

/// Type of admin operation requiring multi-sig approval
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MultiSigAction {
    /// Transfer admin to a new address
    TransferAdmin,
    /// Update fee structure
    UpdateFees,
    /// Pause the contract
    PauseContract,
    /// Unpause the contract
    UnpauseContract,
}

/// A pending multi-sig proposal
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MultiSigProposal {
    pub id: u64,
    pub proposer: Address,
    pub action: MultiSigAction,
    /// ABI-encoded action payload (e.g., new admin address, fee values)
    pub payload: soroban_sdk::Bytes,
    pub created_at: u64,
    pub executed: bool,
    pub cancelled: bool,
    pub approval_count: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Error(pub u32);

#[allow(non_upper_case_globals)]
impl Error {
    pub const InsufficientFee: Self = Self(1);
    pub const Unauthorized: Self = Self(2);
    pub const InvalidParameters: Self = Self(3);
    pub const TokenNotFound: Self = Self(4);
    pub const MetadataAlreadySet: Self = Self(5);
    pub const AlreadyInitialized: Self = Self(6);
    pub const InsufficientBalance: Self = Self(7);
    pub const ArithmeticError: Self = Self(8);
    pub const BatchTooLarge: Self = Self(9);
    pub const InvalidAmount: Self = Self(10);
    pub const ClawbackDisabled: Self = Self(11);
    pub const InvalidBurnAmount: Self = Self(12);
    pub const BurnAmountExceedsBalance: Self = Self(13);
    pub const ContractPaused: Self = Self(14);
    pub const InvalidTokenParams: Self = Self(15);
    pub const BatchCreationFailed: Self = Self(16);
    pub const StreamNotFound: Self = Self(17);
    pub const InvalidSchedule: Self = Self(18);
    pub const StreamCancelled: Self = Self(19);
    pub const CliffNotReached: Self = Self(20);
    pub const NothingToClaim: Self = Self(21);
    pub const MissingAdmin: Self = Self(22);
    pub const MissingTreasury: Self = Self(23);
    pub const InvalidBaseFee: Self = Self(24);
    pub const InvalidMetadataFee: Self = Self(25);
    pub const InconsistentTokenCount: Self = Self(26);
    pub const WithdrawalCapExceeded: Self = Self(27);
    pub const RecipientNotAllowed: Self = Self(28);
    pub const TimelockNotExpired: Self = Self(29);
    pub const ChangeAlreadyExecuted: Self = Self(30);
    pub const ChangeNotFound: Self = Self(31);
    pub const MaxSupplyExceeded: Self = Self(32);
    pub const InvalidMaxSupply: Self = Self(33);
    pub const MintingDisabled: Self = Self(34);
    pub const TokenPaused: Self = Self(35);
    pub const FreezeNotEnabled: Self = Self(36);
    pub const AddressFrozen: Self = Self(37);
    pub const AddressNotFrozen: Self = Self(38);
    pub const ProposalInTerminalState: Self = Self(39);
    pub const InvalidStateTransition: Self = Self(40);
    pub const InvalidTimeWindow: Self = Self(41);
    pub const PayloadTooLarge: Self = Self(42);
    pub const ProposalNotFound: Self = Self(43);
    pub const VotingNotStarted: Self = Self(44);
    pub const VotingEnded: Self = Self(45);
    pub const VotingClosed: Self = Self(46);
    pub const AlreadyVoted: Self = Self(47);
    pub const ProposalNotQueued: Self = Self(48);
    pub const ProposalCancelled: Self = Self(49);
    pub const QuorumNotMet: Self = Self(50);
    pub const CampaignNotFound: Self = Self(51);
    pub const InvalidBudget: Self = Self(52);
    pub const InsufficientBudget: Self = Self(53);
    // Buyback price trigger errors
    pub const PriceTriggerNotMet: Self = Self(54);
    pub const CampaignExpiredError: Self = Self(55);
    pub const IntervalNotElapsed: Self = Self(56);
    // Airdrop errors
    pub const AirdropNotFound: Self = Self(57);
    pub const AirdropAlreadyClaimed: Self = Self(58);
    pub const InvalidMerkleProof: Self = Self(59);
    pub const AirdropExpired: Self = Self(60);
    pub const AirdropNotStarted: Self = Self(61);
    // Governance template errors
    pub const TemplateNotFound: Self = Self(62);
    // Upgrade errors
    pub const UpgradeUnauthorized: Self = Self(63);
    pub const MigrationFailed: Self = Self(64);
    // Campaign state errors
    pub const CampaignAlreadyPaused: Self = Self(65);
    pub const CampaignNotPaused: Self = Self(66);
    pub const CampaignCompleted: Self = Self(67);
    pub const CampaignCancelled: Self = Self(68);
    // Dynamic quorum errors
    pub const DynamicQuorumDisabled: Self = Self(69);
    pub const InsufficientParticipationHistory: Self = Self(70);
    pub const InvalidQuorumBounds: Self = Self(71);
    pub const MetadataNotSet: Self = Self(80);
    // Multi-sig errors
    pub const MultiSigNotConfigured: Self = Self(72);
    pub const MultiSigProposalNotFound: Self = Self(73);
    pub const MultiSigAlreadyApproved: Self = Self(74);
    pub const MultiSigProposalExecuted: Self = Self(75);
    pub const MultiSigProposalCancelled: Self = Self(76);
    pub const MultiSigThresholdNotMet: Self = Self(77);
    pub const NotASigner: Self = Self(78);
    pub const InvalidThreshold: Self = Self(79);
    // Burn schedule errors
    pub const BurnScheduleNotFound: Self = Self(81);
    pub const BurnScheduleLocked: Self = Self(82);
    // Storage migration errors (#1147)
    pub const StorageMigrationAlreadyRun: Self = Self(83);
    pub const StorageMigrationNotRequired: Self = Self(84);
    // Dividend distribution errors (#1148)
    pub const DividendDistributionFailed: Self = Self(85);
    pub const DividendZeroHolders: Self = Self(86);
    pub const DividendOverflow: Self = Self(87);
    pub const DividendExceedsPool: Self = Self(88);
    pub const BurnScheduleAlreadyExecuted: Self = Self(83);
    pub const BurnScheduleCancelled: Self = Self(84);
    pub const InvalidUnlockTime: Self = Self(85);
    // Batch rollback errors
    /// A batch operation failed at the given element index; no state was changed.
    pub const PartialBatchFailure: Self = Self(86);
    // Stream dispute errors
    pub const StreamDisputed: Self = Self(87);
    pub const StreamNotDisputed: Self = Self(88);
    pub const DisputeAlreadyRaised: Self = Self(89);
    // Campaign recovery errors
    pub const CampaignFinalizationFailed: Self = Self(90);
    // Proposal cancellation errors
    pub const ProposalNotCancellable: Self = Self(91);
    // Burn reentrancy guard (#1132)
    pub const BurnReentrancyDetected: Self = Self(92);
    // Metadata content hash errors (#1131)
    pub const InvalidMetadataHash: Self = Self(93);
    pub const MetadataHashMismatch: Self = Self(94);
    // Milestone signature errors (#1133)
    pub const MilestoneUnauthorized: Self = Self(95);
    pub const MilestoneAlreadyVerified: Self = Self(96);
    // Vault beneficiary multi-party auth errors (#1134)
    pub const VaultOwnerChangePending: Self = Self(97);
    pub const VaultOwnerChangeNotFound: Self = Self(98);
    pub const VaultOwnerChangeAlreadyApproved: Self = Self(99);
    // Pull-model dividend distribution errors (#1148)
    pub const DistributionNotFound: Self = Self(100);
    pub const DistributionWindowClosed: Self = Self(101);
    pub const DistributionWindowOpen: Self = Self(102);
    pub const DistributionAlreadyClaimed: Self = Self(103);
    pub const DistributionAlreadyReclaimed: Self = Self(104);
    pub const DistributionZeroSupply: Self = Self(105);
    // Commit-reveal errors (#1626)
    pub const CommitRevealSessionNotFound: Self = Self(106);
    pub const CommitWindowClosed: Self = Self(107);
    pub const RevealWindowClosed: Self = Self(108);
    pub const RevealWindowOpen: Self = Self(109);
    pub const AlreadyCommitted: Self = Self(110);
    pub const AlreadyRevealed: Self = Self(111);
    pub const CommitmentMismatch: Self = Self(112);
    pub const NoBidderCommitment: Self = Self(113);
    pub const NoValidReveals: Self = Self(114);
    pub const AlreadyFinalised: Self = Self(115);
    pub const TooManyBidders: Self = Self(116);
    // Compliance reporting errors
    pub const ComplianceRuleExists: Self = Self(117);
    pub const ComplianceRuleNotFound: Self = Self(118);
    pub const ComplianceCheckFailed: Self = Self(119);
    // Freeze cooldown errors
    pub const FreezeCooldownActive: Self = Self(120);
    // Batch scheduler continuation errors
    pub const ContinuationAlreadyPending: Self = Self(121);
    pub const NoContinuationPending: Self = Self(122);
    pub const ContinuationNotYetEligible: Self = Self(123);
    // Settlement reservation errors
    pub const ReservationNotFound: Self = Self(124);
    pub const ReservationNotPending: Self = Self(125);
    pub const ReservationNotYetStuck: Self = Self(126);
    // Milestone verification errors (#1133 extension)
    pub const InvalidProof: Self = Self(127);
    pub const VerificationUnavailable: Self = Self(128);
    // Proposal type queue errors
    pub const ProposalNotAtQueueFront: Self = Self(129);
    // Vault circuit breaker errors
    pub const VaultCircuitBreakerActive: Self = Self(130);
    // Metadata identity lock errors
    pub const MetadataImmutable: Self = Self(131);
    // Multisig admin-change errors
    pub const DuplicateSigners: Self = Self(132);
    // Staking errors (#1757)
    pub const StakingPoolNotFound: Self = Self(133);
    pub const StakingNotActive: Self = Self(134);
    pub const InvalidRewardRate: Self = Self(135);
    pub const InsufficientStake: Self = Self(136);

    /// Stable string name for this error code, for off-chain event payloads
    /// (see `emit_operation_failed`). Covers the vault entry-point error
    /// surface (`create_vault`, `claim_vault`, `cancel_vault`,
    /// `verify_milestone`, `propose_vault_owner_change`,
    /// `approve_vault_owner_change`); any other code maps to `"UnknownError"`
    /// rather than failing, so this never breaks when new errors are added.
    pub fn name(&self) -> &'static str {
        match self.0 {
            14 => "ContractPaused",
            10 => "InvalidAmount",
            3 => "InvalidParameters",
            4 => "TokenNotFound",
            2 => "Unauthorized",
            8 => "ArithmeticError",
            21 => "NothingToClaim",
            20 => "CliffNotReached",
            95 => "MilestoneUnauthorized",
            96 => "MilestoneAlreadyVerified",
            97 => "VaultOwnerChangePending",
            98 => "VaultOwnerChangeNotFound",
            99 => "VaultOwnerChangeAlreadyApproved",
            130 => "VaultCircuitBreakerActive",
            133 => "StakingPoolNotFound",
            134 => "StakingNotActive",
            135 => "InvalidRewardRate",
            136 => "InsufficientStake",
            _ => "UnknownError",
        }
    }
}

impl From<Error> for soroban_sdk::Error {
    fn from(value: Error) -> Self {
        soroban_sdk::Error::from_contract_error(value.0)
    }
}

impl From<&Error> for soroban_sdk::Error {
    fn from(value: &Error) -> Self {
        soroban_sdk::Error::from_contract_error(value.0)
    }
}

impl From<soroban_sdk::Error> for Error {
    fn from(value: soroban_sdk::Error) -> Self {
        if value.is_type(soroban_sdk::xdr::ScErrorType::Contract) {
            Error(value.get_code())
        } else {
            // Preserve compatibility with existing call sites expecting a contract error.
            Error::InvalidParameters
        }
    }
}

// Buyback-and-burn campaign error codes (issue #1764).
// These are dedicated discriminants -- earlier revisions reused unrelated
// codes (e.g. ContractPaused for an inactive campaign), which made off-chain
// error decoding ambiguous.
// - CampaignNotFound      -> 51
// - CampaignInactive      -> 133
// - ExceedsStepLimit      -> 134
// - SlippageExceeded      -> 135
// - ReconciliationFailed  -> 136
// - InvariantViolation    -> 137
// - InsufficientBudget    -> 53
// - InvalidStateTransition-> 40

/// Type of pending change
///
/// Identifies which operation is being timelocked.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionType {
    FeeChange,
    TreasuryChange,
    PauseContract,
    UnpauseContract,
    PolicyUpdate,
    ParameterChange,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VoteChoice {
    For,
    Against,
    Abstain,
}

/// State transitions for a governance proposal lifecycle
///
/// A proposal moves through these states: Created → Active → Succeeded/Defeated
/// → Queued → Executed/Cancelled, with Expired/Failed as terminal states.
///
/// # Variants
/// * `Created` - Proposal just created, voting not yet started
/// * `Active` - Voting period is active
/// * `Succeeded` - Voting ended with approval threshold met and quorum satisfied
/// * `Defeated` - Voting ended without meeting approval or quorum requirements
/// * `Queued` - Succeeded proposal queued for execution after timelock
/// * `Executed` - Proposal executed successfully
/// * `Cancelled` - Proposal cancelled before execution
/// * `Expired` - Proposal never executed before expiration timestamp
/// * `Failed` - Proposal execution failed (execution reverted)
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalState {
    Created,
    Active,
    Succeeded,
    Defeated,
    Queued,
    Executed,
    Cancelled,
    Expired,
    Failed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChangeType {
    FeeUpdate,
    PauseUpdate,
    TreasuryUpdate,
}

/// Pending change awaiting timelock expiry
///
/// Represents a scheduled change that cannot be executed
/// until the timelock period has elapsed.
///
/// # Fields
/// * `id` - Unique identifier for this change
/// * `change_type` - Type of change being scheduled
/// * `scheduled_by` - Admin who scheduled the change
/// * `scheduled_at` - Timestamp when change was scheduled
/// * `execute_at` - Timestamp when change can be executed
/// * `executed` - Whether the change has been executed
/// * `base_fee` - New base fee (for FeeUpdate)
/// * `metadata_fee` - New metadata fee (for FeeUpdate)
/// * `paused` - New pause state (for PauseUpdate)
/// * `treasury` - New treasury address (for TreasuryUpdate)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingChange {
    pub id: u64,
    pub change_type: ChangeType,
    pub scheduled_by: Address,
    pub scheduled_at: u64,
    pub execute_at: u64,
    pub executed: bool,
    pub base_fee: Option<i128>,
    pub metadata_fee: Option<i128>,
    pub paused: Option<bool>,
    pub treasury: Option<Address>,
}

/// Governance proposal
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub action_type: ActionType,
    pub payload: Bytes,
    pub description: String,
    pub created_at: u64,
    pub start_time: u64,
    pub end_time: u64,
    pub eta: u64,
    /// Timelock delay (in ledgers) captured at queue time for this proposal type.
    /// Execution is blocked until `queued_at_ledger + timelock_delay` ledgers have passed.
    pub timelock_delay: u64,
    /// Ledger sequence number when the proposal was queued (set by `queue_proposal`).
    /// Zero when the proposal has not yet been queued.
    pub queued_at_ledger: u32,
    pub votes_for: i128,
    pub votes_against: i128,
    pub votes_abstain: i128,
    pub state: ProposalState,
    pub executed_at: Option<u64>,
    pub cancelled_at: Option<u64>,
    /// Circulating supply (sum of all token `total_supply`) snapshotted at proposal
    /// creation time. Used as the denominator for quorum calculations so that
    /// supply changes after creation do not affect the quorum requirement.
    pub circulating_supply_snapshot: i128,
}

/// Pagination cursor for token queries
///
/// Represents the position in a paginated result set.
/// Uses token index as the cursor for deterministic ordering.
///
/// # Fields
/// * `next_index` - The next token index to fetch (u32::MAX = end of results)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaginationCursor {
    pub next_index: u32,
}

/// Paginated token result
///
/// Contains a page of tokens and a cursor for fetching the next page.
///
/// # Fields
/// * `tokens` - Vector of token info for this page
/// * `cursor` - Cursor for next page (None = no more results)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamPage {
    pub token_indices: Vec<u32>,
    pub next_cursor: Option<u32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaginatedTokens {
    pub tokens: soroban_sdk::Vec<TokenInfo>,
    pub has_more: bool,
    pub cursor: PaginationCursor,
}

/// Keyset cursor for stream pagination.
///
/// Identifies a position in the `(created_ledger, stream_id)` ascending
/// ordering of an owner's streams. Unlike offset-based pagination, this
/// cursor is stable across concurrent inserts: a stream created after the
/// cursor was issued can never be skipped or duplicated by a subsequent
/// page fetch, because the scan always resumes strictly after the last
/// `(created_ledger, stream_id)` pair returned.
///
/// # Fields
/// * `created_ledger` - Ledger sequence number when the stream was created
/// * `stream_id` - Unique stream identifier (tiebreaker for same-ledger creates)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCursor {
    pub created_ledger: u32,
    pub stream_id: u64,
}

impl StreamCursor {
    /// True if `self` sorts strictly before `other` in `(created_ledger, stream_id)` order.
    pub fn is_before(&self, other: &StreamCursor) -> bool {
        (self.created_ledger, self.stream_id) < (other.created_ledger, other.stream_id)
    }
}

/// Response for keyset-paginated stream listings.
///
/// # Fields
/// * `streams` - Page of streams ordered by `(created_ledger, stream_id)` ascending
/// * `next_cursor` - Cursor to pass to the next call; only meaningful when `has_more` is `true`
/// * `has_more` - Whether additional streams exist beyond this page
///
/// `next_cursor` is a plain `StreamCursor` rather than `Option<StreamCursor>`
/// because `Option<T>` of a custom `#[contracttype]` is not marshalled
/// correctly by this soroban-sdk version's generated contract client when
/// nested inside another `#[contracttype]` struct — check `has_more` rather
/// than relying on an absent cursor.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaginatedStreamsResponse {
    pub streams: soroban_sdk::Vec<StreamInfo>,
    /// Cursor for the next page: empty when this is the last page, otherwise a
    /// single element.
    ///
    /// Modelled as a 0-or-1 element `Vec` rather than the more natural
    /// `Option<StreamCursor>` because soroban-sdk 27's `#[contracttype]`
    /// derives only a fallible `TryFrom<StreamCursor> for ScVal`, while the
    /// XDR crate's `ScVal: From<&Option<T>>` requires `T: Into<ScVal>`. An
    /// `Option` of a user-defined contract type therefore fails to compile in
    /// any build where `soroban-sdk/testutils` is unified in -- i.e. every
    /// test build of this crate. `has_more` remains the flag to branch on.
    pub next_cursor: soroban_sdk::Vec<StreamCursor>,
    pub has_more: bool,
}

/// Paginated vault result
///
/// Contains a page of vaults and an optional cursor for fetching the next page.
///
/// # Fields
/// * `vaults` - Vector of vault records in ascending vault_id order
/// * `next_cursor` - Cursor for next page (None = no more results)
///   - For get_vaults_page: next vault_id to fetch
///   - For get_vaults_by_owner: next index in owner's vault list
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultsPage {
    pub vaults: soroban_sdk::Vec<Vault>,
    pub next_cursor: Option<u64>,
}

/// Treasury withdrawal policy
///
/// Defines limits and controls for treasury withdrawals.
///
/// # Fields
/// * `daily_cap` - Maximum amount that can be withdrawn per day (in stroops)
/// * `allowlist_enabled` - Whether recipient allowlist is enforced
/// * `period_duration` - Duration of withdrawal period in seconds (default 86400 = 1 day)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreasuryPolicy {
    pub daily_cap: i128,
    pub allowlist_enabled: bool,
    pub period_duration: u64,
}

/// Treasury withdrawal tracking for current period
///
/// Tracks withdrawals within the current time period.
///
/// # Fields
/// * `period_start` - Timestamp when current period started
/// * `amount_withdrawn` - Total amount withdrawn in current period
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawalPeriod {
    pub period_start: u64,
    pub amount_withdrawn: i128,
}

#[cfg(all(test, feature = "legacy-tests"))]
mod tests {
    use super::{DataKey, Vault, VaultStatus};
    use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address, BytesN, Env};

    #[contract]
    struct VaultTypeTestContract;

    #[contractimpl]
    impl VaultTypeTestContract {}

    fn setup() -> (Env, Address) {
        let env = Env::default();
        let contract_id = env.register_contract(None, VaultTypeTestContract);
        (env, contract_id)
    }

    #[test]
    fn test_vault_status_serialization_round_trip() {
        let (env, contract_id) = setup();
        let variants = [
            VaultStatus::Active,
            VaultStatus::Claimed,
            VaultStatus::Cancelled,
        ];

        env.as_contract(&contract_id, || {
            for (i, status) in variants.iter().enumerate() {
                let key = DataKey::Vault(i as u64);
                env.storage().instance().set(&key, status);
                let decoded: VaultStatus = env.storage().instance().get(&key).unwrap();
                assert_eq!(decoded, *status);
            }
        });
    }

    #[test]
    fn test_vault_serialization_round_trip() {
        let (env, contract_id) = setup();
        let vault = Vault {
            id: 42,
            token: Address::generate(&env),
            owner: Address::generate(&env),
            creator: Address::generate(&env),
            total_amount: 1_000_000,
            claimed_amount: 250_000,
            unlock_time: 1_750_000_000,
            milestone_hash: BytesN::from_array(&env, &[7u8; 32]),
            status: VaultStatus::Active,
            created_at: 1_700_000_000,
        };

        env.as_contract(&contract_id, || {
            let key = DataKey::Vault(vault.id);
            env.storage().instance().set(&key, &vault);
            let decoded: Vault = env.storage().instance().get(&key).unwrap();
            assert_eq!(decoded, vault);
        });
    }

    #[test]
    fn test_vault_datakey_serialization_round_trip() {
        let (env, contract_id) = setup();
        let owner = Address::generate(&env);
        let creator = Address::generate(&env);
        let keys = [
            DataKey::Vault(99),
            DataKey::VaultCount,
            DataKey::VaultByOwner(owner, 1),
            DataKey::OwnerVaultCount(Address::generate(&env)),
            DataKey::VaultByCreator(creator, 2),
            DataKey::CreatorVaultCount(Address::generate(&env)),
        ];

        env.as_contract(&contract_id, || {
            for (i, key) in keys.iter().enumerate() {
                env.storage().instance().set(key, &(i as u32));
                let value: u32 = env.storage().instance().get(key).unwrap();
                assert_eq!(value, i as u32);
            }
        });
    }

    #[test]
    fn test_campaign_status_serialization_round_trip() {
        let (env, contract_id) = setup();
        let variants = [
            super::CampaignStatus::Active,
            super::CampaignStatus::Paused,
            super::CampaignStatus::Completed,
            super::CampaignStatus::Cancelled,
        ];

        env.as_contract(&contract_id, || {
            for (i, status) in variants.iter().enumerate() {
                let key = DataKey::BuybackCampaign(i as u64);
                env.storage().instance().set(&key, status);
                let decoded: super::CampaignStatus = env.storage().instance().get(&key).unwrap();
                assert_eq!(decoded, *status);
            }
        });
    }

    #[test]
    fn test_buyback_campaign_serialization_round_trip() {
        let (env, contract_id) = setup();
        let campaign = super::BuybackCampaign {
            id: 123,
            token_index: 5,
            creator: Address::generate(&env),
            budget: 10_000_000_0000000,
            spent: 2_500_000_0000000,
            tokens_bought: 500_000_0000000,
            execution_count: 10,
            status: super::CampaignStatus::Active,
            created_at: 1_700_000_000,
            updated_at: 1_700_100_000,
            start_time: 1_700_000_000,
            end_time: 1_700_864_000,
            min_interval: 3600,
            max_slippage_bps: 100,
            source_token: Address::generate(&env),
            target_token: Address::generate(&env),
        };

        env.as_contract(&contract_id, || {
            let key = DataKey::BuybackCampaign(campaign.id);
            env.storage().instance().set(&key, &campaign);
            let decoded: super::BuybackCampaign = env.storage().instance().get(&key).unwrap();
            assert_eq!(decoded, campaign);
        });
    }

    #[test]
    fn test_campaign_datakey_serialization_round_trip() {
        let (env, contract_id) = setup();
        let creator = Address::generate(&env);
        let keys = [
            DataKey::BuybackCampaign(42),
            DataKey::BuybackCampaignCount,
            DataKey::NextCampaignId,
            DataKey::CampaignByCreator(creator.clone(), 0),
            DataKey::CreatorCampaignCount(creator.clone()),
            DataKey::CampaignByToken(5, 0),
            DataKey::TokenCampaignCount(5),
        ];

        env.as_contract(&contract_id, || {
            for (i, key) in keys.iter().enumerate() {
                env.storage().instance().set(key, &(i as u64));
                let value: u64 = env.storage().instance().get(key).unwrap();
                assert_eq!(value, i as u64);
            }
        });
    }

    #[test]
    fn test_campaign_field_ordering_deterministic() {
        let (env, contract_id) = setup();
        
        // Create two identical campaigns
        let campaign1 = super::BuybackCampaign {
            id: 1,
            token_index: 0,
            creator: Address::generate(&env),
            budget: 1_000_000,
            spent: 0,
            tokens_bought: 0,
            execution_count: 0,
            status: super::CampaignStatus::Active,
            created_at: 1_000_000,
            updated_at: 1_000_000,
            start_time: 1_000_000,
            end_time: 2_000_000,
            min_interval: 600,
            max_slippage_bps: 100,
            source_token: Address::generate(&env),
            target_token: Address::generate(&env),
        };

        let campaign2 = super::BuybackCampaign {
            id: campaign1.id,
            token_index: campaign1.token_index,
            creator: campaign1.creator.clone(),
            budget: campaign1.budget,
            spent: campaign1.spent,
            tokens_bought: campaign1.tokens_bought,
            execution_count: campaign1.execution_count,
            status: campaign1.status,
            created_at: campaign1.created_at,
            updated_at: campaign1.updated_at,
            start_time: campaign1.start_time,
            end_time: campaign1.end_time,
            min_interval: campaign1.min_interval,
            max_slippage_bps: campaign1.max_slippage_bps,
            source_token: campaign1.source_token.clone(),
            target_token: campaign1.target_token.clone(),
        };

        // Verify they are equal
        assert_eq!(campaign1, campaign2);

        // Verify serialization produces identical results
        env.as_contract(&contract_id, || {
            env.storage().instance().set(&DataKey::BuybackCampaign(1), &campaign1);
            env.storage().instance().set(&DataKey::BuybackCampaign(2), &campaign2);
            
            let decoded1: super::BuybackCampaign = env.storage().instance().get(&DataKey::BuybackCampaign(1)).unwrap();
            let decoded2: super::BuybackCampaign = env.storage().instance().get(&DataKey::BuybackCampaign(2)).unwrap();
            
            assert_eq!(decoded1, decoded2);
        });
    }

    #[test]
    fn test_campaign_storage_retrieval_by_id() {
        let (env, contract_id) = setup();
        
        let campaigns = vec![
            super::BuybackCampaign {
                id: 0,
                token_index: 0,
                creator: Address::generate(&env),
                budget: 1_000_000,
                spent: 0,
                tokens_bought: 0,
                execution_count: 0,
                status: super::CampaignStatus::Active,
                created_at: 1_000_000,
                updated_at: 1_000_000,
                start_time: 1_000_000,
                end_time: 2_000_000,
                min_interval: 600,
                max_slippage_bps: 100,
                source_token: Address::generate(&env),
                target_token: Address::generate(&env),
            },
            super::BuybackCampaign {
                id: 1,
                token_index: 1,
                creator: Address::generate(&env),
                budget: 2_000_000,
                spent: 500_000,
                tokens_bought: 100_000,
                execution_count: 5,
                status: super::CampaignStatus::Paused,
                created_at: 1_100_000,
                updated_at: 1_200_000,
                start_time: 1_100_000,
                end_time: 2_100_000,
                min_interval: 900,
                max_slippage_bps: 200,
                source_token: Address::generate(&env),
                target_token: Address::generate(&env),
            },
        ];

        env.as_contract(&contract_id, || {
            // Store campaigns
            for campaign in &campaigns {
                env.storage().instance().set(&DataKey::BuybackCampaign(campaign.id), campaign);
            }

            // Retrieve and verify each campaign
            for campaign in &campaigns {
                let retrieved: super::BuybackCampaign = 
                    env.storage().instance().get(&DataKey::BuybackCampaign(campaign.id)).unwrap();
                assert_eq!(retrieved, *campaign);
            }
        });
    }

    #[test]
    fn test_campaign_storage_retrieval_by_creator() {
        let (env, contract_id) = setup();
        let creator = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // Store campaign indexes for creator
            env.storage().instance().set(&DataKey::CampaignByCreator(creator.clone(), 0), &10u64);
            env.storage().instance().set(&DataKey::CampaignByCreator(creator.clone(), 1), &20u64);
            env.storage().instance().set(&DataKey::CreatorCampaignCount(creator.clone()), &2u32);

            // Retrieve and verify
            let campaign_id_0: u64 = env.storage().instance().get(&DataKey::CampaignByCreator(creator.clone(), 0)).unwrap();
            let campaign_id_1: u64 = env.storage().instance().get(&DataKey::CampaignByCreator(creator.clone(), 1)).unwrap();
            let count: u32 = env.storage().instance().get(&DataKey::CreatorCampaignCount(creator.clone())).unwrap();

            assert_eq!(campaign_id_0, 10);
            assert_eq!(campaign_id_1, 20);
            assert_eq!(count, 2);
        });
    }

    #[test]
    fn test_campaign_storage_retrieval_by_token() {
        let (env, contract_id) = setup();
        let token_index = 5u32;

        env.as_contract(&contract_id, || {
            // Store campaign indexes for token
            env.storage().instance().set(&DataKey::CampaignByToken(token_index, 0), &100u64);
            env.storage().instance().set(&DataKey::CampaignByToken(token_index, 1), &200u64);
            env.storage().instance().set(&DataKey::TokenCampaignCount(token_index), &2u32);

            // Retrieve and verify
            let campaign_id_0: u64 = env.storage().instance().get(&DataKey::CampaignByToken(token_index, 0)).unwrap();
            let campaign_id_1: u64 = env.storage().instance().get(&DataKey::CampaignByToken(token_index, 1)).unwrap();
            let count: u32 = env.storage().instance().get(&DataKey::TokenCampaignCount(token_index)).unwrap();

            assert_eq!(campaign_id_0, 100);
            assert_eq!(campaign_id_1, 200);
            assert_eq!(count, 2);
        });
    }

    #[test]
    fn test_campaign_status_all_variants() {
        let (env, contract_id) = setup();
        
        let statuses = [
            (super::CampaignStatus::Active, "Active"),
            (super::CampaignStatus::Paused, "Paused"),
            (super::CampaignStatus::Completed, "Completed"),
            (super::CampaignStatus::Cancelled, "Cancelled"),
        ];

        env.as_contract(&contract_id, || {
            for (i, (status, _name)) in statuses.iter().enumerate() {
                let key = DataKey::BuybackCampaign(i as u64);
                env.storage().instance().set(&key, status);
                let decoded: super::CampaignStatus = env.storage().instance().get(&key).unwrap();
                assert_eq!(decoded, *status);
            }
        });
    }

    #[test]
    fn test_campaign_with_max_values() {
        let (env, contract_id) = setup();
        
        let campaign = super::BuybackCampaign {
            id: u64::MAX,
            token_index: u32::MAX,
            creator: Address::generate(&env),
            budget: i128::MAX,
            spent: i128::MAX,
            tokens_bought: i128::MAX,
            execution_count: u32::MAX,
            status: super::CampaignStatus::Completed,
            created_at: u64::MAX,
            updated_at: u64::MAX,
            start_time: u64::MAX,
            end_time: u64::MAX,
            min_interval: u64::MAX,
            max_slippage_bps: u32::MAX,
            source_token: Address::generate(&env),
            target_token: Address::generate(&env),
        };

        env.as_contract(&contract_id, || {
            env.storage().instance().set(&DataKey::BuybackCampaign(campaign.id), &campaign);
            let decoded: super::BuybackCampaign = env.storage().instance().get(&DataKey::BuybackCampaign(campaign.id)).unwrap();
            assert_eq!(decoded, campaign);
        });
    }

    #[test]
    fn test_campaign_with_min_values() {
        let (env, contract_id) = setup();
        
        let campaign = super::BuybackCampaign {
            id: 0,
            token_index: 0,
            creator: Address::generate(&env),
            budget: 0,
            spent: 0,
            tokens_bought: 0,
            execution_count: 0,
            status: super::CampaignStatus::Active,
            created_at: 0,
            updated_at: 0,
            start_time: 0,
            end_time: 0,
            min_interval: 0,
            max_slippage_bps: 0,
            source_token: Address::generate(&env),
            target_token: Address::generate(&env),
        };

        env.as_contract(&contract_id, || {
            env.storage().instance().set(&DataKey::BuybackCampaign(campaign.id), &campaign);
            let decoded: super::BuybackCampaign = env.storage().instance().get(&DataKey::BuybackCampaign(campaign.id)).unwrap();
            assert_eq!(decoded, campaign);
        });
    }
}
// ═══════════════════════════════════════════════════════════════════════
// Token Fractionalization Types
// ═══════════════════════════════════════════════════════════════════════

/// Fractionalized asset vault containing locked NFT-like asset
///
/// Represents a unique asset that has been locked in the contract
/// and fractionalized into fungible tokens representing ownership shares.
///
/// # Fields
/// * `id` - Unique vault identifier
/// * `asset_id` - Unique identifier of the locked asset (e.g., NFT token ID)
/// * `asset_contract` - Contract address of the original asset
/// * `owner` - Original owner who fractionalized the asset
/// * `fractional_token` - Address of the minted fractional tokens
/// * `total_supply` - Total supply of fractional tokens minted
/// * `created_at` - Timestamp when asset was fractionalized
/// * `status` - Current status of the fractionalized asset
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FractionalVault {
    pub id: u64,
    pub asset_id: BytesN<32>,
    pub asset_contract: Address,
    pub owner: Address,
    pub fractional_token: Address,
    pub total_supply: i128,
    pub created_at: u64,
    pub status: FractionalStatus,
}

/// Status of a fractionalized asset
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FractionalStatus {
    /// Asset is locked and fractional tokens are in circulation
    Active,
    /// Asset has been redeemed and returned to owner
    Redeemed,
}

/// Parameters for fractionalizing an asset
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FractionalizationParams {
    pub asset_id: BytesN<32>,
    pub asset_contract: Address,
    pub total_supply: i128,
    pub token_name: String,
    pub token_symbol: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Fee Update Governance Types (#1385)
// ─────────────────────────────────────────────────────────────────────────────

/// A governance proposal for updating the factory fee structure.
///
/// Must pass quorum and wait for the timelock ETA before execution.
/// Separate from the general proposal system for simplicity.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeUpdateProposal {
    pub proposal_id: u64,
    pub proposer: Address,
    pub new_base_fee: Option<i128>,
    pub new_metadata_fee: Option<i128>,
    pub proposed_at: u64,
    /// Earliest ledger timestamp at which the proposal may be executed
    pub eta: u64,
    pub executed: bool,
    pub cancelled: bool,
    pub yes_votes: i128,
    pub no_votes: i128,
    pub quorum_required: i128,
    pub queued: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull-model Dividend Distribution Types (#1148)
// ─────────────────────────────────────────────────────────────────────────────

/// An on-chain dividend distribution round (pull model).
///
/// Created by `initiate_distribution`; each holder independently calls
/// `claim_dividend` during the claim window.  After `claim_deadline_ledger`
/// passes, unclaimed funds can be recovered by the admin via `reclaim_unclaimed`.
///
/// # Fields
/// * `id`                      – Unique distribution identifier (auto-increment)
/// * `token_index`             – Index of the token whose holders receive dividends
/// * `asset`                   – Address of the asset being distributed (e.g. XLM token)
/// * `total_amount`            – Total pool size funded by the initiator
/// * `snapshot_ledger`         – Ledger at which holder balances were snapshotted
/// * `total_supply_at_snapshot`– Token total supply at snapshot (denominator for pro-rata)
/// * `claim_deadline_ledger`   – Last ledger at which holders may claim
/// * `reclaimed`               – Whether the admin has already reclaimed unclaimed funds
/// * `created_at`              – Ledger timestamp of distribution creation
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DistributionRecord {
    pub id: u32,
    pub token_index: u32,
    pub asset: Address,
    pub total_amount: i128,
    pub snapshot_ledger: u32,
    pub total_supply_at_snapshot: i128,
    pub claim_deadline_ledger: u32,
    pub reclaimed: bool,
    pub created_at: u64,
}