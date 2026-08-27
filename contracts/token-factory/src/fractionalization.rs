//! Asset Fractionalization Module
//!
//! Locks a unique external asset (identified by its `asset_contract` SAC
//! address plus a caller-supplied `asset_id`) in this contract and mints
//! fractional ownership shares. Locking is performed via the standard
//! `soroban_sdk::token` client against the external asset contract, mirroring
//! the pattern already used by `vault.rs` / `create_vault` for real token
//! custody.
//!
//! Fractional shares are tracked in dedicated storage (`FractionalShareBalance`)
//! rather than through the factory's own token registry, since shares aren't
//! one of this factory's deployed tokens.
//!
//! The asset can only be redeemed once a single holder has accumulated and
//! burned 100% of the outstanding shares for that vault.

use crate::storage;
use crate::types::{Error, FractionalStatus, FractionalVault, FractionalizationParams};
use soroban_sdk::{token, Address, Env};

/// Amount of the underlying asset locked to represent one unique, indivisible unit.
const UNIQUE_ASSET_AMOUNT: i128 = 1;

fn validate_params(params: &FractionalizationParams) -> Result<(), Error> {
    if params.token_name.is_empty() || params.token_name.len() > 32 {
        return Err(Error::InvalidTokenParams);
    }
    if params.token_symbol.is_empty() || params.token_symbol.len() > 12 {
        return Err(Error::InvalidTokenParams);
    }
    if params.total_supply <= 0 {
        return Err(Error::InvalidAmount);
    }
    Ok(())
}

/// Lock a unique asset and mint `params.total_supply` fractional ownership shares.
///
/// `owner` must hold and authorize the transfer of `UNIQUE_ASSET_AMOUNT` of
/// `params.asset_contract` to this contract. The pair
/// `(params.asset_contract, params.asset_id)` identifies this specific
/// unique asset and cannot have another active fractionalization vault.
///
/// # Returns
/// The id of the newly created fractionalization vault.
///
/// # Errors
/// * `Error::ContractPaused` - Contract is paused
/// * `Error::InvalidTokenParams` - Shares token name/symbol are invalid
/// * `Error::InvalidAmount` - `total_supply` is zero or negative
/// * `Error::AssetAlreadyFractionalized` - This asset already has an active vault
/// * `Error::ArithmeticError` - Overflow incrementing the vault id counter
pub fn fractionalize(
    env: &Env,
    owner: Address,
    params: FractionalizationParams,
) -> Result<u64, Error> {
    owner.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    validate_params(&params)?;

    // Reject double-fractionalization / enforce asset uniqueness: this exact
    // (asset_contract, asset_id) pair may not have another active vault.
    if let Some(existing_id) =
        storage::get_asset_fractionalization_index(env, &params.asset_contract, &params.asset_id)
    {
        if let Some(existing) = storage::get_fractional_vault(env, existing_id) {
            if existing.status == FractionalStatus::Active {
                return Err(Error::AssetAlreadyFractionalized);
            }
        }
    }

    // Lock the asset: transfer the single unique unit from the owner into
    // this contract's custody via the external asset's standard token interface.
    let asset_client = token::Client::new(env, &params.asset_contract);
    asset_client.transfer(&owner, env.current_contract_address(), &UNIQUE_ASSET_AMOUNT);

    let vault_id = storage::increment_fractional_vault_count(env)?;

    // The shares "token" isn't a separately deployed contract — the factory
    // itself is the fractional token's issuer/ledger of record, matching how
    // this factory's own registered tokens report their own contract address
    // (see `token_creation::create_token_internal`).
    let fractional_token = env.current_contract_address();

    let vault = FractionalVault {
        id: vault_id,
        asset_id: params.asset_id.clone(),
        asset_contract: params.asset_contract.clone(),
        owner: owner.clone(),
        fractional_token: fractional_token.clone(),
        total_supply: params.total_supply,
        created_at: env.ledger().timestamp(),
        status: FractionalStatus::Active,
    };
    storage::set_fractional_vault(env, &vault);
    storage::set_asset_fractionalization_index(
        env,
        &params.asset_contract,
        &params.asset_id,
        vault_id,
    );
    storage::set_fractional_share_balance(env, vault_id, &owner, params.total_supply);

    crate::events::emit_asset_fractionalized(
        env,
        vault_id,
        &params.asset_id,
        &params.asset_contract,
        &owner,
        &fractional_token,
        params.total_supply,
    );

    Ok(vault_id)
}

/// Redeem (unlock) a fractionalized asset.
///
/// `caller` must hold and authorize the burn of 100% of the vault's
/// outstanding shares; the locked asset is then released back to `caller`.
///
/// # Errors
/// * `Error::ContractPaused` - Contract is paused
/// * `Error::FractionalVaultNotFound` - No active vault exists for `vault_id`
/// * `Error::InsufficientShares` - Caller does not hold 100% of the outstanding shares
pub fn redeem(env: &Env, caller: Address, vault_id: u64) -> Result<(), Error> {
    caller.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let mut vault =
        storage::get_fractional_vault(env, vault_id).ok_or(Error::FractionalVaultNotFound)?;

    if vault.status != FractionalStatus::Active {
        return Err(Error::FractionalVaultNotFound);
    }

    let caller_shares = storage::get_fractional_share_balance(env, vault_id, &caller);
    if caller_shares <= 0 || caller_shares != vault.total_supply {
        return Err(Error::InsufficientShares);
    }

    // Burn 100% of the outstanding shares held by the caller.
    storage::set_fractional_share_balance(env, vault_id, &caller, 0);

    // Release the locked asset back to the caller.
    let asset_client = token::Client::new(env, &vault.asset_contract);
    asset_client.transfer(
        &env.current_contract_address(),
        &caller,
        &UNIQUE_ASSET_AMOUNT,
    );

    vault.status = FractionalStatus::Redeemed;
    storage::set_fractional_vault(env, &vault);

    crate::events::emit_asset_redeemed(
        env,
        vault_id,
        &vault.asset_id,
        &vault.asset_contract,
        &caller,
        caller_shares,
    );

    Ok(())
}

/// Returns `true` if `vault_id` currently has an active fractionalization vault.
pub fn is_fractionalized(env: &Env, vault_id: u64) -> bool {
    match storage::get_fractional_vault(env, vault_id) {
        Some(vault) => vault.status == FractionalStatus::Active,
        None => false,
    }
}
