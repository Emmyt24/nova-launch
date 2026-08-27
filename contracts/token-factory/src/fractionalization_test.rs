//! Fractionalization Entry Point Tests
//!
//! Covers `fractionalize` / `redeem_fractional_asset` / status queries at
//! the contract entry-point level (via `TokenFactoryClient`), matching the
//! acceptance criteria: fractionalize/redeem happy path, double
//! fractionalization rejection, unauthorized redemption, asset-uniqueness
//! enforcement, and partial-shares redemption rejection.
//!
//! The locked "unique asset" is a real Stellar Asset Contract instance
//! registered via `Env::register_stellar_asset_contract_v2`, exercised
//! through the standard `soroban_sdk::token` client — the same mechanism
//! this crate already uses for real token custody in `vault.rs`.

#![cfg(test)]

use crate::types::{Error, FractionalStatus, FractionalizationParams};
use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address, BytesN, Env, String};

const BASE_FEE: i128 = 70_000_000;
const METADATA_FEE: i128 = 30_000_000;

struct TestCtx {
    env: Env,
    contract_id: Address,
    owner: Address,
    asset_contract: Address,
    asset_id: BytesN<32>,
}

impl TestCtx {
    fn client(&self) -> TokenFactoryClient<'_> {
        TokenFactoryClient::new(&self.env, &self.contract_id)
    }

    fn params(&self, total_supply: i128) -> FractionalizationParams {
        FractionalizationParams {
            asset_id: self.asset_id.clone(),
            asset_contract: self.asset_contract.clone(),
            total_supply,
            token_name: String::from_str(&self.env, "Fractional Shares"),
            token_symbol: String::from_str(&self.env, "FRAC"),
        }
    }
}

/// Deploys and initializes the factory, registers a real Stellar Asset
/// Contract to stand in for the unique external asset, and mints exactly
/// one unit of it to a fresh `owner`.
fn setup() -> TestCtx {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &BASE_FEE, &METADATA_FEE);

    let asset_admin = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(asset_admin.clone());
    let asset_contract = asset.address();

    let owner = Address::generate(&env);
    token::StellarAssetClient::new(&env, &asset_contract).mint(&owner, &1);

    let asset_id = BytesN::from_array(&env, &[7u8; 32]);

    TestCtx {
        env,
        contract_id,
        owner,
        asset_contract,
        asset_id,
    }
}

// ════════════════════════════════════════════════════════════════════════
// Happy path
// ════════════════════════════════════════════════════════════════════════

#[test]
fn test_fractionalize_and_redeem_happy_path() {
    let ctx = setup();
    let client = ctx.client();
    let asset_token = token::Client::new(&ctx.env, &ctx.asset_contract);

    let vault_id = client.fractionalize(&ctx.owner, &ctx.params(1_000));

    // Asset locked away from the owner into the contract's custody.
    assert_eq!(asset_token.balance(&ctx.owner), 0);
    assert_eq!(asset_token.balance(&ctx.contract_id), 1);

    // Shares minted entirely to owner.
    assert_eq!(
        client.get_fractional_share_balance(&vault_id, &ctx.owner),
        1_000
    );
    assert!(client.is_asset_fractionalized(&vault_id));

    let vault = client.get_fractional_vault(&vault_id).unwrap();
    assert_eq!(vault.id, vault_id);
    assert_eq!(vault.asset_contract, ctx.asset_contract);
    assert_eq!(vault.asset_id, ctx.asset_id);
    assert_eq!(vault.owner, ctx.owner);
    assert_eq!(vault.total_supply, 1_000);
    assert_eq!(vault.status, FractionalStatus::Active);

    // Redeem: owner holds 100% of shares.
    client.redeem_fractional_asset(&ctx.owner, &vault_id);

    assert_eq!(asset_token.balance(&ctx.owner), 1);
    assert_eq!(asset_token.balance(&ctx.contract_id), 0);
    assert_eq!(
        client.get_fractional_share_balance(&vault_id, &ctx.owner),
        0
    );
    assert!(!client.is_asset_fractionalized(&vault_id));

    let vault = client.get_fractional_vault(&vault_id).unwrap();
    assert_eq!(vault.status, FractionalStatus::Redeemed);
}

// ════════════════════════════════════════════════════════════════════════
// Double-fractionalization rejection
// ════════════════════════════════════════════════════════════════════════

#[test]
fn test_double_fractionalization_rejected() {
    let ctx = setup();
    let client = ctx.client();

    client.fractionalize(&ctx.owner, &ctx.params(1_000));

    // Same (asset_contract, asset_id) pair, still active — must be rejected
    // even though the owner no longer holds a spendable unit of the asset.
    let result = client.try_fractionalize(&ctx.owner, &ctx.params(500));
    assert_eq!(result, Err(Ok(Error::AssetAlreadyFractionalized)));
}

#[test]
fn test_refractionalize_after_redeem_succeeds() {
    let ctx = setup();
    let client = ctx.client();

    let vault_id = client.fractionalize(&ctx.owner, &ctx.params(1_000));
    client.redeem_fractional_asset(&ctx.owner, &vault_id);

    // Asset is back with owner as a whole unit; fractionalizing again must succeed.
    let result = client.try_fractionalize(&ctx.owner, &ctx.params(250));
    assert!(result.is_ok());
}

// ════════════════════════════════════════════════════════════════════════
// Unauthorized redemption
// ════════════════════════════════════════════════════════════════════════

#[test]
fn test_unauthorized_redemption_rejected() {
    let ctx = setup();
    let client = ctx.client();

    let vault_id = client.fractionalize(&ctx.owner, &ctx.params(1_000));

    // Attacker holds zero shares and never locked the asset.
    let attacker = Address::generate(&ctx.env);
    let result = client.try_redeem_fractional_asset(&attacker, &vault_id);
    assert_eq!(result, Err(Ok(Error::InsufficientShares)));
}

// ════════════════════════════════════════════════════════════════════════
// Asset-uniqueness enforcement
// ════════════════════════════════════════════════════════════════════════

#[test]
fn test_asset_uniqueness_enforced_across_owners() {
    let ctx = setup();
    let client = ctx.client();

    client.fractionalize(&ctx.owner, &ctx.params(1_000));

    // A different address cannot fractionalize the same (asset_contract,
    // asset_id) identity while it is actively locked, even with a fresh
    // FractionalizationParams — uniqueness of the underlying asset is
    // enforced regardless of who calls.
    let second_owner = Address::generate(&ctx.env);
    let mut params = ctx.params(1_000);
    params.total_supply = 42;
    let result = client.try_fractionalize(&second_owner, &params);
    assert_eq!(result, Err(Ok(Error::AssetAlreadyFractionalized)));
}

#[test]
fn test_fractionalize_zero_or_negative_supply_rejected() {
    let ctx = setup();
    let client = ctx.client();

    let result = client.try_fractionalize(&ctx.owner, &ctx.params(0));
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));

    let result = client.try_fractionalize(&ctx.owner, &ctx.params(-1));
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));
}

// ════════════════════════════════════════════════════════════════════════
// Partial-shares redemption rejection
// ════════════════════════════════════════════════════════════════════════

#[test]
fn test_partial_shares_redemption_rejected() {
    let ctx = setup();
    let client = ctx.client();

    let vault_id = client.fractionalize(&ctx.owner, &ctx.params(1_000));

    // Simulate some shares moving to another holder. There is no public
    // transfer entry point for fractional shares (mirroring how this
    // crate's other test suites, e.g. burn/vault tests, adjust balances
    // directly in storage rather than via a transfer entry point), so the
    // split is applied directly in storage here.
    let other_holder = Address::generate(&ctx.env);
    ctx.env.as_contract(&ctx.contract_id, || {
        crate::storage::set_fractional_share_balance(&ctx.env, vault_id, &ctx.owner, 600);
        crate::storage::set_fractional_share_balance(&ctx.env, vault_id, &other_holder, 400);
    });

    let result = client.try_redeem_fractional_asset(&ctx.owner, &vault_id);
    assert_eq!(result, Err(Ok(Error::InsufficientShares)));

    // The other holder alone doesn't have 100% either.
    let result = client.try_redeem_fractional_asset(&other_holder, &vault_id);
    assert_eq!(result, Err(Ok(Error::InsufficientShares)));
}

// ════════════════════════════════════════════════════════════════════════
// Misc coverage
// ════════════════════════════════════════════════════════════════════════

#[test]
fn test_redeem_nonexistent_vault_rejected() {
    let ctx = setup();
    let client = ctx.client();
    let caller = Address::generate(&ctx.env);

    let result = client.try_redeem_fractional_asset(&caller, &9999_u64);
    assert_eq!(result, Err(Ok(Error::FractionalVaultNotFound)));
}

#[test]
fn test_redeem_already_redeemed_vault_rejected() {
    let ctx = setup();
    let client = ctx.client();

    let vault_id = client.fractionalize(&ctx.owner, &ctx.params(1_000));
    client.redeem_fractional_asset(&ctx.owner, &vault_id);

    let result = client.try_redeem_fractional_asset(&ctx.owner, &vault_id);
    assert_eq!(result, Err(Ok(Error::FractionalVaultNotFound)));
}

#[test]
fn test_get_fractional_vault_none_for_unknown_id() {
    let ctx = setup();
    let client = ctx.client();

    assert!(client.get_fractional_vault(&9999_u64).is_none());
    assert!(!client.is_asset_fractionalized(&9999_u64));
}
