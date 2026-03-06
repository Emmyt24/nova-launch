/// Event emission helpers for versioned stream events.
/// This module provides safe, type-checked methods for emitting stream events
/// with version tracking for backend indexer stability.

use soroban_sdk::{Env, Symbol, String};
use crate::types::{StreamCreatedV1, StreamClaimedV1, StreamCancelledV1, StreamPausedV1};

/// Emit a stream created event (v1)
/// 
/// Topic: "stream_created_v1"
/// 
/// # Arguments
/// - `env`: The contract environment
/// - `event`: The `StreamCreatedV1` event payload
pub fn emit_stream_created(env: &Env, event: StreamCreatedV1) {
    let topics = (Symbol::new(env, "stream_created_v1"),);
    env.events().publish(topics, event);
}

/// Emit a stream claimed event (v1)
/// 
/// Topic: "stream_claimed_v1"
/// 
/// # Arguments
/// - `env`: The contract environment
/// - `event`: The `StreamClaimedV1` event payload
pub fn emit_stream_claimed(env: &Env, event: StreamClaimedV1) {
    let topics = (Symbol::new(env, "stream_claimed_v1"),);
    env.events().publish(topics, event);
}

/// Emit a stream cancelled event (v1)
/// 
/// Topic: "stream_cancelled_v1"
/// 
/// # Arguments
/// - `env`: The contract environment
/// - `event`: The `StreamCancelledV1` event payload
pub fn emit_stream_cancelled(env: &Env, event: StreamCancelledV1) {
    let topics = (Symbol::new(env, "stream_cancelled_v1"),);
    env.events().publish(topics, event);
}

/// Emit a stream paused event (v1)
/// 
/// Topic: "stream_paused_v1"
/// 
/// # Arguments
/// - `env`: The contract environment
/// - `event`: The `StreamPausedV1` event payload
pub fn emit_stream_paused(env: &Env, event: StreamPausedV1) {
    let topics = (Symbol::new(env, "stream_paused_v1"),);
    env.events().publish(topics, event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Address;

    #[test]
    fn test_stream_created_event_structure() {
        let event = StreamCreatedV1 {
            event_version: 1,
            timestamp: 1234567890,
            stream_id: String::from_small_str("stream_001"),
            creator: Address::random(&soroban_sdk::testutils::random()),
            beneficiary: Address::random(&soroban_sdk::testutils::random()),
            token_address: Address::random(&soroban_sdk::testutils::random()),
            total_amount: 1000000,
            start_time: 1234567890,
            duration_seconds: 2592000,
        };
        
        assert_eq!(event.event_version, 1);
        assert_eq!(event.total_amount, 1000000);
        assert_eq!(event.duration_seconds, 2592000);
    }
}
