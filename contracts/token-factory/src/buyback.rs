use soroban_sdk::{contract, contractimpl, Address, Env};

use crate::types::{DataKey, Error};

#[derive(Clone, Debug, PartialEq, Eq)]
#[soroban_sdk::contracttype]
pub struct BuybackCampaign {
    pub token_address: Address,
    pub total_budget: i128,
    pub spent: i128,
    pub tokens_bought: i128,
    pub tokens_burned: i128,
    pub max_spend_per_step: i128,
    pub slippage_tolerance_bps: u32,
    pub active: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[soroban_sdk::contracttype]
pub struct ExecutionResult {
    pub spent: i128,
    pub bought: i128,
    pub burned: i128,
    pub reconciled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[soroban_sdk::contracttype]
pub struct ReconciliationReport {
    pub expected_burn: i128,
    pub realized_burn: i128,
    pub delta: i128,
    pub reconciled: bool,
}

#[contract]
pub struct BuybackContract;

#[contractimpl]
impl BuybackContract {
    pub fn execute_buyback_step(
        env: Env,
        campaign_id: u64,
        quote_amount: i128,
        min_tokens_out: i128,
    ) -> Result<ExecutionResult, Error> {
        let key = DataKey::BuybackCampaign(campaign_id);
        let mut campaign: BuybackCampaign = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::CampaignNotFound)?;

        if !campaign.active {
            return Err(Error::CampaignInactive);
        }

        if quote_amount <= 0 || min_tokens_out <= 0 {
            return Err(Error::InvalidAmount);
        }

        if quote_amount > campaign.max_spend_per_step {
            return Err(Error::ExceedsStepLimit);
        }

        let remaining = campaign.total_budget.checked_sub(campaign.spent)
            .ok_or(Error::ArithmeticError)?;
        
        if quote_amount > remaining {
            return Err(Error::InsufficientBudget);
        }

        // Simulate swap (in production, call DEX contract)
        let tokens_received = simulate_swap(&env, quote_amount, min_tokens_out)?;

        // Slippage check
        let expected_min = calculate_min_with_slippage(quote_amount, campaign.slippage_tolerance_bps)?;
        if tokens_received < expected_min {
            return Err(Error::SlippageExceeded);
        }

        // Burn tokens and get realized amount
        let realized_burn = burn_tokens(&env, &campaign.token_address, tokens_received)?;

        // Reconciliation: expected vs realized
        let reconciliation = reconcile_burn(tokens_received, realized_burn)?;
        
        if !reconciliation.reconciled {
            return Err(Error::ReconciliationFailed);
        }

        // Invariant checks before update
        check_monotonic_invariants(&campaign, quote_amount, realized_burn)?;

        // Update campaign atomically
        let new_spent = campaign.spent.checked_add(quote_amount)
            .ok_or(Error::ArithmeticError)?;
        let new_bought = campaign.tokens_bought.checked_add(tokens_received)
            .ok_or(Error::ArithmeticError)?;
        let new_burned = campaign.tokens_burned.checked_add(realized_burn)
            .ok_or(Error::ArithmeticError)?;

        campaign.spent = new_spent;
        campaign.tokens_bought = new_bought;
        campaign.tokens_burned = new_burned;

        env.storage().persistent().set(&key, &campaign);

        // Emit settlement event
        emit_buyback_step_settled(
            &env,
            campaign_id,
            quote_amount,
            tokens_received,
            realized_burn,
            reconciliation.delta,
        );

        Ok(ExecutionResult {
            spent: quote_amount,
            bought: tokens_received,
            burned: realized_burn,
            reconciled: true,
        })
    }

    pub fn create_campaign(
        env: Env,
        campaign_id: u64,
        token_address: Address,
        total_budget: i128,
        max_spend_per_step: i128,
        slippage_tolerance_bps: u32,
    ) -> Result<(), Error> {
        if total_budget <= 0 || max_spend_per_step <= 0 {
            return Err(Error::InvalidAmount);
        }

        if max_spend_per_step > total_budget {
            return Err(Error::InvalidParameters);
        }

        if slippage_tolerance_bps > 10000 {
            return Err(Error::InvalidParameters);
        }

        let campaign = BuybackCampaign {
            token_address,
            total_budget,
            spent: 0,
            tokens_bought: 0,
            tokens_burned: 0,
            max_spend_per_step,
            slippage_tolerance_bps,
            active: true,
        };

        let key = DataKey::BuybackCampaign(campaign_id);
        env.storage().persistent().set(&key, &campaign);

        Ok(())
    }

    pub fn get_campaign(env: Env, campaign_id: u64) -> Result<BuybackCampaign, Error> {
        let key = DataKey::BuybackCampaign(campaign_id);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(Error::CampaignNotFound)
    }
}

fn simulate_swap(env: &Env, quote_amount: i128, min_out: i128) -> Result<i128, Error> {
    // Simplified swap simulation: 1:100 ratio
    let tokens = quote_amount.checked_mul(100)
        .ok_or(Error::ArithmeticError)?;
    
    if tokens < min_out {
        return Err(Error::SlippageExceeded);
    }
    
    Ok(tokens)
}

fn burn_tokens(env: &Env, _token: &Address, amount: i128) -> Result<i128, Error> {
    if amount <= 0 {
        return Err(Error::InvalidBurnAmount);
    }
    // In production: invoke token.burn() and return actual burned amount
    // For now, simulate potential rounding by returning exact amount
    Ok(amount)
}

fn reconcile_burn(expected: i128, realized: i128) -> Result<ReconciliationReport, Error> {
    let delta = expected.checked_sub(realized)
        .ok_or(Error::ArithmeticError)?;
    
    // Allow small rounding differences (up to 1 unit)
    let reconciled = delta.abs() <= 1;
    
    Ok(ReconciliationReport {
        expected_burn: expected,
        realized_burn: realized,
        delta,
        reconciled,
    })
}

fn check_monotonic_invariants(
    campaign: &BuybackCampaign,
    new_spent: i128,
    new_burned: i128,
) -> Result<(), Error> {
    // Spent must be monotonically increasing
    if new_spent <= 0 {
        return Err(Error::InvariantViolation);
    }
    
    // Burned must be monotonically increasing
    if new_burned <= 0 {
        return Err(Error::InvariantViolation);
    }
    
    // New totals must not decrease
    let next_spent = campaign.spent.checked_add(new_spent)
        .ok_or(Error::ArithmeticError)?;
    let next_burned = campaign.tokens_burned.checked_add(new_burned)
        .ok_or(Error::ArithmeticError)?;
    
    if next_spent < campaign.spent {
        return Err(Error::InvariantViolation);
    }
    
    if next_burned < campaign.tokens_burned {
        return Err(Error::InvariantViolation);
    }
    
    // Spent must not exceed budget
    if next_spent > campaign.total_budget {
        return Err(Error::InvariantViolation);
    }
    
    Ok(())
}

fn emit_buyback_step_settled(
    env: &Env,
    campaign_id: u64,
    spent: i128,
    bought: i128,
    burned: i128,
    delta: i128,
) {
    env.events().publish(
        (soroban_sdk::symbol_short!("buyback"), campaign_id),
        (spent, bought, burned, delta),
    );
}

fn calculate_min_with_slippage(amount: i128, slippage_bps: u32) -> Result<i128, Error> {
    let slippage_factor = 10000u32.checked_sub(slippage_bps)
        .ok_or(Error::ArithmeticError)?;
    
    let min = amount
        .checked_mul(slippage_factor as i128)
        .ok_or(Error::ArithmeticError)?
        .checked_div(10000)
        .ok_or(Error::ArithmeticError)?;
    
    Ok(min)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup() -> (Env, Address) {
        let env = Env::default();
        let contract_id = env.register_contract(None, BuybackContract);
        (env, contract_id)
    }

    #[test]
    fn test_create_campaign_success() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        let result = env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(
                env.clone(),
                1,
                token.clone(),
                1_000_000,
                100_000,
                500, // 5% slippage
            )
        });

        assert!(result.is_ok());

        let campaign = env.as_contract(&contract_id, || {
            BuybackContract::get_campaign(env.clone(), 1)
        });

        assert!(campaign.is_ok());
        let c = campaign.unwrap();
        assert_eq!(c.total_budget, 1_000_000);
        assert_eq!(c.spent, 0);
        assert_eq!(c.tokens_bought, 0);
        assert_eq!(c.tokens_burned, 0);
        assert!(c.active);
    }

    #[test]
    fn test_create_campaign_invalid_budget() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        let result = env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(env.clone(), 1, token, 0, 100_000, 500)
        });

        assert_eq!(result, Err(Error::InvalidAmount));
    }

    #[test]
    fn test_create_campaign_step_exceeds_budget() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        let result = env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(env.clone(), 1, token, 100_000, 200_000, 500)
        });

        assert_eq!(result, Err(Error::InvalidParameters));
    }

    #[test]
    fn test_create_campaign_invalid_slippage() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        let result = env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(env.clone(), 1, token, 1_000_000, 100_000, 10001)
        });

        assert_eq!(result, Err(Error::InvalidParameters));
    }

    #[test]
    fn test_execute_step_success() {
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

            let result = BuybackContract::execute_buyback_step(
                env.clone(),
                1,
                50_000,
                4_500_000, // min tokens out
            );

            assert!(result.is_ok());
            let exec = result.unwrap();
            assert_eq!(exec.spent, 50_000);
            assert_eq!(exec.bought, 5_000_000); // 50k * 100
            assert_eq!(exec.burned, 5_000_000);
            assert!(exec.reconciled);

            let campaign = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            assert_eq!(campaign.spent, 50_000);
            assert_eq!(campaign.tokens_bought, 5_000_000);
            assert_eq!(campaign.tokens_burned, 5_000_000);
        });
    }

    #[test]
    fn test_execute_step_exceeds_step_limit() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(env.clone(), 1, token, 1_000_000, 100_000, 500)
                .unwrap();

            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 150_000, 1_000_000);

            assert_eq!(result, Err(Error::ExceedsStepLimit));
        });
    }

    #[test]
    fn test_execute_step_insufficient_budget() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(env.clone(), 1, token, 100_000, 50_000, 500)
                .unwrap();

            // First execution
            BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 1_000_000).unwrap();

            // Second execution
            BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 1_000_000).unwrap();

            // Third should fail
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 1_000_000);

            assert_eq!(result, Err(Error::InsufficientBudget));
        });
    }

    #[test]
    fn test_execute_step_slippage_exceeded() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(env.clone(), 1, token, 1_000_000, 100_000, 500)
                .unwrap();

            // Request more tokens than swap will provide
            let result = BuybackContract::execute_buyback_step(
                env.clone(),
                1,
                50_000,
                6_000_000, // min out > 5M actual
            );

            assert_eq!(result, Err(Error::SlippageExceeded));
        });
    }

    #[test]
    fn test_execute_step_campaign_not_found() {
        let (env, contract_id) = setup();

        let result = env.as_contract(&contract_id, || {
            BuybackContract::execute_buyback_step(env.clone(), 999, 50_000, 1_000_000)
        });

        assert_eq!(result, Err(Error::CampaignNotFound));
    }

    #[test]
    fn test_execute_step_invalid_amounts() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(env.clone(), 1, token, 1_000_000, 100_000, 500)
                .unwrap();

            let result1 = BuybackContract::execute_buyback_step(env.clone(), 1, 0, 1_000_000);
            assert_eq!(result1, Err(Error::InvalidAmount));

            let result2 = BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 0);
            assert_eq!(result2, Err(Error::InvalidAmount));

            let result3 = BuybackContract::execute_buyback_step(env.clone(), 1, -100, 1_000_000);
            assert_eq!(result3, Err(Error::InvalidAmount));
        });
    }

    #[test]
    fn test_multiple_executions_accounting() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(env.clone(), 1, token, 1_000_000, 100_000, 500)
                .unwrap();

            // Execute 3 steps
            for _ in 0..3 {
                BuybackContract::execute_buyback_step(env.clone(), 1, 30_000, 2_500_000).unwrap();
            }

            let campaign = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            assert_eq!(campaign.spent, 90_000);
            assert_eq!(campaign.tokens_bought, 9_000_000);
            assert_eq!(campaign.tokens_burned, 9_000_000);
        });
    }

    #[test]
    fn test_slippage_calculation() {
        // 5% slippage (500 bps)
        let min = calculate_min_with_slippage(1_000_000, 500).unwrap();
        assert_eq!(min, 950_000);

        // 1% slippage (100 bps)
        let min = calculate_min_with_slippage(1_000_000, 100).unwrap();
        assert_eq!(min, 990_000);

        // 0% slippage
        let min = calculate_min_with_slippage(1_000_000, 0).unwrap();
        assert_eq!(min, 1_000_000);
    }

    #[test]
    fn test_atomic_accounting_on_failure() {
        let (env, contract_id) = setup();
        let token = Address::generate(&env);

        env.as_contract(&contract_id, || {
            BuybackContract::create_campaign(env.clone(), 1, token, 1_000_000, 100_000, 500)
                .unwrap();

            // Successful execution
            BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 4_500_000).unwrap();

            let campaign_before = BuybackContract::get_campaign(env.clone(), 1).unwrap();

            // Failed execution (slippage)
            let result = BuybackContract::execute_buyback_step(env.clone(), 1, 50_000, 6_000_000);
            assert!(result.is_err());

            // Campaign state should be unchanged
            let campaign_after = BuybackContract::get_campaign(env.clone(), 1).unwrap();
            assert_eq!(campaign_before, campaign_after);
        });
    }

    #[test]
    fn test_reconciliation_exact_match() {
        let report = reconcile_burn(1_000_000, 1_000_000).unwrap();
        assert_eq!(report.expected_burn, 1_000_000);
        assert_eq!(report.realized_burn, 1_000_000);
        assert_eq!(report.delta, 0);
        assert!(report.reconciled);
    }

    #[test]
    fn test_reconciliation_rounding_tolerance() {
        // 1 unit difference is acceptable
        let report = reconcile_burn(1_000_000, 999_999).unwrap();
        assert_eq!(report.delta, 1);
        assert!(report.reconciled);

        let report = reconcile_burn(999_999, 1_000_000).unwrap();
        assert_eq!(report.delta, -1);
        assert!(report.reconciled);
    }

    #[test]
    fn test_reconciliation_exceeds_tolerance() {
        // 2 units difference is not acceptable
        let report = reconcile_burn(1_000_000, 999_998).unwrap();
        assert_eq!(report.delta, 2);
        assert!(!report.reconciled);
    }

    #[test]
    fn test_monotonic_invariant_positive_amounts() {
        let campaign = BuybackCampaign {
            token_address: Address::generate(&Env::default()),
            total_budget: 1_000_000,
            spent: 100_000,
            tokens_bought: 10_000_000,
            tokens_burned: 10_000_000,
            max_spend_per_step: 100_000,
            slippage_tolerance_bps: 500,
            active: true,
        };

        let result = check_monotonic_invariants(&campaign, 50_000, 5_000_000);
        assert!(result.is_ok());
    }

    #[test]
    fn test_monotonic_invariant_zero_spent() {
        let campaign = BuybackCampaign {
            token_address: Address::generate(&Env::default()),
            total_budget: 1_000_000,
            spent: 100_000,
            tokens_bought: 10_000_000,
            tokens_burned: 10_000_000,
            max_spend_per_step: 100_000,
            slippage_tolerance_bps: 500,
            active: true,
        };

        let result = check_monotonic_invariants(&campaign, 0, 5_000_000);
        assert_eq!(result, Err(Error::InvariantViolation));
    }

    #[test]
    fn test_monotonic_invariant_zero_burned() {
        let campaign = BuybackCampaign {
            token_address: Address::generate(&Env::default()),
            total_budget: 1_000_000,
            spent: 100_000,
            tokens_bought: 10_000_000,
            tokens_burned: 10_000_000,
            max_spend_per_step: 100_000,
            slippage_tolerance_bps: 500,
            active: true,
        };

        let result = check_monotonic_invariants(&campaign, 50_000, 0);
        assert_eq!(result, Err(Error::InvariantViolation));
    }

    #[test]
    fn test_monotonic_invariant_exceeds_budget() {
        let campaign = BuybackCampaign {
            token_address: Address::generate(&Env::default()),
            total_budget: 1_000_000,
            spent: 950_000,
            tokens_bought: 95_000_000,
            tokens_burned: 95_000_000,
            max_spend_per_step: 100_000,
            slippage_tolerance_bps: 500,
            active: true,
        };

        // Trying to spend 100k when only 50k remains
        let result = check_monotonic_invariants(&campaign, 100_000, 10_000_000);
        assert_eq!(result, Err(Error::InvariantViolation));
    }
}
