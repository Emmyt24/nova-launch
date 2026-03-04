use soroban_sdk::{Address, Env, String, Vec};
use crate::types::{Error, TokenCreationParams, TokenInfo};
use crate::storage;

/// Validate token creation parameters
fn validate_token_params(
    name: &String,
    symbol: &String,
    decimals: u32,
    initial_supply: i128,
) -> Result<(), Error> {
    // Validate name length (1-32 characters)
    if name.len() == 0 || name.len() > 32 {
        return Err(Error::InvalidTokenParams);
    }

    // Validate symbol length (1-12 characters)
    if symbol.len() == 0 || symbol.len() > 12 {
        return Err(Error::InvalidTokenParams);
    }

    // Validate decimals (0-18)
    if decimals > 18 {
        return Err(Error::InvalidTokenParams);
    }

    // Validate initial supply (must be positive)
    if initial_supply <= 0 {
        return Err(Error::InvalidTokenParams);
    }

    Ok(())
}

/// Calculate total fee for token creation
fn calculate_creation_fee(env: &Env, has_metadata: bool) -> i128 {
    let base_fee = storage::get_base_fee(env);
    let metadata_fee = if has_metadata {
        storage::get_metadata_fee(env)
    } else {
        0
    };
    
    base_fee + metadata_fee
}

/// Create a single token (internal implementation)
pub fn create_token_internal(
    env: &Env,
    creator: &Address,
    params: &TokenCreationParams,
    token_index: u32,
) -> Result<Address, Error> {
    // Validate parameters
    validate_token_params(
        &params.name,
        &params.symbol,
        params.decimals,
        params.initial_supply,
    )?;

    // Generate token address (placeholder - in production this would deploy actual token contract)
    // For now, we create a deterministic address based on token index
    let token_address = env.current_contract_address();

    // Create token info
    let token_info = TokenInfo {
        address: token_address.clone(),
        creator: creator.clone(),
        name: params.name.clone(),
        symbol: params.symbol.clone(),
        decimals: params.decimals,
        total_supply: params.initial_supply,
        metadata_uri: params.metadata_uri.clone(),
        created_at: env.ledger().timestamp(),
        total_burned: 0,
        burn_count: 0,
        clawback_enabled: false,
    };

    // Store token info
    storage::set_token_info(env, token_index, &token_info);
    storage::set_token_info_by_address(env, &token_address, &token_info);

    // Set initial balance for creator
    storage::set_balance(env, token_index, creator, params.initial_supply);

    // Emit token created event
    crate::events::emit_token_created(
        env,
        &token_address,
        creator,
    );

    Ok(token_address)
}

/// Create a single token with fee payment
pub fn create_token(
    env: &Env,
    creator: Address,
    name: String,
    symbol: String,
    decimals: u32,
    initial_supply: i128,
    metadata_uri: Option<String>,
    fee_payment: i128,
) -> Result<Address, Error> {
    // Check if paused
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    // Require creator authorization
    creator.require_auth();

    // Calculate and verify fee
    let required_fee = calculate_creation_fee(env, metadata_uri.is_some());
    if fee_payment < required_fee {
        return Err(Error::InsufficientFee);
    }

    // Get next token index
    let token_index = storage::increment_token_count(env) - 1;

    // Create token parameters
    let params = TokenCreationParams {
        name,
        symbol,
        decimals,
        initial_supply,
        metadata_uri,
    };

    // Create token
    let token_address = create_token_internal(env, &creator, &params, token_index)?;

    // Transfer fee to treasury (placeholder - in production would use actual token transfer)
    // let treasury = storage::get_treasury(env);
    // token::transfer(env, &creator, &treasury, fee_payment);

    Ok(token_address)
}

/// Batch create multiple tokens atomically
/// 
/// All tokens are created in a single transaction with atomic semantics.
/// If any token fails validation, the entire batch is rolled back.
/// 
/// # Arguments
/// * `creator` - Address creating the tokens (must authorize)
/// * `tokens` - Vector of token creation parameters
/// * `total_fee_payment` - Total fee payment for all tokens
/// 
/// # Returns
/// Vector of created token addresses
/// 
/// # Errors
/// * `ContractPaused` - Contract is paused
/// * `InsufficientFee` - Total fee payment is insufficient
/// * `InvalidTokenParams` - Any token has invalid parameters
/// * `BatchCreationFailed` - Batch creation failed (atomic rollback)
pub fn batch_create_tokens(
    env: &Env,
    creator: Address,
    tokens: Vec<TokenCreationParams>,
    total_fee_payment: i128,
) -> Result<Vec<Address>, Error> {
    // Check if paused
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    // Require creator authorization
    creator.require_auth();

    // Validate batch is not empty
    if tokens.is_empty() {
        return Err(Error::InvalidTokenParams);
    }

    // Phase 1: Validate all tokens before any state changes (atomic semantics)
    let mut total_required_fee = 0i128;
    for token in tokens.iter() {
        // Validate each token's parameters
        validate_token_params(
            &token.name,
            &token.symbol,
            token.decimals,
            token.initial_supply,
        )?;

        // Calculate fee for this token
        let token_fee = calculate_creation_fee(env, token.metadata_uri.is_some());
        total_required_fee = total_required_fee
            .checked_add(token_fee)
            .ok_or(Error::InvalidTokenParams)?;
    }

    // Verify total fee payment
    if total_fee_payment < total_required_fee {
        return Err(Error::InsufficientFee);
    }

    // Phase 2: Create all tokens (all validations passed)
    let mut created_addresses = Vec::new(env);
    let starting_token_count = storage::get_token_count(env);

    for (i, token) in tokens.iter().enumerate() {
        let token_index = starting_token_count + (i as u32);
        
        // Create token
        let token_address = create_token_internal(env, &creator, &token, token_index)
            .map_err(|_| Error::BatchCreationFailed)?;
        
        created_addresses.push_back(token_address);
    }

    // Update token count
    let new_count = starting_token_count + (tokens.len() as u32);
    env.storage().instance().set(&crate::types::DataKey::TokenCount, &new_count);

    // Emit batch creation event
    crate::events::emit_batch_tokens_created(env, &creator, tokens.len() as u32);

    // Transfer total fee to treasury (placeholder)
    // let treasury = storage::get_treasury(env);
    // token::transfer(env, &creator, &treasury, total_fee_payment);

    Ok(created_addresses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup_test_env() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        // Initialize storage
        storage::set_admin(&env, &admin);
        storage::set_treasury(&env, &treasury);
        storage::set_base_fee(&env, 100);
        storage::set_metadata_fee(&env, 50);

        (env, admin, treasury)
    }

    #[test]
    fn test_validate_token_params_success() {
        let env = Env::default();
        let name = String::from_str(&env, "TestToken");
        let symbol = String::from_str(&env, "TEST");
        
        let result = validate_token_params(&name, &symbol, 6, 1_000_000);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_token_params_empty_name() {
        let env = Env::default();
        let name = String::from_str(&env, "");
        let symbol = String::from_str(&env, "TEST");
        
        let result = validate_token_params(&name, &symbol, 6, 1_000_000);
        assert_eq!(result, Err(Error::InvalidTokenParams));
    }

    #[test]
    fn test_validate_token_params_name_too_long() {
        let env = Env::default();
        let name = String::from_str(&env, "ThisIsAVeryLongTokenNameThatExceedsTheMaximumAllowedLength");
        let symbol = String::from_str(&env, "TEST");
        
        let result = validate_token_params(&name, &symbol, 6, 1_000_000);
        assert_eq!(result, Err(Error::InvalidTokenParams));
    }

    #[test]
    fn test_validate_token_params_invalid_decimals() {
        let env = Env::default();
        let name = String::from_str(&env, "TestToken");
        let symbol = String::from_str(&env, "TEST");
        
        let result = validate_token_params(&name, &symbol, 19, 1_000_000);
        assert_eq!(result, Err(Error::InvalidTokenParams));
    }

    #[test]
    fn test_validate_token_params_zero_supply() {
        let env = Env::default();
        let name = String::from_str(&env, "TestToken");
        let symbol = String::from_str(&env, "TEST");
        
        let result = validate_token_params(&name, &symbol, 6, 0);
        assert_eq!(result, Err(Error::InvalidTokenParams));
    }

    #[test]
    fn test_calculate_creation_fee_without_metadata() {
        let (env, _, _) = setup_test_env();
        let fee = calculate_creation_fee(&env, false);
        assert_eq!(fee, 100);
    }

    #[test]
    fn test_calculate_creation_fee_with_metadata() {
        let (env, _, _) = setup_test_env();
        let fee = calculate_creation_fee(&env, true);
        assert_eq!(fee, 150);
    }
}
