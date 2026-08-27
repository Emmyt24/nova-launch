#![cfg(test)]

use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

// ── #1680: vote_proposal overflow returns typed error, not panic ───────────

/// Inject a proposal whose vote counter is already at i128::MAX, then cast
/// one more vote and verify that Error::ArithmeticError is returned instead
/// of panicking.
#[test]
fn test_vote_proposal_overflow_returns_typed_error() {
    use crate::storage;
    use crate::timelock::vote_proposal;
    use crate::types::{
        ActionType, Bytes, Error, Proposal, ProposalState, String, VoteChoice,
    };
    use soroban_sdk::testutils::Ledger;

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);

    let admin = Address::generate(&env);
    let voter = Address::generate(&env);

    // Build an overflowing proposal directly in storage
    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &admin);
        storage::set_treasury(&env, &admin);
        storage::set_base_fee(&env, 1_000_000);
        storage::set_metadata_fee(&env, 500_000);

        let now = env.ledger().timestamp();

        let proposal = Proposal {
            id: 0,
            proposer: admin.clone(),
            action_type: ActionType::FeeChange,
            payload: Bytes::new(&env),
            description: String::from_str(&env, "overflow test"),
            created_at: now,
            start_time: now,
            // Set end_time far in the future so voting window is open
            end_time: now + 86_400,
            eta: now + 90_000,
            timelock_delay: 0,
            queued_at_ledger: 0,
            // votes_for already at i128::MAX — next checked_add(1) overflows
            votes_for: i128::MAX,
            votes_against: 0,
            votes_abstain: 0,
            state: ProposalState::Active,
            executed_at: None,
            cancelled_at: None,
            circulating_supply_snapshot: 1_000_000,
        };

        storage::set_proposal(&env, 0, &proposal);

        // Voter must not have voted yet
        let result = vote_proposal(&env, &voter, 0, VoteChoice::For);
        assert_eq!(
            result,
            Err(Error::ArithmeticError),
            "votes_for overflow must return ArithmeticError, not panic"
        );
    });
}

/// Same test for votes_against overflow path.
#[test]
fn test_vote_proposal_against_overflow_returns_typed_error() {
    use crate::storage;
    use crate::timelock::vote_proposal;
    use crate::types::{
        ActionType, Bytes, Error, Proposal, ProposalState, String, VoteChoice,
    };
    use soroban_sdk::testutils::Ledger;

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);

    let admin = Address::generate(&env);
    let voter = Address::generate(&env);

    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &admin);
        storage::set_treasury(&env, &admin);
        storage::set_base_fee(&env, 1_000_000);
        storage::set_metadata_fee(&env, 500_000);

        let now = env.ledger().timestamp();

        let proposal = Proposal {
            id: 1,
            proposer: admin.clone(),
            action_type: ActionType::FeeChange,
            payload: Bytes::new(&env),
            description: String::from_str(&env, "against overflow test"),
            created_at: now,
            start_time: now,
            end_time: now + 86_400,
            eta: now + 90_000,
            timelock_delay: 0,
            queued_at_ledger: 0,
            votes_for: 0,
            // votes_against already at i128::MAX — next checked_add(1) overflows
            votes_against: i128::MAX,
            votes_abstain: 0,
            state: ProposalState::Active,
            executed_at: None,
            cancelled_at: None,
            circulating_supply_snapshot: 1_000_000,
        };

        storage::set_proposal(&env, 1, &proposal);

        let result = vote_proposal(&env, &voter, 1, VoteChoice::Against);
        assert_eq!(
            result,
            Err(Error::ArithmeticError),
            "votes_against overflow must return ArithmeticError, not panic"
        );
    });
}

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &1_000_000, &500_000);

    (env, contract_id, admin, treasury)
}

#[test]
fn test_timelock_basic_setup() {
    let (_env, _contract_id, _admin, _treasury) = setup();
    // Basic test to verify setup works
}

// ── #1130: Timelock delay bounds ──────────────────────────────────────────

#[test]
fn test_timelock_delay_below_min_rejected() {
    // A delay of 0 (below MIN_TIMELOCK_DELAY = 3600) must be rejected.
    use crate::timelock::{initialize_timelock, MIN_TIMELOCK_DELAY};
    use crate::storage;

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);

    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &Address::generate(&env));
        // below minimum
        let result = initialize_timelock(&env, Some(MIN_TIMELOCK_DELAY - 1));
        assert!(result.is_err());
        // exactly at minimum — must succeed
        let result = initialize_timelock(&env, Some(MIN_TIMELOCK_DELAY));
        assert!(result.is_ok());
    });
}

#[test]
fn test_timelock_delay_above_max_rejected() {
    // A delay above MAX_TIMELOCK_DELAY must be rejected.
    use crate::timelock::{initialize_timelock, MAX_TIMELOCK_DELAY};
    use crate::storage;

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);

    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &Address::generate(&env));
        let result = initialize_timelock(&env, Some(MAX_TIMELOCK_DELAY + 1));
        assert!(result.is_err());
        // exactly at maximum — must succeed
        let result = initialize_timelock(&env, Some(MAX_TIMELOCK_DELAY));
        assert!(result.is_ok());
    });
}

#[test]
fn test_timelock_delay_in_range_accepted() {
    // A delay within [MIN, MAX] must succeed.
    use crate::timelock::{initialize_timelock, MAX_TIMELOCK_DELAY, MIN_TIMELOCK_DELAY};
    use crate::storage;

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);

    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &Address::generate(&env));
        let mid = (MIN_TIMELOCK_DELAY + MAX_TIMELOCK_DELAY) / 2;
        let result = initialize_timelock(&env, Some(mid));
        assert!(result.is_ok());
    });
}
