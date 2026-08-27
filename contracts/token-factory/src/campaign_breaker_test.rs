//! Buyback campaign circuit breaker & governance emergency halt tests (#577).
//!
//! Covers the three automatic trigger conditions (volatility spikes,
//! failed-settlement streaks, oracle divergence), the governance-controlled
//! `emergency_halt_campaign` / `clear_emergency_halt` path, unauthorized
//! attempts, and the safe recovery flow.
//!
//! State-changing calls go through `TokenFactoryClient` so every invocation
//! gets its own authorization frame, mirroring real call flow.
//!
//! Soroban SDK conventions used here:
//! - `client.foo(...)` returns the raw type directly and panics on error.
//!   Used for all success-path calls.
//! - `client.try_foo(...)` returns `Result<T, InvokeError<Error>>`.
//!   `try_foo(...).unwrap_err().unwrap()` extracts the inner `Error` value
//!   for negative-path assertions (same pattern as negative_tests.rs).
//! - `env.events().all()` only reflects events from the MOST RECENT top-level
//!   invocation. Event assertions must come immediately after the emitting
//!   call, before any subsequent client calls reset the event buffer.

#![cfg(test)]

use super::*;
use crate::campaign_breaker;
use crate::storage;
use crate::types::{
    BuybackCampaign, CampaignBreakerConfig, CampaignHaltReason, CampaignStatus, Error,
};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, Env, Symbol, TryFromVal, Val,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Registers the contract and configures governance.
/// Returns (env, governance_address, contract_id).
fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, crate::TokenFactory);
    let governance = Address::generate(&env);
    env.as_contract(&contract_id, || {
        storage::set_governance(&env, &governance);
    });
    (env, governance, contract_id)
}

fn setup_without_governance() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, crate::TokenFactory);
    (env, contract_id)
}

fn seed_campaign(env: &Env, contract_id: &Address, campaign_id: u64, owner: &Address) {
    let campaign = BuybackCampaign {
        id: campaign_id,
        token_index: 0,
        budget: 1_000_000_000,
        spent: 0,
        tokens_bought: 0,
        execution_count: 0,
        start_time: 0,
        end_time: u64::MAX,
        min_interval: 0,
        max_slippage_bps: 100,
        source_token: Address::generate(env),
        target_token: Address::generate(env),
        owner: owner.clone(),
        status: CampaignStatus::Active,
        created_at: 0,
        updated_at: 0,
        trigger_price: 0,
        last_executed_at: 0,
    };
    env.as_contract(contract_id, || {
        storage::set_campaign(env, campaign_id, &campaign);
    });
}

/// Check whether any event with the given first-topic symbol was emitted in
/// the CURRENT invocation's event buffer.
///
/// Must be called immediately after the client call that should emit the event,
/// before any subsequent client call resets `env.events().all()`.
fn has_event(env: &Env, name: &str) -> bool {
    use soroban_sdk::xdr::ContractEventBody;
    let target = Symbol::new(env, name);
    env.events().all().events().iter().any(|event| {
        let ContractEventBody::V0(v0) = &event.body;
        v0.topics
            .iter()
            .filter_map(|t| Val::try_from_val(env, t).ok())
            .any(|val| {
                Symbol::try_from_val(env, &val)
                    .map(|s| s == target)
                    .unwrap_or(false)
            })
    })
}

fn advance_time(env: &Env, seconds: u64) {
    env.ledger().with_mut(|li| li.timestamp += seconds);
}

fn default_config() -> CampaignBreakerConfig {
    CampaignBreakerConfig {
        volatility_threshold_bps: campaign_breaker::DEFAULT_VOLATILITY_THRESHOLD_BPS,
        max_consecutive_failures: campaign_breaker::DEFAULT_MAX_CONSECUTIVE_FAILURES,
        divergence_threshold_bps: campaign_breaker::DEFAULT_DIVERGENCE_THRESHOLD_BPS,
    }
}

// ── Governance emergency halt path ───────────────────────────────────────────

#[test]
fn test_governance_can_emergency_halt_and_clear() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    // Successful halt — plain client call panics on error
    client.emergency_halt_campaign(&governance, &1, &CampaignHaltReason::GovernanceManual);
    // Event check must come immediately after the emitting call
    assert!(
        has_event(&env, "cmp_hlt"),
        "cmp_hlt event must be emitted on halt"
    );

    assert!(client.is_campaign_halted(&1));

    let state = client.get_campaign_breaker_state(&1).unwrap();
    assert_eq!(state.reason, CampaignHaltReason::GovernanceManual);
    assert_eq!(state.halted_by, Some(governance.clone()));
    assert_eq!(state.halted_at, env.ledger().timestamp());

    // Safe recovery flow
    advance_time(&env, 100);
    client.clear_emergency_halt(&governance, &1);
    // Event check immediately after the emitting call
    assert!(
        has_event(&env, "cmp_uhlt"),
        "cmp_uhlt event must be emitted on clear"
    );

    assert!(!client.is_campaign_halted(&1));
    // Clean-slate recovery removes the overlay entirely
    assert_eq!(client.get_campaign_breaker_state(&1), None);
}

#[test]
fn test_unauthorized_halt_rejected() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    let attacker = Address::generate(&env);
    // try_* + .unwrap_err().unwrap() is the standard Soroban error-extraction pattern
    let err = client
        .try_emergency_halt_campaign(&attacker, &1, &CampaignHaltReason::GovernanceManual)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Unauthorized);

    // Nothing was halted by the unauthorized attempt
    assert!(!client.is_campaign_halted(&1));
}

#[test]
fn test_halt_requires_configured_governance() {
    let (env, cid) = setup_without_governance();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    let caller = Address::generate(&env);
    let err = client
        .try_emergency_halt_campaign(&caller, &1, &CampaignHaltReason::GovernanceManual)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Unauthorized);
}

#[test]
fn test_halt_unknown_campaign_rejected() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let err = client
        .try_emergency_halt_campaign(&governance, &999, &CampaignHaltReason::GovernanceManual)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::CampaignNotFound);
}

#[test]
fn test_double_halt_preserves_original_audit_trail() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    client.emergency_halt_campaign(&governance, &1, &CampaignHaltReason::VolatilitySpike);
    let original = client.get_campaign_breaker_state(&1).unwrap();

    advance_time(&env, 5_000);
    let err = client
        .try_emergency_halt_campaign(
            &governance,
            &1,
            &CampaignHaltReason::SettlementFailureStreak,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::CampaignAlreadyPaused);

    // First halt wins — audit fields are tamper-resistant
    let after = client.get_campaign_breaker_state(&1).unwrap();
    assert_eq!(after, original);
    assert_eq!(after.reason, CampaignHaltReason::VolatilitySpike);
}

#[test]
fn test_clear_when_not_halted_rejected() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    let err = client
        .try_clear_emergency_halt(&governance, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::CampaignNotPaused);
}

#[test]
fn test_clear_unknown_campaign_rejected() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let err = client
        .try_clear_emergency_halt(&governance, &42)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::CampaignNotFound);
}

#[test]
fn test_unauthorized_clear_rejected() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    client.emergency_halt_campaign(&governance, &1, &CampaignHaltReason::GovernanceManual);

    let attacker = Address::generate(&env);
    let err = client
        .try_clear_emergency_halt(&attacker, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Unauthorized);
    assert!(client.is_campaign_halted(&1));
}

#[test]
fn test_reads_and_queries_preserved_while_halted() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 7, &owner);

    client.emergency_halt_campaign(&governance, &7, &CampaignHaltReason::OracleDivergence);

    // Read/query behavior is fully preserved during a halt
    let campaign = env.as_contract(&cid, || storage::get_campaign(&env, 7).unwrap());
    assert_eq!(campaign.id, 7);
    assert_eq!(campaign.status, CampaignStatus::Active);
    assert!(client.is_campaign_halted(&7));
    assert!(client.get_campaign_breaker_state(&7).is_some());
}

// ── Execution guard ──────────────────────────────────────────────────────────

#[test]
fn test_execution_guard_blocks_only_halted_campaigns() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    // Trip via failure streak (each client call is its own auth frame)
    for _ in 0..3 {
        client.record_settlement_outcome(&owner, &1, &false);
    }

    env.as_contract(&cid, || {
        assert_eq!(
            campaign_breaker::ensure_execution_allowed(&env, 1),
            Err(Error::CampaignEmergencyHalted)
        );
        assert_eq!(campaign_breaker::ensure_execution_allowed(&env, 2), Ok(()));
    });

    // Recovery restores execution
    client.clear_emergency_halt(&governance, &1);
    env.as_contract(&cid, || {
        assert_eq!(campaign_breaker::ensure_execution_allowed(&env, 1), Ok(()));
    });
    assert_eq!(client.get_campaign_breaker_state(&1), None);
}

// ── Trigger 1: volatility spikes ─────────────────────────────────────────────

#[test]
fn test_volatility_spike_trips_breaker() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    // +30% between observations vs. 20% default threshold
    // First observation — no previous price; cannot trip
    assert!(!client.report_campaign_price(&owner, &1, &1_000_000));

    // Second observation — 30% spike trips the breaker
    let tripped = client.report_campaign_price(&owner, &1, &1_300_000);
    // Check event immediately after the emitting call
    assert!(
        has_event(&env, "cmp_trp"),
        "cmp_trp event must be emitted on breaker trip"
    );
    assert!(tripped);

    assert!(client.is_campaign_halted(&1));
    let state = client.get_campaign_breaker_state(&1).unwrap();
    assert_eq!(state.reason, CampaignHaltReason::VolatilitySpike);
    // Automatic trips carry no manual halting address
    assert_eq!(state.halted_by, None);
}

#[test]
fn test_price_move_within_threshold_does_not_trip() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    // 10% move is within the default 20% threshold
    assert!(!client.report_campaign_price(&owner, &1, &1_000_000));
    assert!(!client.report_campaign_price(&owner, &1, &1_100_000));
    assert!(!client.is_campaign_halted(&1));
}

#[test]
fn test_downward_spike_also_trips() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    client.report_campaign_price(&owner, &1, &1_000_000);
    // -30% crash is as dangerous as a pump
    assert!(client.report_campaign_price(&owner, &1, &700_000));
    assert!(client.is_campaign_halted(&1));
    assert_eq!(
        client.get_campaign_breaker_state(&1).unwrap().reason,
        CampaignHaltReason::VolatilitySpike
    );
}

#[test]
fn test_non_positive_price_rejected() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    assert_eq!(
        client
            .try_report_campaign_price(&owner, &1, &0)
            .unwrap_err()
            .unwrap(),
        Error::InvalidParameters
    );
    assert_eq!(
        client
            .try_report_campaign_price(&owner, &1, &-5)
            .unwrap_err()
            .unwrap(),
        Error::InvalidParameters
    );
}

// ── Trigger 2: settlement failure streaks ────────────────────────────────────

#[test]
fn test_settlement_failure_streak_trips_after_threshold() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    // Two failures — not yet at the limit of 3
    for _ in 0..2 {
        assert!(!client.record_settlement_outcome(&owner, &1, &false));
    }
    assert!(!client.is_campaign_halted(&1));

    // Third consecutive failure trips at the default limit of 3
    let tripped = client.record_settlement_outcome(&owner, &1, &false);
    // Check event immediately after the emitting call
    assert!(
        has_event(&env, "cmp_trp"),
        "cmp_trp event must be emitted on streak trip"
    );
    assert!(tripped);
    assert!(client.is_campaign_halted(&1));

    let state = client.get_campaign_breaker_state(&1).unwrap();
    assert_eq!(state.reason, CampaignHaltReason::SettlementFailureStreak);
    assert_eq!(state.consecutive_failures, 3);
}

#[test]
fn test_successful_settlement_resets_streak() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    // Two failures, then a success resets the streak, then two more failures
    for outcome in [false, false, true, false, false] {
        assert!(!client.record_settlement_outcome(&owner, &1, &outcome));
    }
    assert!(!client.is_campaign_halted(&1));
    assert_eq!(
        client
            .get_campaign_breaker_state(&1)
            .unwrap()
            .consecutive_failures,
        2
    );
}

// ── Trigger 3: oracle divergence ─────────────────────────────────────────────

#[test]
fn test_oracle_divergence_trips_breaker() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    // Primary vs secondary sources diverge by ~20% vs. 10% threshold
    let tripped = client.report_oracle_prices(&owner, &1, &1_000_000, &1_200_000);
    assert!(tripped);
    assert!(client.is_campaign_halted(&1));
    assert_eq!(
        client.get_campaign_breaker_state(&1).unwrap().reason,
        CampaignHaltReason::OracleDivergence
    );
}

#[test]
fn test_oracle_divergence_within_threshold_does_not_trip() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    // 5% divergence is within the 10% default threshold
    assert!(!client.report_oracle_prices(&owner, &1, &1_000_000, &1_050_000));
    assert!(!client.is_campaign_halted(&1));
}

#[test]
fn test_zero_price_in_divergence_rejected() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    assert_eq!(
        client
            .try_report_oracle_prices(&owner, &1, &0, &1_000)
            .unwrap_err()
            .unwrap(),
        Error::InvalidParameters
    );
    assert_eq!(
        client
            .try_report_oracle_prices(&owner, &1, &1_000, &-1)
            .unwrap_err()
            .unwrap(),
        Error::InvalidParameters
    );
}

// ── Telemetry frozen while halted ────────────────────────────────────────────

#[test]
fn test_telemetry_frozen_while_halted() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    client.emergency_halt_campaign(&governance, &1, &CampaignHaltReason::GovernanceManual);

    // Telemetry reports are rejected so forensic halt state stays frozen
    assert_eq!(
        client
            .try_report_campaign_price(&owner, &1, &100)
            .unwrap_err()
            .unwrap(),
        Error::CampaignEmergencyHalted
    );
    assert_eq!(
        client
            .try_record_settlement_outcome(&owner, &1, &true)
            .unwrap_err()
            .unwrap(),
        Error::CampaignEmergencyHalted
    );
    assert_eq!(
        client
            .try_report_oracle_prices(&owner, &1, &100, &101)
            .unwrap_err()
            .unwrap(),
        Error::CampaignEmergencyHalted
    );
}

// ── Telemetry authorization ──────────────────────────────────────────────────

#[test]
fn test_reporter_must_be_owner_or_governance() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    let outsider = Address::generate(&env);
    assert_eq!(
        client
            .try_report_campaign_price(&outsider, &1, &100)
            .unwrap_err()
            .unwrap(),
        Error::Unauthorized
    );
    assert_eq!(
        client
            .try_record_settlement_outcome(&outsider, &1, &true)
            .unwrap_err()
            .unwrap(),
        Error::Unauthorized
    );

    // Governance may also report telemetry — first observation, no trip
    assert!(!client.report_campaign_price(&governance, &1, &100));
}

#[test]
fn test_report_for_unknown_campaign_rejected() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    assert_eq!(
        client
            .try_report_campaign_price(&governance, &99, &100)
            .unwrap_err()
            .unwrap(),
        Error::CampaignNotFound
    );
    assert_eq!(
        client
            .try_record_settlement_outcome(&governance, &99, &true)
            .unwrap_err()
            .unwrap(),
        Error::CampaignNotFound
    );
}

// ── Configuration ────────────────────────────────────────────────────────────

#[test]
fn test_default_config_when_unset() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    assert_eq!(client.get_campaign_breaker_config(), default_config());
}

#[test]
fn test_governance_can_set_config() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);

    client.set_campaign_breaker_config(&governance, &500, &5, &250);

    let stored = client.get_campaign_breaker_config();
    assert_eq!(stored.volatility_threshold_bps, 500);
    assert_eq!(stored.max_consecutive_failures, 5);
    assert_eq!(stored.divergence_threshold_bps, 250);
}

#[test]
fn test_unauthorized_config_change_rejected() {
    let (env, _governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let attacker = Address::generate(&env);
    let cfg = default_config();
    let err = client
        .try_set_campaign_breaker_config(
            &attacker,
            &cfg.volatility_threshold_bps,
            &cfg.max_consecutive_failures,
            &cfg.divergence_threshold_bps,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::Unauthorized);
}

#[test]
fn test_invalid_configs_rejected() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);

    for (volatility, failures, divergence) in [
        (0u32, 3u32, 1_000u32),
        (200_000, 3, 1_000),
        (2_000, 0, 1_000),
        (2_000, 5_000, 1_000),
        (2_000, 3, 0),
    ] {
        let err = client
            .try_set_campaign_breaker_config(&governance, &volatility, &failures, &divergence)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, Error::InvalidBreakerConfig);
    }
}

#[test]
fn test_custom_thresholds_apply_to_checks() {
    let (env, governance, cid) = setup();
    let client = TokenFactoryClient::new(&env, &cid);
    let owner = Address::generate(&env);
    seed_campaign(&env, &cid, 1, &owner);

    // Tighten volatility threshold to 5%
    client.set_campaign_breaker_config(&governance, &500, &3, &1_000);

    // First observation sets the baseline
    assert!(!client.report_campaign_price(&owner, &1, &1_000_000));
    // A 10% move trips the tightened 5% threshold (would pass the default 20%)
    assert!(client.report_campaign_price(&owner, &1, &1_100_000));
    assert!(client.is_campaign_halted(&1));
}

// ── Error-code stability for the new surface ─────────────────────────────────

#[test]
fn test_campaign_halt_error_codes_are_stable() {
    assert_eq!(Error::CampaignEmergencyHalted.0, 133);
    assert_eq!(Error::InvalidBreakerConfig.0, 134);
}
