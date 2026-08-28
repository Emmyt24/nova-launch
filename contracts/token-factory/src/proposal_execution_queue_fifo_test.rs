//! FIFO execution queue with per-type dependency resolution (#1366).
//!
//! Governance proposals that mutate the same state must execute in a
//! deterministic order. These tests exercise the per-[`ActionType`] FIFO queue:
//!
//! - **FIFO order enforced** — two same-type proposals must execute in the
//!   order they were enqueued; executing the second before the first is
//!   rejected with [`Error::ProposalNotAtQueueFront`].
//! - **Cross-type independence** — proposals of different types live in
//!   independent queues and execute without blocking one another.
//! - Queue-position queries and the enqueue duplicate/state guards.

#[cfg(test)]
mod proposal_execution_queue_fifo_test {
    use crate::proposal_type_queue;
    use crate::storage;
    use crate::test_helpers::{fee_change_payload, pause_payload};
    use crate::timelock::{create_proposal, execute_proposal, queue_proposal, vote_proposal};
    use crate::types::{ActionType, Error, ProposalState, VoteChoice};
    use crate::TokenFactory;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Bytes, Env, Vec,
    };

    // ── Harness ───────────────────────────────────────────────────────────

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TokenFactory);
        let admin = Address::generate(&env);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_treasury(&env, &Address::generate(&env));
            storage::set_base_fee(&env, 1_000_000);
            storage::set_metadata_fee(&env, 500_000);
            crate::timelock::initialize_timelock(&env, Some(3_600)).unwrap();
        });
        (env, contract_id, admin)
    }

    /// Create a proposal, pass it with a majority, advance past voting, and
    /// queue it. Leaves the ledger at `end_time + 1` (before its eta) with the
    /// proposal in `Queued` state. Returns its id.
    fn make_queued(
        env: &Env,
        contract_id: &Address,
        admin: &Address,
        action_type: ActionType,
        payload: Bytes,
    ) -> u64 {
        env.as_contract(contract_id, || {
            let now = env.ledger().timestamp();
            let start = now + 10;
            let end = start + 1_000;
            let eta = end + 10_000; // generous timelock so etas don't elapse early

            let id = create_proposal(env, admin, action_type, payload, start, end, eta).unwrap();

            // Vote during the active window: 2 for, 1 against → passes.
            env.ledger().with_mut(|l| l.timestamp = start + 1);
            vote_proposal(env, &Address::generate(env), id, VoteChoice::For).unwrap();
            vote_proposal(env, &Address::generate(env), id, VoteChoice::For).unwrap();
            vote_proposal(env, &Address::generate(env), id, VoteChoice::Against).unwrap();

            // Advance past voting end and queue.
            env.ledger().with_mut(|l| l.timestamp = end + 1);
            queue_proposal(env, id).unwrap();

            assert_eq!(
                storage::get_proposal(env, id).unwrap().state,
                ProposalState::Queued
            );
            id
        })
    }

    fn enq(env: &Env, contract_id: &Address, id: u64) -> Result<u32, Error> {
        env.as_contract(contract_id, || proposal_type_queue::enqueue(env, id))
    }

    fn exec(env: &Env, contract_id: &Address, id: u64) -> Result<(), Error> {
        env.as_contract(contract_id, || execute_proposal(env, id))
    }

    fn pos(env: &Env, contract_id: &Address, id: u64) -> Option<u32> {
        env.as_contract(contract_id, || proposal_type_queue::position(env, id))
    }

    fn queue_ids(env: &Env, contract_id: &Address, action_type: ActionType) -> Vec<u64> {
        env.as_contract(contract_id, || {
            proposal_type_queue::queue_for(env, action_type)
        })
    }

    fn state(env: &Env, contract_id: &Address, id: u64) -> ProposalState {
        env.as_contract(contract_id, || {
            storage::get_proposal(env, id).unwrap().state
        })
    }

    fn advance_past_etas(env: &Env) {
        env.ledger().with_mut(|l| l.timestamp += 1_000_000);
    }

    fn fee(env: &Env) -> Bytes {
        fee_change_payload(env, 2_000_000, 1_000_000)
    }

    // ── FIFO ordering for same-type proposals ────────────────────────────

    #[test]
    fn test_same_type_executes_in_fifo_order() {
        let (env, contract_id, admin) = setup();

        // Two fee-update proposals; `first` is queued before `second`.
        let first = make_queued(&env, &contract_id, &admin, ActionType::FeeChange, fee(&env));
        let second = make_queued(&env, &contract_id, &admin, ActionType::FeeChange, fee(&env));

        assert_eq!(enq(&env, &contract_id, first).unwrap(), 0);
        assert_eq!(enq(&env, &contract_id, second).unwrap(), 1);

        advance_past_etas(&env);

        // The second proposal cannot jump the queue.
        assert_eq!(
            exec(&env, &contract_id, second),
            Err(Error::ProposalNotAtQueueFront)
        );
        assert_eq!(state(&env, &contract_id, second), ProposalState::Queued);

        // The front proposal executes and is removed, promoting `second`.
        exec(&env, &contract_id, first).unwrap();
        assert_eq!(state(&env, &contract_id, first), ProposalState::Executed);
        assert_eq!(pos(&env, &contract_id, second), Some(0));

        // Now the second proposal may execute.
        exec(&env, &contract_id, second).unwrap();
        assert_eq!(state(&env, &contract_id, second), ProposalState::Executed);
        assert_eq!(
            queue_ids(&env, &contract_id, ActionType::FeeChange).len(),
            0
        );
    }

    // ── Cross-type proposals are independent ─────────────────────────────

    #[test]
    fn test_different_types_execute_independently() {
        let (env, contract_id, admin) = setup();

        // Two fee proposals (same queue) and one pause proposal (separate queue).
        let fee1 = make_queued(&env, &contract_id, &admin, ActionType::FeeChange, fee(&env));
        let fee2 = make_queued(&env, &contract_id, &admin, ActionType::FeeChange, fee(&env));
        let pause = make_queued(
            &env,
            &contract_id,
            &admin,
            ActionType::PauseContract,
            pause_payload(&env),
        );

        enq(&env, &contract_id, fee1).unwrap();
        enq(&env, &contract_id, fee2).unwrap();
        enq(&env, &contract_id, pause).unwrap();

        advance_past_etas(&env);

        // The pause proposal is the sole entry in its own type queue, so it can
        // execute even though the fee queue still has fee1 ahead of fee2.
        exec(&env, &contract_id, pause).unwrap();
        assert_eq!(state(&env, &contract_id, pause), ProposalState::Executed);

        // The fee queue is untouched by the pause execution: fee1 still front,
        // and fee2 is still blocked behind it.
        assert_eq!(pos(&env, &contract_id, fee1), Some(0));
        assert_eq!(pos(&env, &contract_id, fee2), Some(1));
        assert_eq!(
            exec(&env, &contract_id, fee2),
            Err(Error::ProposalNotAtQueueFront)
        );

        exec(&env, &contract_id, fee1).unwrap();
        exec(&env, &contract_id, fee2).unwrap();
        assert_eq!(state(&env, &contract_id, fee1), ProposalState::Executed);
        assert_eq!(state(&env, &contract_id, fee2), ProposalState::Executed);
    }

    // ── enqueue guards ───────────────────────────────────────────────────

    #[test]
    fn test_enqueue_duplicate_rejected() {
        let (env, contract_id, admin) = setup();
        let id = make_queued(&env, &contract_id, &admin, ActionType::FeeChange, fee(&env));
        enq(&env, &contract_id, id).unwrap();
        assert_eq!(enq(&env, &contract_id, id), Err(Error::InvalidParameters));
    }

    #[test]
    fn test_enqueue_non_queued_proposal_rejected() {
        let (env, contract_id, admin) = setup();
        // Created but never voted/queued → still in a non-Queued state.
        let id = env.as_contract(&contract_id, || {
            let now = env.ledger().timestamp();
            create_proposal(
                &env,
                &admin,
                ActionType::FeeChange,
                fee(&env),
                now + 10,
                now + 1_000,
                now + 11_000,
            )
            .unwrap()
        });
        assert_eq!(enq(&env, &contract_id, id), Err(Error::InvalidParameters));
    }

    #[test]
    fn test_enqueue_nonexistent_proposal_rejected() {
        let (env, contract_id, _admin) = setup();
        assert_eq!(enq(&env, &contract_id, 999), Err(Error::ProposalNotFound));
    }

    // ── Backward compatibility: non-enqueued proposals are unconstrained ─

    #[test]
    fn test_non_enqueued_proposal_executes_without_fifo_constraint() {
        let (env, contract_id, admin) = setup();
        // Queued but deliberately NOT placed in the type queue.
        let id = make_queued(&env, &contract_id, &admin, ActionType::FeeChange, fee(&env));
        assert_eq!(pos(&env, &contract_id, id), None);

        advance_past_etas(&env);
        exec(&env, &contract_id, id).unwrap();
        assert_eq!(state(&env, &contract_id, id), ProposalState::Executed);
    }
}
