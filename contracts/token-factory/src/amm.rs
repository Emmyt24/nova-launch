//! AMM constant-product pools (#559).
//!
//! Implements a minimal constant-product (`x * y = k`) AMM for pairs of
//! factory-registered tokens. LP shares are stored directly in contract
//! persistent storage; no separate LP-token contract is deployed.
//!
//! ## Design notes
//!
//! * Token pairs are always keyed by `(min_index, max_index)` so the key is
//!   canonical regardless of the direction a caller specifies.
//! * A 0.3 % swap fee is retained in the pool reserves, growing `k` on every
//!   swap and rewarding LPs.
//! * LP shares on the first deposit are set to `sqrt(amount_a * amount_b)`
//!   using an integer Newton-Raphson square-root; subsequent deposits are
//!   proportional to the existing reserves.
//! * All arithmetic uses `checked_*` operations and returns
//!   [`Error::ArithmeticError`] on overflow.

use crate::events;
use crate::storage;
use crate::types::{AddLiquidityResult, AmmPool, Error, SwapQuote};
use soroban_sdk::{Address, Env};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Swap fee numerator  (0.3 % = 997 / 1000).
const FEE_NUMERATOR: i128 = 997;
/// Swap fee denominator.
const FEE_DENOMINATOR: i128 = 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Integer square root via Newton-Raphson (floor).
/// Returns 0 for n = 0.
fn isqrt(n: i128) -> i128 {
    if n <= 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Apply the constant-product swap formula with a 0.3 % fee retained in the
/// pool.
///
/// Returns `(amount_out, new_reserve_in, new_reserve_out)`.
///
/// Formula:
/// ```text
/// amount_in_with_fee = amount_in * FEE_NUMERATOR
/// amount_out = (amount_in_with_fee * reserve_out)
///            / (reserve_in * FEE_DENOMINATOR + amount_in_with_fee)
/// ```
fn constant_product_out(
    amount_in: i128,
    reserve_in: i128,
    reserve_out: i128,
) -> Result<(i128, i128, i128), Error> {
    let amount_in_with_fee = amount_in
        .checked_mul(FEE_NUMERATOR)
        .ok_or(Error::ArithmeticError)?;

    let numerator = amount_in_with_fee
        .checked_mul(reserve_out)
        .ok_or(Error::ArithmeticError)?;

    let denominator = reserve_in
        .checked_mul(FEE_DENOMINATOR)
        .ok_or(Error::ArithmeticError)?
        .checked_add(amount_in_with_fee)
        .ok_or(Error::ArithmeticError)?;

    let amount_out = numerator
        .checked_div(denominator)
        .ok_or(Error::ArithmeticError)?;

    let new_reserve_in = reserve_in
        .checked_add(amount_in)
        .ok_or(Error::ArithmeticError)?;
    let new_reserve_out = reserve_out
        .checked_sub(amount_out)
        .ok_or(Error::ArithmeticError)?;

    Ok((amount_out, new_reserve_in, new_reserve_out))
}

// ── Public interface ──────────────────────────────────────────────────────────

/// Create a new constant-product AMM pool for the given token pair.
///
/// * `creator` – must be the factory admin or the creator of one of the tokens.
/// * `token_index_a` / `token_index_b` – factory indices of the two tokens;
///   must be distinct registered tokens.
///
/// The pool is created empty (no initial liquidity). Call
/// [`add_liquidity`] afterwards to seed it.
///
/// Returns `Ok(())` on success; errors if the pool already exists or
/// parameters are invalid.
pub fn create_pool(
    env: &Env,
    creator: Address,
    token_index_a: u32,
    token_index_b: u32,
) -> Result<(), Error> {
    creator.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    if token_index_a == token_index_b {
        return Err(Error::IdenticalTokens);
    }

    // Both tokens must exist.
    storage::get_token_info(env, token_index_a).ok_or(Error::TokenNotFound)?;
    storage::get_token_info(env, token_index_b).ok_or(Error::TokenNotFound)?;

    // Canonical key: lower index first.
    let (ka, kb) = storage::amm_canonical_pair(token_index_a, token_index_b);

    // Pool must not already exist.
    if storage::get_amm_pool(env, ka, kb).is_some() {
        return Err(Error::PoolAlreadyExists);
    }

    // Authorisation: admin or creator of either token.
    let admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if creator != admin {
        let token_a = storage::get_token_info(env, ka).ok_or(Error::TokenNotFound)?;
        let token_b = storage::get_token_info(env, kb).ok_or(Error::TokenNotFound)?;
        if creator != token_a.creator && creator != token_b.creator {
            return Err(Error::Unauthorized);
        }
    }

    let pool = AmmPool {
        token_index_a: ka,
        token_index_b: kb,
        reserve_a: 0,
        reserve_b: 0,
        total_shares: 0,
        created_at: env.ledger().timestamp(),
    };

    storage::set_amm_pool(env, &pool);
    storage::increment_amm_pool_count(env)?;

    events::emit_amm_pool_created(env, ka, kb, &creator);

    Ok(())
}

/// Add liquidity to an existing pool and receive LP shares.
///
/// * `provider` – the liquidity provider; must authorise the call.
/// * `amount_a` / `amount_b` – desired amounts to deposit.
///
/// On the **first deposit** (both reserves are zero), the exact amounts are
/// used and LP shares = `sqrt(amount_a * amount_b)`.
///
/// On **subsequent deposits** the amounts are adjusted to keep the existing
/// ratio, capping at the desired amounts. LP shares are proportional to the
/// increase in reserves.
///
/// Returns [`AddLiquidityResult`] with the actual amounts deposited and LP
/// shares minted.
pub fn add_liquidity(
    env: &Env,
    provider: Address,
    token_index_a: u32,
    token_index_b: u32,
    amount_a: i128,
    amount_b: i128,
) -> Result<AddLiquidityResult, Error> {
    provider.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    if amount_a <= 0 || amount_b <= 0 {
        return Err(Error::ZeroLiquidity);
    }

    let (ka, kb) = storage::amm_canonical_pair(token_index_a, token_index_b);
    // Flip the caller-supplied amounts to match canonical order.
    let (desired_a, desired_b) = if token_index_a == ka {
        (amount_a, amount_b)
    } else {
        (amount_b, amount_a)
    };

    let mut pool = storage::get_amm_pool(env, ka, kb).ok_or(Error::PoolNotFound)?;

    let (actual_a, actual_b, shares_minted) = if pool.total_shares == 0 {
        // First deposit: use exact amounts.
        let shares = isqrt(
            desired_a
                .checked_mul(desired_b)
                .ok_or(Error::ArithmeticError)?,
        );
        if shares == 0 {
            return Err(Error::ZeroLiquidity);
        }
        (desired_a, desired_b, shares)
    } else {
        // Subsequent deposits: preserve ratio, cap at desired amounts.
        // optimal_b = desired_a * reserve_b / reserve_a
        let optimal_b = desired_a
            .checked_mul(pool.reserve_b)
            .ok_or(Error::ArithmeticError)?
            .checked_div(pool.reserve_a)
            .ok_or(Error::ArithmeticError)?;

        let (act_a, act_b) = if optimal_b <= desired_b {
            (desired_a, optimal_b)
        } else {
            // optimal_a = desired_b * reserve_a / reserve_b
            let optimal_a = desired_b
                .checked_mul(pool.reserve_a)
                .ok_or(Error::ArithmeticError)?
                .checked_div(pool.reserve_b)
                .ok_or(Error::ArithmeticError)?;
            (optimal_a, desired_b)
        };

        if act_a <= 0 || act_b <= 0 {
            return Err(Error::ZeroLiquidity);
        }

        // shares_minted = total_shares * act_a / reserve_a
        let shares = pool
            .total_shares
            .checked_mul(act_a)
            .ok_or(Error::ArithmeticError)?
            .checked_div(pool.reserve_a)
            .ok_or(Error::ArithmeticError)?;

        if shares == 0 {
            return Err(Error::ZeroLiquidity);
        }

        (act_a, act_b, shares)
    };

    // Deduct from provider's internal balances.
    let bal_a = storage::get_balance(env, ka, &provider);
    if bal_a < actual_a {
        return Err(Error::InsufficientBalance);
    }
    storage::set_balance(
        env,
        ka,
        &provider,
        bal_a.checked_sub(actual_a).ok_or(Error::ArithmeticError)?,
    );

    let bal_b = storage::get_balance(env, kb, &provider);
    if bal_b < actual_b {
        return Err(Error::InsufficientBalance);
    }
    storage::set_balance(
        env,
        kb,
        &provider,
        bal_b.checked_sub(actual_b).ok_or(Error::ArithmeticError)?,
    );

    // Update reserves.
    pool.reserve_a = pool
        .reserve_a
        .checked_add(actual_a)
        .ok_or(Error::ArithmeticError)?;
    pool.reserve_b = pool
        .reserve_b
        .checked_add(actual_b)
        .ok_or(Error::ArithmeticError)?;
    pool.total_shares = pool
        .total_shares
        .checked_add(shares_minted)
        .ok_or(Error::ArithmeticError)?;

    storage::set_amm_pool(env, &pool);

    // Mint LP shares to provider.
    let prev_shares = storage::get_amm_shares(env, ka, kb, &provider);
    storage::set_amm_shares(
        env,
        ka,
        kb,
        &provider,
        prev_shares
            .checked_add(shares_minted)
            .ok_or(Error::ArithmeticError)?,
    );
    storage::set_amm_total_shares(env, ka, kb, pool.total_shares);

    events::emit_amm_liquidity_added(
        env,
        ka,
        kb,
        &provider,
        actual_a,
        actual_b,
        shares_minted,
    );

    Ok(AddLiquidityResult {
        shares_minted,
        amount_a: actual_a,
        amount_b: actual_b,
    })
}

/// Remove liquidity from a pool by burning LP shares.
///
/// * `provider` – must authorise the call and hold at least `shares` LP
///   shares in this pool.
/// * `shares` – number of LP shares to burn.
///
/// Returns `(amount_a, amount_b)` — the token amounts returned to the
/// provider.
pub fn remove_liquidity(
    env: &Env,
    provider: Address,
    token_index_a: u32,
    token_index_b: u32,
    shares: i128,
) -> Result<(i128, i128), Error> {
    provider.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    if shares <= 0 {
        return Err(Error::ZeroShares);
    }

    let (ka, kb) = storage::amm_canonical_pair(token_index_a, token_index_b);
    let mut pool = storage::get_amm_pool(env, ka, kb).ok_or(Error::PoolNotFound)?;

    if pool.total_shares == 0 {
        return Err(Error::InsufficientReserves);
    }

    let provider_shares = storage::get_amm_shares(env, ka, kb, &provider);
    if provider_shares < shares {
        return Err(Error::SharesExceedBalance);
    }

    // amount_x = shares * reserve_x / total_shares
    let out_a = shares
        .checked_mul(pool.reserve_a)
        .ok_or(Error::ArithmeticError)?
        .checked_div(pool.total_shares)
        .ok_or(Error::ArithmeticError)?;

    let out_b = shares
        .checked_mul(pool.reserve_b)
        .ok_or(Error::ArithmeticError)?
        .checked_div(pool.total_shares)
        .ok_or(Error::ArithmeticError)?;

    if out_a <= 0 || out_b <= 0 {
        return Err(Error::ZeroLiquidity);
    }

    // Burn shares.
    storage::set_amm_shares(
        env,
        ka,
        kb,
        &provider,
        provider_shares
            .checked_sub(shares)
            .ok_or(Error::ArithmeticError)?,
    );

    pool.total_shares = pool
        .total_shares
        .checked_sub(shares)
        .ok_or(Error::ArithmeticError)?;
    pool.reserve_a = pool
        .reserve_a
        .checked_sub(out_a)
        .ok_or(Error::ArithmeticError)?;
    pool.reserve_b = pool
        .reserve_b
        .checked_sub(out_b)
        .ok_or(Error::ArithmeticError)?;

    storage::set_amm_pool(env, &pool);
    storage::set_amm_total_shares(env, ka, kb, pool.total_shares);

    // Return tokens to provider.
    let bal_a = storage::get_balance(env, ka, &provider);
    storage::set_balance(
        env,
        ka,
        &provider,
        bal_a.checked_add(out_a).ok_or(Error::ArithmeticError)?,
    );

    let bal_b = storage::get_balance(env, kb, &provider);
    storage::set_balance(
        env,
        kb,
        &provider,
        bal_b.checked_add(out_b).ok_or(Error::ArithmeticError)?,
    );

    events::emit_amm_liquidity_removed(env, ka, kb, &provider, out_a, out_b, shares);

    Ok((out_a, out_b))
}

/// Swap an exact amount of one token for the other.
///
/// * `caller` – must authorise the call and hold at least `amount_in` of
///   `token_index_in`.
/// * `token_index_in` – the token being sold.
/// * `token_index_out` – the token being bought.
/// * `amount_in` – exact amount to sell.
/// * `min_amount_out` – slippage guard; the call fails with
///   [`Error::ZeroAmountOut`] if the output would be less than this.
///
/// Returns the amount of `token_index_out` received.
pub fn swap(
    env: &Env,
    caller: Address,
    token_index_in: u32,
    token_index_out: u32,
    amount_in: i128,
    min_amount_out: i128,
) -> Result<i128, Error> {
    caller.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    if amount_in <= 0 {
        return Err(Error::ZeroAmountIn);
    }
    if token_index_in == token_index_out {
        return Err(Error::IdenticalTokens);
    }

    let (ka, kb) = storage::amm_canonical_pair(token_index_in, token_index_out);
    let mut pool = storage::get_amm_pool(env, ka, kb).ok_or(Error::PoolNotFound)?;

    if pool.reserve_a == 0 || pool.reserve_b == 0 {
        return Err(Error::InsufficientReserves);
    }

    // Orient reserves to the direction of the swap.
    let (reserve_in, reserve_out) = if token_index_in == ka {
        (pool.reserve_a, pool.reserve_b)
    } else {
        (pool.reserve_b, pool.reserve_a)
    };

    let (amount_out, new_reserve_in, new_reserve_out) =
        constant_product_out(amount_in, reserve_in, reserve_out)?;

    if amount_out <= 0 {
        return Err(Error::ZeroAmountOut);
    }
    if amount_out < min_amount_out {
        return Err(Error::ZeroAmountOut);
    }

    // Deduct input token from caller.
    let bal_in = storage::get_balance(env, token_index_in, &caller);
    if bal_in < amount_in {
        return Err(Error::InsufficientBalance);
    }
    storage::set_balance(
        env,
        token_index_in,
        &caller,
        bal_in.checked_sub(amount_in).ok_or(Error::ArithmeticError)?,
    );

    // Credit output token to caller.
    let bal_out = storage::get_balance(env, token_index_out, &caller);
    storage::set_balance(
        env,
        token_index_out,
        &caller,
        bal_out
            .checked_add(amount_out)
            .ok_or(Error::ArithmeticError)?,
    );

    // Update pool reserves in canonical order.
    if token_index_in == ka {
        pool.reserve_a = new_reserve_in;
        pool.reserve_b = new_reserve_out;
    } else {
        pool.reserve_b = new_reserve_in;
        pool.reserve_a = new_reserve_out;
    }

    storage::set_amm_pool(env, &pool);

    events::emit_amm_swap(env, token_index_in, token_index_out, &caller, amount_in, amount_out);

    Ok(amount_out)
}

/// Quote a swap without modifying any state.
///
/// Returns a [`SwapQuote`] with the expected output and resulting reserves.
pub fn quote_swap(
    env: &Env,
    token_index_in: u32,
    token_index_out: u32,
    amount_in: i128,
) -> Result<SwapQuote, Error> {
    if amount_in <= 0 {
        return Err(Error::ZeroAmountIn);
    }
    if token_index_in == token_index_out {
        return Err(Error::IdenticalTokens);
    }

    let (ka, kb) = storage::amm_canonical_pair(token_index_in, token_index_out);
    let pool = storage::get_amm_pool(env, ka, kb).ok_or(Error::PoolNotFound)?;

    if pool.reserve_a == 0 || pool.reserve_b == 0 {
        return Err(Error::InsufficientReserves);
    }

    let (reserve_in, reserve_out) = if token_index_in == ka {
        (pool.reserve_a, pool.reserve_b)
    } else {
        (pool.reserve_b, pool.reserve_a)
    };

    let (amount_out, new_reserve_in, new_reserve_out) =
        constant_product_out(amount_in, reserve_in, reserve_out)?;

    if amount_out <= 0 {
        return Err(Error::ZeroAmountOut);
    }

    Ok(SwapQuote {
        amount_out,
        new_reserve_in,
        new_reserve_out,
    })
}

/// Fetch a pool's current state.
pub fn get_pool(env: &Env, token_index_a: u32, token_index_b: u32) -> Option<AmmPool> {
    let (ka, kb) = storage::amm_canonical_pair(token_index_a, token_index_b);
    storage::get_amm_pool(env, ka, kb)
}

/// Fetch a provider's LP share balance in a pool (0 if none).
pub fn get_shares(env: &Env, token_index_a: u32, token_index_b: u32, provider: &Address) -> i128 {
    let (ka, kb) = storage::amm_canonical_pair(token_index_a, token_index_b);
    storage::get_amm_shares(env, ka, kb, provider)
}
