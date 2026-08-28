//! Multi-epoch integration tests for pull-model dividend distribution (#1759).
//!
//! Exercises `initiate_distribution` / `claim_dividend` / `reclaim_unclaimed`
//! across several independent distribution rounds ("epochs") against a token
//! whose holder balances change between rounds, to verify:
//! * each round's pro-rata snapshot is scoped to its own `snapshot_ledger`
//!   and `total_supply_at_snapshot`, independent of later balance changes;
//! * double-claim prevention is per-distribution, not global to a holder;
//! * the reclaim deadline is enforced independently per round.

use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
use soroban_sdk::{token, Address, Env, String};
use token_factory::{TokenFactory, TokenFactoryClient};

struct World {
    env: Env,
    contract_id: Address,
    admin: Address,
    treasury: Address,
    creator: Address,
    asset: Address,
}

fn setup() -> World {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    client.initialize(&admin, &treasury, &1_000_000_i128, &500_000_i128);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let asset = sac.address();
    token::StellarAssetClient::new(&env, &asset).mint(&admin, &10_000_000_i128);

    World {
        env,
        contract_id,
        admin,
        treasury,
        creator,
        asset,
    }
}

fn client(w: &World) -> TokenFactoryClient {
    TokenFactoryClient::new(&w.env, &w.contract_id)
}

fn advance_ledger(env: &Env, by: u32) {
    let li = env.ledger().get();
    env.ledger().set(LedgerInfo {
        sequence_number: li.sequence_number + by,
        ..li
    });
}

#[test]
fn multi_epoch_distributions_use_independent_snapshots_and_claim_state() {
    let w = setup();
    let c = client(&w);

    // ── Setup: token with two initial holders ──────────────────────────────
    c.create_token(
        &w.creator,
        &String::from_str(&w.env, "Epoch Token"),
        &String::from_str(&w.env, "EPT"),
        &7,
        &600_i128, // creator holds 600
        &None,
        &1_000_000_i128,
    );
    let token_index = 0u32;

    let holder_a = Address::generate(&w.env);
    c.mint(&w.creator, &token_index, &holder_a, &400_i128); // holder_a holds 400
                                                            // total supply after setup: 1000 (creator 60%, holder_a 40%)

    // ── Epoch 1 ──────────────────────────────────────────────────────────
    let deadline_1 = w.env.ledger().sequence() + 10;
    let dist_1 = c.initiate_distribution(
        &w.admin,
        &token_index,
        &w.asset,
        &1_000_000_i128,
        &deadline_1,
    );

    let record_1 = c.get_distribution(&dist_1);
    assert_eq!(record_1.total_supply_at_snapshot, 1_000_i128);

    let claimed_a_epoch1 = c.claim_dividend(&holder_a, &dist_1);
    assert_eq!(claimed_a_epoch1, 400_000_i128);

    // Double-claim within the same epoch is rejected.
    let double_claim = c.try_claim_dividend(&holder_a, &dist_1);
    assert!(
        double_claim.is_err(),
        "double claim within an epoch must be rejected"
    );

    // Creator never claims epoch 1 — let the window close and reclaim.
    advance_ledger(&w.env, 11);
    assert!(w.env.ledger().sequence() > deadline_1);

    let claim_after_deadline = c.try_claim_dividend(&w.creator, &dist_1);
    assert!(
        claim_after_deadline.is_err(),
        "claim after the deadline must be rejected"
    );

    let reclaimed_1 = c.reclaim_unclaimed(&w.admin, &dist_1);
    assert_eq!(reclaimed_1, 600_000_i128); // creator's unclaimed 60% share

    // A second reclaim on the same (now-settled) round must be rejected.
    let double_reclaim = c.try_reclaim_unclaimed(&w.admin, &dist_1);
    assert!(double_reclaim.is_err(), "double reclaim must be rejected");

    // ── Balances shift between epochs ───────────────────────────────────
    let holder_b = Address::generate(&w.env);
    c.mint(&w.creator, &token_index, &holder_b, &1_000_i128);
    // total supply now: 2000 (creator 600 = 30%, holder_a 400 = 20%, holder_b 1000 = 50%)

    // ── Epoch 2: independent snapshot, independent claim state ─────────────
    let deadline_2 = w.env.ledger().sequence() + 10;
    let dist_2 = c.initiate_distribution(
        &w.admin,
        &token_index,
        &w.asset,
        &2_000_000_i128,
        &deadline_2,
    );

    let record_2 = c.get_distribution(&dist_2);
    assert_ne!(record_2.snapshot_ledger, record_1.snapshot_ledger);
    assert_eq!(record_2.total_supply_at_snapshot, 2_000_i128);

    // holder_a already claimed epoch 1 but has NOT claimed epoch 2 — must succeed,
    // proving claim-settled state is scoped per distribution_id, not per holder.
    assert!(c.has_claimed_dividend(&dist_1, &holder_a));
    assert!(!c.has_claimed_dividend(&dist_2, &holder_a));

    let claimed_a_epoch2 = c.claim_dividend(&holder_a, &dist_2);
    assert_eq!(claimed_a_epoch2, 400_000_i128); // 20% of 2_000_000

    let claimed_b_epoch2 = c.claim_dividend(&holder_b, &dist_2);
    assert_eq!(claimed_b_epoch2, 1_000_000_i128); // 50% of 2_000_000

    let claimed_creator_epoch2 = c.claim_dividend(&w.creator, &dist_2);
    assert_eq!(claimed_creator_epoch2, 600_000_i128); // 30% of 2_000_000

    assert_eq!(c.get_dividend_claimed_total(&dist_2), 2_000_000_i128);

    // Everyone claimed epoch 2 in full, so the deadline passing leaves nothing
    // to reclaim.
    advance_ledger(&w.env, 11);
    let reclaimed_2 = c.reclaim_unclaimed(&w.admin, &dist_2);
    assert_eq!(reclaimed_2, 0_i128);

    // ── Final asset accounting sanity check ─────────────────────────────
    let asset_client = token::Client::new(&w.env, &w.asset);
    assert_eq!(asset_client.balance(&holder_a), 400_000_i128 + 400_000_i128);
    assert_eq!(asset_client.balance(&holder_b), 1_000_000_i128);
    assert_eq!(asset_client.balance(&w.creator), 600_000_i128);
    assert_eq!(asset_client.balance(&w.treasury), 600_000_i128); // reclaimed_1 only
    assert_eq!(asset_client.balance(&w.contract_id), 0_i128); // fully drained
}

#[test]
fn distribution_count_and_lookup_are_stable_across_epochs() {
    let w = setup();
    let c = client(&w);

    c.create_token(
        &w.creator,
        &String::from_str(&w.env, "Epoch Token"),
        &String::from_str(&w.env, "EPT"),
        &7,
        &1_000_i128,
        &None,
        &1_000_000_i128,
    );
    let token_index = 0u32;

    assert_eq!(c.get_distribution_count(), 0);

    let deadline = w.env.ledger().sequence() + 10;
    let dist_1 = c.initiate_distribution(&w.admin, &token_index, &w.asset, &100_i128, &deadline);
    let dist_2 = c.initiate_distribution(&w.admin, &token_index, &w.asset, &200_i128, &deadline);

    assert_eq!(c.get_distribution_count(), 2);
    assert_ne!(dist_1, dist_2);

    // Querying a never-created round fails cleanly rather than returning a
    // default/zeroed record.
    let missing = c.try_get_distribution(&999u32);
    assert!(missing.is_err(), "unknown distribution id must error");
}
