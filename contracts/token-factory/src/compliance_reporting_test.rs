//! Compliance Reporting – fixture-based reconciliation tests
//!
//! These tests verify that `generate_report` correctly aggregates on-chain
//! storage state into its output fields.  All expected totals are
//! hand-computed from the fixture data below so a future refactor that
//! accidentally changes the aggregation logic will cause an assertion failure
//! here rather than silently producing wrong audit data.
//!
//! Two scenarios are covered:
//!
//! 1. **Known-fixture reconciliation** – seed the factory with a specific set
//!    of tokens whose `total_supply`, `total_burned`, and `burn_count` are
//!    chosen to make hand-computation easy and unambiguous.
//!
//! 2. **Zero-activity range** – an initialised factory with no tokens
//!    registered should produce a valid (empty) report, not an error.

#![cfg(test)]
extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Env, String as SorobanString};

use crate::{
    compliance_reporting::{generate_report, get_report},
    types::{DataKey, TokenInfo},
    TokenFactory, TokenFactoryClient,
};

// ─── constants ───────────────────────────────────────────────────────────────

const BASE_FEE: i128 = 100_000_000;    // 10 XLM in stroops
const METADATA_FEE: i128 = 50_000_000; //  5 XLM in stroops

// Fixture token values – hand-computed expected totals appear alongside each
// use so the arithmetic is obvious to a reader (and to an auditor).
//
// Token 0: total_supply =  1_000_000  total_burned =   100_000  burn_count =  2
// Token 1: total_supply =  5_000_000  total_burned =   500_000  burn_count =  5
// Token 2: total_supply = 10_000_000  total_burned = 1_000_000  burn_count = 10
//
// Expected totals:
//   total_supply   =  1_000_000 +  5_000_000 + 10_000_000 = 16_000_000
//   total_burned   =    100_000 +    500_000 +  1_000_000 =  1_600_000
//   total_burn_ops =          2 +          5 +         10 =         17
//   token_count    = 3

const FIXTURE_TOKEN_0_SUPPLY: i128 = 1_000_000;
const FIXTURE_TOKEN_0_BURNED: i128 = 100_000;
const FIXTURE_TOKEN_0_BURN_COUNT: u32 = 2;

const FIXTURE_TOKEN_1_SUPPLY: i128 = 5_000_000;
const FIXTURE_TOKEN_1_BURNED: i128 = 500_000;
const FIXTURE_TOKEN_1_BURN_COUNT: u32 = 5;

const FIXTURE_TOKEN_2_SUPPLY: i128 = 10_000_000;
const FIXTURE_TOKEN_2_BURNED: i128 = 1_000_000;
const FIXTURE_TOKEN_2_BURN_COUNT: u32 = 10;

// Hand-computed aggregate totals – these must equal the sum of the fixture
// values above.  They are kept as named constants so assertion messages are
// self-documenting.
const EXPECTED_TOTAL_SUPPLY: i128 =
    FIXTURE_TOKEN_0_SUPPLY + FIXTURE_TOKEN_1_SUPPLY + FIXTURE_TOKEN_2_SUPPLY; // 16_000_000
const EXPECTED_TOTAL_BURNED: i128 =
    FIXTURE_TOKEN_0_BURNED + FIXTURE_TOKEN_1_BURNED + FIXTURE_TOKEN_2_BURNED; // 1_600_000
const EXPECTED_TOTAL_BURN_OPS: u32 =
    FIXTURE_TOKEN_0_BURN_COUNT + FIXTURE_TOKEN_1_BURN_COUNT + FIXTURE_TOKEN_2_BURN_COUNT; // 17
const EXPECTED_TOKEN_COUNT: u32 = 3;

// ─── helpers ─────────────────────────────────────────────────────────────────

/// Deploy the factory and return `(contract_id, admin)`.
///
/// The factory is fully initialised (via `initialize`) so every internal
/// storage key that `generate_report` reads—admin, governance config, paused
/// flag—is present before the test body runs.
fn deploy_factory(env: &Env) -> (Address, Address) {
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    client.initialize(&admin, &treasury, &BASE_FEE, &METADATA_FEE);
    (contract_id, admin)
}

/// Build a minimal `TokenInfo` with deterministic supply/burned/burn_count.
///
/// All other fields are given plausible defaults that do not affect the
/// compliance report aggregation (they are never read by `generate_report`).
fn make_token_info(
    env: &Env,
    creator: &Address,
    total_supply: i128,
    total_burned: i128,
    burn_count: u32,
) -> TokenInfo {
    TokenInfo {
        address: Address::generate(env),
        creator: creator.clone(),
        name: SorobanString::from_str(env, "TestToken"),
        symbol: SorobanString::from_str(env, "TST"),
        decimals: 7,
        total_supply,
        initial_supply: total_supply + total_burned, // initial = remaining + burned
        max_supply: None,
        total_burned,
        burn_count,
        metadata_uri: None,
        metadata_version: 0,
        created_at: env.ledger().timestamp(),
        is_paused: false,
        clawback_enabled: false,
        freeze_enabled: false,
    }
}

/// Seed tokens directly into instance storage and update `TokenCount`.
///
/// Using direct storage writes keeps the fixture deterministic: we know
/// exactly which values end up in storage without relying on the full
/// `create_token` → `burn` flows (which involve fees, sub-contract wasm,
/// and other cross-cutting concerns that are irrelevant to this test).
fn seed_tokens(env: &Env, contract_id: &Address, infos: &[TokenInfo]) {
    env.as_contract(contract_id, || {
        for (i, info) in infos.iter().enumerate() {
            env.storage()
                .instance()
                .set(&DataKey::Token(i as u32), info);
        }
        // Update the authoritative token count so `aggregate_token_metrics`
        // iterates the correct range [0, token_count).
        env.storage()
            .instance()
            .set(&DataKey::TokenCount, &(infos.len() as u32));
    });
}

// ─── test 1: known-fixture reconciliation ────────────────────────────────────

/// Seed three tokens with known supply/burned/burn_count values, generate a
/// compliance report, and assert every aggregate field matches the
/// hand-computed expected total.
///
/// This is the core "does the report reconcile with storage" test.  If
/// `aggregate_token_metrics` is changed to skip a token, use the wrong range,
/// or perform arithmetic incorrectly, this test will detect the divergence.
#[test]
fn test_report_reconciles_with_known_fixture() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, admin) = deploy_factory(&env);

    // ── seed fixture ─────────────────────────────────────────────────────────
    let token_infos = [
        make_token_info(
            &env,
            &admin,
            FIXTURE_TOKEN_0_SUPPLY,
            FIXTURE_TOKEN_0_BURNED,
            FIXTURE_TOKEN_0_BURN_COUNT,
        ),
        make_token_info(
            &env,
            &admin,
            FIXTURE_TOKEN_1_SUPPLY,
            FIXTURE_TOKEN_1_BURNED,
            FIXTURE_TOKEN_1_BURN_COUNT,
        ),
        make_token_info(
            &env,
            &admin,
            FIXTURE_TOKEN_2_SUPPLY,
            FIXTURE_TOKEN_2_BURNED,
            FIXTURE_TOKEN_2_BURN_COUNT,
        ),
    ];
    seed_tokens(&env, &contract_id, &token_infos);

    // ── generate report ───────────────────────────────────────────────────────
    let report = env
        .as_contract(&contract_id, || generate_report(&env, &admin))
        .expect("generate_report must succeed for an authorised admin");

    // ── field-for-field assertions ────────────────────────────────────────────

    // Report IDs are 0-based; the first report ever generated has id = 0.
    assert_eq!(report.report_id, 0, "first report should have id 0");

    // The admin address captured in the report must match the caller.
    assert_eq!(
        report.generated_by, admin,
        "generated_by must equal the admin that triggered generation"
    );

    // token_count must reflect the number of tokens seeded.
    assert_eq!(
        report.token_count, EXPECTED_TOKEN_COUNT,
        "token_count mismatch: expected {EXPECTED_TOKEN_COUNT}, got {}",
        report.token_count
    );

    // total_supply is the sum of every token's current (post-burn) supply:
    //   1_000_000 + 5_000_000 + 10_000_000 = 16_000_000
    assert_eq!(
        report.total_supply, EXPECTED_TOTAL_SUPPLY,
        "total_supply mismatch: expected {EXPECTED_TOTAL_SUPPLY}, got {}",
        report.total_supply
    );

    // total_burned is the sum of every token's cumulative burned amount:
    //   100_000 + 500_000 + 1_000_000 = 1_600_000
    assert_eq!(
        report.total_burned, EXPECTED_TOTAL_BURNED,
        "total_burned mismatch: expected {EXPECTED_TOTAL_BURNED}, got {}",
        report.total_burned
    );

    // total_burn_ops is the sum of every token's burn operation count:
    //   2 + 5 + 10 = 17
    assert_eq!(
        report.total_burn_ops, EXPECTED_TOTAL_BURN_OPS,
        "total_burn_ops mismatch: expected {EXPECTED_TOTAL_BURN_OPS}, got {}",
        report.total_burn_ops
    );

    // The default governance config (set by `initialize`) is quorum=30, approval=51.
    assert_eq!(
        report.governance_quorum_percent, 30,
        "governance_quorum_percent should reflect the default initialisation config"
    );
    assert_eq!(
        report.governance_approval_percent, 51,
        "governance_approval_percent should reflect the default initialisation config"
    );

    // The factory was not paused when the report was generated.
    assert!(
        !report.contract_paused,
        "contract_paused should be false; the factory was never paused in this fixture"
    );

    // Round-trip: the stored report must be identical to what generate_report returned.
    let retrieved = env
        .as_contract(&contract_id, || get_report(&env, report.report_id))
        .expect("report should be persistently retrievable by its ID");
    assert_eq!(
        report, retrieved,
        "retrieved report must be byte-for-byte identical to the generated snapshot"
    );
}

// ─── test 2: zero-activity range ─────────────────────────────────────────────

/// When no tokens have been registered (factory just deployed, zero activity),
/// `generate_report` must return a valid report with zero aggregate values —
/// it must NOT return an error or panic.
///
/// This models the "zero-activity time range" requirement: querying a period
/// with no on-chain events should produce an empty-but-valid audit record.
#[test]
fn test_report_for_zero_activity_is_valid_not_error() {
    let env = Env::default();
    env.mock_all_auths();

    let (contract_id, admin) = deploy_factory(&env);

    // No tokens seeded — factory starts with TokenCount == 0 (the `initialize`
    // call does not create any tokens).

    let report = env
        .as_contract(&contract_id, || generate_report(&env, &admin))
        .expect("generate_report must not error on a factory with zero registered tokens");

    // ── identity assertions ────────────────────────────────────────────────

    assert_eq!(report.report_id, 0, "first report id should be 0");
    assert_eq!(
        report.generated_by, admin,
        "generated_by must capture the caller address"
    );

    // ── zero-value aggregate assertions ───────────────────────────────────
    //
    // With no tokens, every aggregate total must be zero.  Returning an error
    // or any non-zero value here would be incorrect behaviour.

    assert_eq!(
        report.token_count, 0,
        "token_count must be 0 when no tokens are registered"
    );
    assert_eq!(
        report.total_supply, 0,
        "total_supply must be 0 when no tokens are registered"
    );
    assert_eq!(
        report.total_burned, 0,
        "total_burned must be 0 when no tokens are registered"
    );
    assert_eq!(
        report.total_burn_ops, 0,
        "total_burn_ops must be 0 when no tokens are registered"
    );

    // Governance defaults still apply even with zero activity.
    assert_eq!(
        report.governance_quorum_percent, 30,
        "governance defaults should be present even for an empty factory"
    );
    assert_eq!(
        report.governance_approval_percent, 51,
        "governance defaults should be present even for an empty factory"
    );

    // Freshly deployed factory is not paused.
    assert!(
        !report.contract_paused,
        "a newly deployed, never-paused factory must report contract_paused = false"
    );

    // The zero-activity report must be persistable and retrievable just like
    // any other report; it is a valid append-only snapshot, not a null/sentinel.
    let retrieved = env
        .as_contract(&contract_id, || get_report(&env, report.report_id))
        .expect("zero-activity report must be retrievable by ID");
    assert_eq!(
        report, retrieved,
        "zero-activity report must survive a storage round-trip unchanged"
    );
}
