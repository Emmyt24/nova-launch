#![cfg(test)]
//! Property 57: Campaign execution event idempotency
//!
//! Proves that replaying a campaign execution event with the same `tx_hash`
//! leaves `current_amount` (spent) and `execution_count` unchanged.
//!
//! Covers campaign types: BUYBACK, AIRDROP, LIQUIDITY.
//! Runs ≥ 100 proptest iterations per property.

extern crate std;

use proptest::prelude::*;
use std::collections::HashSet;
use std::string::String;

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CampaignType {
    Buyback,
    Airdrop,
    Liquidity,
}

#[derive(Clone, Debug)]
struct ExecutionEvent {
    tx_hash: String,
    spend_amount: i128,
}

#[derive(Clone, Debug)]
struct CampaignState {
    campaign_type: CampaignType,
    budget: i128,
    current_amount: i128,  // total spent so far
    execution_count: u32,
    seen_tx_hashes: HashSet<String>,
}

impl CampaignState {
    fn new(campaign_type: CampaignType, budget: i128) -> Self {
        Self {
            campaign_type,
            budget,
            current_amount: 0,
            execution_count: 0,
            seen_tx_hashes: HashSet::new(),
        }
    }

    /// Apply an execution event. Returns `true` if the event was applied,
    /// `false` if it was a duplicate (idempotent replay).
    fn apply(&mut self, event: &ExecutionEvent) -> bool {
        // Idempotency guard: duplicate tx_hash is a no-op
        if self.seen_tx_hashes.contains(&event.tx_hash) {
            return false;
        }

        let spend = event.spend_amount.max(0).min(self.budget - self.current_amount);
        self.current_amount += spend;
        self.execution_count = self.execution_count.saturating_add(1);
        self.seen_tx_hashes.insert(event.tx_hash.clone());
        true
    }
}

// ---------------------------------------------------------------------------
// Proptest strategies
// ---------------------------------------------------------------------------

fn campaign_type_strategy() -> impl Strategy<Value = CampaignType> {
    prop_oneof![
        Just(CampaignType::Buyback),
        Just(CampaignType::Airdrop),
        Just(CampaignType::Liquidity),
    ]
}

fn tx_hash_strategy() -> impl Strategy<Value = String> {
    // Small alphabet keeps duplicates frequent enough to exercise idempotency
    "[a-f0-9]{4}".prop_map(|s| s)
}

fn event_strategy() -> impl Strategy<Value = ExecutionEvent> {
    (tx_hash_strategy(), 1i128..=500_000i128).prop_map(|(tx_hash, spend_amount)| {
        ExecutionEvent { tx_hash, spend_amount }
    })
}

// ---------------------------------------------------------------------------
// Property 57: idempotency under duplicate tx_hash replay
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// Property 57 – Campaign execution event idempotency
    ///
    /// For any sequence of execution events, replaying an event whose
    /// `tx_hash` has already been processed must leave `current_amount`
    /// and `execution_count` unchanged.
    #[test]
    fn prop57_execution_event_idempotency(
        campaign_type in campaign_type_strategy(),
        budget in 1_000i128..=10_000_000i128,
        events in prop::collection::vec(event_strategy(), 1..40),
        replay_indices in prop::collection::vec(0usize..40, 1..10),
    ) {
        let mut state = CampaignState::new(campaign_type, budget);

        // Apply the initial event sequence
        for event in &events {
            state.apply(event);
        }

        // Replay selected events and assert idempotency
        for &idx in &replay_indices {
            let event = &events[idx % events.len()];

            // Only assert idempotency for hashes already seen
            if state.seen_tx_hashes.contains(&event.tx_hash) {
                let amount_before = state.current_amount;
                let count_before = state.execution_count;

                let applied = state.apply(event);

                prop_assert!(
                    !applied,
                    "duplicate tx_hash '{}' should be rejected (campaign_type={:?})",
                    event.tx_hash,
                    campaign_type,
                );
                prop_assert_eq!(
                    state.current_amount,
                    amount_before,
                    "current_amount changed on replay of tx_hash '{}' (campaign_type={:?})",
                    event.tx_hash,
                    campaign_type,
                );
                prop_assert_eq!(
                    state.execution_count,
                    count_before,
                    "execution_count changed on replay of tx_hash '{}' (campaign_type={:?})",
                    event.tx_hash,
                    campaign_type,
                );
            }
        }
    }

    /// Property 57b – Monotonic invariants hold after idempotent replays
    ///
    /// `current_amount` and `execution_count` must never decrease, even
    /// when duplicate events are interspersed with fresh ones.
    #[test]
    fn prop57b_monotonic_after_replay(
        campaign_type in campaign_type_strategy(),
        budget in 1_000i128..=10_000_000i128,
        events in prop::collection::vec(event_strategy(), 2..50),
    ) {
        let mut state = CampaignState::new(campaign_type, budget);
        let mut prev_amount = 0i128;
        let mut prev_count = 0u32;

        for (i, event) in events.iter().enumerate() {
            state.apply(event);

            prop_assert!(
                state.current_amount >= prev_amount,
                "current_amount regressed at step {i} (campaign_type={:?}): {} < {}",
                campaign_type,
                state.current_amount,
                prev_amount,
            );
            prop_assert!(
                state.execution_count >= prev_count,
                "execution_count regressed at step {i} (campaign_type={:?}): {} < {}",
                campaign_type,
                state.execution_count,
                prev_count,
            );
            prop_assert!(
                state.current_amount <= state.budget,
                "current_amount exceeded budget at step {i} (campaign_type={:?})",
                campaign_type,
            );

            prev_amount = state.current_amount;
            prev_count = state.execution_count;
        }
    }
}
