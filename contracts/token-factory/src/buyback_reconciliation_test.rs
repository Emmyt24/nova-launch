#[cfg(test)]
mod reconciliation_tests {
    use crate::buyback::{BuybackContract, BuybackCampaign};
    use crate::types::Error;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup() -> (Env, Address) {
        let env = Env::default();
        let contract_id = env.register_contract(None, BuybackContract);
        (env, contract_id)
    }

    #[test]
    fn test_rounding_edge_one_unit_down() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(
                env.clone(),
                1,
                token,
                1_000_000,
                100_000,
                500,
            )
            .unwrap();

            // Execute with amount that could have rounding
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 33_333, 3_000_000);
            assert!(result.is_ok());
            
            let exec = result.unwrap();
            assert!(exec.reconciled);
        });
    }

    #[test]
    fn test_rounding_edge_large_amounts() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(
                env.clone(),
                1,
                token,
                i128::MAX / 2,
                1_000_000_000,
                500,
            )
            .unwrap();

            let result = BuybackContract::execute_buyback_step(
                env.clone(),
                1,
                999_999_999,
                90_000_000_000,
            );
            assert!(result.is_ok());
            assert!(result.unwrap().reconciled);
        });
    }

    #[test]
    fn test_sequential_reconciliation_consistency() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(
                env.clone(),
                1,
                token,
                1_000_000,
                100_000,
                500,
            )
            .unwrap();

            // Execute multiple steps and verify monotonic increase
            let mut prev_spent = 0i128;
            let mut prev_burned = 0i128;

            for i in 1..=5 {
                let amount = 10_000 * i;
                BuybackContract::execute_buyback_step(env.clone(), 1, amount, 900_000).unwrap();

                let campaign = BuybackContract::get_campaign(env.clone(), 1).unwrap();
                
                // Verify monotonic increase
                assert!(campaign.spent > prev_spent);
                assert!(campaign.tokens_burned > prev_burned);
                
                prev_spent = campaign.spent;
                prev_burned = campaign.tokens_burned;
            }
        });
    }

    #[test]
    fn test_reconciliation_with_minimum_amounts() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(
                env.clone(),
                1,
                token,
                1_000_000,
                100_000,
                500,
            )
            .unwrap();

            // Minimum viable amounts
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 1, 95);
            assert!(result.is_ok());
            
            let exec = result.unwrap();
            assert_eq!(exec.spent, 1);
            assert_eq!(exec.bought, 100);
            assert_eq!(exec.burned, 100);
            assert!(exec.reconciled);
        });
    }

    #[test]
    fn test_invariant_protection_on_overflow() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(
                env.clone(),
                1,
                token,
                1_000_000_000,
                500_000_000,
                500,
            )
            .unwrap();

            // First execution
            let result = BuybackContract::execute_buyback_step(
                env.clone(),
                1,
                250_000_000,
                23_000_000_000,
            );
            assert!(result.is_ok());

            // Second execution within budget
            let result = BuybackContract::execute_buyback_step(
                env.clone(),
                1,
                250_000_000,
                23_000_000_000,
            );
            assert!(result.is_ok());
            
            // Verify no overflow occurred
            let campaign = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            assert_eq!(campaign.spent, 500_000_000);
        });
    }

    #[test]
    fn test_reconciliation_delta_tracking() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(
                env.clone(),
                1,
                token,
                1_000_000,
                100_000,
                500,
            )
            .unwrap();

            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 4_500_000)
                .unwrap();

            // Delta should be 0 for exact match
            assert_eq!(result.burned, result.bought);
            assert!(result.reconciled);
        });
    }

    #[test]
    fn test_campaign_state_after_reconciliation_failure() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(
                env.clone(),
                1,
                token,
                1_000_000,
                100_000,
                500,
            )
            .unwrap();

            // Successful execution
            BuybackContract::execute_buyback_step(env.clone(), 1, 30_000, 2_500_000).unwrap();
            
            let state_before = BuybackContract::get_campaign(env.clone(), 1).unwrap();

            // Any failure should not modify state
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 200_000, 1_000_000);
            assert!(result.is_err());

            let state_after = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            assert_eq!(state_before, state_after);
        });
    }

    #[test]
    fn test_monotonic_counters_never_decrease() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(
                env.clone(),
                1,
                token,
                1_000_000,
                100_000,
                500,
            )
            .unwrap();

            let amounts = [10_000, 20_000, 15_000, 25_000, 5_000];
            let mut prev_spent = 0i128;
            let mut prev_burned = 0i128;

            for amount in amounts {
                let min_out = (amount * 100 * 95) / 100; // 5% slippage tolerance
                BuybackContract::execute_buyback_step(env.clone(), 1, amount, min_out).unwrap();
                
                let campaign = BuybackContract::get_campaign(env.clone(), 1).unwrap();
                
                // Verify strictly increasing
                assert!(campaign.spent > prev_spent);
                assert!(campaign.tokens_burned > prev_burned);
                
                prev_spent = campaign.spent;
                prev_burned = campaign.tokens_burned;
            }
        });
    }

    #[test]
    fn test_reconciliation_with_zero_slippage() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // 0% slippage requires exact match
            BuybackContract::create_campaign(env.clone(), 1, token, 1_000_000, 100_000, 0)
                .unwrap();

            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 5_000_000);
            assert!(result.is_ok());
            
            let exec = result.unwrap();
            assert_eq!(exec.bought, 5_000_000);
            assert_eq!(exec.burned, 5_000_000);
            assert!(exec.reconciled);
        });
    }

    #[test]
    fn test_budget_boundary_reconciliation() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(
                env.clone(),
                1,
                token,
                100_000,
                50_000,
                500,
            )
            .unwrap();

            // Use exactly the budget
            BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 4_500_000).unwrap();
            BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 4_500_000).unwrap();

            let campaign = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            assert_eq!(campaign.spent, 100_000);
            assert_eq!(campaign.spent, campaign.total_budget);

            // Next should fail due to budget
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 1, 95);
            assert_eq!(result, Err(Error::InsufficientBudget));
        });
    }
}
