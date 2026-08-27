//! Supporting types for the payment-streaming / vesting feature (Issue #1765).
//!
//! `StreamInfo`, `StreamParams`, `Milestone`, `RecurringStream`,
//! `RecurringStreamParams`, `StreamCursor` and `PaginatedStreamsResponse`
//! already live in `types.rs` (pre-existing scaffolding shared with other
//! stream-storage/pagination code); this module holds the pieces that are
//! new for this feature — the metadata-update request shape and the bounds
//! that keep batch creation and recurring streams gas/storage-safe.

use soroban_sdk::{contracttype, String};

pub use crate::types::{
    Milestone, PaginatedStreamsResponse, RecurringStream, RecurringStreamParams, StreamCursor,
    StreamInfo, StreamParams,
};

/// Maximum number of streams that may be created in a single `batch_create_streams` call.
pub const MAX_BATCH_SIZE: u32 = 100;

/// Maximum number of milestones a single stream may carry, bounding the
/// per-claim milestone scan and the storage cost of a `StreamInfo` record.
pub const MAX_MILESTONES_PER_STREAM: u32 = 20;

/// Maximum number of periods a recurring stream may be configured to create,
/// bounding total gas/storage growth for a single recurring schedule.
pub const MAX_RECURRING_PERIODS: u32 = 10_000;

/// Maximum number of child stream ids a recurring stream tracks in
/// `RecurringStream::child_streams`. Once reached, no further periods can be
/// triggered even if `auto_renew` is set — this bounds the size of a single
/// `RecurringStream` storage record.
pub const MAX_TRACKED_CHILD_STREAMS: u32 = 1_000;

/// Request payload for updating a stream's metadata.
///
/// Kept as a distinct type (rather than a bare `Option<String>` parameter)
/// so the metadata-update entry point has a stable, self-documenting shape
/// that can grow additional fields later without changing its signature.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateStreamMetadataRequest {
    pub stream_id: u64,
    pub metadata: Option<String>,
}

/// Result of a `batch_create_streams` call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchCreateStreamsResult {
    /// Ids of the newly created streams, in input order.
    pub stream_ids: soroban_sdk::Vec<u64>,
}
