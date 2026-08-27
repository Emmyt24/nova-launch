//! Game History Ordering and Pagination Test Suite
//!
//! Validates that deployment history entries are stored in chronological order,
//! pagination cursors correctly navigate multi-page result sets with no gaps
//! or duplicates, and empty queries return valid empty results.

#[cfg(test)]
mod game_history_test {
    use crate::game_history::{self, DeploymentRecord};
    use crate::storage;
    use crate::types::TokenInfo;
    use soroban_sdk::{
        testutils::Address as _, Address, Env, String,
    };

    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        let admin = Address::generate(&env);

        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_treasury(&env, &Address::generate(&env));
            storage::set_base_fee(&env, 1_000_000);
            storage::set_metadata_fee(&env, 500_000);
        });

        (env, contract_id)
    }

    fn record_deployment(
        env: &Env,
        contract_id: &Address,
        creator: &Address,
        token_index: u32,
        name: &str,
        symbol: &str,
        initial_supply: i128,
        deployed_at: u64,
    ) {
        let token_address = Address::generate(env);
        env.as_contract(contract_id, || {
            let token_info = TokenInfo {
                creator: creator.clone(),
                name: String::from_str(env, name),
                symbol: String::from_str(env, symbol),
                initial_supply,
                decimals: 6,
                created_at: deployed_at,
                transfer_fee_basis_points: 0,
                clawback_enabled: false,
                freeze_enabled: false,
                paused: false,
            };

            game_history::record_deployment(env, token_index, &token_info);
        });
    }

    // ── Chronological ordering of entries ────────────────────────────────────

    #[test]
    fn test_deployment_records_are_chronologically_ordered() {
        let (env, contract_id) = setup();
        let creator = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let base_time = env.ledger().timestamp();

            // Record 3 deployments with ascending timestamps
            record_deployment(&env, &contract_id, &creator, 0, "Token A", "TKA", 1_000_000, base_time);
            record_deployment(&env, &contract_id, &creator, 1, "Token B", "TKB", 2_000_000, base_time + 100);
            record_deployment(&env, &contract_id, &creator, 2, "Token C", "TKC", 3_000_000, base_time + 200);

            // Verify they're stored in order by querying
            let record_0 = game_history::get_history_record(&env, 0).unwrap();
            let record_1 = game_history::get_history_record(&env, 1).unwrap();
            let record_2 = game_history::get_history_record(&env, 2).unwrap();

            assert_eq!(record_0.history_index, 0);
            assert_eq!(record_1.history_index, 1);
            assert_eq!(record_2.history_index, 2);

            // Verify timestamps are in ascending order
            assert!(record_0.deployed_at < record_1.deployed_at);
            assert!(record_1.deployed_at < record_2.deployed_at);

            // Verify total history count
            assert_eq!(game_history::history_count(&env), 3);
        });
    }

    // ── Pagination with no gaps or duplicates ───────────────────────────────

    #[test]
    fn test_pagination_covers_all_records_with_no_gaps_or_duplicates() {
        let (env, contract_id) = setup();
        let creator = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let base_time = env.ledger().timestamp();
            let num_records = 15;

            // Record 15 deployments
            for i in 0..num_records {
                record_deployment(
                    &env,
                    &contract_id,
                    &creator,
                    i as u32,
                    &format!("Token {}", i),
                    &format!("T{}", i),
                    (i as i128 + 1) * 1_000_000,
                    base_time + (i as u64 * 10),
                );
            }

            // Paginate with limit=5: expect 3 pages
            let page1 = game_history::query_by_creator(&env, &creator, 0, 5)
                .expect("First page query should succeed");
            let page2 = game_history::query_by_creator(&env, &creator, 5, 5)
                .expect("Second page query should succeed");
            let page3 = game_history::query_by_creator(&env, &creator, 10, 5)
                .expect("Third page query should succeed");

            // Verify page sizes
            assert_eq!(page1.len(), 5, "First page must have 5 records");
            assert_eq!(page2.len(), 5, "Second page must have 5 records");
            assert_eq!(page3.len(), 5, "Third page must have 5 records");

            // Verify no gaps: concatenate all pages
            let mut all_records = page1.clone();
            for record in page2.iter() {
                all_records.push_back(record.clone());
            }
            for record in page3.iter() {
                all_records.push_back(record.clone());
            }

            // Verify total and ordering
            assert_eq!(all_records.len(), 15, "Concatenated pages must cover all 15 records");

            // Verify no duplicates by checking history indices
            let mut seen_indices = std::collections::HashSet::new();
            for record in all_records.iter() {
                assert!(
                    seen_indices.insert(record.history_index),
                    "History index {} appears multiple times",
                    record.history_index
                );
            }

            // Verify indices are contiguous (no gaps)
            for i in 0..15 {
                assert!(
                    seen_indices.contains(&(i as u64)),
                    "History index {} is missing",
                    i
                );
            }

            // Verify chronological order is preserved across pages
            let mut last_time = 0u64;
            for record in all_records.iter() {
                assert!(
                    record.deployed_at >= last_time,
                    "Records must be in chronological order; found {} after {}",
                    record.deployed_at,
                    last_time
                );
                last_time = record.deployed_at;
            }
        });
    }

    #[test]
    fn test_pagination_with_exact_page_boundary() {
        let (env, contract_id) = setup();
        let creator = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let base_time = env.ledger().timestamp();

            // Record exactly 10 deployments (2 pages of 5)
            for i in 0..10 {
                record_deployment(
                    &env,
                    &contract_id,
                    &creator,
                    i,
                    &format!("Token {}", i),
                    &format!("T{}", i),
                    (i as i128 + 1) * 1_000_000,
                    base_time + (i as u64 * 10),
                );
            }

            let page1 = game_history::query_by_creator(&env, &creator, 0, 5).unwrap();
            let page2 = game_history::query_by_creator(&env, &creator, 5, 5).unwrap();
            let page3 = game_history::query_by_creator(&env, &creator, 10, 5).unwrap();

            assert_eq!(page1.len(), 5);
            assert_eq!(page2.len(), 5);
            assert_eq!(page3.len(), 0, "Requesting beyond available records must return empty");
        });
    }

    // ── Empty history query ─────────────────────────────────────────────────

    #[test]
    fn test_empty_history_query_returns_empty_result() {
        let (env, contract_id) = setup();
        let creator_with_no_tokens = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // Query a creator who has never deployed tokens
            let result = game_history::query_by_creator(&env, &creator_with_no_tokens, 0, 10)
                .expect("Empty query should not error");

            assert_eq!(result.len(), 0, "Empty history must return 0 records");
        });
    }

    #[test]
    fn test_empty_time_range_query() {
        let (env, contract_id) = setup();
        let creator = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let base_time = env.ledger().timestamp();

            // Record 3 deployments at times 100, 200, 300
            record_deployment(&env, &contract_id, &creator, 0, "Token A", "TKA", 1_000_000, base_time + 100);
            record_deployment(&env, &contract_id, &creator, 1, "Token B", "TKB", 2_000_000, base_time + 200);
            record_deployment(&env, &contract_id, &creator, 2, "Token C", "TKC", 3_000_000, base_time + 300);

            // Query a time range with no deployments (base_time + 1 to base_time + 50)
            let result = game_history::query_by_time_range(&env, base_time + 1, base_time + 50, 10)
                .expect("Empty time-range query should not error");

            assert_eq!(result.len(), 0, "Empty time range must return 0 records");
        });
    }

    // ── Query with offset at various positions ──────────────────────────────

    #[test]
    fn test_pagination_with_different_offsets() {
        let (env, contract_id) = setup();
        let creator = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let base_time = env.ledger().timestamp();

            // Record 10 deployments
            for i in 0..10 {
                record_deployment(
                    &env,
                    &contract_id,
                    &creator,
                    i,
                    &format!("Token {}", i),
                    &format!("T{}", i),
                    (i as i128 + 1) * 1_000_000,
                    base_time + (i as u64 * 10),
                );
            }

            // Offset 0, limit 3
            let page0 = game_history::query_by_creator(&env, &creator, 0, 3).unwrap();
            assert_eq!(page0.len(), 3);
            assert_eq!(page0[0].history_index, 0);

            // Offset 3, limit 3
            let page1 = game_history::query_by_creator(&env, &creator, 3, 3).unwrap();
            assert_eq!(page1.len(), 3);
            assert_eq!(page1[0].history_index, 3);

            // Offset 6, limit 3
            let page2 = game_history::query_by_creator(&env, &creator, 6, 3).unwrap();
            assert_eq!(page2.len(), 3);
            assert_eq!(page2[0].history_index, 6);

            // Offset 9, limit 3 (only 1 record left)
            let page3 = game_history::query_by_creator(&env, &creator, 9, 3).unwrap();
            assert_eq!(page3.len(), 1);
            assert_eq!(page3[0].history_index, 9);

            // Offset beyond total (should return empty)
            let page4 = game_history::query_by_creator(&env, &creator, 15, 3).unwrap();
            assert_eq!(page4.len(), 0);
        });
    }

    // ── Query by time range ──────────────────────────────────────────────────

    #[test]
    fn test_query_by_time_range_inclusivity() {
        let (env, contract_id) = setup();
        let creator = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let base_time = env.ledger().timestamp();

            // Record deployments at times 100, 200, 300
            record_deployment(&env, &contract_id, &creator, 0, "Token A", "TKA", 1_000_000, base_time + 100);
            record_deployment(&env, &contract_id, &creator, 1, "Token B", "TKB", 2_000_000, base_time + 200);
            record_deployment(&env, &contract_id, &creator, 2, "Token C", "TKC", 3_000_000, base_time + 300);

            // Query [100, 200] (inclusive) should return records 0 and 1
            let result = game_history::query_by_time_range(&env, base_time + 100, base_time + 200, 10)
                .unwrap();
            assert_eq!(result.len(), 2);
            assert_eq!(result[0].deployed_at, base_time + 100);
            assert_eq!(result[1].deployed_at, base_time + 200);

            // Query [200, 300] should return records 1 and 2
            let result = game_history::query_by_time_range(&env, base_time + 200, base_time + 300, 10)
                .unwrap();
            assert_eq!(result.len(), 2);
            assert_eq!(result[0].deployed_at, base_time + 200);
            assert_eq!(result[1].deployed_at, base_time + 300);
        });
    }

    // ── Pagination respects limit parameter ──────────────────────────────────

    #[test]
    fn test_pagination_respects_max_limit() {
        let (env, contract_id) = setup();
        let creator = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let base_time = env.ledger().timestamp();

            // Record 50 deployments
            for i in 0..50 {
                record_deployment(
                    &env,
                    &contract_id,
                    &creator,
                    i,
                    &format!("Token {}", i),
                    &format!("T{}", i),
                    (i as i128 + 1) * 1_000_000,
                    base_time + (i as u64 * 10),
                );
            }

            // Query with limit=100 should still cap at max allowed (100)
            // and return all 50 records
            let result = game_history::query_by_creator(&env, &creator, 0, 100).unwrap();
            assert_eq!(result.len(), 50, "Should return all 50 records when limit allows");

            // Query with limit=20 should return exactly 20
            let result = game_history::query_by_creator(&env, &creator, 0, 20).unwrap();
            assert_eq!(result.len(), 20, "Should return only 20 records");
        });
    }
}
