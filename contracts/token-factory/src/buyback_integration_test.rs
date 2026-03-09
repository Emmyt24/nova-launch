#[cfg(test)]
mod buyback_integration_tests {
    use crate::buyback::{BuybackContract, BuybackCampaign, ExecutionResult};
    use crate::types::Error;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup() -> (Env, Address) {
        let env = Env::default();
        let contract_id = env.register_contract(None, BuybackContract);
        (env, contract_id)
    }

    #[test]
    fn test_budget_exhaustion_boundary() {
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

            // Execute exactly to budget
            BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 1_000_000).unwrap();
            BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 1_000_000).unwrap();

            let campaign = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            assert_eq!(campaign.spent, 100_000);
            assert_eq!(campaign.total_budget - campaign.spent, 0);

            // Next execution should fail
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 1, 1_000_000);
            assert_eq!(result, Err(Error::InsufficientBudget));
        });
    }

    #[test]
    fn test_partial_budget_remaining() {
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

            // Use 90k of 100k budget
            BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 1_000_000).unwrap();
            BuybackContract::execute_buyback_step(env.clone(), 1, 40_000, 1_000_000).unwrap();

            let campaign = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            assert_eq!(campaign.spent, 90_000);

            // Can execute with remaining 10k
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 10_000, 900_000);
            assert!(result.is_ok());

            // But not more
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 1, 1_000_000);
            assert_eq!(result, Err(Error::InsufficientBudget));
        });
    }

    #[test]
    fn test_slippage_tolerance_boundaries() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // 0% slippage
            BuybackContract::create_campaign(env.clone(), 1, token.clone(), 1_000_000, 100_000, 0)
                .unwrap();

            // 100% slippage (10000 bps)
            BuybackContract::create_campaign(
                env.clone(),
                2,
                token.clone(),
                1_000_000,
                100_000,
                10000,
            )
            .unwrap();

            // 50% slippage (5000 bps)
            BuybackContract::create_campaign(env.clone(), 3, token, 1_000_000, 100_000, 5000)
                .unwrap();

            // All should be created successfully
            assert!(BuybackContract::get_campaign(env.clone(), 1).is_ok());
            assert!(BuybackContract::get_campaign(env.clone(), 2).is_ok());
            assert!(BuybackContract::get_campaign(env.clone(), 3).is_ok());
        });
    }

    #[test]
    fn test_max_spend_per_step_enforcement() {
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

            // Exactly at limit - should succeed
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 100_000, 9_000_000);
            assert!(result.is_ok());

            // One over limit - should fail
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 100_001, 9_000_000);
            assert_eq!(result, Err(Error::ExceedsStepLimit));
        });
    }

    #[test]
    fn test_concurrent_campaigns() {
        let (env, contract_id) = setup();
        let token1 = Address::generate(&env);
        let token2 = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // Create two campaigns
            BuybackContract::create_campaign(
                env.clone(),
                1,
                token1,
                1_000_000,
                100_000,
                500,
            )
            .unwrap();

            BuybackContract::create_campaign(
                env.clone(),
                2,
                token2,
                2_000_000,
                200_000,
                300,
            )
            .unwrap();

            // Execute on both
            BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 4_500_000).unwrap();
            BuybackContract::execute_buyback_step(env.clone(), 2, 100_000, 9_000_000).unwrap();

            // Verify independent accounting
            let c1 = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            let c2 = BuybackContract::get_campaign(env.clone(), 2).unwrap();

            assert_eq!(c1.spent, 50_000);
            assert_eq!(c2.spent, 100_000);
            assert_eq!(c1.tokens_bought, 5_000_000);
            assert_eq!(c2.tokens_bought, 10_000_000);
        });
    }

    #[test]
    fn test_arithmetic_overflow_protection() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // Create campaign with max i128 budget
            let max_budget = i128::MAX;
            let result = BuybackContract::create_campaign(
                env.clone(),
                1,
                token,
                max_budget,
                1_000_000,
                500,
            );
            assert!(result.is_ok());

            // Execution should handle large numbers safely
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 1_000_000, 1_000_000);
            assert!(result.is_ok());
        });
    }

    #[test]
    fn test_zero_slippage_exact_match() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            // 0% slippage means exact match required
            BuybackContract::create_campaign(env.clone(), 1, token, 1_000_000, 100_000, 0)
                .unwrap();

            // Exact match should succeed
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 5_000_000);
            assert!(result.is_ok());

            // Even 1 token more should fail
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 5_000_001);
            assert_eq!(result, Err(Error::SlippageExceeded));
        });
    }

    #[test]
    fn test_campaign_state_isolation() {
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

            // Execute successfully
            BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 4_500_000).unwrap();

            let state_before = BuybackContract::get_campaign(env.clone(), 1).unwrap();

            // Failed execution on different campaign shouldn't affect this one
            let result = BuybackContract::execute_buyback_step(env.clone(), 999, 50_000, 1_000_000);
            assert!(result.is_err());

            let state_after = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            assert_eq!(state_before, state_after);
        });
    }

    #[test]
    fn test_execution_result_accuracy() {
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

            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 75_000, 7_000_000)
                .unwrap();

            assert_eq!(result.spent, 75_000);
            assert_eq!(result.bought, 7_500_000); // 75k * 100
            assert_eq!(result.burned, 7_500_000);

            // Verify campaign state matches result
            let campaign = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            assert_eq!(campaign.spent, result.spent);
            assert_eq!(campaign.tokens_bought, result.bought);
            assert_eq!(campaign.tokens_burned, result.burned);
        });
    }

    #[test]
    fn test_minimum_viable_execution() {
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

            // Minimum amounts (1 unit)
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 1, 95);
            assert!(result.is_ok());

            let exec = result.unwrap();
            assert_eq!(exec.spent, 1);
            assert_eq!(exec.bought, 100);
            assert_eq!(exec.burned, 100);
        });
    }

    #[test]
    fn test_campaign_budget_tracking_precision() {
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

            // Execute multiple times with different amounts
            BuybackContract::execute_buyback_step(env.clone(), 1, 10_000, 1_000_000).unwrap();
            BuybackContract::execute_buyback_step(env.clone(), 1, 25_000, 1_000_000).unwrap();
            BuybackContract::execute_buyback_step(env.clone(), 1, 15_000, 1_000_000).unwrap();
            BuybackContract::execute_buyback_step(env.clone(), 1, 30_000, 1_000_000).unwrap();

            let campaign = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            assert_eq!(campaign.spent, 80_000);
        });
    }
}
