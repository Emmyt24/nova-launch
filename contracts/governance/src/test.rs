#![cfg(test)]

use crate::{GovernanceContract, GovernanceContractClient};
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, String};

/// Returns (env, client, admin) — matches the two-argument initialize signature.
fn setup() -> (Env, GovernanceContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, GovernanceContract);
    let client = GovernanceContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    // Current signature: initialize(admin: Address, total_supply: i128)
    client.initialize(&admin, &1_000_000_i128);

    (env, client, admin)
}

#[test]
fn test_initialize() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, GovernanceContract);
    let client = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    // Two-argument form matching current GovernanceContract::initialize
    client.initialize(&admin, &1_000_000_i128);
}

#[test]
fn test_cannot_initialize_twice() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, GovernanceContract);
    let client = GovernanceContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.initialize(&admin, &1_000_000_i128);

    // Second initialization must fail
    let result = client.try_initialize(&admin, &1_000_000_i128);
    assert!(result.is_err(), "second initialize must return an error");
}

#[test]
fn test_create_proposal() {
    let (env, client, creator) = setup();

    // Six-argument create_proposal: creator, description, payload, voting_period, quorum, threshold_percent
    let proposal_id = client.create_proposal(
        &creator,
        &String::from_str(&env, "Test proposal"),
        &Bytes::new(&env),
        &3600_u64,
        &1000_i128,
        &50_u32,
    );

    assert_eq!(proposal_id, 0);

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.id, 0);
    assert_eq!(proposal.creator, creator);
    assert_eq!(proposal.votes_for, 0);
    assert_eq!(proposal.votes_against, 0);
    assert_eq!(proposal.status, crate::types::ProposalStatus::Active);
}

#[test]
fn test_unique_proposal_ids() {
    let (env, client, creator) = setup();

    let id1 = client.create_proposal(
        &creator,
        &String::from_str(&env, "Proposal 1"),
        &Bytes::new(&env),
        &3600_u64,
        &1000_i128,
        &50_u32,
    );

    let id2 = client.create_proposal(
        &creator,
        &String::from_str(&env, "Proposal 2"),
        &Bytes::new(&env),
        &3600_u64,
        &1000_i128,
        &50_u32,
    );

    assert_ne!(id1, id2);
    assert_eq!(id1, 0);
    assert_eq!(id2, 1);
}
