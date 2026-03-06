#[cfg(test)]
mod stream_lifecycle_integration_tests {
    use crate::streaming;
    use crate::storage;
    use crate::types::{Error, StreamParams};
    use crate::events;
    use soroban_sdk::{testutils::{Address as _, Ledger}, vec, Address, Env, Symbol};

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let recipient = Address::generate(&env);

        // Initialize storage
        storage::set_admin(&env, &admin);
        storage::set_paused(&env, false);

        // Create a token for streaming
        let token_info = crate::types::TokenInfo {
            address: Address::generate(&env),
            creator: creator.clone(),
            name: soroban_sdk::String::from_str(&env, "Test Token"),
            symbol: soroban_sdk::String::from_str(&env, "TST"),
            decimals: 7,
            total_supply: 1_000_000_0000000,
            initial_supply: 1_000_000_0000000,
            max_supply: None,
            total_burned: 0,
            burn_count: 0,
            metadata_uri: None,
            created_at: env.ledger().timestamp(),
            is_paused: false,
            clawback_enabled: false,
        };
        storage::set_token_info(&env, 0, &token_info);

        (env, admin, creator, recipient)
    }

    fn create_test_stream(env: &Env, creator: &Address, recipient: &Address, amount: i128, start: u64, end: u64, cliff: u64) -> u64 {
        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: amount,
            start_time: start,
            end_time: end,
            cliff_time: cliff,
        };

        streaming::create_stream(env, creator, &params).unwrap()
    }

    #[test]
    fn test_lifecycle_full_stream_with_pause_resume() {
        // Test: create -> wait -> partial claim -> pause/unpause -> final claim
        let (env, admin, creator, recipient) = setup();

        // Event tracking
        let mut event_count = 0;
        env.events().all().iter().for_each(|_| event_count += 1);
        let initial_events = event_count;

        // CREATE STREAM
        let stream_id = create_test_stream(&env, &creator, &recipient, 1000, 100, 200, 150);
        
        // Verify stream created event
        let events_after_create = env.events().all().len() - initial_events;
        assert_eq!(events_after_create, 1);

        // Verify stream state
        let stream = storage::get_stream(&env, stream_id).unwrap();
        assert_eq!(stream.total_amount, 1000);
        assert_eq!(stream.claimed_amount, 0);
        assert!(!stream.cancelled);

        // WAIT TO CLIFF (50% vested)
        env.ledger().with_mut(|li| {
            li.timestamp = 150;
        });

        // PARTIAL CLAIM (50% = 500)
        let claimed1 = streaming::claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed1, 500);

        // Verify partial claim event
        let events_after_claim1 = env.events().all().len() - initial_events;
        assert_eq!(events_after_claim1, 2);

        // Verify stream state after partial claim
        let stream = storage::get_stream(&env, stream_id).unwrap();
        assert_eq!(stream.claimed_amount, 500);

        // PAUSE CONTRACT
        crate::TokenFactory::pause(env.clone(), admin.clone()).unwrap();
        
        // Verify pause event
        let events_after_pause = env.events().all().len() - initial_events;
        assert_eq!(events_after_pause, 3);

        // Try to claim while paused (should fail)
        env.ledger().with_mut(|li| {
            li.timestamp = 175;
        });
        let claim_while_paused = streaming::claim_stream(&env, &recipient, stream_id);
        assert_eq!(claim_while_paused, Err(Error::ContractPaused));

        // UNPAUSE CONTRACT
        crate::TokenFactory::unpause(env.clone(), admin.clone()).unwrap();
        
        // Verify unpause event
        let events_after_unpause = env.events().all().len() - initial_events;
        assert_eq!(events_after_unpause, 4);

        // FINAL CLAIM (remaining 25% = 250)
        let claimed2 = streaming::claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed2, 250);

        // Verify final claim event
        let events_after_claim2 = env.events().all().len() - initial_events;
        assert_eq!(events_after_claim2, 5);

        // Verify final stream state
        let stream = storage::get_stream(&env, stream_id).unwrap();
        assert_eq!(stream.claimed_amount, 750); // 500 + 250

        // FINAL INVARIANTS
        assert!(stream.claimed_amount <= stream.total_amount);
        assert_eq!(stream.claimed_amount, 750);
        assert_eq!(stream.total_amount, 1000);

        // Event sequence validation
        let events = env.events().all();
        assert_eq!(events.len(), initial_events + 5);
        
        // Verify event types in correct order
        let event_symbols: Vec<Symbol> = events.iter()
            .skip(initial_events as usize)
            .map(|event| event.topics[0])
            .collect();
        
        assert_eq!(event_symbols.get(0), Some(&symbol_short!("strm_crt")));  // Stream created
        assert_eq!(event_symbols.get(1), Some(&symbol_short!("strm_clm")));  // First claim
        assert_eq!(event_symbols.get(2), Some(&symbol_short!("pause_v1")));  // Contract paused
        assert_eq!(event_symbols.get(3), Some(&symbol_short!("unpaus_v1"))); // Contract unpaused
        assert_eq!(event_symbols.get(4), Some(&symbol_short!("strm_clm")));  // Second claim
    }

    #[test]
    fn test_lifecycle_cancel_with_vested_claim() {
        // Test: create -> cancel -> vested claim only
        let (env, _admin, creator, recipient) = setup();

        // Event tracking
        let mut event_count = 0;
        env.events().all().iter().for_each(|_| event_count += 1);
        let initial_events = event_count;

        // CREATE STREAM
        let stream_id = create_test_stream(&env, &creator, &recipient, 1000, 100, 200, 150);

        // Verify stream created event
        let events_after_create = env.events().all().len() - initial_events;
        assert_eq!(events_after_create, 1);

        // WAIT TO 50% VESTING
        env.ledger().with_mut(|li| {
            li.timestamp = 150;
        });

        // CANCEL STREAM
        streaming::cancel_stream(&env, &creator, stream_id).unwrap();

        // Verify cancel event
        let events_after_cancel = env.events().all().len() - initial_events;
        assert_eq!(events_after_cancel, 2);

        // Verify stream is cancelled
        let stream = storage::get_stream(&env, stream_id).unwrap();
        assert!(stream.cancelled);

        // TRY TO CLAIM FROM CANCELLED STREAM (should fail)
        let claim_cancelled = streaming::claim_stream(&env, &recipient, stream_id);
        assert_eq!(claim_cancelled, Err(Error::StreamCancelled));

        // FINAL INVARIANTS
        assert_eq!(stream.claimed_amount, 0); // Nothing claimed before cancellation
        assert!(stream.claimed_amount <= stream.total_amount);
        assert!(stream.cancelled);

        // Event sequence validation
        let events = env.events().all();
        assert_eq!(events.len(), initial_events + 2);
        
        // Verify event types in correct order
        let event_symbols: Vec<Symbol> = events.iter()
            .skip(initial_events as usize)
            .map(|event| event.topics[0])
            .collect();
        
        assert_eq!(event_symbols.get(0), Some(&symbol_short!("strm_crt")));  // Stream created
        assert_eq!(event_symbols.get(1), Some(&symbol_short!("strm_cnl")));  // Stream cancelled
    }

    #[test]
    fn test_lifecycle_complete_vesting_with_final_invariants() {
        // Test: create -> wait until end -> final claim -> verify invariants
        let (env, _admin, creator, recipient) = setup();

        // CREATE STREAM
        let stream_id = create_test_stream(&env, &creator, &recipient, 1000, 100, 200, 150);

        // WAIT UNTIL AFTER END TIME
        env.ledger().with_mut(|li| {
            li.timestamp = 250;
        });

        // FINAL CLAIM (100% = 1000)
        let claimed = streaming::claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed, 1000);

        // Verify final stream state
        let stream = storage::get_stream(&env, stream_id).unwrap();
        assert_eq!(stream.claimed_amount, 1000);

        // FINAL INVARIANTS
        assert_eq!(stream.claimed_amount, stream.total_amount); // Fully claimed
        assert!(stream.claimed_amount <= stream.total_amount);
        assert!(!stream.cancelled);

        // Try to claim again (should fail - nothing left)
        let claim_again = streaming::claim_stream(&env, &recipient, stream_id);
        assert_eq!(claim_again, Err(Error::InvalidAmount));

        // Verify no further accrual after end
        env.ledger().with_mut(|li| {
            li.timestamp = 1000; // Much later
        });
        
        let claimable_after_end = streaming::get_claimable_amount(&env, stream_id).unwrap();
        assert_eq!(claimable_after_end, 0); // No additional accrual
    }

    #[test]
    fn test_lifecycle_multiple_partial_claims() {
        // Test: create -> multiple partial claims -> final claim
        let (env, _admin, creator, recipient) = setup();

        // CREATE STREAM
        let stream_id = create_test_stream(&env, &creator, &recipient, 1000, 100, 200, 150);

        // CLAIM 1: At 50% (500)
        env.ledger().with_mut(|li| {
            li.timestamp = 150;
        });
        let claimed1 = streaming::claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed1, 500);

        // CLAIM 2: At 75% (additional 250)
        env.ledger().with_mut(|li| {
            li.timestamp = 175;
        });
        let claimed2 = streaming::claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed2, 250);

        // CLAIM 3: At 100% (additional 250)
        env.ledger().with_mut(|li| {
            li.timestamp = 250;
        });
        let claimed3 = streaming::claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed3, 250);

        // Verify final state
        let stream = storage::get_stream(&env, stream_id).unwrap();
        assert_eq!(stream.claimed_amount, 1000); // 500 + 250 + 250

        // FINAL INVARIANTS
        assert_eq!(stream.claimed_amount, stream.total_amount);
        assert!(stream.claimed_amount <= stream.total_amount);
    }

    #[test]
    fn test_lifecycle_cancel_before_cliff() {
        // Test: create -> cancel before cliff -> no claimable amount
        let (env, _admin, creator, recipient) = setup();

        // CREATE STREAM
        let stream_id = create_test_stream(&env, &creator, &recipient, 1000, 100, 200, 150);

        // CANCEL BEFORE CLIFF
        env.ledger().with_mut(|li| {
            li.timestamp = 120; // Before cliff at 150
        });
        streaming::cancel_stream(&env, &creator, stream_id).unwrap();

        // Verify stream is cancelled
        let stream = storage::get_stream(&env, stream_id).unwrap();
        assert!(stream.cancelled);
        assert_eq!(stream.claimed_amount, 0);

        // FINAL INVARIANTS
        assert_eq!(stream.claimed_amount, 0);
        assert!(stream.claimed_amount <= stream.total_amount);
        assert!(stream.cancelled);

        // Try to claim (should fail)
        let claim_cancelled = streaming::claim_stream(&env, &recipient, stream_id);
        assert_eq!(claim_cancelled, Err(Error::StreamCancelled));
    }

    #[test]
    fn test_lifecycle_batch_operations_with_invariants() {
        // Test: batch create -> batch claim -> verify invariants
        let (env, _admin, creator, recipient) = setup();

        let recipient2 = Address::generate(&env);

        // BATCH CREATE STREAMS
        let streams = vec![
            &env,
            StreamParams {
                recipient: recipient.clone(),
                token_index: 0,
                total_amount: 1000,
                start_time: 100,
                end_time: 200,
                cliff_time: 150,
            },
            StreamParams {
                recipient: recipient2.clone(),
                token_index: 0,
                total_amount: 2000,
                start_time: 100,
                end_time: 200,
                cliff_time: 150,
            },
        ];

        let stream_ids = streaming::batch_create_streams(&env, &creator, &streams).unwrap();
        assert_eq!(stream_ids.len(), 2);

        // WAIT TO 50% VESTING
        env.ledger().with_mut(|li| {
            li.timestamp = 150;
        });

        // BATCH CLAIM
        let claimed_amounts = streaming::batch_claim(&env, &recipient, &stream_ids.slice(0, 1)).unwrap();
        assert_eq!(claimed_amounts.get(0), Some(&500)); // 50% of 1000

        // Verify invariants for first stream
        let stream1 = storage::get_stream(&env, stream_ids.get(0).unwrap()).unwrap();
        assert_eq!(stream1.claimed_amount, 500);
        assert!(stream1.claimed_amount <= stream1.total_amount);

        // Claim from second stream separately
        let claimed2 = streaming::claim_stream(&env, &recipient2, stream_ids.get(1).unwrap()).unwrap();
        assert_eq!(claimed2, 1000); // 50% of 2000

        // Verify invariants for second stream
        let stream2 = storage::get_stream(&env, stream_ids.get(1).unwrap()).unwrap();
        assert_eq!(stream2.claimed_amount, 1000);
        assert!(stream2.claimed_amount <= stream2.total_amount);
    }

    #[test]
    fn test_lifecycle_no_accrual_after_end() {
        // Test: verify no accrual after stream end time
        let (env, _admin, creator, recipient) = setup();

        // CREATE STREAM
        let stream_id = create_test_stream(&env, &creator, &recipient, 1000, 100, 200, 150);

        // WAIT UNTIL AFTER END AND CLAIM EVERYTHING
        env.ledger().with_mut(|li| {
            li.timestamp = 250;
        });
        let claimed = streaming::claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed, 1000);

        // ADVANCE TIME SIGNIFICANTLY
        env.ledger().with_mut(|li| {
            li.timestamp = 10000; // Much later
        });

        // VERIFY NO ADDITIONAL ACCRUAL
        let claimable = streaming::get_claimable_amount(&env, stream_id).unwrap();
        assert_eq!(claimable, 0);

        // Try to claim again (should fail)
        let claim_again = streaming::claim_stream(&env, &recipient, stream_id);
        assert_eq!(claim_again, Err(Error::InvalidAmount));

        // Verify final invariants
        let stream = storage::get_stream(&env, stream_id).unwrap();
        assert_eq!(stream.claimed_amount, 1000);
        assert_eq!(stream.claimed_amount, stream.total_amount);
        assert!(stream.claimed_amount <= stream.total_amount);
    }

    #[test]
    fn test_lifecycle_event_sequence_comprehensive() {
        // Test: comprehensive event sequence validation
        let (env, admin, creator, recipient) = setup();

        // CREATE STREAM
        let stream_id = create_test_stream(&env, &creator, &recipient, 1000, 100, 200, 150);

        // PAUSE/UNPAUSE CYCLE
        crate::TokenFactory::pause(env.clone(), admin.clone()).unwrap();
        crate::TokenFactory::unpause(env.clone(), admin.clone()).unwrap();

        // CLAIM AT 50%
        env.ledger().with_mut(|li| {
            li.timestamp = 150;
        });
        streaming::claim_stream(&env, &recipient, stream_id).unwrap();

        // CANCEL STREAM
        streaming::cancel_stream(&env, &creator, stream_id).unwrap();

        // COLLECT AND VALIDATE ALL EVENTS
        let events = env.events().all();
        let event_symbols: Vec<Symbol> = events.iter()
            .map(|event| event.topics[0])
            .collect();

        // Expected event sequence:
        // 1. Stream created
        // 2. Contract paused
        // 3. Contract unpaused
        // 4. Stream claimed
        // 5. Stream cancelled

        assert_eq!(event_symbols.get(0), Some(&symbol_short!("strm_crt")));
        assert_eq!(event_symbols.get(1), Some(&symbol_short!("pause_v1")));
        assert_eq!(event_symbols.get(2), Some(&symbol_short!("unpaus_v1")));
        assert_eq!(event_symbols.get(3), Some(&symbol_short!("strm_clm")));
        assert_eq!(event_symbols.get(4), Some(&symbol_short!("strm_cnl")));

        // Verify final stream state
        let stream = storage::get_stream(&env, stream_id).unwrap();
        assert_eq!(stream.claimed_amount, 500);
        assert!(stream.cancelled);
        assert!(stream.claimed_amount <= stream.total_amount);
    }

    // Helper function to get symbol_short for testing
    fn symbol_short(s: &str) -> soroban_sdk::Symbol {
        soroban_sdk::symbol_short!(s)
    }
}
