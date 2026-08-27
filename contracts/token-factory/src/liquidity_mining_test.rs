//! Liquidity Mining Program test suite
//!
//! Covers: full pool lifecycle state transitions (including rejecting
//! invalid transitions), reward accrual across pause/resume, proportional
//! distribution among multiple providers, and admin-only reward-rate
//! updates.
//!
//! Each mutating call runs inside its own `env.as_contract(...)` frame
//! (see the `call_*` helpers below) so that `mock_all_auths()` sees a
//! fresh top-level invocation per `require_auth()` call — batching two
//! auth-requiring calls into a single `as_contract` closure trips the
//! host's "frame is already authorized" guard.

#[cfg(test)]
mod liquidity_mining_test {
    use crate::liquidity_mining;
    use crate::storage;
    use crate::types::{Error, LiquidityMiningPool, MiningPoolStatus, ProviderStake, TokenInfo};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env, String,
    };

    // ─────────────────────────────────────────────────────────────────
    // Per-call helpers — each opens its own `as_contract` frame
    // ─────────────────────────────────────────────────────────────────

    fn call_create_pool(
        env: &Env,
        contract_id: &Address,
        admin: &Address,
        reward_token_index: u32,
        stake_token_index: u32,
        reward_rate: i128,
        start_time: u64,
        end_time: u64,
    ) -> Result<u64, Error> {
        env.as_contract(contract_id, || {
            liquidity_mining::create_mining_pool(
                env,
                admin,
                reward_token_index,
                stake_token_index,
                reward_rate,
                start_time,
                end_time,
            )
        })
    }

    fn call_deposit(
        env: &Env,
        contract_id: &Address,
        provider: &Address,
        pool_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        env.as_contract(contract_id, || {
            liquidity_mining::deposit(env, provider, pool_id, amount)
        })
    }

    fn call_withdraw(
        env: &Env,
        contract_id: &Address,
        provider: &Address,
        pool_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        env.as_contract(contract_id, || {
            liquidity_mining::withdraw(env, provider, pool_id, amount)
        })
    }

    fn call_claim_rewards(
        env: &Env,
        contract_id: &Address,
        provider: &Address,
        pool_id: u64,
    ) -> Result<i128, Error> {
        env.as_contract(contract_id, || {
            liquidity_mining::claim_rewards(env, provider, pool_id)
        })
    }

    fn call_pause(env: &Env, contract_id: &Address, admin: &Address, pool_id: u64) -> Result<(), Error> {
        env.as_contract(contract_id, || {
            liquidity_mining::pause_mining_pool(env, admin, pool_id)
        })
    }

    fn call_resume(env: &Env, contract_id: &Address, admin: &Address, pool_id: u64) -> Result<(), Error> {
        env.as_contract(contract_id, || {
            liquidity_mining::resume_mining_pool(env, admin, pool_id)
        })
    }

    fn call_end(env: &Env, contract_id: &Address, admin: &Address, pool_id: u64) -> Result<(), Error> {
        env.as_contract(contract_id, || {
            liquidity_mining::end_mining_pool(env, admin, pool_id)
        })
    }

    fn call_update_reward_rate(
        env: &Env,
        contract_id: &Address,
        admin: &Address,
        pool_id: u64,
        new_rate: i128,
    ) -> Result<(), Error> {
        env.as_contract(contract_id, || {
            liquidity_mining::update_reward_rate(env, admin, pool_id, new_rate)
        })
    }

    fn query_pool(env: &Env, contract_id: &Address, pool_id: u64) -> Option<LiquidityMiningPool> {
        env.as_contract(contract_id, || liquidity_mining::get_mining_pool(env, pool_id))
    }

    fn query_position(
        env: &Env,
        contract_id: &Address,
        pool_id: u64,
        provider: &Address,
    ) -> Option<ProviderStake> {
        env.as_contract(contract_id, || {
            liquidity_mining::get_provider_position(env, pool_id, provider)
        })
    }

    fn query_claimable(
        env: &Env,
        contract_id: &Address,
        pool_id: u64,
        provider: &Address,
    ) -> Result<i128, Error> {
        env.as_contract(contract_id, || {
            liquidity_mining::get_claimable_rewards(env, pool_id, provider)
        })
    }

    fn advance_time(env: &Env, seconds: u64) {
        env.ledger().with_mut(|l| l.timestamp += seconds);
    }

    // ─────────────────────────────────────────────────────────────────
    // Test setup
    // ─────────────────────────────────────────────────────────────────

    /// Registers a fresh `TokenFactory` contract, bootstraps admin/pause
    /// state, and creates a reward + stake token pair (indices 0 and 1).
    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, crate::TokenFactory);
        let admin = Address::generate(&env);
        let provider = Address::generate(&env);

        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_paused(&env, false);
            storage::set_token_info(&env, 0, &make_token(&env, &admin));
            storage::set_token_info(&env, 1, &make_token(&env, &admin));
        });

        (env, contract_id, admin, provider)
    }

    fn make_token(env: &Env, creator: &Address) -> TokenInfo {
        TokenInfo {
            address: Address::generate(env),
            creator: creator.clone(),
            name: String::from_str(env, "Token"),
            symbol: String::from_str(env, "TKN"),
            decimals: 7,
            total_supply: 1_000_000_0000000,
            initial_supply: 1_000_000_0000000,
            max_supply: None,
            total_burned: 0,
            burn_count: 0,
            metadata_uri: None,
            metadata_version: 0,
            created_at: env.ledger().timestamp(),
            is_paused: false,
            clawback_enabled: false,
            freeze_enabled: false,
        }
    }

    /// Creates an `Active` pool: reward token 0, stake token 1, rate 10,
    /// running from `now` to `now + 1_000`.
    fn create_pool(env: &Env, contract_id: &Address, admin: &Address) -> u64 {
        let now = env.ledger().timestamp();
        call_create_pool(env, contract_id, admin, 0, 1, 10, now, now + 1_000).unwrap()
    }

    // ─────────────────────────────────────────────────────────────────
    // Pool creation
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn test_create_pool_success() {
        let (env, contract_id, admin, _provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        let pool = query_pool(&env, &contract_id, pool_id).unwrap();
        assert_eq!(pool.id, pool_id);
        assert_eq!(pool.reward_rate, 10);
        assert_eq!(pool.status, MiningPoolStatus::Active);
        assert_eq!(pool.total_staked, 0);
    }

    #[test]
    fn test_create_pool_increments_count() {
        let (env, contract_id, admin, _provider) = setup();
        create_pool(&env, &contract_id, &admin);
        let count = env.as_contract(&contract_id, || liquidity_mining::get_mining_pool_count(&env));
        assert_eq!(count, 1);
    }

    #[test]
    fn test_create_pool_invalid_time_window() {
        let (env, contract_id, admin, _provider) = setup();
        let now = env.ledger().timestamp();
        let result = call_create_pool(&env, &contract_id, &admin, 0, 1, 10, now + 100, now + 50);
        assert_eq!(result, Err(Error::InvalidPoolTimeWindow));
    }

    #[test]
    fn test_create_pool_end_in_past() {
        let (env, contract_id, admin, _provider) = setup();
        env.ledger().with_mut(|l| l.timestamp = 5_000);
        let result = call_create_pool(&env, &contract_id, &admin, 0, 1, 10, 1_000, 2_000);
        assert_eq!(result, Err(Error::InvalidPoolTimeWindow));
    }

    #[test]
    fn test_create_pool_invalid_reward_rate() {
        let (env, contract_id, admin, _provider) = setup();
        let now = env.ledger().timestamp();
        let result = call_create_pool(&env, &contract_id, &admin, 0, 1, 0, now, now + 1_000);
        assert_eq!(result, Err(Error::InvalidRewardRate));
    }

    #[test]
    fn test_create_pool_unauthorized() {
        let (env, contract_id, _admin, provider) = setup();
        let now = env.ledger().timestamp();
        let result = call_create_pool(&env, &contract_id, &provider, 0, 1, 10, now, now + 1_000);
        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_create_pool_invalid_token() {
        let (env, contract_id, admin, _provider) = setup();
        let now = env.ledger().timestamp();
        let result = call_create_pool(&env, &contract_id, &admin, 99, 1, 10, now, now + 1_000);
        assert_eq!(result, Err(Error::TokenNotFound));
    }

    #[test]
    fn test_create_pool_contract_paused() {
        let (env, contract_id, admin, _provider) = setup();
        env.as_contract(&contract_id, || storage::set_paused(&env, true));
        let now = env.ledger().timestamp();
        let result = call_create_pool(&env, &contract_id, &admin, 0, 1, 10, now, now + 1_000);
        assert_eq!(result, Err(Error::ContractPaused));
    }

    // ─────────────────────────────────────────────────────────────────
    // Deposit
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn test_deposit_success() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();

        let position = query_position(&env, &contract_id, pool_id, &provider).unwrap();
        assert_eq!(position.staked_amount, 1_000);

        let pool = query_pool(&env, &contract_id, pool_id).unwrap();
        assert_eq!(pool.total_staked, 1_000);
    }

    #[test]
    fn test_deposit_zero_amount_rejected() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);
        let result = call_deposit(&env, &contract_id, &provider, pool_id, 0);
        assert_eq!(result, Err(Error::InvalidAmount));
    }

    #[test]
    fn test_deposit_negative_amount_rejected() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);
        let result = call_deposit(&env, &contract_id, &provider, pool_id, -1);
        assert_eq!(result, Err(Error::InvalidAmount));
    }

    #[test]
    fn test_deposit_pool_not_found() {
        let (env, contract_id, _admin, provider) = setup();
        let result = call_deposit(&env, &contract_id, &provider, 999, 1_000);
        assert_eq!(result, Err(Error::MiningPoolNotFound));
    }

    #[test]
    fn test_deposit_before_pool_start_rejected() {
        let (env, contract_id, admin, provider) = setup();
        let now = env.ledger().timestamp();
        let pool_id =
            call_create_pool(&env, &contract_id, &admin, 0, 1, 10, now + 500, now + 2_000).unwrap();

        let result = call_deposit(&env, &contract_id, &provider, pool_id, 1_000);
        assert_eq!(result, Err(Error::InvalidPoolTimeWindow));
    }

    #[test]
    fn test_deposit_after_pool_end_rejected() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        advance_time(&env, 2_000);
        let result = call_deposit(&env, &contract_id, &provider, pool_id, 1_000);
        assert_eq!(result, Err(Error::InvalidPoolTimeWindow));
    }

    #[test]
    fn test_deposit_paused_pool_rejected() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_pause(&env, &contract_id, &admin, pool_id).unwrap();
        let result = call_deposit(&env, &contract_id, &provider, pool_id, 1_000);
        assert_eq!(result, Err(Error::MiningPoolNotActive));
    }

    #[test]
    fn test_multiple_deposits_accumulate() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 500).unwrap();
        call_deposit(&env, &contract_id, &provider, pool_id, 300).unwrap();

        let position = query_position(&env, &contract_id, pool_id, &provider).unwrap();
        assert_eq!(position.staked_amount, 800);

        let pool = query_pool(&env, &contract_id, pool_id).unwrap();
        assert_eq!(pool.total_staked, 800);
    }

    // ─────────────────────────────────────────────────────────────────
    // Withdraw
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn test_withdraw_success() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();
        call_withdraw(&env, &contract_id, &provider, pool_id, 400).unwrap();

        let position = query_position(&env, &contract_id, pool_id, &provider).unwrap();
        assert_eq!(position.staked_amount, 600);

        let pool = query_pool(&env, &contract_id, pool_id).unwrap();
        assert_eq!(pool.total_staked, 600);
    }

    #[test]
    fn test_withdraw_full_amount() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();
        call_withdraw(&env, &contract_id, &provider, pool_id, 1_000).unwrap();

        let position = query_position(&env, &contract_id, pool_id, &provider).unwrap();
        assert_eq!(position.staked_amount, 0);
    }

    #[test]
    fn test_withdraw_exceeds_balance_rejected() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 500).unwrap();
        let result = call_withdraw(&env, &contract_id, &provider, pool_id, 600);
        assert_eq!(result, Err(Error::InsufficientStakedAmount));
    }

    #[test]
    fn test_withdraw_zero_amount_rejected() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 500).unwrap();
        let result = call_withdraw(&env, &contract_id, &provider, pool_id, 0);
        assert_eq!(result, Err(Error::InvalidAmount));
    }

    #[test]
    fn test_withdraw_no_position_rejected() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);
        let result = call_withdraw(&env, &contract_id, &provider, pool_id, 100);
        assert_eq!(result, Err(Error::NoMiningPosition));
    }

    #[test]
    fn test_withdraw_allowed_after_pool_ended() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();
        call_end(&env, &contract_id, &admin, pool_id).unwrap();
        let result = call_withdraw(&env, &contract_id, &provider, pool_id, 1_000);
        assert!(result.is_ok(), "withdrawal must remain possible after pool ends");
    }

    // ─────────────────────────────────────────────────────────────────
    // Reward accrual and claiming
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn test_rewards_accrue_over_time() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();
        advance_time(&env, 100);

        let claimable = query_claimable(&env, &contract_id, pool_id, &provider).unwrap();
        assert!(claimable > 0, "rewards should have accrued");
    }

    #[test]
    fn test_claim_rewards_success() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();
        advance_time(&env, 100);

        let claimed = call_claim_rewards(&env, &contract_id, &provider, pool_id).unwrap();
        assert!(claimed > 0, "should have claimed rewards");

        let claimable = query_claimable(&env, &contract_id, pool_id, &provider).unwrap();
        assert_eq!(claimable, 0, "pending rewards reset after claim");
    }

    #[test]
    fn test_claim_nothing_to_claim() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);
        let result = call_claim_rewards(&env, &contract_id, &provider, pool_id);
        assert_eq!(result, Err(Error::NoMiningPosition));
    }

    #[test]
    fn test_claim_immediately_after_deposit_is_zero() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();
        let result = call_claim_rewards(&env, &contract_id, &provider, pool_id);
        assert_eq!(result, Err(Error::NothingToClaim));
    }

    #[test]
    fn test_rewards_stop_at_end_time() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();
        advance_time(&env, 5_000);
        let claimable_past = query_claimable(&env, &contract_id, pool_id, &provider).unwrap();

        advance_time(&env, 5_000);
        let claimable_further = query_claimable(&env, &contract_id, pool_id, &provider).unwrap();

        assert_eq!(
            claimable_past, claimable_further,
            "rewards must not accrue past end_time"
        );
    }

    #[test]
    fn test_proportional_rewards_two_providers() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);
        let provider2 = Address::generate(&env);

        // 3000/1000 = 75/25 split
        call_deposit(&env, &contract_id, &provider, pool_id, 3_000).unwrap();
        call_deposit(&env, &contract_id, &provider2, pool_id, 1_000).unwrap();

        advance_time(&env, 100);

        let r1 = query_claimable(&env, &contract_id, pool_id, &provider).unwrap();
        let r2 = query_claimable(&env, &contract_id, pool_id, &provider2).unwrap();

        assert!(r1 > r2, "larger depositor should earn more");
        let ratio = r1 / r2.max(1);
        assert!((2..=4).contains(&ratio), "ratio should be ~3x, got {}", ratio);
    }

    #[test]
    fn test_rewards_preserved_after_withdraw() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();
        advance_time(&env, 100);
        call_withdraw(&env, &contract_id, &provider, pool_id, 1_000).unwrap();

        let position = query_position(&env, &contract_id, pool_id, &provider).unwrap();
        assert!(
            position.pending_rewards > 0,
            "pending rewards must be preserved after withdraw"
        );
    }

    // ─────────────────────────────────────────────────────────────────
    // Pool lifecycle: pause / resume / end (state machine)
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn test_pause_resume_pause_cycle() {
        let (env, contract_id, admin, _provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_pause(&env, &contract_id, &admin, pool_id).unwrap();
        assert_eq!(
            query_pool(&env, &contract_id, pool_id).unwrap().status,
            MiningPoolStatus::Paused
        );

        call_resume(&env, &contract_id, &admin, pool_id).unwrap();
        assert_eq!(
            query_pool(&env, &contract_id, pool_id).unwrap().status,
            MiningPoolStatus::Active
        );

        call_pause(&env, &contract_id, &admin, pool_id).unwrap();
        assert_eq!(
            query_pool(&env, &contract_id, pool_id).unwrap().status,
            MiningPoolStatus::Paused
        );
    }

    #[test]
    fn test_pause_already_paused_rejected() {
        let (env, contract_id, admin, _provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_pause(&env, &contract_id, &admin, pool_id).unwrap();
        let result = call_pause(&env, &contract_id, &admin, pool_id);
        assert_eq!(result, Err(Error::MiningPoolInvalidTransition));
    }

    #[test]
    fn test_resume_active_pool_rejected() {
        let (env, contract_id, admin, _provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);
        let result = call_resume(&env, &contract_id, &admin, pool_id);
        assert_eq!(result, Err(Error::MiningPoolInvalidTransition));
    }

    #[test]
    fn test_end_pool_success() {
        let (env, contract_id, admin, _provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_end(&env, &contract_id, &admin, pool_id).unwrap();
        assert_eq!(
            query_pool(&env, &contract_id, pool_id).unwrap().status,
            MiningPoolStatus::Ended
        );
    }

    #[test]
    fn test_end_already_ended_rejected() {
        let (env, contract_id, admin, _provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_end(&env, &contract_id, &admin, pool_id).unwrap();
        let result = call_end(&env, &contract_id, &admin, pool_id);
        assert_eq!(result, Err(Error::MiningPoolInvalidTransition));
    }

    #[test]
    fn test_pause_ended_pool_rejected() {
        let (env, contract_id, admin, _provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_end(&env, &contract_id, &admin, pool_id).unwrap();
        let result = call_pause(&env, &contract_id, &admin, pool_id);
        assert_eq!(result, Err(Error::MiningPoolInvalidTransition));
    }

    #[test]
    fn test_resume_ended_pool_rejected() {
        let (env, contract_id, admin, _provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_end(&env, &contract_id, &admin, pool_id).unwrap();
        let result = call_resume(&env, &contract_id, &admin, pool_id);
        assert_eq!(result, Err(Error::MiningPoolInvalidTransition));
    }

    #[test]
    fn test_pause_unauthorized() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);
        let result = call_pause(&env, &contract_id, &provider, pool_id);
        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_end_unauthorized() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);
        let result = call_end(&env, &contract_id, &provider, pool_id);
        assert_eq!(result, Err(Error::Unauthorized));
    }

    // ─────────────────────────────────────────────────────────────────
    // Reward rate update (admin only)
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn test_update_reward_rate_success() {
        let (env, contract_id, admin, _provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_update_reward_rate(&env, &contract_id, &admin, pool_id, 50).unwrap();
        let pool = query_pool(&env, &contract_id, pool_id).unwrap();
        assert_eq!(pool.reward_rate, 50);
    }

    #[test]
    fn test_update_reward_rate_zero_rejected() {
        let (env, contract_id, admin, _provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);
        let result = call_update_reward_rate(&env, &contract_id, &admin, pool_id, 0);
        assert_eq!(result, Err(Error::InvalidRewardRate));
    }

    #[test]
    fn test_update_reward_rate_paused_pool_rejected() {
        let (env, contract_id, admin, _provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_pause(&env, &contract_id, &admin, pool_id).unwrap();
        let result = call_update_reward_rate(&env, &contract_id, &admin, pool_id, 20);
        assert_eq!(result, Err(Error::MiningPoolNotActive));
    }

    #[test]
    fn test_update_reward_rate_unauthorized() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);
        let result = call_update_reward_rate(&env, &contract_id, &provider, pool_id, 20);
        assert_eq!(result, Err(Error::Unauthorized));
    }

    // ─────────────────────────────────────────────────────────────────
    // Reward accrual pauses while the pool is paused
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn test_no_rewards_during_pause() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();

        advance_time(&env, 50);
        call_pause(&env, &contract_id, &admin, pool_id).unwrap();

        let claimable_at_pause = query_claimable(&env, &contract_id, pool_id, &provider).unwrap();

        advance_time(&env, 100);
        let claimable_while_paused = query_claimable(&env, &contract_id, pool_id, &provider).unwrap();

        assert_eq!(
            claimable_at_pause, claimable_while_paused,
            "rewards must not accrue while the pool is paused"
        );
    }

    #[test]
    fn test_rewards_resume_after_unpause() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();

        advance_time(&env, 50);
        call_pause(&env, &contract_id, &admin, pool_id).unwrap();

        let claimable_at_pause = query_claimable(&env, &contract_id, pool_id, &provider).unwrap();

        advance_time(&env, 100);
        call_resume(&env, &contract_id, &admin, pool_id).unwrap();

        advance_time(&env, 50);
        let claimable_after_resume = query_claimable(&env, &contract_id, pool_id, &provider).unwrap();

        assert!(
            claimable_after_resume > claimable_at_pause,
            "rewards should accrue again after resume"
        );
    }

    // ─────────────────────────────────────────────────────────────────
    // Arithmetic safety
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn test_deposit_i128_max_rejected() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        call_deposit(&env, &contract_id, &provider, pool_id, 1_000).unwrap();
        let result = call_deposit(&env, &contract_id, &provider, pool_id, i128::MAX);
        assert!(result.is_err());
    }

    #[test]
    fn test_claimable_rewards_no_position_returns_zero() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);
        let claimable = query_claimable(&env, &contract_id, pool_id, &provider).unwrap();
        assert_eq!(claimable, 0);
    }

    // ─────────────────────────────────────────────────────────────────
    // Integration: full lifecycle
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn test_full_lifecycle() {
        let (env, contract_id, admin, provider) = setup();
        let pool_id = create_pool(&env, &contract_id, &admin);

        // Deposit
        call_deposit(&env, &contract_id, &provider, pool_id, 2_000).unwrap();

        // Accrue
        advance_time(&env, 200);

        // Claim
        let claimed = call_claim_rewards(&env, &contract_id, &provider, pool_id).unwrap();
        assert!(claimed > 0);

        // Accrue more
        advance_time(&env, 200);

        // Withdraw everything
        call_withdraw(&env, &contract_id, &provider, pool_id, 2_000).unwrap();
        let position = query_position(&env, &contract_id, pool_id, &provider).unwrap();
        assert!(position.pending_rewards > 0);

        // Admin ends the pool
        call_end(&env, &contract_id, &admin, pool_id).unwrap();
        assert_eq!(
            query_pool(&env, &contract_id, pool_id).unwrap().status,
            MiningPoolStatus::Ended
        );

        // Remaining rewards still claimable after the pool ends
        let final_claim = call_claim_rewards(&env, &contract_id, &provider, pool_id).unwrap();
        assert!(final_claim > 0);
    }
}
