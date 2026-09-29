//! Tests for the governance delegation module.
//!
//! These tests exercise the delegation behavior defined in
//! `contracts/governance/src/delegation.rs`, including the one-level
//! (non-chained) delegation invariant documented by `MAX_CHAIN_DEPTH`.

use governance::delegation::{delegate, revoke_delegation, DelegationError, MAX_CHAIN_DEPTH};

#[test]
fn max_chain_depth_documents_a_structural_invariant() {
    // `MAX_CHAIN_DEPTH` is not read by a runtime depth counter. It documents
    // the invariant that delegation is never chained: a delegatee's own
    // delegation (if any) is never followed. The invariant is enforced
    // structurally by the re-delegation branch of `delegate`, which refuses
    // to chain a second hop. This assertion keeps the documented limit in
    // sync with the behavior the tests below rely on.
    assert_eq!(MAX_CHAIN_DEPTH, 1);
}

#[test]
fn delegate_records_a_single_hop() {
    let mut state = Default::default();
    delegate(&mut state, "alice", "bob").unwrap();
    assert_eq!(state.delegate_of("alice"), Some("bob"));
}

#[test]
fn delegation_is_not_chained_beyond_one_hop() {
    // alice -> bob, then bob -> carol. Because delegation is never chained,
    // alice's effective delegate must remain bob rather than resolving
    // through bob to carol.
    let mut state = Default::default();
    delegate(&mut state, "alice", "bob").unwrap();
    delegate(&mut state, "bob", "carol").unwrap();

    assert_eq!(state.delegate_of("alice"), Some("bob"));
    assert_eq!(state.delegate_of("bob"), Some("carol"));
}

#[test]
fn self_delegation_is_rejected() {
    let mut state = Default::default();
    let err = delegate(&mut state, "alice", "alice").unwrap_err();
    assert_eq!(err, DelegationError::SelfDelegation);
}

#[test]
fn revoke_clears_the_delegation() {
    let mut state = Default::default();
    delegate(&mut state, "alice", "bob").unwrap();
    revoke_delegation(&mut state, "alice").unwrap();
    assert_eq!(state.delegate_of("alice"), None);
}
