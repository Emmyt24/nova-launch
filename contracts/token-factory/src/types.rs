#![allow(dead_code)]

use soroban_sdk::{contracterror, contracttype, Address, String, Vec};

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
/// * `created_at` - Unix timestamp of token creation
/// * `total_burned` - Cumulative amount of tokens burned
/// * `burn_count` - Number of burn operations performed
/// * `metadata_uri` - Optional IPFS URI for additional metadata
/// * `created_at` - Unix timestamp of token creation
/// * `clawback_enabled` - Whether admin can burn from any address
///
/// # Examples
/// ```
/// let token_info = factory.get_token_info(&env, 0)?;
/// assert_eq!(token_info.symbol, "MTK");
/// ```
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stream {
    pub stream_id: String,
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
    pub created_at: u64,
    pub is_paused: bool,
}

/// Compact read-only snapshot of a token's current state.
/// Returned by get_token_stats().
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenStats {
    pub current_supply: i128,
    pub total_burned: i128,
    pub burn_count: u32,
    pub is_paused: bool,
    pub has_clawback: bool,
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

/// Storage keys for contract data
///
/// Defines all storage locations used by the factory contract.
/// Each variant maps to a specific piece of contract state.
///
/// # Variants
/// * `Admin` - Factory administrator address
/// * `Treasury` - Fee collection address
/// * `BaseFee` - Base deployment fee amount
/// * `MetadataFee` - Metadata deployment fee amount
/// * `TokenCount` - Total number of tokens created
/// * `Token(u32)` - Token info by index
/// * `Balance(u32, Address)` - Token balance for holder
/// * `BurnCount(u32)` - Number of burns for token
/// * `TokenByAddress(Address)` - Token info lookup by address
/// * `Paused` - Contract pause state
/// * `TimelockConfig` - Timelock configuration
/// * `PendingChange(u64)` - Pending change by ID
/// * `NextChangeId` - Next available change ID
/// * `CreatorTokens(Address)` - Vector of token indices for a creator
/// * `CreatorTokenCount(Address)` - Number of tokens created by address
/// * `TreasuryPolicy` - Treasury withdrawal policy
/// * `WithdrawalPeriod` - Current withdrawal period tracking
/// * `AllowedRecipient(Address)` - Whether address is allowed recipient
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
    PendingChange(u64),
    NextChangeId,
    CreatorTokens(Address),
    CreatorTokenCount(Address),
    TreasuryPolicy,
    WithdrawalPeriod,
    AllowedRecipient(Address),
    // Stream management keys
    StreamCount,                    // Total number of streams created
    Stream(u64),                    // Stream info by ID (using u64 for consistency)
    NextStreamId,                   // Next available stream ID
    // Governance proposal keys
    ProposalCount,                  // Total number of proposals created
    Proposal(u64),                  // Proposal by ID
    NextProposalId,                 // Next available proposal ID
    ProposalVote(u64, Address),     // Vote by proposal ID and voter address
}

/// Contract error codes
///
/// Defines all possible error conditions that can occur during
/// contract execution. Each error has a unique numeric code.
///
/// # Variants
/// * `InsufficientFee` - Provided fee is less than required
/// * `Unauthorized` - Caller lacks required permissions
/// * `InvalidParameters` - Function arguments are invalid
/// * `TokenNotFound` - Requested token does not exist
/// * `MetadataAlreadySet` - Token metadata cannot be changed
/// * `AlreadyInitialized` - Contract has already been initialized
/// * `InsufficientBalance` - Account balance too low for operation
/// * `ArithmeticError` - Numeric overflow or underflow occurred
/// * `BatchTooLarge` - Batch operation exceeds maximum size
/// * `InvalidAmount` - Amount is zero or negative
/// * `ClawbackDisabled` - Clawback not enabled for this token
/// * `InvalidBurnAmount` - Burn amount is invalid
/// * `BurnAmountExceedsBalance` - Burn amount exceeds available balance
/// * `ContractPaused` - Operation not allowed while paused
/// * `TimelockNotExpired` - Timelock period has not elapsed
/// * `ChangeAlreadyExecuted` - Change has already been executed
/// * `MaxSupplyExceeded` - Minting would exceed max supply cap
/// * `InvalidMaxSupply` - Max supply is less than initial supply
/// * `WithdrawalCapExceeded` - Withdrawal would exceed daily cap
/// * `RecipientNotAllowed` - Recipient not in allowlist
///
/// # Examples
/// ```
/// if amount <= 0 {
///     return Err(Error::InvalidAmount);
/// }
/// ```
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InsufficientFee     = 1,
    Unauthorized        = 2,
    InvalidParameters   = 3,
    TokenNotFound       = 4,
    MetadataAlreadySet  = 5,
    AlreadyInitialized  = 6,
    InsufficientBalance = 7,
    ArithmeticError     = 8,
    BatchTooLarge       = 9,
    TokenPaused         = 10,
    InvalidAmount = 11,
    ClawbackDisabled = 12,
    InvalidBurnAmount = 13,
    BurnAmountExceedsBalance = 14,
    ContractPaused = 15,
    InvalidTokenParams = 16,
    BatchCreationFailed = 17,
    TimelockNotExpired = 18,
    ChangeAlreadyExecuted = 19,
    MaxSupplyExceeded = 20,
    InvalidMaxSupply = 21,
    WithdrawalCapExceeded = 22,
    RecipientNotAllowed = 23,
    MissingAdmin = 24,
    MissingTreasury = 25,
    InvalidBaseFee = 26,
    InvalidMetadataFee = 27,
    InconsistentTokenCount = 28,
    StreamNotFound = 29,
    StreamCancelled = 30,
    NothingToClaim = 31,
    InvalidTimeWindow = 32,
    PayloadTooLarge = 33,
    ProposalNotFound = 34,
    VotingNotStarted = 35,
    VotingEnded = 36,
    AlreadyVoted = 37,
}

/// Type of pending change
///
/// Identifies which operation is being timelocked.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChangeType {
    FeeUpdate,
    PauseUpdate,
    TreasuryUpdate,
}

/// Type of governance action
///
/// Identifies the type of action proposed in a governance proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActionType {
    FeeChange,
    TreasuryChange,
    PauseContract,
    UnpauseContract,
    PolicyUpdate,
}

/// Vote choice for a proposal
///
/// Represents the voter's position on a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoteChoice {
    For,
    Against,
    Abstain,
}

/// Governance proposal
///
/// Represents a proposal for a governance action with voting period.
///
/// # Fields
/// * `id` - Unique proposal identifier
/// * `proposer` - Address that created the proposal
/// * `action_type` - Type of action being proposed
/// * `payload` - Encoded action payload (bounded to 1024 bytes)
/// * `start_time` - Voting start timestamp
/// * `end_time` - Voting end timestamp
/// * `eta` - Estimated time of execution after approval
/// * `created_at` - Timestamp when proposal was created
/// * `votes_for` - Number of votes in favor
/// * `votes_against` - Number of votes against
/// * `votes_abstain` - Number of abstain votes
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub action_type: ActionType,
    pub payload: Vec<u8>,
    pub start_time: u64,
    pub end_time: u64,
    pub eta: u64,
    pub created_at: u64,
    pub votes_for: u32,
    pub votes_against: u32,
    pub votes_abstain: u32,
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
// NOTE: Cannot be #[contracttype] because Option<PaginationCursor> is not serializable
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaginatedTokens {
    pub tokens: soroban_sdk::Vec<TokenInfo>,
    pub cursor: Option<u32>,
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

/// Stream information
///
/// Contains all data for a payment stream including vesting schedule.
///
/// # Fields
/// * `id` - Unique stream identifier
/// * `creator` - Address that created the stream
/// * `recipient` - Address that receives vested tokens
/// * `token_index` - Index of the token being streamed
/// * `total_amount` - Total amount to be vested
/// * `claimed_amount` - Amount already claimed by recipient
/// * `start_time` - Stream start timestamp
/// * `end_time` - Stream end timestamp (full vesting)
/// * `cliff_time` - Cliff timestamp (no claims before this)
/// * `cancelled` - Whether the stream has been cancelled
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
    pub cancelled: bool,
}

/// Stream creation parameters
///
/// Parameters for creating a new payment stream.
///
/// # Fields
/// * `recipient` - Address that will receive vested tokens
/// * `token_index` - Index of the token to stream
/// * `total_amount` - Total amount to vest
/// * `start_time` - Stream start timestamp
/// * `end_time` - Stream end timestamp
/// * `cliff_time` - Cliff timestamp
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

/// Timelock configuration
///
/// Defines the delay period for timelocked operations.
///
/// # Fields
/// * `delay_seconds` - Delay in seconds before changes can be executed
/// * `enabled` - Whether timelock is enabled
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockConfig {
    pub delay_seconds: u64,
    pub enabled: bool,
}

