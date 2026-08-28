use crate::storage;
/// invariants.rs
///
/// Internal correctness assertions for the token-factory contract.
/// These functions are called after sensitive write paths in test/debug
/// builds. They are zero-cost in release builds.
///
/// Three invariant families:
///   1. Supply conservation   — current_supply + total_burned == initial_supply
///   2. Monotonic counters    — token_count and stream_counts never decrease
///   3. Proposal terminal-state immutability  — (governance placeholder)
use soroban_sdk::Env;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Supply Conservation
// ─────────────────────────────────────────────────────────────────────────────

/// Assert that `current_supply + total_burned == initial_supply` for the
/// given token.
///
/// Panics in debug/test builds when the invariant is violated.
pub fn assert_supply_conservation(env: &Env, token_index: u32, initial_supply: i128) {
    let info = storage::get_token_info(env, token_index).expect("invariant: token must exist");

    let current_supply = info.total_supply;
    let total_burned = storage::get_total_burned(env, token_index);

    let reconstructed = current_supply
        .checked_add(total_burned)
        .expect("invariant: supply + burned overflows i128");

    assert_eq!(
        reconstructed, initial_supply,
        "INVARIANT VIOLATION [supply_conservation]: \
         current_supply({}) + total_burned({}) = {} != initial_supply({})",
        current_supply, total_burned, reconstructed, initial_supply,
    );
}

/// Assert that `current_supply` is non-negative.
pub fn assert_supply_non_negative(env: &Env, token_index: u32) {
    let info = storage::get_token_info(env, token_index).expect("invariant: token must exist");

    assert!(
        info.total_supply >= 0,
        "INVARIANT VIOLATION [supply_non_negative]: \
         total_supply({}) must not be negative",
        info.total_supply,
    );
}

/// Assert that `total_burned` is non-negative and does not exceed
/// `initial_supply`.
pub fn assert_burned_within_bounds(env: &Env, token_index: u32, initial_supply: i128) {
    let total_burned = storage::get_total_burned(env, token_index);

    assert!(
        total_burned >= 0,
        "INVARIANT VIOLATION [burned_non_negative]: total_burned({}) < 0",
        total_burned,
    );

    assert!(
        total_burned <= initial_supply,
        "INVARIANT VIOLATION [burned_within_bounds]: \
         total_burned({}) > initial_supply({})",
        total_burned,
        initial_supply,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Monotonic Counters
// ─────────────────────────────────────────────────────────────────────────────

/// Assert that the global token count has not decreased below `floor`.
/// Call with the count captured before a write to confirm it did not regress.
pub fn assert_token_count_monotonic(env: &Env, floor: u32) {
    let current = storage::get_token_count(env);
    assert!(
        current >= floor,
        "INVARIANT VIOLATION [token_count_monotonic]: \
         token_count({}) < floor({})",
        current,
        floor,
    );
}

/// Assert that the stream count for a beneficiary has not decreased below
/// `floor`.
pub fn assert_stream_count_monotonic(env: &Env, beneficiary: &soroban_sdk::Address, floor: u32) {
    let current = storage::get_beneficiary_stream_count(env, beneficiary);
    assert!(
        current >= floor,
        "INVARIANT VIOLATION [stream_count_monotonic]: \
         stream_count({}) < floor({}) for beneficiary",
        current,
        floor,
    );
}

/// Assert that `burn_count` for a token has not decreased below `floor`.
pub fn assert_burn_count_monotonic(env: &Env, token_index: u32, floor: u32) {
    let current = storage::get_burn_count(env, token_index);
    assert!(
        current >= floor,
        "INVARIANT VIOLATION [burn_count_monotonic]: \
         burn_count({}) < floor({}) for token_index({})",
        current,
        floor,
        token_index,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Proposal Terminal-State Immutability
//    (governance is not yet wired into storage, so these work against a
//     locally-supplied `ProposalStatus` value — ready to plug in when
//     the governance module lands)
// ─────────────────────────────────────────────────────────────────────────────

/// Possible proposal lifecycle states.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Pending,
    Active,
    Executed,
    Rejected,
}

impl ProposalStatus {
    /// A proposal in a terminal state must never transition to any other state.
    pub fn is_terminal(self) -> bool {
        matches!(self, ProposalStatus::Executed | ProposalStatus::Rejected)
    }
}

/// Assert that a terminal-state proposal has not been mutated.
/// `before` is the status captured before the attempted write;
/// `after` is the status observed after.
pub fn assert_terminal_state_immutable(before: ProposalStatus, after: ProposalStatus) {
    if before.is_terminal() {
        assert_eq!(
            before, after,
            "INVARIANT VIOLATION [terminal_state_immutable]: \
             proposal transitioned out of terminal state {:?} → {:?}",
            before, after,
        );
    }
}
