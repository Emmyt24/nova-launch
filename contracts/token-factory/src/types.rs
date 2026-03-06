use soroban_sdk::{contracterror, contracttype, Address, String, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FactoryState {
    pub admin: Address,
    pub treasury: Address,
    pub base_fee: i128,
    pub metadata_fee: i128,
}

/// Event schema versioning for backend indexer stability.
/// All stream events follow the versioning pattern: {event_type}_v{version}
/// This ensures compatibility across contract upgrades and allows indexers to
/// handle schema changes gracefully.
/// 
/// # Event Topics Reference
/// - stream_created_v1: Emitted when a new token stream is created
/// - stream_claimed_v1: Emitted when stream tokens are claimed/distributed
/// - stream_cancelled_v1: Emitted when a stream is cancelled
/// - stream_paused_v1: Emitted when a stream is paused
/// 
/// # Payload Schema
/// Each event payload includes:
/// - event_version: Version of the event schema (u32)
/// - timestamp: Block time in seconds (u64)
/// - Versioned contents specific to each event (see individual types)

/// Stream Created Event (v1) - Emitted when a new token stream is initiated
///
/// # Payload Schema v1
/// ```json
/// {
///   "event_version": 1,
///   "timestamp": 1234567890,
///   "stream_id": "abc123...",
///   "creator": "GXXXXXX...",
///   "beneficiary": "GYYYYYY...",
///   "token_address": "CZZZZZZ...",
///   "total_amount": 1000000,
///   "start_time": 1234567890,
///   "duration_seconds": 2592000
/// }
/// ```
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCreatedV1 {
    pub event_version: u32,
    pub timestamp: u64,
    pub stream_id: String,
    pub creator: Address,
    pub beneficiary: Address,
    pub token_address: Address,
    pub total_amount: i128,
    pub start_time: u64,
    pub duration_seconds: u64,
}

/// Stream Claimed Event (v1) - Emitted when tokens are claimed from a stream
///
/// # Payload Schema v1
/// ```json
/// {
///   "event_version": 1,
///   "timestamp": 1234567890,
///   "stream_id": "abc123...",
///   "claimer": "GXXXXXX...",
///   "claimed_amount": 250000,
///   "remaining_amount": 750000,
///   "claim_count": 1
/// }
/// ```
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamClaimedV1 {
    pub event_version: u32,
    pub timestamp: u64,
    pub stream_id: String,
    pub claimer: Address,
    pub claimed_amount: i128,
    pub remaining_amount: i128,
    pub claim_count: u32,
}

/// Stream Cancelled Event (v1) - Emitted when a stream is cancelled
///
/// # Payload Schema v1
/// ```json
/// {
///   "event_version": 1,
///   "timestamp": 1234567890,
///   "stream_id": "abc123...",
///   "canceller": "GXXXXXX...",
///   "beneficiary_received": 250000,
///   "creator_refunded": 750000,
///   "cancellation_reason": "completed|manual_cancel"
/// }
/// ```
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCancelledV1 {
    pub event_version: u32,
    pub timestamp: u64,
    pub stream_id: String,
    pub canceller: Address,
    pub beneficiary_received: i128,
    pub creator_refunded: i128,
    pub cancellation_reason: String,
}

/// Stream Paused Event (v1) - Emitted when a stream is paused
///
/// # Payload Schema v1
/// ```json
/// {
///   "event_version": 1,
///   "timestamp": 1234567890,
///   "stream_id": "abc123...",
///   "pauser": "GXXXXXX...",
///   "paused_at_timestamp": 1234567890,
///   "remaining_amount": 750000,
///   "pause_reason": "user_request|insufficient_funds"
/// }
/// ```
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamPausedV1 {
    pub event_version: u32,
    pub timestamp: u64,
    pub stream_id: String,
    pub pauser: Address,
    pub paused_at_timestamp: u64,
    pub remaining_amount: i128,
    pub pause_reason: String,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenInfo {
    pub address: Address,
    pub creator: Address,
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    pub total_supply: i128,
    pub metadata_uri: Option<String>,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Treasury,
    BaseFee,
    MetadataFee,
    TokenCount,
    Token(u32), // Token index -> TokenInfo
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InsufficientFee = 1,
    Unauthorized = 2,
    InvalidParameters = 3,
    TokenNotFound = 4,
    MetadataAlreadySet = 5,
    AlreadyInitialized = 6,
}
