#![cfg(test)]

use crate::timelock::{create_proposal, vote_proposal, get_vote_counts, has_voted, get_proposal, initialize_timelock};
use crate::types::{ActionType, VoteChoice, Error};
use crate::storage;
use soroban_sdk::{testutils::Address as _, vec, Env};
use soroban_sdk::testutils::Ledger;

fn setup_for_voting() -> (Env, soroban_sdk::Address) {
    let env = Env::default();
    env.mock_all_auths();
    
    let admin = soroban_sdk::Address::generate(&env);
    storage::set_admin(&env, &admin);
    storage::set_treasury(&env, &soroban_sdk::Address::generate(&env));
    storage::set_base_fee(&env, 1_000_000);
    storage::set_metadata_fee(&env, 500_000);
    
    initialize_timelock(&env, Some(3600)).unwrap();
    
    (env, admin)
}

fn create_test_proposal(env: &Env, admin: &soroban_sdk::Address) -> u64 {
    let current_time = env.ledger().timestamp();
    let start_time = current_time + 100;
    let end_time = start_time + 86400;
    let eta = end_time + 3600;
    let payload = vec![env, 1u8, 2u8, 3u8];
    
    create_proposal(
        env,
        admin,
        ActionType::FeeChange,
        payload,
        start_time,
        end_time,
        eta,
    ).unwrap()
}

#[test]
fn test_vote_proposal_valid() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to voting period
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 150;
    });
    
    let voter = soroban_sdk::Address::generate(&env);
    
    // Cast vote
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    
    // Verify vote was recorded
    assert!(has_voted(&env, proposal_id, &voter));
    
    // Verify vote counts
    let (votes_for, votes_against, votes_abstain) = get_vote_counts(&env, proposal_id).unwrap();
    assert_eq!(votes_for, 1);
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 0);
}

#[test]
fn test_vote_proposal_duplicate_rejection() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to voting period
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 150;
    });
    
    let voter = soroban_sdk::Address::generate(&env);
    
    // Cast first vote
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    
    // Try to vote again - should fail
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::Against);
    assert_eq!(result, Err(Error::AlreadyVoted));
    
    // Verify vote counts didn't change
    let (votes_for, votes_against, votes_abstain) = get_vote_counts(&env, proposal_id).unwrap();
    assert_eq!(votes_for, 1);
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 0);
}

#[test]
fn test_vote_before_start_time() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Don't advance time - still before start_time
    let voter = soroban_sdk::Address::generate(&env);
    
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::For);
    assert_eq!(result, Err(Error::VotingNotStarted));
}

#[test]
fn test_vote_at_exact_start_time() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to exactly start_time
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 100;
    });
    
    let voter = soroban_sdk::Address::generate(&env);
    
    // Should succeed at exact start time
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    
    let (votes_for, _, _) = get_vote_counts(&env, proposal_id).unwrap();
    assert_eq!(votes_for, 1);
}

#[test]
fn test_vote_at_exact_end_time() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to exactly end_time
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 100 + 86400;
    });
    
    let voter = soroban_sdk::Address::generate(&env);
    
    // Should fail at exact end time (>= end_time)
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::For);
    assert_eq!(result, Err(Error::VotingEnded));
}

#[test]
fn test_vote_after_end_time() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time past end_time
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 100 + 86400 + 1000;
    });
    
    let voter = soroban_sdk::Address::generate(&env);
    
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::For);
    assert_eq!(result, Err(Error::VotingEnded));
}

#[test]
fn test_vote_one_second_before_end() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to one second before end_time
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 100 + 86400 - 1;
    });
    
    let voter = soroban_sdk::Address::generate(&env);
    
    // Should succeed
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    
    let (votes_for, _, _) = get_vote_counts(&env, proposal_id).unwrap();
    assert_eq!(votes_for, 1);
}

#[test]
fn test_vote_nonexistent_proposal() {
    let (env, _admin) = setup_for_voting();
    
    let voter = soroban_sdk::Address::generate(&env);
    
    let result = vote_proposal(&env, &voter, 999, VoteChoice::For);
    assert_eq!(result, Err(Error::ProposalNotFound));
}

#[test]
fn test_multiple_voters_for() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to voting period
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 150;
    });
    
    // Three voters vote "For"
    let voter1 = soroban_sdk::Address::generate(&env);
    let voter2 = soroban_sdk::Address::generate(&env);
    let voter3 = soroban_sdk::Address::generate(&env);
    
    vote_proposal(&env, &voter1, proposal_id, VoteChoice::For).unwrap();
    vote_proposal(&env, &voter2, proposal_id, VoteChoice::For).unwrap();
    vote_proposal(&env, &voter3, proposal_id, VoteChoice::For).unwrap();
    
    let (votes_for, votes_against, votes_abstain) = get_vote_counts(&env, proposal_id).unwrap();
    assert_eq!(votes_for, 3);
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 0);
}

#[test]
fn test_multiple_voters_mixed() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to voting period
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 150;
    });
    
    // Create voters
    let voter1 = soroban_sdk::Address::generate(&env);
    let voter2 = soroban_sdk::Address::generate(&env);
    let voter3 = soroban_sdk::Address::generate(&env);
    let voter4 = soroban_sdk::Address::generate(&env);
    let voter5 = soroban_sdk::Address::generate(&env);
    
    // Cast mixed votes
    vote_proposal(&env, &voter1, proposal_id, VoteChoice::For).unwrap();
    vote_proposal(&env, &voter2, proposal_id, VoteChoice::For).unwrap();
    vote_proposal(&env, &voter3, proposal_id, VoteChoice::Against).unwrap();
    vote_proposal(&env, &voter4, proposal_id, VoteChoice::Abstain).unwrap();
    vote_proposal(&env, &voter5, proposal_id, VoteChoice::Against).unwrap();
    
    let (votes_for, votes_against, votes_abstain) = get_vote_counts(&env, proposal_id).unwrap();
    assert_eq!(votes_for, 2);
    assert_eq!(votes_against, 2);
    assert_eq!(votes_abstain, 1);
}

#[test]
fn test_vote_all_abstain() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to voting period
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 150;
    });
    
    let voter1 = soroban_sdk::Address::generate(&env);
    let voter2 = soroban_sdk::Address::generate(&env);
    
    vote_proposal(&env, &voter1, proposal_id, VoteChoice::Abstain).unwrap();
    vote_proposal(&env, &voter2, proposal_id, VoteChoice::Abstain).unwrap();
    
    let (votes_for, votes_against, votes_abstain) = get_vote_counts(&env, proposal_id).unwrap();
    assert_eq!(votes_for, 0);
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 2);
}

#[test]
fn test_has_voted_check() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to voting period
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 150;
    });
    
    let voter1 = soroban_sdk::Address::generate(&env);
    let voter2 = soroban_sdk::Address::generate(&env);
    
    // Initially, no one has voted
    assert!(!has_voted(&env, proposal_id, &voter1));
    assert!(!has_voted(&env, proposal_id, &voter2));
    
    // Voter1 votes
    vote_proposal(&env, &voter1, proposal_id, VoteChoice::For).unwrap();
    
    // Now voter1 has voted, but not voter2
    assert!(has_voted(&env, proposal_id, &voter1));
    assert!(!has_voted(&env, proposal_id, &voter2));
    
    // Voter2 votes
    vote_proposal(&env, &voter2, proposal_id, VoteChoice::Against).unwrap();
    
    // Now both have voted
    assert!(has_voted(&env, proposal_id, &voter1));
    assert!(has_voted(&env, proposal_id, &voter2));
}

#[test]
fn test_vote_counts_for_nonexistent_proposal() {
    let (env, _admin) = setup_for_voting();
    
    let result = get_vote_counts(&env, 999);
    assert!(result.is_none());
}

#[test]
fn test_admin_can_vote() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to voting period
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 150;
    });
    
    // Admin can vote on their own proposal
    vote_proposal(&env, &admin, proposal_id, VoteChoice::For).unwrap();
    
    assert!(has_voted(&env, proposal_id, &admin));
    let (votes_for, _, _) = get_vote_counts(&env, proposal_id).unwrap();
    assert_eq!(votes_for, 1);
}

#[test]
fn test_vote_persistence() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to voting period
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 150;
    });
    
    let voter = soroban_sdk::Address::generate(&env);
    
    // Cast vote
    vote_proposal(&env, &voter, proposal_id, VoteChoice::For).unwrap();
    
    // Retrieve proposal and verify vote counts persisted
    let proposal = get_proposal(&env, proposal_id).unwrap();
    assert_eq!(proposal.votes_for, 1);
    assert_eq!(proposal.votes_against, 0);
    assert_eq!(proposal.votes_abstain, 0);
}

#[test]
fn test_different_proposals_independent_votes() {
    let (env, admin) = setup_for_voting();
    
    // Create two proposals
    let proposal_id_1 = create_test_proposal(&env, &admin);
    let proposal_id_2 = create_test_proposal(&env, &admin);
    
    // Advance time to voting period
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 150;
    });
    
    let voter = soroban_sdk::Address::generate(&env);
    
    // Vote on first proposal
    vote_proposal(&env, &voter, proposal_id_1, VoteChoice::For).unwrap();
    
    // Should be able to vote on second proposal (different proposal)
    vote_proposal(&env, &voter, proposal_id_2, VoteChoice::Against).unwrap();
    
    // Verify both votes recorded
    assert!(has_voted(&env, proposal_id_1, &voter));
    assert!(has_voted(&env, proposal_id_2, &voter));
    
    let (votes_for_1, _, _) = get_vote_counts(&env, proposal_id_1).unwrap();
    let (_, votes_against_2, _) = get_vote_counts(&env, proposal_id_2).unwrap();
    
    assert_eq!(votes_for_1, 1);
    assert_eq!(votes_against_2, 1);
}

#[test]
fn test_vote_boundary_start_minus_one() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to one second before start_time
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 99;
    });
    
    let voter = soroban_sdk::Address::generate(&env);
    
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::For);
    assert_eq!(result, Err(Error::VotingNotStarted));
}

#[test]
fn test_vote_boundary_end_plus_one() {
    let (env, admin) = setup_for_voting();
    let proposal_id = create_test_proposal(&env, &admin);
    
    // Advance time to one second after end_time
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp + 100 + 86400 + 1;
    });
    
    let voter = soroban_sdk::Address::generate(&env);
    
    let result = vote_proposal(&env, &voter, proposal_id, VoteChoice::For);
    assert_eq!(result, Err(Error::VotingEnded));
}
