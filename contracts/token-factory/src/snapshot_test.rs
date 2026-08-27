#![cfg(test)]

use crate::{snapshot, storage, types::DataKey, TokenFactory, TokenFactoryClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, TokenFactoryClient, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let holder = Address::generate(&env);

    client.initialize(&admin, &treasury, &1_000_000, &500_000);

    (env, client, admin, holder)
}

#[test]
fn test_snapshot_captures_state_before_mutations() {
    let (env, _client, _admin, holder) = setup();

    let token_index = 0u32;
    let initial_balance = 1_000_000i128;

    // Set initial balance
    env.as_contract(&env.current_contract_address(), || {
        storage::set_balance(&env, token_index, &holder, initial_balance);
    });

    // Take snapshot of initial state
    env.as_contract(&env.current_contract_address(), || {
        snapshot::record_balance_snapshot(&env, token_index, &holder, initial_balance).unwrap();
    });

    // Verify snapshot was recorded
    env.as_contract(&env.current_contract_address(), || {
        let count = snapshot::get_balance_snapshot_count(&env, token_index, &holder);
        assert_eq!(count, 1);

        let snap = snapshot::get_balance_snapshot(&env, token_index, &holder, 0).unwrap();
        assert_eq!(snap.balance, initial_balance);
    });

    // Now mutate the balance
    env.as_contract(&env.current_contract_address(), || {
        storage::set_balance(&env, token_index, &holder, 2_000_000);

        // Take another snapshot
        snapshot::record_balance_snapshot(&env, token_index, &holder, 2_000_000).unwrap();

        // Verify first snapshot is still unchanged
        let first_snap = snapshot::get_balance_snapshot(&env, token_index, &holder, 0).unwrap();
        assert_eq!(first_snap.balance, initial_balance, "First snapshot should be immutable");

        // Verify second snapshot captures new state
        let second_snap = snapshot::get_balance_snapshot(&env, token_index, &holder, 1).unwrap();
        assert_eq!(second_snap.balance, 2_000_000);
    });
}

#[test]
fn test_snapshot_taken_during_batch_reflects_consistent_state() {
    let (env, _client, _admin, holder) = setup();

    let token_index = 0u32;

    env.as_contract(&env.current_contract_address(), || {
        // Initial state
        storage::set_balance(&env, token_index, &holder, 0);
        snapshot::record_balance_snapshot(&env, token_index, &holder, 0).unwrap();

        // Simulate a batch mutation: accumulate several mutations
        let mut balance = 0i128;
        for i in 1..=5 {
            balance += 100_000i128 * i as i128;
            storage::set_balance(&env, token_index, &holder, balance);
        }

        // Take a snapshot mid-batch (after some mutations but before all complete)
        snapshot::record_balance_snapshot(&env, token_index, &holder, balance).unwrap();
        let snapshot_idx = 1;

        // Continue mutations
        for i in 6..=10 {
            balance += 100_000i128 * i as i128;
            storage::set_balance(&env, token_index, &holder, balance);
        }

        // Verify the mid-batch snapshot is unchanged
        let mid_batch_snap = snapshot::get_balance_snapshot(&env, token_index, &holder, snapshot_idx).unwrap();
        let final_balance = balance;

        // The snapshot should have captured one consistent point, not a partial mutation
        assert!(mid_batch_snap.balance != final_balance, "Snapshot should not reflect post-batch mutations");
        assert!(mid_batch_snap.balance > 0, "Snapshot should have captured accumulated state");
    });
}

#[test]
fn test_supply_snapshot_captures_state_consistently() {
    let (env, _client, _admin, _holder) = setup();

    let token_index = 0u32;
    let initial_supply = 10_000_000i128;

    env.as_contract(&env.current_contract_address(), || {
        // Record initial supply snapshot
        snapshot::record_supply_snapshot(&env, token_index, initial_supply).unwrap();

        let count = snapshot::get_supply_snapshot_count(&env, token_index);
        assert_eq!(count, 1);

        let snap = snapshot::get_supply_snapshot(&env, token_index, 0).unwrap();
        assert_eq!(snap.total_supply, initial_supply);

        // Mutate supply
        let new_supply = 15_000_000i128;
        snapshot::record_supply_snapshot(&env, token_index, new_supply).unwrap();

        // Verify first snapshot unchanged
        let first_snap = snapshot::get_supply_snapshot(&env, token_index, 0).unwrap();
        assert_eq!(first_snap.total_supply, initial_supply);

        // Verify second snapshot captures new supply
        let second_snap = snapshot::get_supply_snapshot(&env, token_index, 1).unwrap();
        assert_eq!(second_snap.total_supply, new_supply);
    });
}

#[test]
fn test_snapshot_query_at_historical_ledger() {
    let (env, _client, _admin, holder) = setup();

    let token_index = 0u32;

    env.as_contract(&env.current_contract_address(), || {
        // Start at ledger 100
        env.ledger().with_mut(|li| li.sequence = 100);
        storage::set_balance(&env, token_index, &holder, 1_000i128);
        snapshot::record_balance_snapshot(&env, token_index, &holder, 1_000i128).unwrap();

        // Advance to ledger 200
        env.ledger().with_mut(|li| li.sequence = 200);
        storage::set_balance(&env, token_index, &holder, 5_000i128);
        snapshot::record_balance_snapshot(&env, token_index, &holder, 5_000i128).unwrap();

        // Advance to ledger 300
        env.ledger().with_mut(|li| li.sequence = 300);
        storage::set_balance(&env, token_index, &holder, 10_000i128);
        snapshot::record_balance_snapshot(&env, token_index, &holder, 10_000i128).unwrap();

        // Query balance at ledger 150 (should return ledger 100's snapshot)
        let balance_at_150 = snapshot::get_balance_at_ledger(&env, token_index, &holder, 150).unwrap();
        assert_eq!(balance_at_150, 1_000i128);

        // Query balance at ledger 250 (should return ledger 200's snapshot)
        let balance_at_250 = snapshot::get_balance_at_ledger(&env, token_index, &holder, 250).unwrap();
        assert_eq!(balance_at_250, 5_000i128);

        // Query balance at ledger 300 (should return ledger 300's snapshot)
        let balance_at_300 = snapshot::get_balance_at_ledger(&env, token_index, &holder, 300).unwrap();
        assert_eq!(balance_at_300, 10_000i128);
    });
}

#[test]
fn test_snapshot_balance_now_records_and_returns_current() {
    let (env, _client, _admin, holder) = setup();

    let token_index = 0u32;
    let balance = 5_000_000i128;

    env.as_contract(&env.current_contract_address(), || {
        storage::set_balance(&env, token_index, &holder, balance);

        let returned_balance = snapshot::snapshot_balance_now(&env, token_index, &holder);
        assert_eq!(returned_balance, balance);

        // Verify snapshot was recorded
        let count = snapshot::get_balance_snapshot_count(&env, token_index, &holder);
        assert_eq!(count, 1);

        let snap = snapshot::get_balance_snapshot(&env, token_index, &holder, 0).unwrap();
        assert_eq!(snap.balance, balance);
    });
}

#[test]
fn test_snapshot_multiple_holders_isolated() {
    let (env, _client, _admin, holder1) = setup();
    let holder2 = Address::generate(&env);

    let token_index = 0u32;

    env.as_contract(&env.current_contract_address(), || {
        // Record snapshots for holder1
        storage::set_balance(&env, token_index, &holder1, 1_000i128);
        snapshot::record_balance_snapshot(&env, token_index, &holder1, 1_000i128).unwrap();

        // Record snapshots for holder2
        storage::set_balance(&env, token_index, &holder2, 5_000i128);
        snapshot::record_balance_snapshot(&env, token_index, &holder2, 5_000i128).unwrap();

        // Mutate holder1 but not holder2
        storage::set_balance(&env, token_index, &holder1, 2_000i128);
        snapshot::record_balance_snapshot(&env, token_index, &holder1, 2_000i128).unwrap();

        // Verify holder2's snapshots are unaffected
        let holder2_count = snapshot::get_balance_snapshot_count(&env, token_index, &holder2);
        assert_eq!(holder2_count, 1);

        let holder2_snap = snapshot::get_balance_snapshot(&env, token_index, &holder2, 0).unwrap();
        assert_eq!(holder2_snap.balance, 5_000i128);

        // Verify holder1 has two snapshots
        let holder1_count = snapshot::get_balance_snapshot_count(&env, token_index, &holder1);
        assert_eq!(holder1_count, 2);
    });
}

#[test]
fn test_snapshot_torn_read_guard_during_concurrent_batch() {
    let (env, _client, _admin, holder) = setup();

    let token_index = 0u32;

    env.as_contract(&env.current_contract_address(), || {
        // Initial state
        storage::set_balance(&env, token_index, &holder, 0i128);
        snapshot::record_balance_snapshot(&env, token_index, &holder, 0i128).unwrap();

        // Start of batch boundary: snapshot should capture either before or after, never partial
        storage::set_balance(&env, token_index, &holder, 100i128);
        storage::set_balance(&env, token_index, &holder, 200i128);
        snapshot::record_balance_snapshot(&env, token_index, &holder, 200i128).unwrap();

        // Boundary transition - take snapshot
        let boundary_snapshot_idx = 1;
        let boundary_snap = snapshot::get_balance_snapshot(&env, token_index, &holder, boundary_snapshot_idx).unwrap();

        // Continue mutations after boundary
        storage::set_balance(&env, token_index, &holder, 300i128);
        storage::set_balance(&env, token_index, &holder, 400i128);

        // The boundary snapshot should reflect one side of the boundary completely,
        // not a partial mutation from the second batch
        assert_eq!(boundary_snap.balance, 200i128, "Snapshot at boundary should be consistent");

        // Verify current balance is on the other side
        let current_balance = storage::get_balance(&env, token_index, &holder);
        assert_eq!(current_balance, 400i128);

        // Ensure they're different (boundary was crossed)
        assert_ne!(boundary_snap.balance, current_balance, "Snapshot and current state should differ");
    });
}
