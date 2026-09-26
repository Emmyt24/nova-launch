#![cfg(test)]

use crate::{GovernanceContract, GovernanceContractClient};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, String as SorobanString,
};

/// Set up a fresh governance contract using the current two-argument
/// initialize(admin, total_supply) API, and return (env, client, admin).
/// Balances are set via set_balance, matching governance_property_test.rs.
fn setup_test_contract() -> (Env, GovernanceContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, GovernanceContract);
    let client = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    // Current two-argument signature: initialize(admin: Address, total_supply: i128)
    client.initialize(&admin, &10_000_000_i128);

    (env, client, admin)
}

// Strategy for generating vote weights (token balances)
fn vote_weight_strategy() -> impl Strategy<Value = i128> {
    1i128..=1_000_000i128
}

// Strategy for generating number of voters
fn voter_count_strategy() -> impl Strategy<Value = usize> {
    1usize..=20usize
}

// Strategy for generating vote directions (true = for, false = against)
fn vote_direction_strategy() -> impl Strategy<Value = bool> {
    prop::bool::ANY
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// **Feature: governance-vote-accounting, Property 7: One vote per address**
    ///
    /// For any proposal and any address, attempting to cast a second vote
    /// after successfully casting a first vote should be rejected.
    #[test]
    fn property_one_vote_per_address(
        weight in vote_weight_strategy(),
        in_favor in vote_direction_strategy(),
    ) {
        let (env, client, admin) = setup_test_contract();
        let creator = Address::generate(&env);
        let voter = Address::generate(&env);

        // Give the voter a non-zero balance so the vote can succeed
        client.set_balance(&admin, &voter, &weight);

        // Create proposal
        let proposal_id = client.create_proposal(
            &creator,
            &SorobanString::from_str(&env, "Test"),
            &soroban_sdk::Bytes::new(&env),
            &3600_u64,
            &100_i128,
            &50_u32,
        );

        // First vote should succeed
        let _ = client.try_cast_vote(&voter, &proposal_id, &in_favor);

        // Second vote should fail
        let second_vote = client.try_cast_vote(&voter, &proposal_id, &!in_favor);

        prop_assert!(second_vote.is_err(), "Second vote should be rejected");
        prop_assert!(client.has_voted(&proposal_id, &voter), "Voter should be marked as voted");
    }

    /// **Feature: governance-vote-accounting, Property 11: Tally monotonicity**
    ///
    /// For any proposal and any sequence of votes, the votes_for and votes_against
    /// tallies should never decrease.
    #[test]
    fn property_monotonic_vote_totals(
        vote_count in voter_count_strategy(),
        weights in prop::collection::vec(vote_weight_strategy(), 1..20),
        directions in prop::collection::vec(vote_direction_strategy(), 1..20),
    ) {
        let (env, client, admin) = setup_test_contract();
        let creator = Address::generate(&env);

        // Create proposal
        let proposal_id = client.create_proposal(
            &creator,
            &SorobanString::from_str(&env, "Test"),
            &soroban_sdk::Bytes::new(&env),
            &3600_u64,
            &100_i128,
            &50_u32,
        );

        let mut prev_for = 0i128;
        let mut prev_against = 0i128;

        // Cast votes and verify monotonicity
        for i in 0..vote_count.min(weights.len()).min(directions.len()) {
            let voter = Address::generate(&env);
            client.set_balance(&admin, &voter, &weights[i]);
            let _ = client.try_cast_vote(&voter, &proposal_id, &directions[i]);

            if let Some(proposal) = client.get_proposal(&proposal_id) {
                prop_assert!(
                    proposal.votes_for >= prev_for,
                    "votes_for decreased from {} to {}",
                    prev_for,
                    proposal.votes_for
                );
                prop_assert!(
                    proposal.votes_against >= prev_against,
                    "votes_against decreased from {} to {}",
                    prev_against,
                    proposal.votes_against
                );

                prev_for = proposal.votes_for;
                prev_against = proposal.votes_against;
            }
        }
    }

    /// **Feature: governance-vote-accounting, Property 15-18: Quorum and threshold outcomes**
    ///
    /// Tests that quorum and threshold logic works correctly under random vote distributions.
    #[test]
    fn property_quorum_threshold_outcomes(
        quorum in 100i128..=1000i128,
        threshold_percent in 30u32..=70u32,
        vote_count in 1usize..=15usize,
        weights in prop::collection::vec(vote_weight_strategy(), 1..15),
        directions in prop::collection::vec(vote_direction_strategy(), 1..15),
    ) {
        let (env, client, admin) = setup_test_contract();
        let creator = Address::generate(&env);

        // Create proposal with specific quorum and threshold
        let proposal_id = client.create_proposal(
            &creator,
            &SorobanString::from_str(&env, "Test"),
            &soroban_sdk::Bytes::new(&env),
            &100_u64, // Short voting period
            &quorum,
            &threshold_percent,
        );

        // Cast votes
        let actual_count = vote_count.min(weights.len()).min(directions.len());
        for i in 0..actual_count {
            let voter = Address::generate(&env);
            client.set_balance(&admin, &voter, &weights[i]);
            let _ = client.try_cast_vote(&voter, &proposal_id, &directions[i]);
        }

        // Advance time past voting period
        env.ledger().with_mut(|li| {
            li.timestamp = li.timestamp + 200;
        });

        // Finalize and check outcome
        if let Ok(_status) = client.try_finalize_proposal(&proposal_id) {
            let proposal = client.get_proposal(&proposal_id).unwrap();
            let total_votes = proposal.votes_for + proposal.votes_against;

            if total_votes < quorum {
                prop_assert_eq!(
                    proposal.status,
                    crate::types::ProposalStatus::Failed,
                    "Should fail when total votes ({}) < quorum ({})",
                    total_votes,
                    quorum
                );
            } else {
                let threshold_votes = (total_votes * threshold_percent as i128) / 100;
                if proposal.votes_for > threshold_votes {
                    prop_assert_eq!(
                        proposal.status,
                        crate::types::ProposalStatus::Passed,
                        "Should pass when votes_for ({}) > threshold ({})",
                        proposal.votes_for,
                        threshold_votes
                    );
                } else {
                    prop_assert_eq!(
                        proposal.status,
                        crate::types::ProposalStatus::Rejected,
                        "Should be rejected when votes_for ({}) <= threshold ({})",
                        proposal.votes_for,
                        threshold_votes
                    );
                }
            }
        }
    }

    /// **Feature: governance-vote-accounting, Property 12: Total equals sum of components**
    ///
    /// For any proposal, the total vote weight (votes_for + votes_against) should equal
    /// the sum of all individual vote weights cast on that proposal.
    #[test]
    fn property_total_equals_sum(
        vote_count in voter_count_strategy(),
        weights in prop::collection::vec(vote_weight_strategy(), 1..20),
        directions in prop::collection::vec(vote_direction_strategy(), 1..20),
    ) {
        let (env, client, admin) = setup_test_contract();
        let creator = Address::generate(&env);

        let proposal_id = client.create_proposal(
            &creator,
            &SorobanString::from_str(&env, "Test"),
            &soroban_sdk::Bytes::new(&env),
            &3600_u64,
            &100_i128,
            &50_u32,
        );

        let actual_count = vote_count.min(weights.len()).min(directions.len());
        let mut expected_total: i128 = 0;

        for i in 0..actual_count {
            let voter = Address::generate(&env);
            client.set_balance(&admin, &voter, &weights[i]);
            let result = client.try_cast_vote(&voter, &proposal_id, &directions[i]);
            if result.is_ok() {
                expected_total += weights[i];
            }
        }

        if let Some(proposal) = client.get_proposal(&proposal_id) {
            let actual_total = proposal.votes_for + proposal.votes_against;
            prop_assert!(
                actual_total >= 0,
                "Total votes should be non-negative, got {}",
                actual_total
            );
            prop_assert_eq!(
                actual_total,
                expected_total,
                "Total votes {} != sum of individual votes {}",
                actual_total,
                expected_total
            );
        }
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    /// Voting with a zero balance must be rejected with InsufficientBalance.
    /// Previously this was a no-op stub that relied on a "storage always returns 1000"
    /// assumption that no longer holds — this is a real assertion using set_balance.
    #[test]
    fn test_zero_balance_voting_rejected() {
        let (env, client, admin) = setup_test_contract();
        let creator = Address::generate(&env);
        let voter = Address::generate(&env);

        // Explicitly set voter's balance to 0
        client.set_balance(&admin, &voter, &0_i128);

        let proposal_id = client.create_proposal(
            &creator,
            &SorobanString::from_str(&env, "Test"),
            &soroban_sdk::Bytes::new(&env),
            &3600_u64,
            &100_i128,
            &50_u32,
        );

        // A voter with zero balance must be rejected
        let result = client.try_cast_vote(&voter, &proposal_id, &true);
        assert!(
            result.is_err(),
            "casting a vote with zero balance must return an error"
        );
    }

    #[test]
    fn test_voting_on_nonexistent_proposal() {
        let (env, client, _admin) = setup_test_contract();
        let voter = Address::generate(&env);

        let result = client.try_cast_vote(&voter, &999_u32, &true);
        assert!(result.is_err());
    }

    #[test]
    fn test_finalization_before_period_ends() {
        let (env, client, _admin) = setup_test_contract();
        let creator = Address::generate(&env);

        let proposal_id = client.create_proposal(
            &creator,
            &SorobanString::from_str(&env, "Test"),
            &soroban_sdk::Bytes::new(&env),
            &3600_u64,
            &100_i128,
            &50_u32,
        );

        // Try to finalize immediately — must fail
        let result = client.try_finalize_proposal(&proposal_id);
        assert!(result.is_err());
    }

    #[test]
    fn test_no_votes_after_finalization() {
        let (env, client, admin) = setup_test_contract();
        let creator = Address::generate(&env);
        let voter = Address::generate(&env);

        client.set_balance(&admin, &voter, &1000_i128);

        let proposal_id = client.create_proposal(
            &creator,
            &SorobanString::from_str(&env, "Test"),
            &soroban_sdk::Bytes::new(&env),
            &100_u64,
            &100_i128,
            &50_u32,
        );

        // Advance time past voting end
        env.ledger().with_mut(|li| {
            li.timestamp = li.timestamp + 200;
        });

        // Finalize
        let _ = client.try_finalize_proposal(&proposal_id);

        // Try to vote after finalization — must fail
        let result = client.try_cast_vote(&voter, &proposal_id, &true);
        assert!(result.is_err());
    }
}
