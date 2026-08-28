/// invariant_tests.rs
///
/// Targeted tests that intentionally violate each invariant to confirm
/// the assertion triggers. Every test in this file is expected to panic.
extern crate std;

#[cfg(test)]
mod invariant_tests {
    use crate::invariants::{
        assert_burn_count_monotonic, assert_burned_within_bounds, assert_stream_count_monotonic,
        assert_supply_conservation, assert_supply_non_negative, assert_terminal_state_immutable,
        assert_token_count_monotonic, ProposalStatus,
    };
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup() -> (Env, Address, Address, Address, u32) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, crate::TokenFactory);
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &100_i128, &50_i128);

        client.create_token(
            &admin,
            &soroban_sdk::String::from_str(&env, "InvToken"),
            &soroban_sdk::String::from_str(&env, "INV"),
            &6_u32,
            &1_000_000_i128,
            &None,
            &100_i128,
        );

        let token_index = 0_u32;
        crate::storage::set_balance(&env, token_index, &admin, 1_000_000_i128);

        (env, contract_id, admin, treasury, token_index)
    }

    #[test]
    #[should_panic(expected = "INVARIANT VIOLATION [supply_conservation]")]
    fn violation_supply_conservation_corrupt_supply() {
        let (env, _contract_id, _admin, _treasury, token_index) = setup();

        let mut info = crate::storage::get_token_info(&env, token_index).unwrap();
        info.total_supply -= 50_000;
        crate::storage::set_token_info(&env, token_index, &info);

        assert_supply_conservation(&env, token_index, 1_000_000_i128);
    }

    #[test]
    #[should_panic(expected = "INVARIANT VIOLATION [supply_conservation]")]
    fn violation_supply_conservation_inflated_burned() {
        let (env, _contract_id, _admin, _treasury, token_index) = setup();

        crate::storage::add_total_burned(&env, token_index, 999_999_i128);

        assert_supply_conservation(&env, token_index, 1_000_000_i128);
    }

    #[test]
    #[should_panic(expected = "INVARIANT VIOLATION [supply_non_negative]")]
    fn violation_supply_non_negative() {
        let (env, _contract_id, _admin, _treasury, token_index) = setup();

        let mut info = crate::storage::get_token_info(&env, token_index).unwrap();
        info.total_supply = -1_i128;
        crate::storage::set_token_info(&env, token_index, &info);

        assert_supply_non_negative(&env, token_index);
    }

    #[test]
    #[should_panic(expected = "INVARIANT VIOLATION [burned_within_bounds]")]
    fn violation_burned_exceeds_initial_supply() {
        let (env, _contract_id, _admin, _treasury, token_index) = setup();

        crate::storage::add_total_burned(&env, token_index, 2_000_000_i128);

        assert_burned_within_bounds(&env, token_index, 1_000_000_i128);
    }

    #[test]
    #[should_panic(expected = "INVARIANT VIOLATION [token_count_monotonic]")]
    fn violation_token_count_regressed() {
        let (env, _contract_id, _admin, _treasury, _token_index) = setup();

        assert_token_count_monotonic(&env, 2_u32);
    }

    #[test]
    #[should_panic(expected = "INVARIANT VIOLATION [stream_count_monotonic]")]
    fn violation_stream_count_regressed() {
        let (env, _contract_id, admin, _treasury, _token_index) = setup();

        assert_stream_count_monotonic(&env, &admin, 5_u32);
    }

    #[test]
    #[should_panic(expected = "INVARIANT VIOLATION [burn_count_monotonic]")]
    fn violation_burn_count_regressed() {
        let (env, _contract_id, _admin, _treasury, token_index) = setup();

        assert_burn_count_monotonic(&env, token_index, 1_u32);
    }

    #[test]
    #[should_panic(expected = "INVARIANT VIOLATION [terminal_state_immutable]")]
    fn violation_executed_proposal_transitions_to_active() {
        assert_terminal_state_immutable(ProposalStatus::Executed, ProposalStatus::Active);
    }

    #[test]
    #[should_panic(expected = "INVARIANT VIOLATION [terminal_state_immutable]")]
    fn violation_rejected_proposal_transitions_to_pending() {
        assert_terminal_state_immutable(ProposalStatus::Rejected, ProposalStatus::Pending);
    }

    #[test]
    #[should_panic(expected = "INVARIANT VIOLATION [terminal_state_immutable]")]
    fn violation_executed_proposal_transitions_to_rejected() {
        assert_terminal_state_immutable(ProposalStatus::Executed, ProposalStatus::Rejected);
    }

    #[test]
    fn valid_supply_conservation_after_burn() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        client.burn(&admin, &token_index, &200_000_i128);

        assert_supply_conservation(&env, token_index, 1_000_000_i128);
        assert_supply_non_negative(&env, token_index);
        assert_burned_within_bounds(&env, token_index, 1_000_000_i128);
    }

    #[test]
    fn valid_monotonic_counters_after_create() {
        let (env, _contract_id, admin, _treasury, _token_index) = setup();

        assert_token_count_monotonic(&env, 1_u32);
        assert_stream_count_monotonic(&env, &admin, 1_u32);
    }

    #[test]
    fn valid_active_to_executed_transition() {
        assert_terminal_state_immutable(ProposalStatus::Active, ProposalStatus::Executed);
    }

    #[test]
    fn valid_executed_stays_executed() {
        assert_terminal_state_immutable(ProposalStatus::Executed, ProposalStatus::Executed);
    }
}
