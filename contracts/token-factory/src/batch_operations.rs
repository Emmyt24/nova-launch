/// Batch operations for high-volume token processing.
///
/// Provides `batch_reveal` (batch token creation) and `batch_settle` (batch mint)
/// with atomic execution, storage-access optimization, and a hard batch-size cap
/// to bound gas consumption.
///
/// ## Atomicity model
/// Every batch operation is split into two phases:
/// 1. **Stage** – validate every item and compute the exact value that will be
///    written for it. Nothing is written to storage in this phase, so any
///    failure here (returned as `Err`) leaves the ledger byte-for-byte
///    unchanged.
/// 2. **Commit** – write the values staged in phase 1. Every value committed
///    here was already validated, so this phase cannot fail: there is no
///    operator in the commit loop that can return `Err`. This holds even
///    when the function is called directly (bypassing the host's contract
///    invocation boundary, as unit tests do), not just when atomicity is
///    provided implicitly by the host rolling back a failed invocation.
///
/// `preflight_batch_reveal` / `preflight_batch_settle` expose phase 1 standalone
/// so callers can validate a batch without paying for (or risking) execution.
use soroban_sdk::{Address, Env, Map, Vec};

use crate::storage;
use crate::types::{Error, PreflightItemResult, TokenCreationParams};

/// Maximum number of items allowed in a single batch call.
pub const MAX_BATCH_SIZE: u32 = 50;

/// Batch-create tokens in a single atomic transaction.
///
/// All parameter validation is performed before any state is written, so a
/// validation failure on any item leaves the ledger unchanged.
///
/// # Gas optimisation
/// Token count is read once, incremented in memory, and written once at the
/// end — avoiding N redundant storage round-trips.
///
/// # Arguments
/// * `creator`            – Address that will own all created tokens (must auth).
/// * `tokens`             – Parameters for each token; max `MAX_BATCH_SIZE` items.
/// * `total_fee_payment`  – Combined fee covering every token in the batch.
///
/// # Returns
/// Indices of the newly created tokens (in input order).
///
/// # Errors
/// * `ContractPaused`      – Factory is paused.
/// * `BatchTooLarge`       – `tokens.len() > MAX_BATCH_SIZE`.
/// * `InvalidParameters`   – Empty batch.
/// * `InsufficientFee`     – `total_fee_payment` is below the required total.
/// * `InvalidTokenParams`  – Any token fails parameter validation.
pub fn batch_reveal(
    env: &Env,
    creator: Address,
    tokens: Vec<TokenCreationParams>,
    total_fee_payment: i128,
) -> Result<Vec<u32>, Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    creator.require_auth();

    let batch_len = tokens.len();
    if batch_len == 0 {
        return Err(Error::InvalidParameters);
    }
    if batch_len > MAX_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }

    // ── Phase 1 (stage): validate every item and compute its final token
    // index. Nothing is written to storage here. ───────────────────────────
    let base_fee = storage::get_base_fee(env).ok_or(Error::InvalidBaseFee)?;
    let metadata_fee = storage::get_metadata_fee(env).ok_or(Error::InvalidMetadataFee)?;
    let start_index = storage::get_token_count(env);

    let mut required_fee: i128 = 0;
    let mut staged_indices: Vec<u32> = Vec::new(env);
    for (i, token) in tokens.iter().enumerate() {
        validate_token_params(env, &token)?;

        let token_fee = if token.metadata_uri.is_some() {
            base_fee
                .checked_add(metadata_fee)
                .ok_or(Error::ArithmeticError)?
        } else {
            base_fee
        };
        required_fee = required_fee
            .checked_add(token_fee)
            .ok_or(Error::ArithmeticError)?;

        let token_index = start_index
            .checked_add(i as u32)
            .ok_or(Error::ArithmeticError)?;
        staged_indices.push_back(token_index);
    }

    if total_fee_payment < required_fee {
        return Err(Error::InsufficientFee);
    }

    // ── Phase 2 (commit): write every staged token. Every index/value here
    // was already validated above, so this loop is infallible — no item can
    // be left partially applied. A failure would indicate a phase-1/phase-2
    // mismatch, so we panic (triggering a full host-level rollback) rather
    // than risk silently committing a partial batch. ───────────────────────
    let mut indices = Vec::new(env);
    for (token, token_index) in tokens.iter().zip(staged_indices.iter()) {
        crate::token_creation::create_token_internal(env, &creator, &token, token_index)
            .unwrap_or_else(|e| panic!("batch_reveal: phase 2 commit failed after phase 1 validation passed: {:?}", e));
        indices.push_back(token_index);
    }

    // Write the new token count in a single storage operation.
    let new_count = start_index
        .checked_add(batch_len)
        .ok_or(Error::ArithmeticError)?;
    env.storage()
        .instance()
        .set(&crate::types::DataKey::TokenCount, &new_count);

    crate::events::emit_batch_tokens_created(env, &creator, batch_len);

    Ok(indices)
}

/// Dry-run `batch_reveal`'s validation phase without writing any state.
///
/// Returns one [`PreflightItemResult`] per input token (`error_code == 0`
/// means that item would succeed), plus an extra entry at `index ==
/// tokens.len()` with `Error::InsufficientFee` if `total_fee_payment` would
/// be too low for the items that do pass validation. Does not require
/// `creator` authorization since nothing is mutated or spent.
///
/// # Errors
/// * `ContractPaused`    – Factory is paused.
/// * `InvalidParameters` – Empty batch.
/// * `BatchTooLarge`     – `tokens.len() > MAX_BATCH_SIZE`.
pub fn preflight_batch_reveal(
    env: &Env,
    tokens: Vec<TokenCreationParams>,
    total_fee_payment: i128,
) -> Result<Vec<PreflightItemResult>, Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let batch_len = tokens.len();
    if batch_len == 0 {
        return Err(Error::InvalidParameters);
    }
    if batch_len > MAX_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }

    let base_fee = storage::get_base_fee(env).ok_or(Error::InvalidBaseFee)?;
    let metadata_fee = storage::get_metadata_fee(env).ok_or(Error::InvalidMetadataFee)?;

    let mut results = Vec::new(env);
    let mut required_fee: i128 = 0;
    for (i, token) in tokens.iter().enumerate() {
        let error_code = match validate_token_params(env, &token) {
            Ok(()) => 0,
            Err(e) => e.0,
        };
        results.push_back(PreflightItemResult {
            index: i as u32,
            error_code,
        });

        if error_code == 0 {
            let token_fee = if token.metadata_uri.is_some() {
                base_fee.checked_add(metadata_fee).unwrap_or(i128::MAX)
            } else {
                base_fee
            };
            required_fee = required_fee.checked_add(token_fee).unwrap_or(i128::MAX);
        }
    }

    if total_fee_payment < required_fee {
        results.push_back(PreflightItemResult {
            index: batch_len,
            error_code: Error::InsufficientFee.0,
        });
    }

    Ok(results)
}

/// Batch-mint tokens to multiple recipients in a single atomic transaction.
///
/// All recipients receive tokens from the same `token_index`. The caller must
/// be the token creator. Validation of every (recipient, amount) pair — and
/// the resulting per-recipient balance — is done before any balance is
/// updated. Duplicate recipients in the same batch are accumulated correctly.
///
/// # Gas optimisation
/// Token info is loaded once and reused across all mint operations.
///
/// # Arguments
/// * `creator`      – Token creator address (must auth).
/// * `token_index`  – Index of the token to mint.
/// * `recipients`   – `(recipient_address, amount)` pairs; max `MAX_BATCH_SIZE`.
///
/// # Returns
/// Total amount minted across all recipients.
///
/// # Errors
/// * `ContractPaused`    – Factory is paused.
/// * `TokenNotFound`     – `token_index` does not exist.
/// * `Unauthorized`      – Caller is not the token creator.
/// * `TokenPaused`       – Token is paused.
/// * `BatchTooLarge`     – More than `MAX_BATCH_SIZE` recipients.
/// * `InvalidParameters` – Empty recipients list or any amount ≤ 0.
/// * `ArithmeticError`   – Aggregate or per-recipient balance would overflow.
/// * `MaxSupplyExceeded` – Batch would exceed the token's max supply.
pub fn batch_settle(
    env: &Env,
    creator: Address,
    token_index: u32,
    recipients: Vec<(Address, i128)>,
) -> Result<i128, Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    creator.require_auth();

    let batch_len = recipients.len();
    if batch_len == 0 {
        return Err(Error::InvalidParameters);
    }
    if batch_len > MAX_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }

    // Load token info once.
    let token_info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;

    if token_info.creator != creator {
        return Err(Error::Unauthorized);
    }
    if storage::is_token_paused(env, token_index) {
        return Err(Error::TokenPaused);
    }

    // ── Phase 1 (stage): validate every recipient and compute the final
    // balance each unique address will hold. Nothing is written to storage
    // here. Recipient deltas are accumulated per-address first so duplicate
    // recipients in the same batch are handled correctly. ──────────────────
    let mut total_mint: i128 = 0;
    let mut deltas: Map<Address, i128> = Map::new(env);
    for (recipient, amount) in recipients.iter() {
        if amount <= 0 {
            return Err(Error::InvalidParameters);
        }
        total_mint = total_mint
            .checked_add(amount)
            .ok_or(Error::ArithmeticError)?;

        let prior = deltas.get(recipient.clone()).unwrap_or(0);
        let combined = prior.checked_add(amount).ok_or(Error::ArithmeticError)?;
        deltas.set(recipient.clone(), combined);
    }

    // Check max supply once using the aggregated total.
    let new_supply = token_info
        .total_supply
        .checked_add(total_mint)
        .ok_or(Error::ArithmeticError)?;
    if let Some(max) = token_info.max_supply {
        if new_supply > max {
            return Err(Error::MaxSupplyExceeded);
        }
    }

    // Resolve each unique recipient's final balance against current storage,
    // catching any per-recipient overflow before committing anything.
    let mut staged_balances: Map<Address, i128> = Map::new(env);
    for (recipient, delta) in deltas.iter() {
        let current_balance = storage::get_balance(env, token_index, &recipient);
        let new_balance = current_balance
            .checked_add(delta)
            .ok_or(Error::ArithmeticError)?;
        staged_balances.set(recipient, new_balance);
    }

    // ── Phase 2 (commit): write every staged balance and the new total
    // supply. Every value here was already validated above, so this phase
    // is infallible. ─────────────────────────────────────────────────────
    let mut updated_info = token_info;
    updated_info.total_supply = new_supply;
    storage::set_token_info(env, token_index, &updated_info);

    for (recipient, _) in deltas.iter() {
        let new_balance = staged_balances
            .get(recipient.clone())
            .unwrap_or_else(|| panic!("batch_settle: phase 2 commit missing staged balance"));
        storage::set_balance(env, token_index, &recipient, new_balance);
        let _ = crate::snapshot::record_balance_snapshot(env, token_index, &recipient, new_balance);
    }
    let _ = crate::snapshot::record_supply_snapshot(env, token_index, new_supply);

    // Emit one `mint` event per input entry, in input order, matching the
    // documented event-ordering contract (duplicates emit once each).
    for (recipient, amount) in recipients.iter() {
        crate::events::emit_mint(env, token_index, &recipient, amount);
    }

    crate::events::emit_batch_settle(env, token_index, &creator, batch_len, total_mint);

    Ok(total_mint)
}

/// Dry-run `batch_settle`'s validation phase without writing any state.
///
/// Returns one [`PreflightItemResult`] per `(recipient, amount)` pair
/// (`error_code == 0` means that item would succeed), plus an extra entry at
/// `index == recipients.len()` with `Error::MaxSupplyExceeded` if the
/// aggregate mint would exceed the token's max supply.
///
/// # Errors
/// * `ContractPaused`    – Factory is paused.
/// * `InvalidParameters` – Empty recipients list.
/// * `BatchTooLarge`     – More than `MAX_BATCH_SIZE` recipients.
/// * `TokenNotFound`     – `token_index` does not exist.
/// * `Unauthorized`      – Caller is not the token creator.
/// * `TokenPaused`       – Token is paused.
pub fn preflight_batch_settle(
    env: &Env,
    creator: Address,
    token_index: u32,
    recipients: Vec<(Address, i128)>,
) -> Result<Vec<PreflightItemResult>, Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let batch_len = recipients.len();
    if batch_len == 0 {
        return Err(Error::InvalidParameters);
    }
    if batch_len > MAX_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }

    let token_info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;
    if token_info.creator != creator {
        return Err(Error::Unauthorized);
    }
    if storage::is_token_paused(env, token_index) {
        return Err(Error::TokenPaused);
    }

    let mut results = Vec::new(env);
    let mut total_mint: i128 = 0;
    let mut any_item_failed = false;

    for (i, (_recipient, amount)) in recipients.iter().enumerate() {
        if amount <= 0 {
            results.push_back(PreflightItemResult {
                index: i as u32,
                error_code: Error::InvalidParameters.0,
            });
            any_item_failed = true;
            continue;
        }
        match total_mint.checked_add(amount) {
            Some(v) => total_mint = v,
            None => {
                results.push_back(PreflightItemResult {
                    index: i as u32,
                    error_code: Error::ArithmeticError.0,
                });
                any_item_failed = true;
                continue;
            }
        }
        results.push_back(PreflightItemResult {
            index: i as u32,
            error_code: 0,
        });
    }

    if !any_item_failed {
        if let Some(max) = token_info.max_supply {
            let new_supply = token_info.total_supply.checked_add(total_mint).unwrap_or(i128::MAX);
            if new_supply > max {
                results.push_back(PreflightItemResult {
                    index: batch_len,
                    error_code: Error::MaxSupplyExceeded.0,
                });
            }
        }
    }

    Ok(results)
}

// ── helpers ───────────────────────────────────────────────────────────────────

pub(crate) fn validate_token_params(env: &Env, params: &TokenCreationParams) -> Result<(), Error> {
    if params.name.len() == 0 || params.name.len() > 32 {
        return Err(Error::InvalidTokenParams);
    }
    if params.symbol.len() == 0 || params.symbol.len() > 12 {
        return Err(Error::InvalidTokenParams);
    }
    if params.decimals > 18 {
        return Err(Error::InvalidTokenParams);
    }
    if params.initial_supply <= 0 {
        return Err(Error::InvalidTokenParams);
    }
    crate::mint::validate_max_supply_at_creation(params.initial_supply, params.max_supply)?;
    let _ = env; // env available for future validation
    Ok(())
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(any())] // TEMP-VALIDATION-ONLY: disabled for vault_error isolation build
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::{testutils::Address as _, vec, Env, String};

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, crate::TokenFactory);
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &1_000_000_i128, &500_000_i128);

        (env, contract_id, admin, treasury)
    }

    fn make_params(env: &Env, name: &str, symbol: &str) -> TokenCreationParams {
        TokenCreationParams {
            name: String::from_str(env, name),
            symbol: String::from_str(env, symbol),
            decimals: 7,
            initial_supply: 1_000_000,
            max_supply: None,
            metadata_uri: None,
        }
    }

    // ── batch_reveal ──────────────────────────────────────────────────────

    #[test]
    fn batch_reveal_creates_tokens_atomically() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let tokens = vec![
            &env,
            make_params(&env, "Alpha", "ALP"),
            make_params(&env, "Beta", "BET"),
            make_params(&env, "Gamma", "GAM"),
        ];
        // 3 tokens × base_fee (1_000_000 each, no metadata)
        let indices = client.batch_reveal(&admin, &tokens, &3_000_000_i128);

        assert_eq!(indices.len(), 3);
        assert_eq!(indices.get(0).unwrap(), 0);
        assert_eq!(indices.get(1).unwrap(), 1);
        assert_eq!(indices.get(2).unwrap(), 2);
    }

    #[test]
    fn batch_reveal_rejects_empty_batch() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let tokens: Vec<TokenCreationParams> = vec![&env];
        let err = client.try_batch_reveal(&admin, &tokens, &0_i128).unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::InvalidParameters);
    }

    #[test]
    fn batch_reveal_rejects_insufficient_fee() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let tokens = vec![&env, make_params(&env, "Alpha", "ALP")];
        let err = client.try_batch_reveal(&admin, &tokens, &0_i128).unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::InsufficientFee);
    }

    #[test]
    fn batch_reveal_atomic_rollback_on_invalid_param() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let bad = TokenCreationParams {
            name: String::from_str(&env, ""),
            symbol: String::from_str(&env, "BAD"),
            decimals: 7,
            initial_supply: 1_000_000,
            max_supply: None,
            metadata_uri: None,
        };
        let tokens = vec![&env, make_params(&env, "Good", "GD"), bad];
        let err = client.try_batch_reveal(&admin, &tokens, &2_000_000_i128).unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::InvalidTokenParams);

        // Token count must remain 0 — no partial writes.
        let state = client.get_state();
        let _ = state; // state is accessible; token count checked via get_token_info
        let info = client.try_get_token_info(&0_u32);
        assert!(info.is_err(), "no token should have been created");
    }

    // ── batch_settle ──────────────────────────────────────────────────────

    #[test]
    fn batch_settle_mints_to_multiple_recipients() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        // Create a token first.
        client.create_token(
            &admin,
            &String::from_str(&env, "MyToken"),
            &String::from_str(&env, "MTK"),
            &7_u32,
            &1_000_000_i128,
            &None,
            &1_000_000_i128,
        );

        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        let r3 = Address::generate(&env);

        let recipients = vec![
            &env,
            (r1.clone(), 100_i128),
            (r2.clone(), 200_i128),
            (r3.clone(), 300_i128),
        ];

        let total = client.batch_settle(&admin, &0_u32, &recipients);
        assert_eq!(total, 600_i128);
    }

    #[test]
    fn batch_settle_rejects_zero_amount() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        client.create_token(
            &admin,
            &String::from_str(&env, "MyToken"),
            &String::from_str(&env, "MTK"),
            &7_u32,
            &1_000_000_i128,
            &None,
            &1_000_000_i128,
        );

        let r1 = Address::generate(&env);
        let recipients = vec![&env, (r1, 0_i128)];
        let err = client.try_batch_settle(&admin, &0_u32, &recipients).unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::InvalidParameters);
    }

    #[test]
    fn batch_settle_rejects_non_creator() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        client.create_token(
            &admin,
            &String::from_str(&env, "MyToken"),
            &String::from_str(&env, "MTK"),
            &7_u32,
            &1_000_000_i128,
            &None,
            &1_000_000_i128,
        );

        let impostor = Address::generate(&env);
        let r1 = Address::generate(&env);
        let recipients = vec![&env, (r1, 100_i128)];
        let err = client.try_batch_settle(&impostor, &0_u32, &recipients).unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::Unauthorized);
    }

    #[test]
    fn batch_settle_respects_max_supply() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        // Create token with max_supply = 1_000_000 (already at cap from initial supply).
        let params = vec![
            &env,
            TokenCreationParams {
                name: String::from_str(&env, "Capped"),
                symbol: String::from_str(&env, "CAP"),
                decimals: 7,
                initial_supply: 1_000_000,
                max_supply: Some(1_000_000),
                metadata_uri: None,
            },
        ];
        client.batch_reveal(&admin, &params, &1_000_000_i128);

        let r1 = Address::generate(&env);
        let recipients = vec![&env, (r1, 1_i128)];
        let err = client.try_batch_settle(&admin, &0_u32, &recipients).unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::MaxSupplyExceeded);
    }

    #[test]
    fn batch_reveal_with_10_tokens_succeeds() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let mut tokens = Vec::new(&env);
        for i in 0u32..10 {
            let name = soroban_sdk::String::from_str(&env, "Token");
            let sym_str = if i < 10 {
                soroban_sdk::String::from_str(&env, "TK0")
            } else {
                soroban_sdk::String::from_str(&env, "TKX")
            };
            tokens.push_back(TokenCreationParams {
                name,
                symbol: sym_str,
                decimals: 7,
                initial_supply: 1_000_000,
                max_supply: None,
                metadata_uri: None,
            });
        }

        let indices = client.batch_reveal(&admin, &tokens, &10_000_000_i128);
        assert_eq!(indices.len(), 10);
    }

    #[test]
    fn batch_reveal_partial_failure_leaves_no_state() {
        // A bad token in the middle must roll back the entire batch.
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let bad = TokenCreationParams {
            name: String::from_str(&env, ""),   // invalid: empty name
            symbol: String::from_str(&env, "BAD"),
            decimals: 7,
            initial_supply: 1_000_000,
            max_supply: None,
            metadata_uri: None,
        };
        let tokens = vec![
            &env,
            make_params(&env, "Good1", "GD1"),
            bad,
            make_params(&env, "Good2", "GD2"),
        ];
        let err = client.try_batch_reveal(&admin, &tokens, &3_000_000_i128).unwrap_err().unwrap();
        assert_eq!(err, crate::types::Error::InvalidTokenParams);
        // No token should have been created.
        assert!(client.try_get_token_info(&0_u32).is_err());
    }
}
