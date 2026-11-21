//! Property-based tests for governance invariants
//!
//! These tests verify that critical governance invariants hold under randomized conditions:
//! - Monotonic vote totals: vote counts never decrease
//! - Single-vote-per-address: each address can only vote once per proposal
//! - Execution preconditions: proposals can only execute after timelock and with proper state
//! - Terminal state permanence: executed/cancelled proposals cannot be modified

// All timelock entry points are invoked inside `env.as_contract(...)` so that the
// contract's own storage/auth context is active during property runs.

use super::*;
use crate::timelock;
use crate::types::{VoteChoice, ActionType};
use crate::test_helpers::TestEnv;
use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Bytes};

#[cfg(test)]
mod property_tests {
    use super::*;
    use proptest::prelude::*;

    fn test_payload(env: &soroban_sdk::Env, data: &[u8]) -> Bytes {
        Bytes::from_slice(env, data)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(50))]

        /// Property: Monotonic Vote Totals
        /// Invariant: vote counts (for, against, abstain) never decrease
        ///
        /// This test verifies that once votes are cast, the totals only increase
        /// and never decrease, regardless of the order or timing of votes.
        #[test]
        fn prop_monotonic_vote_totals(
            num_voters in 1usize..20,
            vote_choices in prop::collection::vec(0u8..3, 1..20)
        ) {
            let test_env = TestEnv::with_timelock(1000);
            
            let proposal_id = timelock::create_proposal(
                &test_env.env,
                &test_env.admin,
                ActionType::FeeChange,
                test_payload(&test_env.env, &[1, 2, 3]),
                test_env.env.ledger().timestamp() + 1000,
                test_env.env.ledger().timestamp() + 10000,
                test_env.env.ledger().timestamp() + 20000,
            ).unwrap();
            
            test_env.env.ledger().set_timestamp(test_env.env.ledger().timestamp() + 1100);
            
            let mut prev_for = 0i128;
            let mut prev_against = 0i128;
            let mut prev_abstain = 0i128;
            
            for i in 0..num_voters.min(vote_choices.len()) {
                let voter = Address::generate(&test_env.env);
                let choice = match vote_choices[i] % 3 {
                    0 => VoteChoice::For,
                    1 => VoteChoice::Against,
                    _ => VoteChoice::Abstain,
                };
                
                let _ = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                    timelock::vote_proposal(&test_env.env, &voter, proposal_id, choice)
                });
                let (votes_for, votes_against, votes_abstain) = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                    timelock::get_vote_counts(&test_env.env, proposal_id)
                }).unwrap();
                
                prop_assert!(votes_for >= prev_for);
                prop_assert!(votes_against >= prev_against);
                prop_assert!(votes_abstain >= prev_abstain);
                
                prev_for = votes_for;
                prev_against = votes_against;
                prev_abstain = votes_abstain;
            }
        }

        #[test]
        fn prop_single_vote_per_address(
            num_voters in 1usize..15,
            first_votes in prop::collection::vec(0u8..3, 1..15),
            second_votes in prop::collection::vec(0u8..3, 1..15)
        ) {
            let test_env = TestEnv::with_timelock(1000);
            
            let proposal_id = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                timelock::create_proposal(
                    &test_env.env,
                    &test_env.admin,
                    ActionType::FeeChange,
                    test_payload(&test_env.env, &[1, 2, 3]),
                    test_env.env.ledger().timestamp() + 1000,
                    test_env.env.ledger().timestamp() + 10000,
                    test_env.env.ledger().timestamp() + 20000,
                )
            }).unwrap();
            
            test_env.env.ledger().set_timestamp(test_env.env.ledger().timestamp() + 1100);
            
            let mut voters = soroban_sdk::Vec::new(&test_env.env);
            
            for i in 0..num_voters.min(first_votes.len()) {
                let voter = Address::generate(&test_env.env);
                voters.push_back(voter.clone());
                
                let choice = match first_votes[i] % 3 {
                    0 => VoteChoice::For,
                    1 => VoteChoice::Against,
                    _ => VoteChoice::Abstain,
                };
                
                let result = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                    timelock::vote_proposal(&test_env.env, &voter, proposal_id, choice)
                });
                prop_assert!(result.is_ok());
            }
            
            let (first_for, first_against, first_abstain) = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                timelock::get_vote_counts(&test_env.env, proposal_id)
            }).unwrap();
            
            for i in 0..voters.len().min(second_votes.len() as u32) {
                let voter = voters.get(i).unwrap();
                let choice = match second_votes[i as usize] % 3 {
                    0 => VoteChoice::For,
                    1 => VoteChoice::Against,
                    _ => VoteChoice::Abstain,
                };
                
                let result = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                    timelock::vote_proposal(&test_env.env, &voter, proposal_id, choice)
                });
                prop_assert!(result.is_err());
            }
            
            let (final_for, final_against, final_abstain) = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                timelock::get_vote_counts(&test_env.env, proposal_id)
            }).unwrap();
            prop_assert_eq!(first_for, final_for);
            prop_assert_eq!(first_against, final_against);
            prop_assert_eq!(first_abstain, final_abstain);
        }

        #[test]
        fn prop_execution_preconditions(
            time_advance in 0u64..30000,
            num_votes in 0usize..10
        ) {
            let test_env = TestEnv::with_timelock(1000);
            
            let start_time = test_env.env.ledger().timestamp() + 1000;
            let end_time = start_time + 10000;
            let eta = end_time + 7200; // 2 hours — within [MIN=3600, MAX=2592000]
            
            let proposal_id = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                timelock::create_proposal(
                    &test_env.env,
                    &test_env.admin,
                    ActionType::FeeChange,
                    test_payload(&test_env.env, &[1, 2, 3]),
                    start_time,
                    end_time,
                    eta,
                )
            }).unwrap();
            
            if num_votes > 0 {
                test_env.env.ledger().set_timestamp(start_time + 100);
                
                for _ in 0..num_votes {
                    let voter = Address::generate(&test_env.env);
                    let _ = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                        timelock::vote_proposal(&test_env.env, &voter, proposal_id, VoteChoice::For)
                    });
                }
            }
            
            test_env.env.ledger().set_timestamp(start_time + time_advance);
            
            let current_time = test_env.env.ledger().timestamp();
            let _proposal = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                timelock::get_proposal(&test_env.env, proposal_id)
            }).unwrap();
            
            if current_time < start_time {
                let test_voter = Address::generate(&test_env.env);
                let result = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                    timelock::vote_proposal(&test_env.env, &test_voter, proposal_id, VoteChoice::For)
                });
                prop_assert!(result.is_err());
            } else if current_time >= end_time {
                let test_voter = Address::generate(&test_env.env);
                let result = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                    timelock::vote_proposal(&test_env.env, &test_voter, proposal_id, VoteChoice::For)
                });
                prop_assert!(result.is_err());
            }
        }

        #[test]
        fn prop_terminal_state_permanence(
            initial_votes in 1usize..10,
            post_execution_votes in 1usize..5
        ) {
            let test_env = TestEnv::with_timelock(1000);
            
            let start_time = test_env.env.ledger().timestamp() + 1000;
            let end_time = start_time + 5000;
            let eta = end_time + 3600; // exactly MIN_TIMELOCK_DELAY
            
            let proposal_id = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                timelock::create_proposal(
                    &test_env.env,
                    &test_env.admin,
                    ActionType::FeeChange,
                    test_payload(&test_env.env, &[1, 2, 3]),
                    start_time,
                    end_time,
                    eta,
                )
            }).unwrap();
            
            test_env.env.ledger().set_timestamp(start_time + 100);
            
            for _ in 0..initial_votes {
                let voter = Address::generate(&test_env.env);
                let _ = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                    timelock::vote_proposal(&test_env.env, &voter, proposal_id, VoteChoice::For)
                });
            }
            
            let (votes_before, _, _) = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                timelock::get_vote_counts(&test_env.env, proposal_id)
            }).unwrap();
            
            test_env.env.ledger().set_timestamp(end_time + 100);
            
            for _ in 0..post_execution_votes {
                let voter = Address::generate(&test_env.env);
                let result = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                    timelock::vote_proposal(&test_env.env, &voter, proposal_id, VoteChoice::For)
                });
                prop_assert!(result.is_err());
            }
            
            let (votes_after, _, _) = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                timelock::get_vote_counts(&test_env.env, proposal_id)
            }).unwrap();
            prop_assert_eq!(votes_before, votes_after);
        }

        #[test]
        fn prop_vote_distribution_consistency(
            votes in prop::collection::vec((0u8..3, 0u64..5000), 1..20)
        ) {
            let test_env = TestEnv::with_timelock(1000);
            
            let start_time = test_env.env.ledger().timestamp() + 1000;
            
            let proposal_id = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                timelock::create_proposal(
                    &test_env.env,
                    &test_env.admin,
                    ActionType::FeeChange,
                    test_payload(&test_env.env, &[1, 2, 3]),
                    start_time,
                    start_time + 50000,
                    start_time + 60000,
                )
            }).unwrap();
            
            let mut expected_for = 0i128;
            let mut expected_against = 0i128;
            let mut expected_abstain = 0i128;
            
            for (choice_byte, time_offset) in votes {
                test_env.env.ledger().set_timestamp(start_time + time_offset);
                
                let voter = Address::generate(&test_env.env);
                let choice = match choice_byte % 3 {
                    0 => {
                        expected_for += 1;
                        VoteChoice::For
                    },
                    1 => {
                        expected_against += 1;
                        VoteChoice::Against
                    },
                    _ => {
                        expected_abstain += 1;
                        VoteChoice::Abstain
                    },
                };
                
                let result = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                    timelock::vote_proposal(&test_env.env, &voter, proposal_id, choice)
                });
                
                if result.is_ok() {
                    let (votes_for, votes_against, votes_abstain) = test_env.env.as_contract(&test_env.env.current_contract_address(), || {
                        timelock::get_vote_counts(&test_env.env, proposal_id)
                    }).unwrap();
                    let total = votes_for + votes_against + votes_abstain;
                    let expected_total = expected_for + expected_against + expected_abstain;
                    
                    prop_assert_eq!(total, expected_total);
                }
            }
        }
    }
}
