use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

#[test]
fn test_proposal_type_queue_max_length() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let proposer = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    // Create MAX_TYPE_QUEUE_LENGTH proposals and enqueue them
    let action_type = ActionType::UpdateGovernanceConfig;
    let mut proposal_ids = Vec::new(&env);

    for i in 0..proposal_type_queue::MAX_TYPE_QUEUE_LENGTH {
        let config = GovernanceConfig {
            voting_period: 100,
            timelock_period: 50,
            quorum_percentage: 50,
            execution_period: 100,
            dynamic_quorum_enabled: false,
            min_proposal_threshold: 1,
            max_voting_period: 1000,
            max_timelock_period: 1000,
            max_quorum_percentage: 100,
        };

        let proposal_id = client.propose(
            &proposer,
            &String::from_str(&env, &format!("Proposal {}", i)),
            &String::from_str(&env, &format!("Description {}", i)),
            &action_type,
            &Bytes::new(&env),
            &config,
            &100,
        );

        // Queue the proposal
        client.queue_proposal(&proposal_id);

        proposal_ids.push_back(proposal_id);
    }

    // Verify all proposals are enqueued
    let queue_len = proposal_type_queue::queue_len(&env, action_type);
    assert_eq!(queue_len, proposal_type_queue::MAX_TYPE_QUEUE_LENGTH);

    // Try to enqueue one more proposal of the same type - should fail
    let config = GovernanceConfig {
        voting_period: 100,
        timelock_period: 50,
        quorum_percentage: 50,
        execution_period: 100,
        dynamic_quorum_enabled: false,
        min_proposal_threshold: 1,
        max_voting_period: 1000,
        max_timelock_period: 1000,
        max_quorum_percentage: 100,
    };

    let extra_proposal_id = client.propose(
        &proposer,
        &String::from_str(&env, "Extra Proposal"),
        &String::from_str(&env, "Extra Description"),
        &action_type,
        &Bytes::new(&env),
        &config,
        &100,
    );

    // Queue the extra proposal - should fail because queue is at max
    let result = client.queue_proposal(&extra_proposal_id);
    assert!(result.is_err());
}

#[test]
fn test_proposal_type_queue_max_length_different_types() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let proposer = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    // Create MAX_TYPE_QUEUE_LENGTH proposals for one action type
    let action_type_1 = ActionType::UpdateGovernanceConfig;
    for i in 0..proposal_type_queue::MAX_TYPE_QUEUE_LENGTH {
        let config = GovernanceConfig {
            voting_period: 100,
            timelock_period: 50,
            quorum_percentage: 50,
            execution_period: 100,
            dynamic_quorum_enabled: false,
            min_proposal_threshold: 1,
            max_voting_period: 1000,
            max_timelock_period: 1000,
            max_quorum_percentage: 100,
        };

        let proposal_id = client.propose(
            &proposer,
            &String::from_str(&env, &format!("Proposal Type1 {}", i)),
            &String::from_str(&env, &format!("Description {}", i)),
            &action_type_1,
            &Bytes::new(&env),
            &config,
            &100,
        );

        client.queue_proposal(&proposal_id);
    }

    // Create a proposal for a different action type - should succeed
    let action_type_2 = ActionType::UpdateTreasuryAddress;
    let treasury_addr = Address::generate(&env);
    let config = GovernanceConfig {
        voting_period: 100,
        timelock_period: 50,
        quorum_percentage: 50,
        execution_period: 100,
        dynamic_quorum_enabled: false,
        min_proposal_threshold: 1,
        max_voting_period: 1000,
        max_timelock_period: 1000,
        max_quorum_percentage: 100,
    };

    let proposal_id = client.propose(
        &proposer,
        &String::from_str(&env, "Treasury Proposal"),
        &String::from_str(&env, "Treasury Description"),
        &action_type_2,
        &Bytes::new(&env),
        &config,
        &100,
    );

    // Queue the proposal for a different action type - should succeed
    let result = client.queue_proposal(&proposal_id);
    assert!(result.is_ok());

    // Verify queue lengths
    let queue_len_1 = proposal_type_queue::queue_len(&env, action_type_1);
    let queue_len_2 = proposal_type_queue::queue_len(&env, action_type_2);
    assert_eq!(queue_len_1, proposal_type_queue::MAX_TYPE_QUEUE_LENGTH);
    assert_eq!(queue_len_2, 1);
}
