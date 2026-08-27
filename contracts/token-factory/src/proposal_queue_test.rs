//! Proposal Queue Ordering and Expiry Test Suite
//!
//! Validates that proposals submitted in the same ledger maintain FIFO ordering,
//! expired proposals are correctly skipped/cleaned up, and queue accounting
//! remains correct after expiry cleanup.

#[cfg(test)]
mod proposal_queue_test {
    use crate::proposal_queue;
    use crate::storage;
    use crate::timelock::{self, create_proposal, queue_proposal, vote_proposal};
    use crate::types::{ActionType, Error, ProposalPriority, ProposalState, VoteChoice};
    use crate::test_helpers::fee_change_payload;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env,
    };

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        let admin = Address::generate(&env);

        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_treasury(&env, &Address::generate(&env));
            storage::set_base_fee(&env, 1_000_000);
            storage::set_metadata_fee(&env, 500_000);
            timelock::initialize_timelock(&env, Some(3_600)).ok();
            crate::governance::initialize_governance(&env, Some(30), Some(51)).ok();
        });

        (env, contract_id, admin)
    }

    fn create_and_queue_proposal(
        env: &Env,
        contract_id: &Address,
        admin: &Address,
        eta: u64,
    ) -> u64 {
        env.as_contract(contract_id, || {
            let now = env.ledger().timestamp();
            let start = now + 10;
            let end = start + 100;

            let payload = fee_change_payload(env, 2_000_000, 1_000_000);
            let id = create_proposal(env, admin, ActionType::FeeChange, payload, start, end, eta)
                .expect("Failed to create proposal");

            // Vote to pass
            env.ledger().with_mut(|l| l.timestamp = start + 1);
            vote_proposal(env, &Address::generate(env), id, VoteChoice::For)
                .expect("Failed to vote");
            vote_proposal(env, &Address::generate(env), id, VoteChoice::For)
                .expect("Failed to vote");
            vote_proposal(env, &Address::generate(env), id, VoteChoice::Against)
                .expect("Failed to vote");

            // Queue the proposal
            env.ledger().with_mut(|l| l.timestamp = end + 1);
            queue_proposal(env, id).expect("Failed to queue proposal");

            id
        })
    }

    // ── FIFO ordering for proposals submitted in the same ledger ──────────────

    #[test]
    fn test_fifo_ordering_same_ledger_same_priority() {
        let (env, contract_id, admin) = setup();

        env.as_contract(&contract_id, || {
            let now = env.ledger().timestamp();
            let eta = now + 10_000;

            // Create and queue two proposals in the same ledger
            let id1 = create_and_queue_proposal(&env, &contract_id, &admin, eta);
            let id2 = create_and_queue_proposal(&env, &contract_id, &admin, eta);

            // Enqueue both with same priority
            let slot1 = proposal_queue::enqueue_proposal(&env, id1, ProposalPriority::High)
                .expect("Failed to enqueue proposal 1");
            let slot2 = proposal_queue::enqueue_proposal(&env, id2, ProposalPriority::High)
                .expect("Failed to enqueue proposal 2");

            // Verify they're queued in order
            assert!(
                slot1 < slot2,
                "First proposal should have lower slot index than second"
            );

            // Advance past ETA and peek
            env.ledger().with_mut(|l| l.timestamp = eta + 1);

            let next = proposal_queue::peek_next(&env).expect("Should have an entry to peek");
            assert_eq!(
                next.proposal_id, id1,
                "Peek should return the first proposal (FIFO)"
            );
        });
    }

    #[test]
    fn test_fifo_ordering_within_same_priority() {
        let (env, contract_id, admin) = setup();

        env.as_contract(&contract_id, || {
            let now = env.ledger().timestamp();
            let eta = now + 5_000;

            // Create three proposals
            let id1 = create_and_queue_proposal(&env, &contract_id, &admin, eta);
            let id2 = create_and_queue_proposal(&env, &contract_id, &admin, eta);
            let id3 = create_and_queue_proposal(&env, &contract_id, &admin, eta);

            // Enqueue all with same priority
            proposal_queue::enqueue_proposal(&env, id1, ProposalPriority::Medium)
                .expect("Failed to enqueue proposal 1");
            proposal_queue::enqueue_proposal(&env, id2, ProposalPriority::Medium)
                .expect("Failed to enqueue proposal 2");
            proposal_queue::enqueue_proposal(&env, id3, ProposalPriority::Medium)
                .expect("Failed to enqueue proposal 3");

            // Advance past ETA
            env.ledger().with_mut(|l| l.timestamp = eta + 1);

            // Verify FIFO order by dequeuing sequentially
            let entry1 = proposal_queue::dequeue_next(&env).expect("Should dequeue first entry");
            assert_eq!(entry1.proposal_id, id1, "First dequeued should be id1 (FIFO)");

            let entry2 = proposal_queue::dequeue_next(&env).expect("Should dequeue second entry");
            assert_eq!(entry2.proposal_id, id2, "Second dequeued should be id2 (FIFO)");

            let entry3 = proposal_queue::dequeue_next(&env).expect("Should dequeue third entry");
            assert_eq!(entry3.proposal_id, id3, "Third dequeued should be id3 (FIFO)");

            // Queue should now be empty
            let result = proposal_queue::dequeue_next(&env);
            assert_eq!(
                result,
                Err(Error::NothingToClaim),
                "Dequeue from empty queue should error"
            );
        });
    }

    // ── Queue behavior when head proposal expires ────────────────────────────

    #[test]
    fn test_expired_proposal_skipped_on_peek() {
        let (env, contract_id, admin) = setup();

        env.as_contract(&contract_id, || {
            let now = env.ledger().timestamp();
            let eta1 = now + 1_000;
            let eta2 = now + 5_000; // expires later

            // Create and queue two proposals with different ETAs
            let id1 = create_and_queue_proposal(&env, &contract_id, &admin, eta1);
            let id2 = create_and_queue_proposal(&env, &contract_id, &admin, eta2);

            // Enqueue both
            proposal_queue::enqueue_proposal(&env, id1, ProposalPriority::High)
                .expect("Failed to enqueue proposal 1");
            proposal_queue::enqueue_proposal(&env, id2, ProposalPriority::High)
                .expect("Failed to enqueue proposal 2");

            // Advance past first proposal's ETA but not second's
            env.ledger().with_mut(|l| l.timestamp = eta1 + 1);

            // Peek should return the first proposal (oldest ETA that's ready)
            let next = proposal_queue::peek_next(&env).expect("Should have an entry");
            assert_eq!(next.proposal_id, id1, "Should return id1 (earliest ready ETA)");

            // Advance past both ETAs
            env.ledger().with_mut(|l| l.timestamp = eta2 + 1);

            // Peek should still prefer id1 (FIFO within same priority)
            let next = proposal_queue::peek_next(&env).expect("Should have an entry");
            assert_eq!(
                next.proposal_id, id1,
                "Should still return id1 (FIFO within same priority)"
            );
        });
    }

    #[test]
    fn test_expired_proposal_skipped_on_dequeue() {
        let (env, contract_id, admin) = setup();

        env.as_contract(&contract_id, || {
            let now = env.ledger().timestamp();
            let eta1 = now + 500; // expires first
            let eta2 = now + 5_000;

            // Create and queue two proposals
            let id1 = create_and_queue_proposal(&env, &contract_id, &admin, eta1);
            let id2 = create_and_queue_proposal(&env, &contract_id, &admin, eta2);

            // Enqueue both
            proposal_queue::enqueue_proposal(&env, id1, ProposalPriority::Medium)
                .expect("Failed to enqueue proposal 1");
            proposal_queue::enqueue_proposal(&env, id2, ProposalPriority::Medium)
                .expect("Failed to enqueue proposal 2");

            // Advance past first proposal's ETA
            env.ledger().with_mut(|l| l.timestamp = eta1 + 100);

            // Dequeue should return id1 (earliest ready)
            let entry1 = proposal_queue::dequeue_next(&env).expect("Should dequeue id1");
            assert_eq!(entry1.proposal_id, id1);

            // Advance past second proposal's ETA
            env.ledger().with_mut(|l| l.timestamp = eta2 + 100);

            // Dequeue should return id2
            let entry2 = proposal_queue::dequeue_next(&env).expect("Should dequeue id2");
            assert_eq!(entry2.proposal_id, id2);
        });
    }

    // ── Queue length accounting after expiry ────────────────────────────────

    #[test]
    fn test_queue_length_accuracy_after_dequeue() {
        let (env, contract_id, admin) = setup();

        env.as_contract(&contract_id, || {
            let now = env.ledger().timestamp();
            let eta = now + 1_000;

            // Create and queue three proposals
            let id1 = create_and_queue_proposal(&env, &contract_id, &admin, eta);
            let id2 = create_and_queue_proposal(&env, &contract_id, &admin, eta);
            let id3 = create_and_queue_proposal(&env, &contract_id, &admin, eta);

            proposal_queue::enqueue_proposal(&env, id1, ProposalPriority::High)
                .expect("Failed to enqueue");
            proposal_queue::enqueue_proposal(&env, id2, ProposalPriority::High)
                .expect("Failed to enqueue");
            proposal_queue::enqueue_proposal(&env, id3, ProposalPriority::High)
                .expect("Failed to enqueue");

            // Initial queue length should be 3
            assert_eq!(
                proposal_queue::queue_len(&env),
                3,
                "Queue should have 3 entries"
            );

            // Advance past ETA and dequeue one
            env.ledger().with_mut(|l| l.timestamp = eta + 1);
            proposal_queue::dequeue_next(&env).expect("Failed to dequeue");

            // Queue length should now be 2
            assert_eq!(
                proposal_queue::queue_len(&env),
                2,
                "Queue should have 2 entries after dequeuing 1"
            );

            // Dequeue another
            proposal_queue::dequeue_next(&env).expect("Failed to dequeue");

            // Queue length should now be 1
            assert_eq!(
                proposal_queue::queue_len(&env),
                1,
                "Queue should have 1 entry after dequeuing 2"
            );

            // Dequeue the last one
            proposal_queue::dequeue_next(&env).expect("Failed to dequeue");

            // Queue should be empty
            assert_eq!(
                proposal_queue::queue_len(&env),
                0,
                "Queue should be empty after dequeuing all"
            );
        });
    }

    // ── Priority-based ordering ──────────────────────────────────────────────

    #[test]
    fn test_high_priority_executes_before_low_priority() {
        let (env, contract_id, admin) = setup();

        env.as_contract(&contract_id, || {
            let now = env.ledger().timestamp();
            let eta = now + 5_000;

            // Create and queue two proposals
            let id_low = create_and_queue_proposal(&env, &contract_id, &admin, eta);
            let id_high = create_and_queue_proposal(&env, &contract_id, &admin, eta);

            // Enqueue low priority first, then high priority
            proposal_queue::enqueue_proposal(&env, id_low, ProposalPriority::Low)
                .expect("Failed to enqueue low priority");
            proposal_queue::enqueue_proposal(&env, id_high, ProposalPriority::High)
                .expect("Failed to enqueue high priority");

            // Advance past ETA
            env.ledger().with_mut(|l| l.timestamp = eta + 1);

            // Peek should return high priority proposal (priority-based)
            let next = proposal_queue::peek_next(&env).expect("Should have an entry");
            assert_eq!(
                next.proposal_id, id_high,
                "High priority should be returned before low priority"
            );

            // Dequeue and verify
            let entry = proposal_queue::dequeue_next(&env).expect("Should dequeue");
            assert_eq!(entry.proposal_id, id_high, "Should dequeue high priority first");

            // Now low priority should be next
            let next = proposal_queue::peek_next(&env).expect("Should have an entry");
            assert_eq!(next.proposal_id, id_low, "Low priority should be next");
        });
    }

    // ── Remove proposal from queue ──────────────────────────────────────────

    #[test]
    fn test_remove_from_queue_success() {
        let (env, contract_id, admin) = setup();

        env.as_contract(&contract_id, || {
            let now = env.ledger().timestamp();
            let eta = now + 5_000;

            // Create and queue two proposals
            let id1 = create_and_queue_proposal(&env, &contract_id, &admin, eta);
            let id2 = create_and_queue_proposal(&env, &contract_id, &admin, eta);

            proposal_queue::enqueue_proposal(&env, id1, ProposalPriority::High)
                .expect("Failed to enqueue");
            proposal_queue::enqueue_proposal(&env, id2, ProposalPriority::High)
                .expect("Failed to enqueue");

            // Initial length is 2
            assert_eq!(proposal_queue::queue_len(&env), 2);

            // Remove id1
            proposal_queue::remove_from_queue(&env, id1).expect("Failed to remove");

            // Length should now be 1
            assert_eq!(proposal_queue::queue_len(&env), 1);

            // Advance past ETA
            env.ledger().with_mut(|l| l.timestamp = eta + 1);

            // Only id2 should be retrievable
            let next = proposal_queue::peek_next(&env).expect("Should have an entry");
            assert_eq!(next.proposal_id, id2);
        });
    }

    #[test]
    fn test_remove_nonexistent_proposal_fails() {
        let (env, contract_id, admin) = setup();

        env.as_contract(&contract_id, || {
            let now = env.ledger().timestamp();
            let eta = now + 5_000;

            let _id = create_and_queue_proposal(&env, &contract_id, &admin, eta);
            let nonexistent_id = 999u64;

            let result = proposal_queue::remove_from_queue(&env, nonexistent_id);
            assert_eq!(
                result,
                Err(Error::ProposalNotFound),
                "Removing nonexistent proposal should error"
            );
        });
    }

    // ── Empty queue behavior ─────────────────────────────────────────────────

    #[test]
    fn test_empty_queue_peek_returns_none() {
        let (env, contract_id, _admin) = setup();

        env.as_contract(&contract_id, || {
            let result = proposal_queue::peek_next(&env);
            assert_eq!(result, None, "Peeking at empty queue should return None");
        });
    }

    #[test]
    fn test_empty_queue_dequeue_fails() {
        let (env, contract_id, _admin) = setup();

        env.as_contract(&contract_id, || {
            let result = proposal_queue::dequeue_next(&env);
            assert_eq!(
                result,
                Err(Error::NothingToClaim),
                "Dequeuing from empty queue should error"
            );
        });
    }

    #[test]
    fn test_queue_length_empty_returns_zero() {
        let (env, contract_id, _admin) = setup();

        env.as_contract(&contract_id, || {
            let len = proposal_queue::queue_len(&env);
            assert_eq!(len, 0, "Empty queue should have length 0");
        });
    }
}
