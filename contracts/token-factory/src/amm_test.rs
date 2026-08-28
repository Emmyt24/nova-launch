//! Unit tests for the AMM constant-product pool module (#559).

#[cfg(test)]
mod amm_tests {
    use crate::amm;
    use crate::storage;
    use crate::types::Error;
    use soroban_sdk::{Address, Env};

    // ── Helpers ───────────────────────────────────────────────────────────────

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

    /// Returns `(env, admin, creator, provider)` with two tokens (indices 0 and
    /// 1) registered and a pool already created.
    fn setup_with_pool() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        let provider = Address::generate(&env);

        storage::set_admin(&env, &admin);
        storage::set_paused(&env, false);

        storage::set_token_info(&env, 0, &make_token_info(&env, &creator, "TOKА"));
        storage::set_token_info(&env, 1, &make_token_info(&env, &creator, "TOKB"));

        // Create pool (admin is authorised).
        amm::create_pool(&env, admin.clone(), 0, 1).unwrap();

        (env, admin, creator, provider)
    }

    // ── create_pool ───────────────────────────────────────────────────────────

    #[test]
    fn test_create_pool_success() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        storage::set_admin(&env, &admin);
        storage::set_paused(&env, false);
        storage::set_token_info(&env, 0, &make_token_info(&env, &admin, "AA"));
        storage::set_token_info(&env, 1, &make_token_info(&env, &admin, "BB"));

        amm::create_pool(&env, admin.clone(), 0, 1).unwrap();

        let pool = amm::get_pool(&env, 0, 1).expect("pool should exist");
        assert_eq!(pool.token_index_a, 0);
        assert_eq!(pool.token_index_b, 1);
        assert_eq!(pool.reserve_a, 0);
        assert_eq!(pool.reserve_b, 0);
        assert_eq!(pool.total_shares, 0);
    }

    #[test]
    fn test_create_pool_canonical_key_order() {
        // Passing (1, 0) should produce the same pool as (0, 1).
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        storage::set_admin(&env, &admin);
        storage::set_paused(&env, false);
        storage::set_token_info(&env, 0, &make_token_info(&env, &admin, "AA"));
        storage::set_token_info(&env, 1, &make_token_info(&env, &admin, "BB"));

        amm::create_pool(&env, admin.clone(), 1, 0).unwrap();

        // Retrievable in both orders.
        assert!(amm::get_pool(&env, 0, 1).is_some());
        assert!(amm::get_pool(&env, 1, 0).is_some());
    }

    #[test]
    fn test_create_pool_identical_tokens_err() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        storage::set_admin(&env, &admin);
        storage::set_paused(&env, false);
        storage::set_token_info(&env, 0, &make_token_info(&env, &admin, "AA"));

        let err = amm::create_pool(&env, admin.clone(), 0, 0).unwrap_err();
        assert_eq!(err, Error::IdenticalTokens);
    }

    #[test]
    fn test_create_pool_already_exists_err() {
        let (env, admin, _, _) = setup_with_pool();

        let err = amm::create_pool(&env, admin.clone(), 0, 1).unwrap_err();
        assert_eq!(err, Error::PoolAlreadyExists);
    }

    #[test]
    fn test_create_pool_token_not_found_err() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        storage::set_admin(&env, &admin);
        storage::set_paused(&env, false);
        // Only register token 0.
        storage::set_token_info(&env, 0, &make_token_info(&env, &admin, "AA"));

        let err = amm::create_pool(&env, admin.clone(), 0, 99).unwrap_err();
        assert_eq!(err, Error::TokenNotFound);
    }

    #[test]
    fn test_create_pool_unauthorized_err() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let stranger = Address::generate(&env);
        let creator = Address::generate(&env);
        storage::set_admin(&env, &admin);
        storage::set_paused(&env, false);
        storage::set_token_info(&env, 0, &make_token_info(&env, &creator, "AA"));
        storage::set_token_info(&env, 1, &make_token_info(&env, &creator, "BB"));

        // `stranger` is neither admin nor either token's creator.
        let err = amm::create_pool(&env, stranger, 0, 1).unwrap_err();
        assert_eq!(err, Error::Unauthorized);
    }

    #[test]
    fn test_create_pool_by_token_creator() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);
        storage::set_admin(&env, &admin);
        storage::set_paused(&env, false);
        storage::set_token_info(&env, 0, &make_token_info(&env, &creator, "AA"));
        storage::set_token_info(&env, 1, &make_token_info(&env, &creator, "BB"));

        // Token creator should be allowed.
        amm::create_pool(&env, creator.clone(), 0, 1).unwrap();
        assert!(amm::get_pool(&env, 0, 1).is_some());
    }

    // ── add_liquidity ─────────────────────────────────────────────────────────

    #[test]
    fn test_add_liquidity_first_deposit() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        let amount_a = 1000_i128;
        let amount_b = 4000_i128;
        storage::set_balance(&env, 0, &provider, amount_a);
        storage::set_balance(&env, 1, &provider, amount_b);

        let result = amm::add_liquidity(&env, provider.clone(), 0, 1, amount_a, amount_b).unwrap();

        // LP shares = floor(sqrt(1000 * 4000)) = floor(sqrt(4_000_000)) = 2000
        assert_eq!(result.shares_minted, 2000);
        assert_eq!(result.amount_a, amount_a);
        assert_eq!(result.amount_b, amount_b);

        // Provider balances fully consumed.
        assert_eq!(storage::get_balance(&env, 0, &provider), 0);
        assert_eq!(storage::get_balance(&env, 1, &provider), 0);

        // Pool state updated.
        let pool = amm::get_pool(&env, 0, 1).unwrap();
        assert_eq!(pool.reserve_a, amount_a);
        assert_eq!(pool.reserve_b, amount_b);
        assert_eq!(pool.total_shares, 2000);

        // Provider's LP shares recorded.
        assert_eq!(amm::get_shares(&env, 0, 1, &provider), 2000);
    }

    #[test]
    fn test_add_liquidity_subsequent_deposit_proportional() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        // Seed the pool.
        storage::set_balance(&env, 0, &provider, 2000);
        storage::set_balance(&env, 1, &provider, 2000);
        amm::add_liquidity(&env, provider.clone(), 0, 1, 1000, 1000).unwrap();

        // Second provider deposits in ratio 1:1.
        let p2 = Address::generate(&env);
        storage::set_balance(&env, 0, &p2, 500);
        storage::set_balance(&env, 1, &p2, 500);

        let result = amm::add_liquidity(&env, p2.clone(), 0, 1, 500, 500).unwrap();

        // Both providers together.
        let pool = amm::get_pool(&env, 0, 1).unwrap();
        assert_eq!(pool.reserve_a, 1500);
        assert_eq!(pool.reserve_b, 1500);
        assert!(result.shares_minted > 0);
        assert_eq!(pool.total_shares, amm::get_shares(&env, 0, 1, &provider) + result.shares_minted);
    }

    #[test]
    fn test_add_liquidity_zero_amounts_err() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        let err = amm::add_liquidity(&env, provider.clone(), 0, 1, 0, 100).unwrap_err();
        assert_eq!(err, Error::ZeroLiquidity);

        let err = amm::add_liquidity(&env, provider, 0, 1, 100, 0).unwrap_err();
        assert_eq!(err, Error::ZeroLiquidity);
    }

    #[test]
    fn test_add_liquidity_insufficient_balance_err() {
        let (env, _admin, _creator, provider) = setup_with_pool();
        // Give provider only token A.
        storage::set_balance(&env, 0, &provider, 500);

        let err = amm::add_liquidity(&env, provider, 0, 1, 500, 500).unwrap_err();
        assert_eq!(err, Error::InsufficientBalance);
    }

    #[test]
    fn test_add_liquidity_pool_not_found_err() {
        let env = Env::default();
        env.mock_all_auths();
        let provider = Address::generate(&env);

        let err = amm::add_liquidity(&env, provider, 0, 1, 100, 100).unwrap_err();
        assert_eq!(err, Error::PoolNotFound);
    }

    // ── remove_liquidity ──────────────────────────────────────────────────────

    #[test]
    fn test_remove_liquidity_full() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        storage::set_balance(&env, 0, &provider, 1000);
        storage::set_balance(&env, 1, &provider, 4000);
        let add_result = amm::add_liquidity(&env, provider.clone(), 0, 1, 1000, 4000).unwrap();

        let (out_a, out_b) =
            amm::remove_liquidity(&env, provider.clone(), 0, 1, add_result.shares_minted).unwrap();

        assert_eq!(out_a, 1000);
        assert_eq!(out_b, 4000);

        // Pool reserves drained.
        let pool = amm::get_pool(&env, 0, 1).unwrap();
        assert_eq!(pool.reserve_a, 0);
        assert_eq!(pool.reserve_b, 0);
        assert_eq!(pool.total_shares, 0);

        // Provider has tokens back.
        assert_eq!(storage::get_balance(&env, 0, &provider), 1000);
        assert_eq!(storage::get_balance(&env, 1, &provider), 4000);
    }

    #[test]
    fn test_remove_liquidity_partial() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        storage::set_balance(&env, 0, &provider, 1000);
        storage::set_balance(&env, 1, &provider, 1000);
        let add_result = amm::add_liquidity(&env, provider.clone(), 0, 1, 1000, 1000).unwrap();
        let total_shares = add_result.shares_minted;

        let (out_a, out_b) =
            amm::remove_liquidity(&env, provider.clone(), 0, 1, total_shares / 2).unwrap();

        assert_eq!(out_a, 500);
        assert_eq!(out_b, 500);

        let remaining_shares = amm::get_shares(&env, 0, 1, &provider);
        assert_eq!(remaining_shares, total_shares - total_shares / 2);
    }

    #[test]
    fn test_remove_liquidity_zero_shares_err() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        let err = amm::remove_liquidity(&env, provider, 0, 1, 0).unwrap_err();
        assert_eq!(err, Error::ZeroShares);
    }

    #[test]
    fn test_remove_liquidity_shares_exceed_balance_err() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        storage::set_balance(&env, 0, &provider, 100);
        storage::set_balance(&env, 1, &provider, 100);
        amm::add_liquidity(&env, provider.clone(), 0, 1, 100, 100).unwrap();

        let err = amm::remove_liquidity(&env, provider, 0, 1, 999_999).unwrap_err();
        assert_eq!(err, Error::SharesExceedBalance);
    }

    // ── swap ──────────────────────────────────────────────────────────────────

    #[test]
    fn test_swap_a_for_b() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        // Seed pool with 1000 A : 1000 B.
        storage::set_balance(&env, 0, &provider, 1000);
        storage::set_balance(&env, 1, &provider, 1000);
        amm::add_liquidity(&env, provider.clone(), 0, 1, 1000, 1000).unwrap();

        let swapper = Address::generate(&env);
        storage::set_balance(&env, 0, &swapper, 100);

        let amount_out = amm::swap(&env, swapper.clone(), 0, 1, 100, 1).unwrap();

        // With 1000:1000 pool, 100 A in → ~90 B out after 0.3 % fee.
        // Exact: floor((100*997*1000) / (1000*1000 + 100*997)) = floor(99700000/1099700) ≈ 90
        assert!(amount_out > 0);
        assert!(amount_out < 100); // Must be less than input due to the fee.

        // Swapper receives B tokens.
        assert_eq!(storage::get_balance(&env, 1, &swapper), amount_out);
        // Swapper's A balance is zero (fully spent).
        assert_eq!(storage::get_balance(&env, 0, &swapper), 0);
    }

    #[test]
    fn test_swap_b_for_a() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        storage::set_balance(&env, 0, &provider, 1000);
        storage::set_balance(&env, 1, &provider, 1000);
        amm::add_liquidity(&env, provider.clone(), 0, 1, 1000, 1000).unwrap();

        let swapper = Address::generate(&env);
        storage::set_balance(&env, 1, &swapper, 100);

        let amount_out = amm::swap(&env, swapper.clone(), 1, 0, 100, 1).unwrap();

        assert!(amount_out > 0);
        assert_eq!(storage::get_balance(&env, 0, &swapper), amount_out);
        assert_eq!(storage::get_balance(&env, 1, &swapper), 0);
    }

    #[test]
    fn test_swap_zero_amount_in_err() {
        let (env, _admin, _creator, _provider) = setup_with_pool();
        let swapper = Address::generate(&env);

        let err = amm::swap(&env, swapper, 0, 1, 0, 0).unwrap_err();
        assert_eq!(err, Error::ZeroAmountIn);
    }

    #[test]
    fn test_swap_identical_tokens_err() {
        let (env, _admin, _creator, _provider) = setup_with_pool();
        let swapper = Address::generate(&env);
        storage::set_balance(&env, 0, &swapper, 100);

        let err = amm::swap(&env, swapper, 0, 0, 100, 1).unwrap_err();
        assert_eq!(err, Error::IdenticalTokens);
    }

    #[test]
    fn test_swap_no_liquidity_err() {
        let (env, _admin, _creator, _provider) = setup_with_pool();
        // Pool exists but has zero reserves.
        let swapper = Address::generate(&env);
        storage::set_balance(&env, 0, &swapper, 100);

        let err = amm::swap(&env, swapper, 0, 1, 100, 1).unwrap_err();
        assert_eq!(err, Error::InsufficientReserves);
    }

    #[test]
    fn test_swap_slippage_guard_err() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        storage::set_balance(&env, 0, &provider, 1000);
        storage::set_balance(&env, 1, &provider, 1000);
        amm::add_liquidity(&env, provider.clone(), 0, 1, 1000, 1000).unwrap();

        let swapper = Address::generate(&env);
        storage::set_balance(&env, 0, &swapper, 100);

        // Demand more than the pool can give.
        let err = amm::swap(&env, swapper, 0, 1, 100, 999).unwrap_err();
        assert_eq!(err, Error::ZeroAmountOut);
    }

    #[test]
    fn test_swap_insufficient_balance_err() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        storage::set_balance(&env, 0, &provider, 1000);
        storage::set_balance(&env, 1, &provider, 1000);
        amm::add_liquidity(&env, provider.clone(), 0, 1, 1000, 1000).unwrap();

        let swapper = Address::generate(&env);
        // Swapper has no A tokens.

        let err = amm::swap(&env, swapper, 0, 1, 100, 1).unwrap_err();
        assert_eq!(err, Error::InsufficientBalance);
    }

    // ── quote_swap ────────────────────────────────────────────────────────────

    #[test]
    fn test_quote_swap_matches_actual_swap() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        storage::set_balance(&env, 0, &provider, 1000);
        storage::set_balance(&env, 1, &provider, 1000);
        amm::add_liquidity(&env, provider.clone(), 0, 1, 1000, 1000).unwrap();

        let quote = amm::quote_swap(&env, 0, 1, 100).unwrap();

        let swapper = Address::generate(&env);
        storage::set_balance(&env, 0, &swapper, 100);
        let actual = amm::swap(&env, swapper, 0, 1, 100, 1).unwrap();

        assert_eq!(quote.amount_out, actual);
    }

    #[test]
    fn test_quote_swap_does_not_mutate_state() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        storage::set_balance(&env, 0, &provider, 1000);
        storage::set_balance(&env, 1, &provider, 1000);
        amm::add_liquidity(&env, provider.clone(), 0, 1, 1000, 1000).unwrap();

        let before = amm::get_pool(&env, 0, 1).unwrap();
        amm::quote_swap(&env, 0, 1, 100).unwrap();
        let after = amm::get_pool(&env, 0, 1).unwrap();

        assert_eq!(before.reserve_a, after.reserve_a);
        assert_eq!(before.reserve_b, after.reserve_b);
    }

    #[test]
    fn test_quote_swap_zero_in_err() {
        let (env, _admin, _creator, _provider) = setup_with_pool();
        let err = amm::quote_swap(&env, 0, 1, 0).unwrap_err();
        assert_eq!(err, Error::ZeroAmountIn);
    }

    // ── get_pool / get_shares ─────────────────────────────────────────────────

    #[test]
    fn test_get_pool_nonexistent_returns_none() {
        let env = Env::default();
        assert!(amm::get_pool(&env, 5, 6).is_none());
    }

    #[test]
    fn test_get_shares_default_zero() {
        let env = Env::default();
        let user = Address::generate(&env);
        assert_eq!(amm::get_shares(&env, 0, 1, &user), 0);
    }

    // ── constant-product invariant ────────────────────────────────────────────

    #[test]
    fn test_constant_product_invariant_holds_after_swap() {
        let (env, _admin, _creator, provider) = setup_with_pool();

        storage::set_balance(&env, 0, &provider, 10_000);
        storage::set_balance(&env, 1, &provider, 10_000);
        amm::add_liquidity(&env, provider.clone(), 0, 1, 10_000, 10_000).unwrap();

        let pool_before = amm::get_pool(&env, 0, 1).unwrap();
        let k_before = pool_before.reserve_a * pool_before.reserve_b;

        let swapper = Address::generate(&env);
        storage::set_balance(&env, 0, &swapper, 500);
        amm::swap(&env, swapper, 0, 1, 500, 1).unwrap();

        let pool_after = amm::get_pool(&env, 0, 1).unwrap();
        let k_after = pool_after.reserve_a * pool_after.reserve_b;

        // k must be at least as large (it grows slightly because the fee is
        // kept inside the reserves).
        assert!(k_after >= k_before);
    }
}
