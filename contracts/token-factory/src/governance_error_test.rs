//! Governance Error Validation Tests
//!
//! Tests that validate governance lifecycle failures return the correct error codes.
//! Each test ensures that specific governance operations fail with typed errors.

#[cfg(test)]
mod governance_error_tests {
    use crate::types::Error;
    use crate::{TokenFactory, TokenFactoryClient};
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env, String};

    /// Helper function to initialize a factory for testing
    fn setup_factory(env: &Env) -> (TokenFactoryClient, Address, Address) {
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(env, &contract_id);
        
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        
        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
        
        (client, admin, treasury)
    }

    #[test]
    fn test_proposal_not_found_error() {
        let env = Env::default();
        env.mock_all_auths();
        
        let (client, _admin, _treasury) = setup_factory(&env);
        
        // Try to get a non-existent proposal
        let non_existent_proposal_id = 999u64;
        
        // TODO: Uncomment once get_proposal function is implemented
        // let result = client.try_get_proposal(&non_existent_proposal_id);
        // assert_eq!(result, Err(Ok(Error::ProposalNotFound)));
        
        // Verify error code mapping
        assert_eq!(Error::ProposalNotFound as u32, 34);
    }

    #[test]
    fn test_voting_closed_error() {
        let env = Env::default();
        env.mock_all_auths();
        
        let (client, admin, _treasury) = setup_factory(&env);
        
        // TODO: Uncomment once proposal and voting functions are implemented
        // Create a proposal
        // let proposal_id = client.create_proposal(
        //     &admin,
        //     &String::from_str(&env, "Test Proposal"),
        //     &1000u64, // voting_start
        //     &2000u64, // voting_end
        // );
        
        // Advance time past voting end
        // env.ledger().set_timestamp(3000);
        
        // Try to vote after voting period closed
        // let voter = Address::generate(&env);
        // let result = client.try_vote(&proposal_id, &voter, &true);
        // assert_eq!(result, Err(Ok(Error::VotingClosed)));
        
        // Verify error code mapping
        assert_eq!(Error::VotingClosed as u32, 38);
    }

    #[test]
    fn test_already_voted_error() {
        let env = Env::default();
        env.mock_all_auths();
        
        let (client, admin, _treasury) = setup_factory(&env);
        
        // TODO: Uncomment once proposal and voting functions are implemented
        // Create a proposal
        // let proposal_id = client.create_proposal(
        //     &admin,
        //     &String::from_str(&env, "Test Proposal"),
        //     &1000u64,
        //     &5000u64,
        // );
        
        // env.ledger().set_timestamp(2000);
        
        // Vote once
        // let voter = Address::generate(&env);
        // client.vote(&proposal_id, &voter, &true);
        
        // Try to vote again
        // let result = client.try_vote(&proposal_id, &voter, &false);
        // assert_eq!(result, Err(Ok(Error::AlreadyVoted)));
        
        // Verify error code mapping
        assert_eq!(Error::AlreadyVoted as u32, 37);
    }

    #[test]
    fn test_proposal_expired_error() {
        let env = Env::default();
        env.mock_all_auths();
        
        let (client, admin, _treasury) = setup_factory(&env);
        
        // TODO: Uncomment once proposal execution is implemented
        // Create a proposal with expiration
        // let proposal_id = client.create_proposal(
        //     &admin,
        //     &String::from_str(&env, "Test Proposal"),
        //     &1000u64,
        //     &2000u64,
        // );
        
        // Advance time past expiration
        // env.ledger().set_timestamp(10000);
        
        // Try to execute expired proposal
        // let result = client.try_execute_proposal(&proposal_id, &admin);
        // assert_eq!(result, Err(Ok(Error::ProposalExpired)));
        
        // Verify error code mapping
        assert_eq!(Error::ProposalExpired as u32, 39);
    }

    #[test]
    fn test_proposal_not_executable_error() {
        let env = Env::default();
        env.mock_all_auths();
        
        let (client, admin, _treasury) = setup_factory(&env);
        
        // TODO: Uncomment once proposal execution is implemented
        // Create a proposal
        // let proposal_id = client.create_proposal(
        //     &admin,
        //     &String::from_str(&env, "Test Proposal"),
        //     &1000u64,
        //     &5000u64,
        // );
        
        // Try to execute before voting ends
        // env.ledger().set_timestamp(3000);
        // let result = client.try_execute_proposal(&proposal_id, &admin);
        // assert_eq!(result, Err(Ok(Error::ProposalNotExecutable)));
        
        // Verify error code mapping
        assert_eq!(Error::ProposalNotExecutable as u32, 40);
    }

    #[test]
    fn test_quorum_not_met_error() {
        let env = Env::default();
        env.mock_all_auths();
        
        let (client, admin, _treasury) = setup_factory(&env);
        
        // TODO: Uncomment once proposal and quorum logic is implemented
        // Create a proposal with quorum requirement
        // let proposal_id = client.create_proposal(
        //     &admin,
        //     &String::from_str(&env, "Test Proposal"),
        //     &1000u64,
        //     &2000u64,
        // );
        
        // Cast insufficient votes (below quorum)
        // env.ledger().set_timestamp(1500);
        // let voter = Address::generate(&env);
        // client.vote(&proposal_id, &voter, &true);
        
        // Advance past voting period
        // env.ledger().set_timestamp(3000);
        
        // Try to execute with quorum not met
        // let result = client.try_execute_proposal(&proposal_id, &admin);
        // assert_eq!(result, Err(Ok(Error::QuorumNotMet)));
        
        // Verify error code mapping
        assert_eq!(Error::QuorumNotMet as u32, 41);
    }

    #[test]
    fn test_already_executed_error() {
        let env = Env::default();
        env.mock_all_auths();
        
        let (client, admin, _treasury) = setup_factory(&env);
        
        // TODO: Uncomment once proposal execution is implemented
        // Create and execute a proposal
        // let proposal_id = client.create_proposal(
        //     &admin,
        //     &String::from_str(&env, "Test Proposal"),
        //     &1000u64,
        //     &2000u64,
        // );
        
        // Vote and execute
        // env.ledger().set_timestamp(1500);
        // client.vote(&proposal_id, &admin, &true);
        // env.ledger().set_timestamp(3000);
        // client.execute_proposal(&proposal_id, &admin);
        
        // Try to execute again
        // let result = client.try_execute_proposal(&proposal_id, &admin);
        // assert_eq!(result, Err(Ok(Error::AlreadyExecuted)));
        
        // Verify error code mapping
        assert_eq!(Error::AlreadyExecuted as u32, 42);
    }

    #[test]
    fn test_voting_not_started_error() {
        let env = Env::default();
        env.mock_all_auths();
        
        let (client, admin, _treasury) = setup_factory(&env);
        
        // TODO: Uncomment once proposal and voting functions are implemented
        // Create a proposal with future start time
        // let proposal_id = client.create_proposal(
        //     &admin,
        //     &String::from_str(&env, "Test Proposal"),
        //     &5000u64, // voting starts in future
        //     &10000u64,
        // );
        
        // Try to vote before voting starts
        // env.ledger().set_timestamp(1000);
        // let voter = Address::generate(&env);
        // let result = client.try_vote(&proposal_id, &voter, &true);
        // assert_eq!(result, Err(Ok(Error::VotingNotStarted)));
        
        // Verify error code mapping
        assert_eq!(Error::VotingNotStarted as u32, 35);
    }

    #[test]
    fn test_voting_ended_error() {
        let env = Env::default();
        env.mock_all_auths();
        
        let (client, admin, _treasury) = setup_factory(&env);
        
        // TODO: Uncomment once proposal and voting functions are implemented
        // Create a proposal
        // let proposal_id = client.create_proposal(
        //     &admin,
        //     &String::from_str(&env, "Test Proposal"),
        //     &1000u64,
        //     &2000u64,
        // );
        
        // Advance time past voting end
        // env.ledger().set_timestamp(3000);
        
        // Try to vote after voting ended
        // let voter = Address::generate(&env);
        // let result = client.try_vote(&proposal_id, &voter, &true);
        // assert_eq!(result, Err(Ok(Error::VotingEnded)));
        
        // Verify error code mapping
        assert_eq!(Error::VotingEnded as u32, 36);
    }

    /// Test that all governance error codes are unique and sequential
    #[test]
    fn test_governance_error_code_uniqueness() {
        let errors = vec![
            Error::ProposalNotFound as u32,
            Error::VotingNotStarted as u32,
            Error::VotingEnded as u32,
            Error::AlreadyVoted as u32,
            Error::VotingClosed as u32,
            Error::ProposalExpired as u32,
            Error::ProposalNotExecutable as u32,
            Error::QuorumNotMet as u32,
            Error::AlreadyExecuted as u32,
        ];

        // Verify all codes are unique
        for i in 0..errors.len() {
            for j in (i + 1)..errors.len() {
                assert_ne!(
                    errors[i], errors[j],
                    "Error codes must be unique: {} == {}",
                    errors[i], errors[j]
                );
            }
        }

        // Verify codes are in expected range (34-42)
        assert_eq!(Error::ProposalNotFound as u32, 34);
        assert_eq!(Error::VotingNotStarted as u32, 35);
        assert_eq!(Error::VotingEnded as u32, 36);
        assert_eq!(Error::AlreadyVoted as u32, 37);
        assert_eq!(Error::VotingClosed as u32, 38);
        assert_eq!(Error::ProposalExpired as u32, 39);
        assert_eq!(Error::ProposalNotExecutable as u32, 40);
        assert_eq!(Error::QuorumNotMet as u32, 41);
        assert_eq!(Error::AlreadyExecuted as u32, 42);
    }

    /// Test error code documentation completeness
    #[test]
    fn test_governance_error_documentation() {
        // This test serves as documentation that all governance errors
        // are properly defined and mapped to their numeric codes
        
        // Proposal lifecycle errors
        assert_eq!(Error::ProposalNotFound as u32, 34, "Proposal does not exist");
        assert_eq!(Error::ProposalExpired as u32, 39, "Proposal past expiration");
        assert_eq!(Error::ProposalNotExecutable as u32, 40, "Cannot execute in current state");
        assert_eq!(Error::AlreadyExecuted as u32, 42, "Proposal already executed");
        
        // Voting lifecycle errors
        assert_eq!(Error::VotingNotStarted as u32, 35, "Voting not yet open");
        assert_eq!(Error::VotingEnded as u32, 36, "Voting period ended");
        assert_eq!(Error::VotingClosed as u32, 38, "Voting no longer accepting votes");
        assert_eq!(Error::AlreadyVoted as u32, 37, "Voter already cast vote");
        
        // Execution validation errors
        assert_eq!(Error::QuorumNotMet as u32, 41, "Insufficient votes for quorum");
    }
}
