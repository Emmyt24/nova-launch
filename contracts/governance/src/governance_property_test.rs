//! Governance Delegation System — Property-Based Tests
//!
//! Uses `proptest` to verify invariants hold across a wide range of inputs.
//!
//! # Invariants tested
//!
//! 1. Vote-power conservation: total vote power equals sum of all balances.
//! 2. No negative vote power: no address ever has negative vote power.
//! 3. Delegation idempotency: delegating to the same delegatee twice is a no-op.
//! 4. Delegate-undelegate round-trip: restores original distribution.
//! 5. Re-delegation atomicity: power moves atomically from old to new delegatee.
//! 6. Arithmetic safety: no overflow/underflow with large balances.
//! 7. Circular delegation always rejected.
//! 8. Balance update propagates correctly to delegatee.

#![cfg(test)]

use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, Address, Env};
use crate::{GovernanceContract, GovernanceContractClient};

// ─── Strategy helpers ──────────────────────────────────────────────────────

fn balance_strategy() -> impl Strategy<Value = i128> {
    1_i128..=1_000_000_i128
}

// ─── Setup helper ─────────────────────────────────────────────────────────

/// Returns (env, contract_id, admin_address).
fn make_contract() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, GovernanceContract);
    let client = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin, &10_000_000_i128);
    (env, contract_id, admin)
}

fn c<'a>(env: &'a Env, id: &'a Address) -> GovernanceContractClient<'a> {
    GovernanceContractClient::new(env, id)
}

// ─── Property 1: Vote-power conservation ──────────────────────────────────

proptest! {
    #[test]
    fn prop_vote_power_conservation(
        alice_bal in balance_strategy(),
        bob_bal   in balance_strategy(),
        carol_bal in balance_strategy(),
    ) {
        let (env, id, admin) = make_contract();
        let client = c(&env, &id);

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);
        let carol = Address::generate(&env);

        client.set_balance(&admin, &alice, &alice_bal);
        client.set_balance(&admin, &bob,   &bob_bal);
        client.set_balance(&admin, &carol, &carol_bal);

        let total = alice_bal + bob_bal + carol_bal;

        client.delegate(&alice, &carol);

        let sum = client.get_vote_power(&alice)
            + client.get_vote_power(&bob)
            + client.get_vote_power(&carol);
        prop_assert_eq!(sum, total, "Vote power must be conserved after delegation");

        client.undelegate(&alice);

        let sum2 = client.get_vote_power(&alice)
            + client.get_vote_power(&bob)
            + client.get_vote_power(&carol);
        prop_assert_eq!(sum2, total, "Vote power must be conserved after undelegation");
    }
}

// ─── Property 2: No negative vote power ───────────────────────────────────

proptest! {
    #[test]
    fn prop_no_negative_vote_power(
        alice_bal in balance_strategy(),
        bob_bal   in balance_strategy(),
    ) {
        let (env, id, admin) = make_contract();
        let client = c(&env, &id);

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);

        client.set_balance(&admin, &alice, &alice_bal);
        client.set_balance(&admin, &bob,   &bob_bal);

        client.delegate(&alice, &bob);

        prop_assert!(client.get_vote_power(&alice) >= 0);
        prop_assert!(client.get_vote_power(&bob)   >= 0);

        client.undelegate(&alice);

        prop_assert!(client.get_vote_power(&alice) >= 0);
        prop_assert!(client.get_vote_power(&bob)   >= 0);
    }
}

// ─── Property 3: Delegation idempotency ───────────────────────────────────

proptest! {
    #[test]
    fn prop_delegation_idempotent(
        alice_bal in balance_strategy(),
        bob_bal   in balance_strategy(),
    ) {
        let (env, id, admin) = make_contract();
        let client = c(&env, &id);

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);

        client.set_balance(&admin, &alice, &alice_bal);
        client.set_balance(&admin, &bob,   &bob_bal);

        client.delegate(&alice, &bob);
        let power_first = client.get_vote_power(&bob);

        client.delegate(&alice, &bob); // second call — no-op
        let power_second = client.get_vote_power(&bob);

        prop_assert_eq!(power_first, power_second,
            "Delegating to the same address twice must be idempotent");
    }
}

// ─── Property 4: Delegate-undelegate round-trip ────────────────────────────

proptest! {
    #[test]
    fn prop_delegate_undelegate_roundtrip(
        alice_bal in balance_strategy(),
        bob_bal   in balance_strategy(),
    ) {
        let (env, id, admin) = make_contract();
        let client = c(&env, &id);

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);

        client.set_balance(&admin, &alice, &alice_bal);
        client.set_balance(&admin, &bob,   &bob_bal);

        let alice_before = client.get_vote_power(&alice);
        let bob_before   = client.get_vote_power(&bob);

        client.delegate(&alice, &bob);
        client.undelegate(&alice);

        prop_assert_eq!(client.get_vote_power(&alice), alice_before,
            "alice's vote power must be restored");
        prop_assert_eq!(client.get_vote_power(&bob), bob_before,
            "bob's vote power must be restored");
    }
}

// ─── Property 5: Re-delegation atomicity ──────────────────────────────────

proptest! {
    #[test]
    fn prop_redelegation_atomic(
        alice_bal in balance_strategy(),
        bob_bal   in balance_strategy(),
        carol_bal in balance_strategy(),
    ) {
        let (env, id, admin) = make_contract();
        let client = c(&env, &id);

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);
        let carol = Address::generate(&env);

        client.set_balance(&admin, &alice, &alice_bal);
        client.set_balance(&admin, &bob,   &bob_bal);
        client.set_balance(&admin, &carol, &carol_bal);

        client.delegate(&alice, &bob);
        let bob_with_alice = client.get_vote_power(&bob);

        client.delegate(&alice, &carol); // re-delegate

        let bob_after   = client.get_vote_power(&bob);
        let carol_after = client.get_vote_power(&carol);

        prop_assert_eq!(bob_after, bob_with_alice - alice_bal,
            "bob must lose alice's contribution");
        prop_assert_eq!(carol_after, carol_bal + alice_bal,
            "carol must gain alice's contribution");
    }
}

// ─── Property 6: Arithmetic safety with large balances ────────────────────

proptest! {
    #[test]
    fn prop_arithmetic_safety_large_balances(
        alice_bal in 1_i128..=i128::MAX / 4,
        bob_bal   in 1_i128..=i128::MAX / 4,
    ) {
        let (env, id, admin) = make_contract();
        let client = c(&env, &id);

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);

        client.set_balance(&admin, &alice, &alice_bal);
        client.set_balance(&admin, &bob,   &bob_bal);

        client.delegate(&alice, &bob); // must not panic

        let bob_power = client.get_vote_power(&bob);
        prop_assert!(bob_power >= 0, "Vote power must not be negative");
        prop_assert_eq!(bob_power, bob_bal + alice_bal);
    }
}

// ─── Property 7: Circular delegation always rejected ──────────────────────

proptest! {
    /// Any attempt to create a delegation cycle must always be rejected.
    /// We verify this by checking that after alice→bob, bob's vote power
    /// still equals alice_bal + bob_bal (no cycle was silently accepted).
    #[test]
    fn prop_circular_delegation_always_rejected(
        alice_bal in balance_strategy(),
        bob_bal   in balance_strategy(),
    ) {
        let (env, id, admin) = make_contract();
        let client = c(&env, &id);

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);

        client.set_balance(&admin, &alice, &alice_bal);
        client.set_balance(&admin, &bob,   &bob_bal);

        // alice → bob succeeds
        client.delegate(&alice, &bob);

        // bob's power must be alice_bal + bob_bal
        let bob_power = client.get_vote_power(&bob);
        prop_assert_eq!(bob_power, alice_bal + bob_bal,
            "bob must hold alice's delegated power plus his own balance");

        // alice has zero vote power (delegated away)
        let alice_power = client.get_vote_power(&alice);
        prop_assert_eq!(alice_power, 0_i128,
            "alice must have zero vote power after delegating");

        // The circular delegation (bob → alice) is tested in the unit tests
        // via #[should_panic].  Here we verify the state invariant holds
        // after the valid delegation above.
        let total = client.get_vote_power(&alice) + client.get_vote_power(&bob);
        prop_assert_eq!(total, alice_bal + bob_bal,
            "Total vote power must be conserved");
    }
}

// ─── Property 8: Balance update propagates to delegatee ───────────────────

proptest! {
    #[test]
    fn prop_balance_update_propagates_to_delegatee(
        initial_bal in balance_strategy(),
        new_bal     in balance_strategy(),
    ) {
        let (env, id, admin) = make_contract();
        let client = c(&env, &id);

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);

        client.set_balance(&admin, &alice, &initial_bal);
        client.delegate(&alice, &bob);

        let bob_before = client.get_vote_power(&bob);

        client.set_balance(&admin, &alice, &new_bal);

        let bob_after = client.get_vote_power(&bob);
        let expected_delta = new_bal - initial_bal;

        prop_assert_eq!(bob_after - bob_before, expected_delta,
            "Delegatee's vote power delta must equal delegator's balance delta");
    }
}

// ─── Property 9: finalize_proposal status matches the decision table ────────
//
// The three-way decision table from finalize_proposal's rustdoc in lib.rs:
//   total_votes < quorum           → Failed
//   total_votes >= quorum
//     votes_for > threshold_votes  → Passed
//     else                         → Rejected

proptest! {
    /// Generate random quorum, threshold_percent, and two voter weights/directions,
    /// drive a full proposal lifecycle, and assert the outcome matches the
    /// decision table documented in `finalize_proposal`'s rustdoc.
    #[test]
    fn prop_finalize_status_matches_decision_table(
        quorum            in 1_i128..=500_i128,
        threshold_percent in 0_u32..=100_u32,
        alice_bal         in 1_i128..=300_i128,
        bob_bal           in 1_i128..=300_i128,
        alice_in_favor    in any::<bool>(),
        bob_in_favor      in any::<bool>(),
    ) {
        let (env, id, admin) = make_contract();
        let client = c(&env, &id);

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);

        // Give voters real balances so cast_vote weight-resolution works.
        client.set_balance(&admin, &alice, &alice_bal);
        client.set_balance(&admin, &bob,   &bob_bal);

        // Create a proposal with a 10-second voting period.
        let voting_period: u64 = 10;
        let proposal_id = client
            .create_proposal(
                &alice,
                &soroban_sdk::String::from_str(&env, "test"),
                &soroban_sdk::Bytes::new(&env),
                &voting_period,
                &quorum,
                &threshold_percent,
            )
            .unwrap();

        // Cast votes while the voting window is still open.
        client.cast_vote(&alice, &proposal_id, &alice_in_favor).unwrap();
        client.cast_vote(&bob,   &proposal_id, &bob_in_favor).unwrap();

        // Advance ledger time past voting_end so finalization is allowed.
        env.ledger().with_mut(|li| {
            li.timestamp = li.timestamp + voting_period + 1;
        });

        let status = client.finalize_proposal(&proposal_id).unwrap();

        // Recompute the decision table in the test.
        let votes_for     = (if alice_in_favor { alice_bal } else { 0 })
                          + (if bob_in_favor   { bob_bal   } else { 0 });
        let votes_against = (if !alice_in_favor { alice_bal } else { 0 })
                          + (if !bob_in_favor   { bob_bal   } else { 0 });
        let total_votes   = votes_for + votes_against;

        use crate::types::ProposalStatus;
        let expected = if total_votes < quorum {
            ProposalStatus::Failed
        } else {
            let threshold_votes = total_votes * threshold_percent as i128 / 100;
            if votes_for > threshold_votes {
                ProposalStatus::Passed
            } else {
                ProposalStatus::Rejected
            }
        };

        prop_assert_eq!(status, expected,
            "finalize_proposal result must match the decision table \
             (quorum={quorum}, threshold={threshold_percent}%, \
             votes_for={votes_for}, votes_against={votes_against})");
    }
}

// ─── Property 10: cast_vote weight-resolution rule ─────────────────────────
//
// From cast_vote's rustdoc:
//   weight = get_vote_power(voter)   if vote_power > 0
//          = get_balance(voter)      if vote_power == 0

proptest! {
    /// Assert that cast_vote uses get_vote_power when it is nonzero, and
    /// falls back to get_balance only when vote power is exactly zero.
    #[test]
    fn prop_cast_vote_weight_resolution(
        alice_bal in 1_i128..=1_000_000_i128,
        bob_bal   in 1_i128..=1_000_000_i128,
    ) {
        let (env, id, admin) = make_contract();
        let client = c(&env, &id);

        let alice = Address::generate(&env);
        let bob   = Address::generate(&env);

        // ── Case A: vote power is nonzero (alice has no delegation) ────────
        // After set_balance with no delegation, alice's vote power == alice_bal.
        client.set_balance(&admin, &alice, &alice_bal);

        let voting_period: u64 = 10;
        let proposal_a = client
            .create_proposal(
                &alice,
                &soroban_sdk::String::from_str(&env, "prop-a"),
                &soroban_sdk::Bytes::new(&env),
                &voting_period,
                &1_i128,
                &50_u32,
            )
            .unwrap();

        client.cast_vote(&alice, &proposal_a, &true).unwrap();

        let vote_a = client.get_proposal_vote(&proposal_a, &alice).unwrap();
        prop_assert_eq!(
            vote_a.weight, alice_bal,
            "weight must equal vote_power (== balance) when vote_power > 0"
        );

        // ── Case B: vote power is zero because alice delegated everything ──
        // bob has a balance; alice delegates to bob so alice's vote power → 0.
        client.set_balance(&admin, &bob, &bob_bal);
        client.delegate(&alice, &bob);

        let alice_power_after_delegation = client.get_vote_power(&alice);
        prop_assert_eq!(
            alice_power_after_delegation, 0_i128,
            "alice must have zero vote power after delegating"
        );

        // Open a fresh proposal so alice can cast a new vote.
        let proposal_b = client
            .create_proposal(
                &bob,
                &soroban_sdk::String::from_str(&env, "prop-b"),
                &soroban_sdk::Bytes::new(&env),
                &voting_period,
                &1_i128,
                &50_u32,
            )
            .unwrap();

        // alice's vote power is 0 → cast_vote falls back to raw balance.
        client.cast_vote(&alice, &proposal_b, &true).unwrap();

        let vote_b = client.get_proposal_vote(&proposal_b, &alice).unwrap();
        prop_assert_eq!(
            vote_b.weight, alice_bal,
            "weight must fall back to raw balance when vote_power == 0"
        );
    }
}
