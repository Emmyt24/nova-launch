#![cfg(test)]
extern crate std;

//! # Gas Compute Thresholds — `gas_compute_thresholds.rs`
//!
//! Enforces CPU instruction budgets for critical contract operations.
//! Tests fail automatically when a measured cost exceeds its baseline threshold,
//! protecting the performance envelope across all key entrypoints.
//!
//! ## Operations Covered
//! - `create_token` — token deployment and registry storage
//! - `execute_change` — timelock governance execution
//! - `pause` / `unpause` — contract-level pause/resume
//! - `pause_token` / `unpause_token` — token-level pause/resume
//! - `get_token_stats` — compact stats query
//! - `get_token_info` — token detail query
//! - `get_state` — factory state query
//! - `get_token_count` — registry count query
//! - `is_paused` — pause state query
//!
//! ## Threshold Update Policy
//!
//! Thresholds may ONLY be raised via a PR that includes ALL of the following:
//!   1. Benchmark output proving the new measured values
//!      (`cargo test gas_compute -- --nocapture`)
//!   2. A written explanation of why the cost increased
//!   3. Sign-off from a maintainer with merge approval
//!
//! Thresholds must NEVER be raised speculatively.
//! Lower them whenever optimizations land.
//!
//! ## Running
//! ```
//! cargo test -p token-factory gas_compute -- --nocapture
//! ```

use soroban_sdk::{testutils::Address as _, Address, Env, String};
use crate::{TokenFactory, TokenFactoryClient};

// ── Baseline thresholds (CPU instructions) ────────────────────────────────────
//
// Established from benchmark observations on soroban-sdk 21.x.
// A 20% margin above observed median is applied to absorb minor variance.
//
// Operation                    Observed (approx)   Threshold (+20%)
// ──────────────────────────────────────────────────────────────────
const THRESHOLD_CREATE_TOKEN:    u64 = 6_000_000;
const THRESHOLD_EXECUTE_CHANGE:  u64 = 5_000_000;
const THRESHOLD_PAUSE:           u64 = 2_000_000;
const THRESHOLD_UNPAUSE:         u64 = 2_000_000;
const THRESHOLD_PAUSE_TOKEN:     u64 = 2_000_000;
const THRESHOLD_UNPAUSE_TOKEN:   u64 = 2_000_000;
const THRESHOLD_GET_TOKEN_STATS: u64 = 1_500_000;
const THRESHOLD_GET_TOKEN_INFO:  u64 = 1_500_000;
const THRESHOLD_GET_STATE:       u64 = 1_500_000;
const THRESHOLD_GET_TOKEN_COUNT: u64 = 1_000_000;
const THRESHOLD_IS_PAUSED:       u64 = 1_000_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Reset budget and measure CPU instructions for a single isolated operation.
fn measure_cpu<F: FnOnce()>(env: &Env, f: F) -> u64 {
    env.budget().reset_unlimited();
    env.budget().reset_default();
    f();
    env.budget().cpu_instruction_cost()
}

/// Assert CPU cost is within threshold, printing a clear diff on failure.
fn assert_threshold(operation: &str, measured: u64, threshold: u64) {
    std::println!(
        "[gas_compute] {:<35} measured={:>12}  threshold={:>12}  {}",
        operation,
        measured,
        threshold,
        if measured <= threshold { "OK" } else { "EXCEEDED" }
    );
    assert!(
        measured <= threshold,
        "GAS REGRESSION: '{}' used {} CPU instructions, \
         exceeding threshold of {} (+{} over limit). \
         See threshold update policy in gas_compute_thresholds.rs.",
        operation,
        measured,
        threshold,
        measured.saturating_sub(threshold),
    );
}

/// Deploy and initialize the factory, return (admin, client).
fn setup(env: &Env) -> (Address, Address, TokenFactoryClient) {
    let contract_id = env.register(TokenFactory, ());
    let client = TokenFactoryClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);
    (admin, contract_id, client)
}

/// Create a token and return its address.
fn create_test_token(
    env: &Env,
    client: &TokenFactoryClient,
    creator: &Address,
    suffix: &str,
) -> Address {
    client.create_token(
        creator,
        &String::from_str(env, &std::format!("Token {}", suffix)),
        &String::from_str(env, &std::format!("TK{}", suffix)),
        &7,
        &1_000_000_000,
        &None,
        &70_000_000,
    )
}

// ── Create ────────────────────────────────────────────────────────────────────

/// create_token() must not exceed THRESHOLD_CREATE_TOKEN CPU instructions.
#[test]
fn gas_compute_create_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, client) = setup(&env);
    let creator = Address::generate(&env);

    let cpu = measure_cpu(&env, || {
        client.create_token(
            &creator,
            &String::from_str(&env, "Compute Token"),
            &String::from_str(&env, "CPT"),
            &7,
            &1_000_000_000,
            &None,
            &70_000_000,
        );
    });

    assert_threshold("create_token", cpu, THRESHOLD_CREATE_TOKEN);
}

// ── Execute ───────────────────────────────────────────────────────────────────

/// execute_change() must not exceed THRESHOLD_EXECUTE_CHANGE CPU instructions.
/// Uses schedule_pause_update as the scheduled operation.
#[test]
fn gas_compute_execute_change() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _, client) = setup(&env);

    // Schedule a pause update (timelock)
    let change_id = client.schedule_pause_update(&admin, &true);

    // Advance ledger past timelock delay
    env.ledger().with_mut(|l| {
        l.timestamp += 86_400 + 1; // 24h + 1s
    });

    let cpu = measure_cpu(&env, || {
        let _ = client.try_execute_change(&change_id);
    });

    assert_threshold("execute_change", cpu, THRESHOLD_EXECUTE_CHANGE);
}

// ── Pause / Resume ────────────────────────────────────────────────────────────

/// pause() must not exceed THRESHOLD_PAUSE CPU instructions.
#[test]
fn gas_compute_pause() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _, client) = setup(&env);

    let cpu = measure_cpu(&env, || {
        client.pause(&admin);
    });

    assert_threshold("pause", cpu, THRESHOLD_PAUSE);
}

/// unpause() must not exceed THRESHOLD_UNPAUSE CPU instructions.
#[test]
fn gas_compute_unpause() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _, client) = setup(&env);

    client.pause(&admin);

    let cpu = measure_cpu(&env, || {
        client.unpause(&admin);
    });

    assert_threshold("unpause", cpu, THRESHOLD_UNPAUSE);
}

/// pause_token() must not exceed THRESHOLD_PAUSE_TOKEN CPU instructions.
#[test]
fn gas_compute_pause_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _, client) = setup(&env);
    let creator = Address::generate(&env);
    create_test_token(&env, &client, &creator, "A");

    let cpu = measure_cpu(&env, || {
        client.pause_token(&admin, &0_u32);
    });

    assert_threshold("pause_token", cpu, THRESHOLD_PAUSE_TOKEN);
}

/// unpause_token() must not exceed THRESHOLD_UNPAUSE_TOKEN CPU instructions.
#[test]
fn gas_compute_unpause_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _, client) = setup(&env);
    let creator = Address::generate(&env);
    create_test_token(&env, &client, &creator, "B");
    client.pause_token(&admin, &0_u32);

    let cpu = measure_cpu(&env, || {
        client.unpause_token(&admin, &0_u32);
    });

    assert_threshold("unpause_token", cpu, THRESHOLD_UNPAUSE_TOKEN);
}

// ── Queries ───────────────────────────────────────────────────────────────────

/// get_token_stats() must not exceed THRESHOLD_GET_TOKEN_STATS CPU instructions.
#[test]
fn gas_compute_get_token_stats() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, client) = setup(&env);
    let creator = Address::generate(&env);
    create_test_token(&env, &client, &creator, "C");

    let cpu = measure_cpu(&env, || {
        let _ = client.get_token_stats(&0_u32);
    });

    assert_threshold("get_token_stats", cpu, THRESHOLD_GET_TOKEN_STATS);
}

/// get_token_info() must not exceed THRESHOLD_GET_TOKEN_INFO CPU instructions.
#[test]
fn gas_compute_get_token_info() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, client) = setup(&env);
    let creator = Address::generate(&env);
    create_test_token(&env, &client, &creator, "D");

    let cpu = measure_cpu(&env, || {
        let _ = client.get_token_info(&0_u32);
    });

    assert_threshold("get_token_info", cpu, THRESHOLD_GET_TOKEN_INFO);
}

/// get_state() must not exceed THRESHOLD_GET_STATE CPU instructions.
#[test]
fn gas_compute_get_state() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, client) = setup(&env);

    let cpu = measure_cpu(&env, || {
        let _ = client.get_state();
    });

    assert_threshold("get_state", cpu, THRESHOLD_GET_STATE);
}

/// get_token_count() must not exceed THRESHOLD_GET_TOKEN_COUNT CPU instructions.
#[test]
fn gas_compute_get_token_count() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, client) = setup(&env);

    let cpu = measure_cpu(&env, || {
        let _ = client.get_token_count();
    });

    assert_threshold("get_token_count", cpu, THRESHOLD_GET_TOKEN_COUNT);
}

/// is_paused() must not exceed THRESHOLD_IS_PAUSED CPU instructions.
#[test]
fn gas_compute_is_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, client) = setup(&env);

    let cpu = measure_cpu(&env, || {
        let _ = client.is_paused();
    });

    assert_threshold("is_paused", cpu, THRESHOLD_IS_PAUSED);
}

// ── Full report ───────────────────────────────────────────────────────────────

/// Print a full compute threshold report for all entrypoints.
/// Run with: cargo test gas_compute_report -- --nocapture
#[test]
fn gas_compute_report() {
    let env = Env::default();
    env.mock_all_auths();

    let (admin, _, client) = setup(&env);
    let creator = Address::generate(&env);

    // create_token
    env.budget().reset_unlimited();
    create_test_token(&env, &client, &creator, "R1");
    let cpu_create = env.budget().cpu_instruction_cost();

    // pause / unpause
    let cpu_pause   = measure_cpu(&env, || { client.pause(&admin); });
    let cpu_unpause = measure_cpu(&env, || { client.unpause(&admin); });

    // token-level pause / unpause
    let cpu_pause_token   = measure_cpu(&env, || { client.pause_token(&admin, &0_u32); });
    let cpu_unpause_token = measure_cpu(&env, || { client.unpause_token(&admin, &0_u32); });

    // queries
    let cpu_stats  = measure_cpu(&env, || { let _ = client.get_token_stats(&0_u32); });
    let cpu_info   = measure_cpu(&env, || { let _ = client.get_token_info(&0_u32); });
    let cpu_state  = measure_cpu(&env, || { let _ = client.get_state(); });
    let cpu_count  = measure_cpu(&env, || { let _ = client.get_token_count(); });
    let cpu_paused = measure_cpu(&env, || { let _ = client.is_paused(); });

    std::println!();
    std::println!("Nova-Launch — Gas Compute Threshold Report");
    std::println!("{}", "=".repeat(75));
    std::println!(
        "{:<35} {:>14} {:>14} {:>8}",
        "Operation", "Measured", "Threshold", "Status"
    );
    std::println!("{}", "-".repeat(75));

    let rows: &[(&str, u64, u64)] = &[
        ("create_token",    cpu_create,       THRESHOLD_CREATE_TOKEN),
        ("pause",           cpu_pause,        THRESHOLD_PAUSE),
        ("unpause",         cpu_unpause,      THRESHOLD_UNPAUSE),
        ("pause_token",     cpu_pause_token,  THRESHOLD_PAUSE_TOKEN),
        ("unpause_token",   cpu_unpause_token,THRESHOLD_UNPAUSE_TOKEN),
        ("get_token_stats", cpu_stats,        THRESHOLD_GET_TOKEN_STATS),
        ("get_token_info",  cpu_info,         THRESHOLD_GET_TOKEN_INFO),
        ("get_state",       cpu_state,        THRESHOLD_GET_STATE),
        ("get_token_count", cpu_count,        THRESHOLD_GET_TOKEN_COUNT),
        ("is_paused",       cpu_paused,       THRESHOLD_IS_PAUSED),
    ];

    for (op, measured, threshold) in rows {
        let status = if measured <= threshold { "OK" } else { "EXCEEDED" };
        std::println!(
            "{:<35} {:>14} {:>14} {:>8}",
            op, measured, threshold, status
        );
        assert!(
            measured <= threshold,
            "GAS REGRESSION: '{}' exceeded threshold ({} > {})",
            op, measured, threshold
        );
    }

    std::println!("{}", "=".repeat(75));
    std::println!();
}
