//! Unit tests for the pull-model dividend distribution module (#1759).
//!
//! Covers the happy path plus the two areas the issue explicitly calls out
//! as common sources of bugs: double-claim prevention and the reclaim
//! deadline boundary.

#![cfg(test)]

use crate::types::Error;
use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
use soroban_sdk::{token, Address, Env, String};

// ── Test helpers ────────────────────────────────────────────────────────────

struct Fixture {
    env: Env,
    client_id: Address,
    admin: Address,
    treasury: Address,
    creator: Address,
    /// Payout asset used to fund distributions (distinct from the factory's
    /// own internally-tracked token whose holders receive dividends).
    asset: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    client.initialize(&admin, &treasury, &1_000_000_i128, &500_000_i128);

    // A real, transferable Stellar asset used as the dividend payout currency.
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let asset = sac.address();
    token::StellarAssetClient::new(&env, &asset).mint(&admin, &1_000_000_000_i128);

    Fixture {
        env,
        client_id: contract_id,
        admin,
        treasury,
        creator,
        asset,
    }
}

fn client(f: &Fixture) -> TokenFactoryClient {
    TokenFactoryClient::new(&f.env, &f.client_id)
}

/// Deploys a token whose `initial_supply` is minted to `f.creator`, and
/// returns its `token_index` (always `0` for the first token in a fresh
/// fixture).
fn create_token(f: &Fixture, initial_supply: i128) -> u32 {
    let c = client(f);
    c.create_token(
        &f.creator,
        &String::from_str(&f.env, "Dividend Token"),
        &String::from_str(&f.env, "DVT"),
        &7,
        &initial_supply,
        &None,
        &1_000_000_i128,
    );
    0
}

fn advance_ledger(env: &Env, by: u32) {
    let li = env.ledger().get();
    env.ledger().set(LedgerInfo {
        sequence_number: li.sequence_number + by,
        ..li
    });
}

// ── initiate_distribution ───────────────────────────────────────────────────

#[test]
fn initiate_distribution_success_records_atomic_snapshot() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);

    let current_ledger = f.env.ledger().sequence();
    let deadline = current_ledger + 100;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &500_000_i128, &deadline);

    assert_eq!(distribution_id, 1);

    let record = c.get_distribution(&distribution_id);
    assert_eq!(record.token_index, token_index);
    assert_eq!(record.asset, f.asset);
    assert_eq!(record.total_amount, 500_000_i128);
    assert_eq!(record.snapshot_ledger, current_ledger);
    assert_eq!(record.total_supply_at_snapshot, 1_000_i128);
    assert_eq!(record.claim_deadline_ledger, deadline);
    assert!(!record.reclaimed);

    // Funds are escrowed in the contract, not left with the admin.
    let asset_client = token::Client::new(&f.env, &f.asset);
    assert_eq!(asset_client.balance(&f.client_id), 500_000_i128);
}

#[test]
fn initiate_distribution_rejects_non_admin() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);
    let not_admin = Address::generate(&f.env);

    let deadline = f.env.ledger().sequence() + 100;
    let result =
        c.try_initiate_distribution(&not_admin, &token_index, &f.asset, &500_000_i128, &deadline);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn initiate_distribution_rejects_unknown_token() {
    let f = setup();
    let c = client(&f);
    let deadline = f.env.ledger().sequence() + 100;
    let result = c.try_initiate_distribution(&f.admin, &99u32, &f.asset, &500_000_i128, &deadline);
    assert_eq!(result, Err(Ok(Error::TokenNotFound)));
}

#[test]
fn initiate_distribution_rejects_non_positive_amount() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);
    let deadline = f.env.ledger().sequence() + 100;
    let result = c.try_initiate_distribution(&f.admin, &token_index, &f.asset, &0_i128, &deadline);
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn initiate_distribution_rejects_deadline_not_in_future() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);
    let current_ledger = f.env.ledger().sequence();
    let result = c.try_initiate_distribution(
        &f.admin,
        &token_index,
        &f.asset,
        &500_000_i128,
        &current_ledger,
    );
    assert_eq!(result, Err(Ok(Error::InvalidParameters)));
}

#[test]
fn initiate_distribution_rejects_zero_total_supply() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);

    // Burn the entire supply so total_supply drops to zero.
    c.burn(&f.creator, &token_index, &1_000_i128);

    let deadline = f.env.ledger().sequence() + 100;
    let result =
        c.try_initiate_distribution(&f.admin, &token_index, &f.asset, &500_000_i128, &deadline);
    assert_eq!(result, Err(Ok(Error::DistributionZeroSupply)));
}

// ── claim_dividend ───────────────────────────────────────────────────────────

#[test]
fn claim_dividend_pays_pro_rata_share() {
    let f = setup();
    let c = client(&f);
    // creator holds 100 (10%), holder_a holds 300 (30%), holder_b holds 600 (60%).
    let token_index = create_token(&f, 100_i128);
    let holder_a = Address::generate(&f.env);
    let holder_b = Address::generate(&f.env);
    c.mint(&f.creator, &token_index, &holder_a, &300_i128);
    c.mint(&f.creator, &token_index, &holder_b, &600_i128);

    let deadline = f.env.ledger().sequence() + 100;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &1_000_000_i128, &deadline);

    let claimed_a = c.claim_dividend(&holder_a, &distribution_id);
    let claimed_b = c.claim_dividend(&holder_b, &distribution_id);
    let claimed_creator = c.claim_dividend(&f.creator, &distribution_id);

    assert_eq!(claimed_a, 300_000_i128);
    assert_eq!(claimed_b, 600_000_i128);
    assert_eq!(claimed_creator, 100_000_i128);

    let asset_client = token::Client::new(&f.env, &f.asset);
    assert_eq!(asset_client.balance(&holder_a), 300_000_i128);
    assert_eq!(asset_client.balance(&holder_b), 600_000_i128);
    assert_eq!(asset_client.balance(&f.creator), 100_000_i128);
    assert_eq!(
        c.get_dividend_claimed_total(&distribution_id),
        1_000_000_i128
    );
}

#[test]
fn claim_dividend_prevents_double_claim() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);

    let deadline = f.env.ledger().sequence() + 100;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &500_000_i128, &deadline);

    let first = c.claim_dividend(&f.creator, &distribution_id);
    assert_eq!(first, 500_000_i128);
    assert!(c.has_claimed_dividend(&distribution_id, &f.creator));

    let second = c.try_claim_dividend(&f.creator, &distribution_id);
    assert_eq!(second, Err(Ok(Error::DistributionAlreadyClaimed)));

    // The second (failed) attempt must not have moved any more funds.
    let asset_client = token::Client::new(&f.env, &f.asset);
    assert_eq!(asset_client.balance(&f.creator), 500_000_i128);
}

#[test]
fn claim_dividend_rejects_after_deadline() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);

    let deadline = f.env.ledger().sequence() + 10;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &500_000_i128, &deadline);

    advance_ledger(&f.env, 11);

    let result = c.try_claim_dividend(&f.creator, &distribution_id);
    assert_eq!(result, Err(Ok(Error::DistributionWindowClosed)));
}

#[test]
fn claim_dividend_allowed_exactly_at_deadline() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);

    let deadline = f.env.ledger().sequence() + 10;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &500_000_i128, &deadline);

    advance_ledger(&f.env, 10);
    assert_eq!(f.env.ledger().sequence(), deadline);

    let claimed = c.claim_dividend(&f.creator, &distribution_id);
    assert_eq!(claimed, 500_000_i128);
}

#[test]
fn claim_dividend_rejects_unknown_distribution() {
    let f = setup();
    let c = client(&f);
    let result = c.try_claim_dividend(&f.creator, &999u32);
    assert_eq!(result, Err(Ok(Error::DistributionNotFound)));
}

#[test]
fn claim_dividend_rejects_zero_balance_holder() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);
    let outsider = Address::generate(&f.env);

    let deadline = f.env.ledger().sequence() + 100;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &500_000_i128, &deadline);

    let result = c.try_claim_dividend(&outsider, &distribution_id);
    assert_eq!(result, Err(Ok(Error::NothingToClaim)));
}

// ── reclaim_unclaimed ────────────────────────────────────────────────────────

#[test]
fn reclaim_unclaimed_rejects_before_deadline() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);

    let deadline = f.env.ledger().sequence() + 100;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &500_000_i128, &deadline);

    let result = c.try_reclaim_unclaimed(&f.admin, &distribution_id);
    assert_eq!(result, Err(Ok(Error::DistributionWindowOpen)));
}

#[test]
fn reclaim_unclaimed_rejects_non_admin() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);
    let not_admin = Address::generate(&f.env);

    let deadline = f.env.ledger().sequence() + 10;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &500_000_i128, &deadline);
    advance_ledger(&f.env, 11);

    let result = c.try_reclaim_unclaimed(&not_admin, &distribution_id);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn reclaim_unclaimed_recovers_only_the_remainder() {
    let f = setup();
    let c = client(&f);
    // creator holds 400 (40%), holder holds 600 (60%).
    let token_index = create_token(&f, 400_i128);
    let holder = Address::generate(&f.env);
    c.mint(&f.creator, &token_index, &holder, &600_i128);

    let deadline = f.env.ledger().sequence() + 10;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &1_000_000_i128, &deadline);

    // Only the 60% holder claims; the creator's 40% share goes unclaimed.
    c.claim_dividend(&holder, &distribution_id);

    advance_ledger(&f.env, 11);

    let treasury_before = token::Client::new(&f.env, &f.asset).balance(&f.treasury);
    let reclaimed = c.reclaim_unclaimed(&f.admin, &distribution_id);
    assert_eq!(reclaimed, 400_000_i128);

    let asset_client = token::Client::new(&f.env, &f.asset);
    assert_eq!(
        asset_client.balance(&f.treasury),
        treasury_before + 400_000_i128
    );

    let record = c.get_distribution(&distribution_id);
    assert!(record.reclaimed);
}

#[test]
fn reclaim_unclaimed_prevents_double_reclaim() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);

    let deadline = f.env.ledger().sequence() + 10;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &500_000_i128, &deadline);
    advance_ledger(&f.env, 11);

    let first = c.reclaim_unclaimed(&f.admin, &distribution_id);
    assert_eq!(first, 500_000_i128);

    let treasury_balance_after_first = token::Client::new(&f.env, &f.asset).balance(&f.treasury);

    let second = c.try_reclaim_unclaimed(&f.admin, &distribution_id);
    assert_eq!(second, Err(Ok(Error::DistributionAlreadyReclaimed)));

    // No additional funds should have moved on the rejected second attempt.
    assert_eq!(
        token::Client::new(&f.env, &f.asset).balance(&f.treasury),
        treasury_balance_after_first
    );
}

#[test]
fn claim_after_reclaim_window_still_rejected_even_if_unreclaimed() {
    // A holder cannot sneak in a claim after the deadline just because the
    // admin hasn't called reclaim_unclaimed yet.
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);

    let deadline = f.env.ledger().sequence() + 10;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &500_000_i128, &deadline);
    advance_ledger(&f.env, 11);

    let result = c.try_claim_dividend(&f.creator, &distribution_id);
    assert_eq!(result, Err(Ok(Error::DistributionWindowClosed)));

    // Reclaim still works and recovers the full amount, since nothing was claimed.
    let reclaimed = c.reclaim_unclaimed(&f.admin, &distribution_id);
    assert_eq!(reclaimed, 500_000_i128);
}

// ── pause interaction ────────────────────────────────────────────────────────

#[test]
fn initiate_and_claim_rejected_while_paused() {
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_000_i128);

    let deadline = f.env.ledger().sequence() + 100;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &500_000_i128, &deadline);

    c.pause(&f.admin);

    let init_result =
        c.try_initiate_distribution(&f.admin, &token_index, &f.asset, &1_i128, &deadline);
    assert_eq!(init_result, Err(Ok(Error::ContractPaused)));

    let claim_result = c.try_claim_dividend(&f.creator, &distribution_id);
    assert_eq!(claim_result, Err(Ok(Error::ContractPaused)));
}

// ── rounding / dust ──────────────────────────────────────────────────────────

#[test]
fn pro_rata_rounding_never_overpays_the_pool() {
    // 3 equal-ish holders splitting an amount that doesn't divide evenly by
    // the total supply — per-share rounding must never let total claims
    // exceed the funded pool.
    let f = setup();
    let c = client(&f);
    let token_index = create_token(&f, 1_i128); // creator holds 1 unit
    let holder_a = Address::generate(&f.env);
    let holder_b = Address::generate(&f.env);
    c.mint(&f.creator, &token_index, &holder_a, &1_i128);
    c.mint(&f.creator, &token_index, &holder_b, &1_i128);
    // total supply = 3, total_amount not evenly divisible by 3.

    let deadline = f.env.ledger().sequence() + 10;
    let distribution_id =
        c.initiate_distribution(&f.admin, &token_index, &f.asset, &100_i128, &deadline);

    let a = c.claim_dividend(&f.creator, &distribution_id);
    let b = c.claim_dividend(&holder_a, &distribution_id);
    let d = c.claim_dividend(&holder_b, &distribution_id);

    assert_eq!(a, 33_i128);
    assert_eq!(b, 33_i128);
    assert_eq!(d, 33_i128);
    assert!(a + b + d <= 100_i128);

    advance_ledger(&f.env, 11);
    let dust = c.reclaim_unclaimed(&f.admin, &distribution_id);
    assert_eq!(dust, 1_i128);
    assert_eq!(a + b + d + dust, 100_i128);
}
