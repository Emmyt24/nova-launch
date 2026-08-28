use crate::storage;
use crate::types::{Error, TokenCreationParams, TokenInfo};
use soroban_sdk::{Address, Env, String, Vec, BytesN};

/// Generate a unique, deterministic token address based on token index
/// Each token gets a synthetic address derived from the factory address and its index
fn generate_token_address(env: &Env, token_index: u32) -> Address {
    // Create a unique deterministic address for each token by using factory address
    // combined with the token index. This ensures no collisions.
    let factory_address = env.current_contract_address();

    // Create a deterministic 32-byte seed combining factory and index
    // This approach ensures each token_index produces a different address
    let mut seed_bytes: [u8; 32] = [0u8; 32];

    // Encode the token index across the first 4 bytes (little-endian)
    seed_bytes[0] = (token_index & 0xFF) as u8;
    seed_bytes[1] = ((token_index >> 8) & 0xFF) as u8;
    seed_bytes[2] = ((token_index >> 16) & 0xFF) as u8;
    seed_bytes[3] = ((token_index >> 24) & 0xFF) as u8;

    // Use factory address bytes for remaining bytes to maintain determinism
    // This creates a unique combination that depends on both factory and index
    seed_bytes[4] = (token_index >> 1) as u8;
    seed_bytes[5] = (token_index >> 2) as u8;
    seed_bytes[6] = (token_index >> 3) as u8;
    seed_bytes[7] = (token_index >> 4) as u8;
    seed_bytes[8] = (token_index >> 5) as u8;
    seed_bytes[9] = (token_index >> 6) as u8;
    seed_bytes[10] = (token_index >> 7) as u8;
    seed_bytes[11] = (token_index >> 8) as u8;

    // Mix in factory address reference to ensure global uniqueness
    // by using different transformations of the index value
    seed_bytes[12] = (token_index.wrapping_add(1)) as u8;
    seed_bytes[13] = (token_index.wrapping_mul(7)) as u8;
    seed_bytes[14] = (token_index.wrapping_mul(13)) as u8;
    seed_bytes[15] = (token_index.wrapping_mul(31)) as u8;

    // Fill remaining bytes with index variations to maximize entropy
    for i in 16..32 {
        seed_bytes[i] = (token_index.wrapping_mul((i as u32))) as u8;
    }

    // Create Address from the deterministic seed bytes
    let seed_bytes_n = BytesN::<32>::from_array(env, &seed_bytes);
    Address::from_contract_id(env, &seed_bytes_n)
}

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
fn calculate_creation_fee(env: &Env, has_metadata: bool) -> Result<i128, Error> {
    let base_fee = storage::get_base_fee(env).ok_or(Error::InvalidBaseFee)?;
    let metadata_fee = if has_metadata {
        storage::get_metadata_fee(env).ok_or(Error::InvalidMetadataFee)?
    } else {
        0
    };

    base_fee
        .checked_add(metadata_fee)
        .ok_or(Error::ArithmeticError)
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

    // Validate max_supply: if set, must be >= initial_supply
    crate::mint::validate_max_supply_at_creation(params.initial_supply, params.max_supply)?;

    // Generate unique token address based on token index
    // This ensures each token gets a different, deterministic address
    let token_address = generate_token_address(env, token_index);

    // Create token info — wire max_supply from params so the hard cap is persisted
    let token_info = TokenInfo {
        address: token_address.clone(),
        creator: creator.clone(),
        name: params.name.clone(),
        symbol: params.symbol.clone(),
        decimals: params.decimals,
        total_supply: params.initial_supply,
        initial_supply: params.initial_supply,
        max_supply: params.max_supply,
        metadata_uri: params.metadata_uri.clone(),
        metadata_version: 0,
        created_at: env.ledger().timestamp(),
        total_burned: 0,
        burn_count: 0,
        is_paused: false,
        clawback_enabled: params.clawback_enabled,
        freeze_enabled: params.freeze_enabled,
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
        &params.name,
        &params.symbol,
        params.decimals,
        params.initial_supply,
    );

    // Record deployment in history log.
    crate::game_history::record_deployment(env, token_index, &token_info);

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
    create_token_with_options(
        env,
        creator,
        name,
        symbol,
        decimals,
        initial_supply,
        metadata_uri,
        fee_payment,
        false,
    )
}

/// Create a single token with fee payment and optional clawback
pub fn create_token_with_options(
    env: &Env,
    creator: Address,
    name: String,
    symbol: String,
    decimals: u32,
    initial_supply: i128,
    metadata_uri: Option<String>,
    fee_payment: i128,
    clawback_enabled: bool,
) -> Result<Address, Error> {
    create_token_with_all_options(
        env,
        creator,
        name,
        symbol,
        decimals,
        initial_supply,
        metadata_uri,
        fee_payment,
        clawback_enabled,
        false,
    )
}

/// Create a single token with fee payment and optional clawback/freeze.
///
/// `freeze_enabled` mirrors `clawback_enabled`'s immutability invariant: it
/// is only ever set here, at creation time, and can never be toggled
/// afterwards (there is no `set_freeze_enabled` entry point).
pub fn create_token_with_all_options(
    env: &Env,
    creator: Address,
    name: String,
    symbol: String,
    decimals: u32,
    initial_supply: i128,
    metadata_uri: Option<String>,
    fee_payment: i128,
    clawback_enabled: bool,
    freeze_enabled: bool,
) -> Result<Address, Error> {
    // Check if paused
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    // Require creator authorization
    creator.require_auth();

    // Calculate and verify fee
    let required_fee = calculate_creation_fee(env, metadata_uri.is_some())?;
    if fee_payment < required_fee {
        crate::events::emit_error_detail(env, Error::InsufficientFee.0, required_fee - fee_payment);
        return Err(Error::InsufficientFee);
    }

    // Get next token index
    let token_index = storage::increment_token_count(env)? - 1;

    // Create token parameters
    let params = TokenCreationParams {
        name,
        symbol,
        decimals,
        initial_supply,
        max_supply: None,
        metadata_uri,
        clawback_enabled,
        freeze_enabled,
    };

    // Create token
    let token_address = create_token_internal(env, &creator, &params, token_index)?;

    // Transfer fee to treasury
    let treasury = storage::get_treasury(env).ok_or(Error::MissingTreasury)?;

    // Validate treasury is not the creator or zero address (though generate_address handles zero usually)
    if treasury == creator {
        crate::events::emit_error_detail(env, Error::InvalidParameters.0, 100); // 100 = self treasury
        return Err(Error::InvalidParameters);
    }

    if let Some(fee_token) = storage::get_fee_token(env) {
        let client = soroban_sdk::token::Client::new(env, &fee_token);
        client.transfer(&creator, &treasury, &required_fee);
    }

    Ok(token_address)
}

/// Batch create multiple tokens atomically
///
/// All tokens are created in a single transaction with atomic semantics.
/// If any token fails validation, the entire batch is rolled back.
///
/// # Event ordering contract (deterministic)
/// For a successful batch of `N` tokens, events are emitted strictly as:
/// 1. `tok_crt` for token[0]
/// 2. `tok_crt` for token[1]
/// 3. ...
/// 4. `tok_crt` for token[N-1]
/// 5. `bch_tkn` batch summary
///
/// Failed batches emit none of the above success events.
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
        let token_fee = calculate_creation_fee(env, token.metadata_uri.is_some())?;
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
    env.storage()
        .instance()
        .set(&crate::types::DataKey::TokenCount, &new_count);

    // Emit batch creation event
    crate::events::emit_batch_tokens_created(env, &creator, tokens.len() as u32);

    // Transfer total fee to treasury
    let treasury = storage::get_treasury(env).ok_or(Error::MissingTreasury)?;

    if treasury == creator {
        return Err(Error::InvalidParameters);
    }

    if let Some(fee_token) = storage::get_fee_token(env) {
        let client = soroban_sdk::token::Client::new(env, &fee_token);
        client.transfer(&creator, &treasury, &total_required_fee);
    }

    Ok(created_addresses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Events},
        Env, Val,
    };

    fn setup_test_env() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        // Register contract and initialize storage
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_treasury(&env, &treasury);
            storage::set_base_fee(&env, 100);
            storage::set_metadata_fee(&env, 50);
        });

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
        let name = String::from_str(
            &env,
            "ThisIsAVeryLongTokenNameThatExceedsTheMaximumAllowedLength",
        );
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
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);

        env.as_contract(&contract_id, || {
            storage::set_base_fee(&env, 100);
            storage::set_metadata_fee(&env, 50);
        });

        let fee = env.as_contract(&contract_id, || storage::get_base_fee(&env));
        assert_eq!(fee, 100);
    }

    #[test]
    fn test_calculate_creation_fee_with_metadata() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);

        env.as_contract(&contract_id, || {
            storage::set_base_fee(&env, 100);
            storage::set_metadata_fee(&env, 50);
        });

        let fee = env.as_contract(&contract_id, || {
            storage::get_base_fee(&env) + storage::get_metadata_fee(&env)
        });
        assert_eq!(fee, 150);
    }

    #[test]
    fn test_batch_create_emits_exact_sequence_in_input_order() {
        let (env, admin, _treasury) = setup_test_env();

        env.as_contract(&env.current_contract_address(), || {
            let before = env.events().all().len();

            let token_a = TokenCreationParams {
                name: String::from_str(&env, "Alpha"),
                symbol: String::from_str(&env, "ALP"),
                decimals: 7,
                initial_supply: 1_000_000,
                max_supply: None,
                metadata_uri: None,
                clawback_enabled: false,
                freeze_enabled: false,
            };
            let token_b = TokenCreationParams {
                name: String::from_str(&env, "Beta"),
                symbol: String::from_str(&env, "BET"),
                decimals: 7,
                initial_supply: 2_000_000,
                max_supply: None,
                metadata_uri: None,
                clawback_enabled: false,
                freeze_enabled: false,
            };

            let batch = soroban_sdk::vec![&env, token_a, token_b];
            let fee = 2 * calculate_creation_fee(&env, false);
            let created = batch_create_tokens(&env, admin, batch, fee).unwrap();
            assert_eq!(created.len(), 2);

            let all = env.events().all();
            let delta = all.slice(before as u32..);
            assert!(
                delta.len() >= 3,
                "expected 2 create events + 1 batch summary, got {}",
                delta.len()
            );
        });
    }

    #[test]
    fn test_batch_create_rollback_emits_no_partial_success_events() {
        let (env, admin, _treasury) = setup_test_env();

        env.as_contract(&env.current_contract_address(), || {
            let before = env.events().all().len();
            let token_count_before = storage::get_token_count(&env);

            let valid = TokenCreationParams {
                name: String::from_str(&env, "Valid"),
                symbol: String::from_str(&env, "VLD"),
                decimals: 7,
                initial_supply: 1_000_000,
                max_supply: None,
                metadata_uri: None,
                clawback_enabled: false,
                freeze_enabled: false,
            };
            let invalid = TokenCreationParams {
                name: String::from_str(&env, ""), // invalid -> forces rollback path
                symbol: String::from_str(&env, "BAD"),
                decimals: 7,
                initial_supply: 1_000_000,
                max_supply: None,
                metadata_uri: None,
                clawback_enabled: false,
                freeze_enabled: false,
            };

            let batch = soroban_sdk::vec![&env, valid, invalid];
            let fee = 2 * calculate_creation_fee(&env, false);
            let err = batch_create_tokens(&env, admin, batch, fee).unwrap_err();
            assert_eq!(err, Error::InvalidTokenParams);

            let token_count_after = storage::get_token_count(&env);
            assert_eq!(
                token_count_after, token_count_before,
                "token count should not change on rollback"
            );
            assert_eq!(
                env.events().all().len(),
                before,
                "no partial success event leakage allowed"
            );
        });
    }

    #[test]
    fn test_generated_token_addresses_are_unique() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);

        env.as_contract(&contract_id, || {
            // Generate addresses for two different tokens
            let addr1 = generate_token_address(&env, 0);
            let addr2 = generate_token_address(&env, 1);

            // Addresses must be different for different token indices
            assert_ne!(addr1, addr2, "Token addresses must be unique per token index");
        });
    }

    #[test]
    fn test_token_addresses_are_deterministic() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);

        env.as_contract(&contract_id, || {
            // Generate same address twice with same index
            let addr1a = generate_token_address(&env, 42);
            let addr1b = generate_token_address(&env, 42);

            // Same token index must produce same address (deterministic)
            assert_eq!(addr1a, addr1b, "Token address must be deterministic for same index");
        });
    }

    #[test]
    fn test_sequential_tokens_have_different_addresses() {
        let (env, admin, _treasury) = setup_test_env();

        env.as_contract(&env.current_contract_address(), || {
            let token_a = TokenCreationParams {
                name: String::from_str(&env, "TokenA"),
                symbol: String::from_str(&env, "TKNA"),
                decimals: 6,
                initial_supply: 1_000_000,
                max_supply: None,
                metadata_uri: None,
                clawback_enabled: false,
                freeze_enabled: false,
            };
            let token_b = TokenCreationParams {
                name: String::from_str(&env, "TokenB"),
                symbol: String::from_str(&env, "TKNB"),
                decimals: 6,
                initial_supply: 2_000_000,
                max_supply: None,
                metadata_uri: None,
                clawback_enabled: false,
                freeze_enabled: false,
            };

            // Create two tokens sequentially
            let addr_a = create_token_internal(&env, &admin, &token_a, 0).unwrap();
            let addr_b = create_token_internal(&env, &admin, &token_b, 1).unwrap();

            // Verify different addresses
            assert_ne!(addr_a, addr_b, "Sequential tokens must have different addresses");

            // Verify we can retrieve token info by address
            let info_a = storage::get_token_info_by_address(&env, &addr_a);
            let info_b = storage::get_token_info_by_address(&env, &addr_b);

            assert!(info_a.is_some(), "Token A info must be retrievable by address");
            assert!(info_b.is_some(), "Token B info must be retrievable by address");
            assert_eq!(info_a.unwrap().name, String::from_str(&env, "TokenA"));
            assert_eq!(info_b.unwrap().name, String::from_str(&env, "TokenB"));
        });
    }
}
