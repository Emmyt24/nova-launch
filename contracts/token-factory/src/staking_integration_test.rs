#[cfg(test)]
mod staking_integration_tests {
    use crate::staking;
    use crate::storage;
    use crate::types::Error;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env,
    };

    const PRECISION: i128 = 1_000_000_000_000;

    fn make_token_info(env: &Env, creator: &Address, symbol: &str) -> crate::types::TokenInfo {
        crate::types::TokenInfo {
            address: Address::generate(env),
            creator: creator.clone(),
            name: soroban_sdk::String::from_str(env, symbol),
            symbol: soroban_sdk::String::from_str(env, symbol),
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

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let user1 = Address::generate(&env);

        storage::set_admin(&env, &admin);
        storage::set_paused(&env, false);

        storage::set_token_info(&env, 0, &make_token_info(&env, &creator, "STK"));
        storage::set_token_info(&env, 1, &make_token_info(&env, &creator, "RWD"));

        storage::set_balance(&env, 0, &user1, 1000);
        storage::set_balance(&env, 1, &creator, 10000);

        (env, admin, creator, user1)
    }

    #[test]
    fn test_create_staking_pool() {
        let (env, admin, _creator, _user1) = setup();

        let reward_rate = 10;
        let pool_id =
            staking::create_staking_pool(&env, admin.clone(), 0, 1, reward_rate).unwrap();

        assert_eq!(pool_id, 0);

        let pool = storage::get_staking_pool(&env, pool_id).unwrap();
        assert_eq!(pool.token_index, 0);
        assert_eq!(pool.reward_token_index, 1);
        assert_eq!(pool.reward_rate, 10);
        assert_eq!(pool.total_staked, 0);
        assert_eq!(pool.creator, admin);
        assert!(pool.active);
    }

    #[test]
    fn test_create_staking_pool_by_token_creator() {
        let (env, _admin, creator, _user1) = setup();

        // The token's creator (not the factory admin) may also create a pool.
        let pool_id = staking::create_staking_pool(&env, creator.clone(), 0, 1, 5).unwrap();
        let pool = storage::get_staking_pool(&env, pool_id).unwrap();
        assert_eq!(pool.creator, creator);
    }

    #[test]
    fn test_create_staking_pool_unauthorized() {
        let (env, _admin, _creator, user1) = setup();

        // user1 is neither the factory admin nor token 0's creator.
        let result = staking::create_staking_pool(&env, user1, 0, 1, 10);
        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_create_staking_pool_negative_rate_rejected() {
        let (env, admin, _creator, _user1) = setup();
        let result = staking::create_staking_pool(&env, admin, 0, 1, -1);
        assert_eq!(result, Err(Error::InvalidRewardRate));
    }

    #[test]
    fn test_stake_success() {
        let (env, admin, _creator, user1) = setup();

        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        staking::stake(&env, user1.clone(), pool_id, 500).unwrap();

        let pool = storage::get_staking_pool(&env, pool_id).unwrap();
        assert_eq!(pool.total_staked, 500);

        let user_stake = storage::get_user_stake(&env, pool_id, &user1).unwrap();
        assert_eq!(user_stake.amount, 500);

        let balance = storage::get_balance(&env, 0, &user1);
        assert_eq!(balance, 500); // 1000 - 500
    }

    #[test]
    fn test_stake_zero_amount_rejected() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        let result = staking::stake(&env, user1, pool_id, 0);
        assert_eq!(result, Err(Error::InvalidParameters));
    }

    #[test]
    fn test_stake_insufficient_balance() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        // user1 has 1000 tokens
        let result = staking::stake(&env, user1, pool_id, 1500);
        assert_eq!(result, Err(Error::InsufficientBalance));
    }

    #[test]
    fn test_stake_nonexistent_pool() {
        let (env, _admin, _creator, user1) = setup();
        let result = staking::stake(&env, user1, 999, 100);
        assert_eq!(result, Err(Error::StakingPoolNotFound));
    }

    #[test]
    fn test_unstake_success() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        staking::stake(&env, user1.clone(), pool_id, 500).unwrap();

        env.ledger().with_mut(|li| {
            li.timestamp += 100;
        });

        staking::unstake(&env, user1.clone(), pool_id, 200).unwrap();

        let pool = storage::get_staking_pool(&env, pool_id).unwrap();
        assert_eq!(pool.total_staked, 300); // 500 - 200

        let user_stake = storage::get_user_stake(&env, pool_id, &user1).unwrap();
        assert_eq!(user_stake.amount, 300);

        let balance = storage::get_balance(&env, 0, &user1);
        assert_eq!(balance, 700); // 1000 - 500 + 200

        // 100s * 10 reward_rate, 100% of pool -> 1000 reward.
        let reward_balance = storage::get_balance(&env, 1, &user1);
        assert_eq!(reward_balance, 1000);
    }

    #[test]
    fn test_unstake_without_ever_staking() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        let result = staking::unstake(&env, user1, pool_id, 100);
        assert_eq!(result, Err(Error::InsufficientStake));
    }

    #[test]
    fn test_unstake_more_than_staked() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        staking::stake(&env, user1.clone(), pool_id, 500).unwrap();

        let result = staking::unstake(&env, user1, pool_id, 501);
        assert_eq!(result, Err(Error::InsufficientStake));
    }

    #[test]
    fn test_claim_rewards() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        staking::stake(&env, user1.clone(), pool_id, 500).unwrap();

        env.ledger().with_mut(|li| {
            li.timestamp += 10;
        });

        staking::claim_rewards(&env, user1.clone(), pool_id).unwrap();

        // 10 seconds * 10 reward rate = 100 total rewards.
        // Since user1 has 100% of the pool, they get 100 rewards.
        let reward_balance = storage::get_balance(&env, 1, &user1);
        assert_eq!(reward_balance, 100);

        // Reward debt is re-anchored so the same period isn't paid twice.
        let result = staking::claim_rewards(&env, user1, pool_id);
        assert_eq!(result, Err(Error::NothingToClaim));
    }

    #[test]
    fn test_pending_rewards() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        staking::stake(&env, user1.clone(), pool_id, 500).unwrap();

        env.ledger().with_mut(|li| {
            li.timestamp += 10;
        });

        let pending = staking::pending_rewards(&env, user1.clone(), pool_id).unwrap();
        assert_eq!(pending, 100);

        // pending_rewards must not mutate state.
        let pool = storage::get_staking_pool(&env, pool_id).unwrap();
        assert_eq!(pool.last_reward_time, env.ledger().timestamp() - 10);
    }

    #[test]
    fn test_pending_rewards_zero_stake() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        // user1 never staked into this pool.
        let pending = staking::pending_rewards(&env, user1, pool_id).unwrap();
        assert_eq!(pending, 0);
    }

    #[test]
    fn test_claim_nothing() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        staking::stake(&env, user1.clone(), pool_id, 500).unwrap();

        // 0 time passed
        let result = staking::claim_rewards(&env, user1.clone(), pool_id);
        assert_eq!(result, Err(Error::NothingToClaim));
    }

    #[test]
    fn test_claim_rewards_without_stake() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        let result = staking::claim_rewards(&env, user1, pool_id);
        assert_eq!(result, Err(Error::InsufficientStake));
    }

    #[test]
    fn test_reward_accrual_over_multiple_periods() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        staking::stake(&env, user1.clone(), pool_id, 500).unwrap();

        env.ledger().with_mut(|li| li.timestamp += 5);
        let pending_1 = staking::pending_rewards(&env, user1.clone(), pool_id).unwrap();
        assert_eq!(pending_1, 50); // 5s * 10

        env.ledger().with_mut(|li| li.timestamp += 5);
        let pending_2 = staking::pending_rewards(&env, user1.clone(), pool_id).unwrap();
        assert_eq!(pending_2, 100); // 10s * 10, still unclaimed

        staking::claim_rewards(&env, user1.clone(), pool_id).unwrap();
        assert_eq!(storage::get_balance(&env, 1, &user1), 100);

        // A further period accrues independently of what was already claimed.
        env.ledger().with_mut(|li| li.timestamp += 3);
        let pending_3 = staking::pending_rewards(&env, user1, pool_id).unwrap();
        assert_eq!(pending_3, 30); // 3s * 10
    }

    #[test]
    fn test_zero_staker_period_is_not_double_counted() {
        let (env, admin, _creator, user1) = setup();
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 10).unwrap();

        // Pool sits empty for a while before anyone stakes.
        env.ledger().with_mut(|li| li.timestamp += 1000);

        staking::stake(&env, user1.clone(), pool_id, 500).unwrap();

        // The empty period must not be attributed to user1 once they join.
        let pending_immediately = staking::pending_rewards(&env, user1.clone(), pool_id).unwrap();
        assert_eq!(pending_immediately, 0);

        env.ledger().with_mut(|li| li.timestamp += 10);
        let pending_after = staking::pending_rewards(&env, user1, pool_id).unwrap();
        assert_eq!(pending_after, 100); // only the post-stake 10s * 10
    }

    #[test]
    fn test_multiple_stakers_share_proportionally() {
        let (env, admin, _creator, user1) = setup();
        let user2 = Address::generate(&env);
        storage::set_balance(&env, 0, &user2, 1000);

        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 100).unwrap();

        // user1 stakes 300, user2 stakes 700 -> 30% / 70% split.
        staking::stake(&env, user1.clone(), pool_id, 300).unwrap();
        staking::stake(&env, user2.clone(), pool_id, 700).unwrap();

        env.ledger().with_mut(|li| li.timestamp += 10);

        // 10s * 100 reward_rate = 1000 total reward, split 300:700.
        let pending_1 = staking::pending_rewards(&env, user1.clone(), pool_id).unwrap();
        let pending_2 = staking::pending_rewards(&env, user2.clone(), pool_id).unwrap();
        assert_eq!(pending_1, 300);
        assert_eq!(pending_2, 700);
        assert_eq!(pending_1 + pending_2, 1000);

        staking::claim_rewards(&env, user1.clone(), pool_id).unwrap();
        staking::claim_rewards(&env, user2.clone(), pool_id).unwrap();
        assert_eq!(storage::get_balance(&env, 1, &user1), 300);
        assert_eq!(storage::get_balance(&env, 1, &user2), 700);
    }

    #[test]
    fn test_late_staker_does_not_earn_pre_entry_rewards() {
        let (env, admin, _creator, user1) = setup();
        let user2 = Address::generate(&env);
        storage::set_balance(&env, 0, &user2, 1000);

        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 100).unwrap();

        staking::stake(&env, user1.clone(), pool_id, 500).unwrap();

        // user1 alone earns 10s * 100 = 1000 before user2 joins.
        env.ledger().with_mut(|li| li.timestamp += 10);
        staking::claim_rewards(&env, user1.clone(), pool_id).unwrap();
        assert_eq!(storage::get_balance(&env, 1, &user1), 1000);

        // user2 joins with an equal stake; the pre-entry rewards must not
        // leak to them.
        staking::stake(&env, user2.clone(), pool_id, 500).unwrap();
        assert_eq!(
            staking::pending_rewards(&env, user2.clone(), pool_id).unwrap(),
            0
        );

        env.ledger().with_mut(|li| li.timestamp += 10);
        // Now evenly split: 10s * 100 = 1000, 500 each.
        assert_eq!(
            staking::pending_rewards(&env, user1, pool_id).unwrap(),
            500
        );
        assert_eq!(
            staking::pending_rewards(&env, user2, pool_id).unwrap(),
            500
        );
    }

    #[test]
    fn test_reward_rate_precision_rounding() {
        let (env, admin, _creator, user1) = setup();
        let user2 = Address::generate(&env);
        storage::set_balance(&env, 0, &user2, 1000);

        // reward_rate and total_staked chosen so per-share division isn't exact,
        // exercising the PRECISION-scaled floor-division rounding behavior.
        let pool_id = staking::create_staking_pool(&env, admin, 0, 1, 7).unwrap();

        staking::stake(&env, user1.clone(), pool_id, 1).unwrap();
        staking::stake(&env, user2.clone(), pool_id, 2).unwrap();

        env.ledger().with_mut(|li| li.timestamp += 1);

        // total reward for the tick = 1 * 7 = 7, split 1:2 across 3 staked.
        // acc_reward_per_share = 7 * PRECISION / 3 (floors).
        let expected_acc = 7i128
            .checked_mul(PRECISION)
            .unwrap()
            .checked_div(3)
            .unwrap();
        staking::claim_rewards(&env, user1.clone(), pool_id).unwrap();
        let pool_after = storage::get_staking_pool(&env, pool_id).unwrap();
        assert_eq!(pool_after.acc_reward_per_share, expected_acc);

        // user1 (1 share) gets floor(1 * expected_acc / PRECISION) = 2.
        // user2 (2 shares) gets floor(2 * expected_acc / PRECISION) = 4.
        let user1_reward = storage::get_balance(&env, 1, &user1);
        assert_eq!(user1_reward, 2);

        staking::claim_rewards(&env, user2.clone(), pool_id).unwrap();
        let user2_reward = storage::get_balance(&env, 1, &user2);
        assert_eq!(user2_reward, 4);

        // Rounding dust (7 - 2 - 4 = 1) is neither over- nor under-paid twice;
        // it simply isn't attributable at this precision and stays unclaimed.
        assert_eq!(
            staking::pending_rewards(&env, user1, pool_id).unwrap(),
            0
        );
        assert_eq!(
            staking::pending_rewards(&env, user2, pool_id).unwrap(),
            0
        );
    }
}
