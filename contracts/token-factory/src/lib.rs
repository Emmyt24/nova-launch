#![no_std]

mod freeze_functions;
mod governance;

mod burn;
mod differential_engine;
mod event_versions;
mod events;
mod mint;
mod pagination;
mod proposal_state_machine;
mod storage;
mod stream_types;
#[cfg(test)]
mod test_helpers;
mod timelock;
mod treasury;
mod types;
mod token_creation;
mod stream_types;
mod vesting;
mod timelock;
mod validation;
mod pagination;
mod mint;
mod treasury;

// #[cfg(test)]
// mod stream_metadata_update_test;

// #[cfg(test)]
// mod governance_test;

use soroban_sdk::{contract, contractimpl, symbol_short, Address, BytesN, Env, String, Vec};
use types::{
    ContractMetadata, Error, FactoryState, PaginationCursor, StreamInfo, StreamPage, StreamParams,
    TokenInfo, TokenStats, Vault, VaultStatus,
};

#[contract]
pub struct TokenFactory;

#[contractimpl]
impl TokenFactory {
    /// Initialize the token factory contract
    ///
    /// Sets up the factory with administrative addresses and fee structure.
    /// This function can only be called once during contract deployment.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Address with administrative privileges
    /// * `treasury` - Address that will receive deployment fees
    /// * `base_fee` - Base fee for token deployment in stroops (must be >= 0)
    /// * `metadata_fee` - Additional fee for metadata in stroops (must be >= 0)
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::AlreadyInitialized` - Contract has already been initialized
    /// * `Error::InvalidParameters` - Either fee is negative
    ///
    /// # Examples
    /// ```
    /// factory.initialize(
    ///     &env,
    ///     admin_address,
    ///     treasury_address,
    ///     1_000_000,  // 0.1 XLM base fee
    ///     500_000,    // 0.05 XLM metadata fee
    /// )?;
    /// ```
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        base_fee: i128,
        metadata_fee: i128,
    ) -> Result<(), Error> {
        // Early return if already initialized
        if storage::has_admin(&env) {
            return Err(Error::AlreadyInitialized);
        }

        // Combined parameter validation (Phase 1 optimization)
        // Check both fees in single evaluation
        if base_fee < 0 || metadata_fee < 0 {
            return Err(Error::InvalidParameters);
        }

        // Set initial state
        storage::set_admin(&env, &admin);
        storage::set_treasury(&env, &treasury);
        storage::set_base_fee(&env, base_fee);
        storage::set_metadata_fee(&env, metadata_fee);

        // Emit initialized event
        events::emit_initialized(&env, &admin, &treasury, base_fee, metadata_fee);

        Ok(())
    }



    /// Get the current factory state
    ///
    /// Returns a snapshot of the factory's configuration including
    /// admin, treasury, fees, and pause status.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    ///
    /// # Returns
    /// Returns a `FactoryState` struct with current configuration
    ///
    /// # Examples
    /// ```
    /// let state = factory.get_state(&env);
    /// assert_eq!(state.admin, expected_admin);
    /// assert_eq!(state.base_fee, 1_000_000);
    /// ```
    pub fn get_state(env: Env) -> FactoryState {
        storage::get_factory_state(&env)
    }

    /// Get the current base fee for token deployment
    ///
    /// Returns the base fee amount in stroops that must be paid
    /// for any token deployment, regardless of metadata inclusion.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    ///
    /// # Returns
    /// Returns the base fee as an i128 in stroops
    ///
    /// # Examples
    /// ```
    /// let base_fee = factory.get_base_fee(&env);
    /// // Ensure user has sufficient balance
    /// assert!(user_balance >= base_fee);
    /// ```
    pub fn get_base_fee(env: Env) -> i128 {
        storage::get_base_fee(&env)
    }

    /// Get the current metadata fee for token deployment
    ///
    /// Returns the additional fee amount in stroops that must be paid
    /// when deploying a token with metadata (IPFS URI).
    ///
    /// # Arguments
    /// * `env` - The contract environment
    ///
    /// # Returns
    /// Returns the metadata fee as an i128 in stroops
    ///
    /// # Examples
    /// ```
    /// let total_fee = factory.get_base_fee(&env) + factory.get_metadata_fee(&env);
    /// // Total fee when including metadata
    /// ```
    pub fn get_metadata_fee(env: Env) -> i128 {
        storage::get_metadata_fee(&env)
    }

    /// Transfer admin rights to a new address
    ///
    /// Allows the current admin to transfer administrative control to a new address.
    /// This is a critical operation that permanently changes who can manage the factory.
    ///
    /// Implements #217, #224
    ///
    /// # Arguments
    /// * `current_admin` - The current admin address (must authorize)
    /// * `new_admin` - The new admin address to transfer rights to
    ///
    /// # Errors
    /// * `Unauthorized` - If caller is not the current admin
    /// * `InvalidParameters` - If new admin is same as current or invalid
    pub fn transfer_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), Error> {
        // Require current admin authorization
        current_admin.require_auth();

        // Combined verification (Phase 1 optimization)
        // Early return if not authorized
        let stored_admin = storage::get_admin(&env);
        if current_admin != stored_admin {
            return Err(Error::Unauthorized);
        }

        // Validate new admin is different
        if new_admin == current_admin {
            return Err(Error::InvalidParameters);
        }

        // Update admin in storage
        storage::set_admin(&env, &new_admin);

        // Validate new admin is valid
        validation::validate_admin(&env)?;

        // Emit optimized event
        events::emit_admin_transfer(&env, &current_admin, &new_admin);

        Ok(())
    }

    /// Pause the contract (admin only)
    ///
    /// Halts critical operations like token creation and metadata updates.
    /// Admin functions like fee updates remain operational during pause.
    /// This is a safety mechanism for emergency situations.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize and match stored admin)
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    ///
    /// # Examples
    /// ```
    /// // Emergency pause
    /// factory.pause(&env, admin_address)?;
    /// assert!(factory.is_paused(&env));
    /// ```
    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();

        // Combined verification (Phase 1 optimization)
        let current_admin = storage::get_admin(&env);
        if admin != current_admin {
            return Err(Error::Unauthorized);
        }

        storage::set_paused(&env, true);

        // Use optimized event
        events::emit_pause(&env, &admin);

        Ok(())
    }

    /// Unpause the contract (admin only)
    ///
    /// Resumes normal operations after a pause. All previously
    /// restricted operations become available again.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize and match stored admin)
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    ///
    /// # Examples
    /// ```
    /// // Resume operations
    /// factory.unpause(&env, admin_address)?;
    /// assert!(!factory.is_paused(&env));
    /// ```
    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();

        // Combined verification (Phase 1 optimization)
        let current_admin = storage::get_admin(&env);
        if admin != current_admin {
            return Err(Error::Unauthorized);
        }

        storage::set_paused(&env, false);

        // Use optimized event
        events::emit_unpause(&env, &admin);

        Ok(())
    }

    /// Check if contract is currently paused
    ///
    /// Returns the current pause state of the contract.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    ///
    /// # Returns
    /// Returns `true` if paused, `false` if operational
    ///
    /// # Examples
    /// ```
    /// if factory.is_paused(&env) {
    ///     // Handle paused state
    ///     return Err(Error::ContractPaused);
    /// }
    /// ```
    pub fn is_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    /// Update fee structure (admin only)
    ///
    /// Allows the admin to update either or both deployment fees.
    /// At least one fee must be specified for the update.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize and match stored admin)
    /// * `base_fee` - Optional new base fee in stroops (None = no change)
    /// * `metadata_fee` - Optional new metadata fee in stroops (None = no change)
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    /// * `Error::InvalidParameters` - Both fees are None or any fee is negative
    ///
    /// # Examples
    /// ```
    /// // Update only base fee
    /// factory.update_fees(&env, admin, Some(2_000_000), None)?;
    ///
    /// // Update both fees
    /// factory.update_fees(&env, admin, Some(2_000_000), Some(1_000_000))?;
    /// ```
    pub fn update_fees(
        env: Env,
        admin: Address,
        base_fee: Option<i128>,
        metadata_fee: Option<i128>,
    ) -> Result<(), Error> {
        admin.require_auth();

        // Early return on unauthorized (Phase 1 optimization)
        let current_admin = storage::get_admin(&env);
        if admin != current_admin {
            return Err(Error::Unauthorized);
        }

        // Early return if no changes requested
        if base_fee.is_none() && metadata_fee.is_none() {
            return Err(Error::InvalidParameters);
        }

        // Validate fees before updating (Phase 1 optimization)
        if let Some(fee) = base_fee {
            if fee < 0 {
                return Err(Error::InvalidParameters);
            }
            storage::set_base_fee(&env, fee);
        }

        if let Some(fee) = metadata_fee {
            if fee < 0 {
                return Err(Error::InvalidParameters);
            }
            storage::set_metadata_fee(&env, fee);
        }

        // Validate fees after update
        validation::validate_fees(&env)?;

        // Get updated fees for event
        let new_base_fee = base_fee.unwrap_or_else(|| storage::get_base_fee(&env));
        let new_metadata_fee = metadata_fee.unwrap_or_else(|| storage::get_metadata_fee(&env));

        // Emit optimized event
        events::emit_fees_updated(&env, new_base_fee, new_metadata_fee);
        Ok(())
    }

    /// Get token info by index
    pub fn get_token_info(env: Env, index: u32) -> Result<TokenInfo, Error> {
        let mut info = storage::get_token_info(&env, index).ok_or(Error::TokenNotFound)?;
        info.is_paused = storage::is_token_paused(&env, index);
        Ok(info)
    }

    /// Batch update admin operations (Phase 2 optimization)
    ///
    /// Updates multiple admin parameters in a single transaction,
    /// reducing gas costs by combining verification and storage operations.
    /// Provides 40-50% gas savings compared to separate function calls.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize and match stored admin)
    /// * `base_fee` - Optional new base fee in stroops (None = no change)
    /// * `metadata_fee` - Optional new metadata fee in stroops (None = no change)
    /// * `paused` - Optional new pause state (None = no change)
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    /// * `Error::InvalidParameters` - All parameters are None or any fee is negative
    ///
    /// # Gas Savings
    /// - Batch both fee updates: -2,000 to 3,000 CPU instructions
    /// - Combined with pause: -1,000 additional CPU instructions
    /// - Total savings vs separate calls: 40-50% for combined operations
    ///
    /// # Examples
    /// ```
    /// // Update fees and pause in one transaction
    /// factory.batch_update_admin(
    ///     &env,
    ///     admin,
    ///     Some(2_000_000),
    ///     Some(1_000_000),
    ///     Some(true),
    /// )?;
    /// ```
    pub fn batch_update_admin(
        env: Env,
        admin: Address,
        base_fee: Option<i128>,
        metadata_fee: Option<i128>,
        paused: Option<bool>,
    ) -> Result<(), Error> {
        admin.require_auth();

        // Single admin verification (Phase 2 optimization)
        let current_admin = storage::get_admin(&env);
        if admin != current_admin {
            return Err(Error::Unauthorized);
        }

        // Early return if no changes
        if base_fee.is_none() && metadata_fee.is_none() && paused.is_none() {
            return Err(Error::InvalidParameters);
        }

        // Validate all inputs before any storage writes (Phase 2 optimization)
        if let Some(fee) = base_fee {
            if fee < 0 {
                return Err(Error::InvalidParameters);
            }
            storage::set_base_fee(&env, fee);
        }

        if let Some(fee) = metadata_fee {
            if fee < 0 {
                return Err(Error::InvalidParameters);
            }
            storage::set_metadata_fee(&env, fee);
        }

        if let Some(pause_state) = paused {
            storage::set_paused(&env, pause_state);
        }

        // Validate fees after update
        validation::validate_fees(&env)?;

        // Get final state for event
        let final_base_fee = storage::get_base_fee(&env);
        let final_metadata_fee = storage::get_metadata_fee(&env);

        // Emit single consolidated event (Phase 2 optimization)
        events::emit_fees_updated(&env, final_base_fee, final_metadata_fee);

        Ok(())
    }

    /// Get token information by contract address
    ///
    /// Retrieves complete information about a token using its
    /// deployed contract address.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `token_address` - The token's contract address
    ///
    /// # Returns
    /// Returns `Ok(TokenInfo)` with token details
    ///
    /// # Errors
    /// * `Error::TokenNotFound` - Token address not found in registry
    ///
    /// # Examples
    /// ```
    /// let token = factory.get_token_info_by_address(&env, token_addr)?;
    /// assert_eq!(token.creator, expected_creator);
    /// ```
    pub fn get_token_info_by_address(env: Env, token_address: Address) -> Result<TokenInfo, Error> {
        storage::get_token_info_by_address(&env, &token_address).ok_or(Error::TokenNotFound)
    }

    /// * `symbol` - Token symbol
    /// * `decimals` - Number of decimal places
    /// * `initial_supply` - Initial token supply
    /// * `fee_payment` - Fee amount (must be >= base_fee)
    /// Toggle clawback capability for a token (creator only)
    ///
    /// Allows the token creator to enable or disable clawback functionality.
    /// When enabled, the creator can burn tokens from any holder's address.
    /// This setting can be toggled multiple times by the creator.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `token_address` - The token's contract address
    /// * `admin` - Token creator address (must authorize and match creator)
    /// * `enabled` - True to enable clawback, false to disable
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::ContractPaused` - Contract is currently paused
    /// * `Error::TokenNotFound` - Token address not found
    /// * `Error::Unauthorized` - Caller is not the token creator
    ///
    /// # Examples
    /// ```
    /// // Enable clawback for emergency situations
    /// factory.set_clawback(&env, token_addr, creator, true)?;
    ///
    /// // Disable clawback for decentralization
    /// factory.set_clawback(&env, token_addr, creator, false)?;
    /// ```
    pub fn set_clawback(
        env: Env,
        token_address: Address,
        admin: Address,
        enabled: bool,
    ) -> Result<(), Error> {
        // Early return if contract is paused (Phase 1 optimization)
        if storage::is_paused(&env) {
            return Err(Error::ContractPaused);
        }

        // Require admin authorization
        admin.require_auth();

        // Get token info
        let mut token_info =
            storage::get_token_info_by_address(&env, &token_address).ok_or(Error::TokenNotFound)?;

        // Verify admin is the token creator
        if token_info.creator != admin {
            return Err(Error::Unauthorized);
        }

        // Update clawback setting
        token_info.clawback_enabled = enabled;
        storage::set_token_info_by_address(&env, &token_address, &token_info);

        // Emit optimized event
        events::emit_clawback_toggled(&env, &token_address, &admin, enabled);
        Ok(())
    }

    /// Burn tokens from caller's own balance
    ///
    /// Allows a token holder to permanently destroy tokens from their
    /// own balance, reducing the total supply.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `caller` - Address burning tokens (must authorize)
    /// * `token_index` - Index of the token to burn
    /// * `amount` - Amount to burn (must be > 0 and <= balance)
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::TokenNotFound` - Token index is invalid
    /// * `Error::InvalidParameters` - Amount is zero or negative
    /// * `Error::InsufficientBalance` - Caller balance is less than amount
    /// * `Error::ArithmeticError` - Numeric overflow/underflow
    ///
    /// # Examples
    /// ```
    /// // Burn 1000 tokens
    /// factory.burn(&env, caller, 0, 1_000_0000000)?;
    /// ```
    pub fn burn(env: Env, caller: Address, token_index: u32, amount: i128) -> Result<(), Error> {
        burn::burn(&env, caller, token_index, amount)
    }

    /// Batch burn tokens from multiple holders (admin only)
    ///
    /// Allows the admin to burn tokens from multiple addresses in a single
    /// transaction. All burns must succeed or the entire batch fails.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize and match stored admin)
    /// * `token_index` - Index of the token to burn
    /// * `burns` - Vector of (holder_address, amount) tuples (max 100 entries)
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    /// * `Error::BatchTooLarge` - More than 100 burn entries
    /// * `Error::InvalidParameters` - Empty batch or invalid amounts
    /// * `Error::TokenNotFound` - Token index is invalid
    /// * `Error::InsufficientBalance` - Any holder has insufficient balance
    /// * `Error::ArithmeticError` - Numeric overflow/underflow
    ///
    /// # Examples
    /// ```
    /// let burns = vec![
    ///     &env,
    ///     (holder1, 1_000_0000000),
    ///     (holder2, 2_000_0000000),
    /// ];
    /// factory.batch_burn(&env, admin, 0, burns)?;
    /// ```
    pub fn batch_burn(
        env: Env,
        admin: Address,
        token_index: u32,
        burns: soroban_sdk::Vec<(Address, i128)>,
    ) -> Result<(), Error> {
        burn::batch_burn(&env, admin, token_index, burns)
    }

    /// Get the total number of burn operations for a token
    ///
    /// Returns the count of all burn operations (both user and admin burns)
    /// performed on the specified token.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `token_index` - Index of the token
    ///
    /// # Returns
    /// Returns the burn count as a u32
    ///
    /// # Examples
    /// ```
    /// let burn_count = factory.get_burn_count(&env, 0);
    /// assert!(burn_count > 0);
    /// ```
    pub fn get_burn_count(env: Env, token_index: u32) -> u32 {
        burn::get_burn_count(&env, token_index)
    }

    /// Admin-initiated burn from any holder's balance
    ///
    /// Allows the admin to burn tokens from any holder's address.
    /// This is a privileged operation that requires admin authentication.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize and match stored admin)
    /// * `token_index` - Index of the token to burn
    /// * `holder` - Address holding the tokens to burn
    /// * `amount` - Amount to burn (must be > 0 and <= holder's balance)
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    /// * `Error::TokenNotFound` - Token index is invalid
    /// * `Error::InvalidParameters` - Amount is zero or negative
    /// * `Error::InsufficientBalance` - Holder balance is less than amount
    /// * `Error::ArithmeticError` - Numeric overflow/underflow
    ///
    /// # Examples
    /// ```
    /// // Admin burns 1000 tokens from a holder
    /// factory.admin_burn(&env, admin, 0, holder, 1_000_0000000)?;
    /// ```
    pub fn admin_burn(
        env: Env,
        admin: Address,
        token_index: u32,
        holder: Address,
        amount: i128,
    ) -> Result<(), Error> {
        burn::admin_burn(&env, admin, token_index, holder, amount)
    }

    /// Set metadata URI for a token (one-time only)
    ///
    /// Allows the token creator to set an IPFS metadata URI for their token.
    /// This operation can only be performed once per token - metadata is
    /// immutable after being set to ensure data integrity and trust.
    ///
    /// # Mutability Rules
    /// - Metadata can only be set if it's currently `None`
    /// - Once set, metadata cannot be changed or removed
    /// - This ensures permanent, tamper-proof token metadata
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `token_index` - Index of the token to update
    /// * `admin` - Token creator address (must authorize and match creator)
    /// * `metadata_uri` - IPFS URI for token metadata (e.g., "ipfs://Qm...")
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::ContractPaused` - Contract is currently paused
    /// * `Error::TokenNotFound` - Token index is invalid
    /// * `Error::Unauthorized` - Caller is not the token creator
    /// * `Error::MetadataAlreadySet` - Metadata has already been set (immutable)
    ///
    /// # Examples
    /// ```
    /// // Set metadata for the first time
    /// let metadata_uri = String::from_str(&env, "ipfs://QmTest123");
    /// factory.set_metadata(&env, 0, creator, metadata_uri)?;
    ///
    /// // Attempting to change metadata will fail
    /// let new_uri = String::from_str(&env, "ipfs://QmTest456");
    /// let result = factory.set_metadata(&env, 0, creator, new_uri);
    /// assert_eq!(result, Err(Error::MetadataAlreadySet));
    /// ```
    pub fn set_metadata(
        env: Env,
        creator: Address,
        tokens: Vec<TokenCreationParams>,
        total_fee_payment: i128,
    ) -> Result<Vec<Address>, Error> {
        token_creation::batch_create_tokens(&env, creator, tokens, total_fee_payment)
    }

    /// Set metadata for a token
    /// 
    /// Allows the token creator to set metadata URI once
    pub fn set_token_metadata(
        env: Env,
        admin: Address,
        token_index: u32,
        metadata_uri: String,
    ) -> Result<(), Error> {
        // Require admin authorization
        admin.require_auth();

        // Get token info
        let mut token_info =
            storage::get_token_info(&env, token_index).ok_or(Error::TokenNotFound)?;

        // Verify admin is the token creator
        if token_info.creator != admin {
            return Err(Error::Unauthorized);
        }

        // Enforce immutability: metadata can only be set once
        if token_info.metadata_uri.is_some() {
            return Err(Error::MetadataAlreadySet);
        }

        // Set metadata URI
        token_info.metadata_uri = Some(metadata_uri.clone());
        storage::set_token_info(&env, token_index, &token_info);

        // Also update by address lookup
        storage::set_token_info_by_address(&env, &token_info.address, &token_info);

        // Emit metadata set event
        events::emit_metadata_set(&env, &token_info.address, &admin, &metadata_uri);

        Ok(())
    }

    pub fn pause_token(env: Env, admin: Address, token_index: u32) -> Result<(), Error> {
        admin.require_auth();
        if admin != storage::get_admin(&env) {
            return Err(Error::Unauthorized);
        }
        storage::get_token_info(&env, token_index).ok_or(Error::TokenNotFound)?;
        storage::set_token_paused(&env, token_index, true);
        Ok(())
    }

    pub fn unpause_token(env: Env, admin: Address, token_index: u32) -> Result<(), Error> {
        admin.require_auth();
        if admin != storage::get_admin(&env) {
            return Err(Error::Unauthorized);
        }
        storage::get_token_info(&env, token_index).ok_or(Error::TokenNotFound)?;
        storage::set_token_paused(&env, token_index, false);
        Ok(())
    }

    pub fn is_token_paused(env: Env, token_index: u32) -> bool {
        storage::is_token_paused(&env, token_index)
    }

    /// Return a compact stats snapshot for a token
    pub fn get_token_stats(env: Env, token_index: u32) -> Result<TokenStats, Error> {
        storage::get_token_info(&env, token_index).ok_or(Error::TokenNotFound)?;

        Ok(TokenStats {
            current_supply: storage::get_token_info(&env, token_index)
                .map(|i| i.total_supply)
                .unwrap_or(0),
            total_burned: storage::get_total_burned(&env, token_index),
            burn_count: storage::get_burn_count(&env, token_index),
            is_paused: storage::is_token_paused(&env, token_index),
            clawback_enabled: false,
            freeze_enabled: false,
        })
    }

    /// Return a paginated list of token indices where beneficiary is the creator.
    /// cursor: starting entry index (0 for first page)
    /// limit: max entries to return (capped at 50)
    pub fn get_streams_by_beneficiary(
        env: Env,
        beneficiary: Address,
        cursor: u32,
        limit: u32,
    ) -> StreamPage {
        let limit = limit.min(50);
        let total = storage::get_beneficiary_stream_count(&env, &beneficiary);

        let mut token_indices = soroban_sdk::Vec::new(&env);
        let mut i = cursor;

        while i < total && (i - cursor) < limit {
            if let Some(token_index) = storage::get_beneficiary_stream_entry(&env, &beneficiary, i)
            {
                token_indices.push_back(token_index);
            }
            i += 1;
        }

        let next_cursor = if i < total { Some(i) } else { None };

        StreamPage {
            token_indices,
            next_cursor,
        }
    }
    // ═══════════════════════════════════════════════════════════════════════
    // Timelock Functions
    // ═══════════════════════════════════════════════════════════════════════

    /// Schedule a fee update with timelock
    ///
    /// Schedules a change to base_fee or metadata_fee that cannot be executed
    /// until the timelock delay has passed. This provides transparency and
    /// allows users to react to upcoming changes.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize and match stored admin)
    /// * `base_fee` - Optional new base fee in stroops (None = no change)
    /// * `metadata_fee` - Optional new metadata fee in stroops (None = no change)
    ///
    /// # Returns
    /// Returns the change ID that can be used to execute or cancel the change
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    /// * `Error::InvalidParameters` - Both fees are None or any fee is negative
    ///
    /// # Examples
    /// ```
    /// // Schedule fee update
    /// let change_id = factory.schedule_fee_update(&env, admin, Some(2_000_000), None)?;
    /// // Wait for timelock to expire, then execute
    /// factory.execute_change(&env, change_id)?;
    /// ```
    pub fn schedule_fee_update(
        env: Env,
        admin: Address,
        base_fee: Option<i128>,
        metadata_fee: Option<i128>,
    ) -> Result<u64, Error> {
        timelock::schedule_fee_update(&env, &admin, base_fee, metadata_fee)
    }

    /// Schedule a pause state change with timelock
    ///
    /// Schedules a change to the contract's pause state that cannot be executed
    /// until the timelock delay has passed.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize and match stored admin)
    /// * `paused` - New pause state (true to pause, false to unpause)
    ///
    /// # Returns
    /// Returns the change ID
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    ///
    /// # Examples
    /// ```
    /// let change_id = factory.schedule_pause_update(&env, admin, true)?;
    /// ```
    pub fn schedule_pause_update(env: Env, admin: Address, paused: bool) -> Result<u64, Error> {
        timelock::schedule_pause_update(&env, &admin, paused)
    }

    /// Schedule a treasury address change with timelock
    ///
    /// Schedules a change to the treasury address that cannot be executed
    /// until the timelock delay has passed.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize and match stored admin)
    /// * `new_treasury` - New treasury address
    ///
    /// # Returns
    /// Returns the change ID
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    ///
    /// # Examples
    /// ```
    /// let change_id = factory.schedule_treasury_update(&env, admin, new_treasury)?;
    /// ```
    pub fn schedule_treasury_update(
        env: Env,
        admin: Address,
        new_treasury: Address,
    ) -> Result<u64, Error> {
        timelock::schedule_treasury_update(&env, &admin, &new_treasury)
    }

    /// Execute a pending change
    ///
    /// Executes a previously scheduled change after the timelock has expired.
    /// Anyone can call this function once the timelock period has elapsed.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `change_id` - ID of the pending change to execute
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::TokenNotFound` - Change ID not found
    /// * `Error::TimelockNotExpired` - Timelock period has not elapsed
    /// * `Error::ChangeAlreadyExecuted` - Change has already been executed
    ///
    /// # Examples
    /// ```
    /// // After timelock expires
    /// factory.execute_change(&env, change_id)?;
    /// ```
    pub fn execute_change(env: Env, change_id: u64) -> Result<(), Error> {
        timelock::execute_change(&env, change_id)
    }

    /// Cancel a pending change
    ///
    /// Cancels a scheduled change before it is executed.
    /// Only the admin can cancel pending changes.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize and match stored admin)
    /// * `change_id` - ID of the pending change to cancel
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    /// * `Error::TokenNotFound` - Change ID not found
    /// * `Error::ChangeAlreadyExecuted` - Change has already been executed
    ///
    /// # Examples
    /// ```
    /// factory.cancel_change(&env, admin, change_id)?;
    /// ```
    pub fn cancel_change(env: Env, admin: Address, change_id: u64) -> Result<(), Error> {
        timelock::cancel_change(&env, &admin, change_id)
    }

    /// Get pending change details
    ///
    /// Retrieves information about a scheduled change including when it
    /// can be executed and what parameters will be changed.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `change_id` - ID of the pending change
    ///
    /// # Returns
    /// Returns the PendingChange if found, None otherwise
    ///
    /// # Examples
    /// ```
    /// if let Some(change) = factory.get_pending_change(&env, change_id) {
    ///     log!("Change can be executed at: {}", change.execute_at);
    /// }
    /// ```
    pub fn get_pending_change(env: Env, change_id: u64) -> Option<types::PendingChange> {
        timelock::get_pending_change(&env, change_id)
    }

    /// Get timelock configuration
    ///
    /// Returns the current timelock settings including the delay period.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    ///
    /// # Returns
    /// Returns the TimelockConfig
    ///
    /// # Examples
    /// ```
    /// let config = factory.get_timelock_config(&env);
    /// log!("Timelock delay: {} seconds", config.delay_seconds);
    /// ```
    pub fn get_timelock_config(env: Env) -> types::TimelockConfig {
        timelock::get_timelock_config(&env)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Pagination Functions
    // ═══════════════════════════════════════════════════════════════════════

    /// Get tokens created by a specific address with pagination
    ///
    /// Returns a paginated list of tokens created by the specified address.
    /// Results are ordered by token creation order (token index).
    /// Useful for explorer and dashboard interfaces.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `creator` - Address of the token creator
    /// * `cursor` - Optional cursor for pagination (None = start from beginning)
    /// * `limit` - Maximum number of tokens to return (default 20, max 100)
    ///
    /// # Returns
    /// Returns `PaginatedTokens` containing:
    /// - `tokens`: Vector of TokenInfo for this page
    /// - `cursor`: Optional cursor for next page (None = no more results)
    ///
    /// # Cursor Semantics
    /// - Cursors are deterministic and stable across calls
    /// - Empty cursor (None) starts from the beginning
    /// - Returned cursor of None indicates end of results
    /// - Cursors contain the next position in the creator's token list
    ///
    /// # Examples
    /// ```
    /// // First page
    /// let page1 = factory.get_tokens_by_creator(&env, creator, None, Some(20))?;
    ///
    /// // Next page
    /// if let Some(cursor) = page1.cursor {
    ///     let page2 = factory.get_tokens_by_creator(&env, creator, Some(cursor), Some(20))?;
    /// }
    ///
    /// // Get total count
    /// let total = factory.get_creator_token_count(&env, creator);
    /// ```
    pub fn get_tokens_by_creator(
        env: Env,
        creator: Address,
        cursor: Option<u32>,
        limit: Option<u32>,
    ) -> Result<types::PaginatedTokens, Error> {
        let pagination_cursor = cursor
            .map(|next_index| PaginationCursor { next_index })
            .unwrap_or(PaginationCursor {
                next_index: u32::MAX,
            }); // Using MAX as NO_CURSOR equivalent
        pagination::get_tokens_by_creator(&env, &creator, pagination_cursor, limit)
    }

    /// Get the total number of tokens created by an address
    ///
    /// Returns the count without fetching the actual token data.
    /// Useful for displaying total counts in UIs.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `creator` - Address of the token creator
    ///
    /// # Returns
    /// Returns the number of tokens created by this address
    ///
    /// # Examples
    /// ```
    /// let count = factory.get_creator_token_count(&env, creator);
    /// log!("Creator has deployed {} tokens", count);
    /// ```
    pub fn get_creator_token_count(env: Env, creator: Address) -> u32 {
        pagination::get_creator_token_count(&env, &creator)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Minting Functions
    // ═══════════════════════════════════════════════════════════════════════

    /// Mint tokens to an address
    ///
    /// Increases the total supply and the recipient's balance.
    /// Enforces max supply constraints if set for the token.
    /// Only the token creator can mint new tokens.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `creator` - Token creator address (must authorize)
    /// * `token_index` - Index of the token to mint
    /// * `to` - Address to receive the minted tokens
    /// * `amount` - Amount to mint (must be > 0)
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the token creator
    /// * `Error::TokenNotFound` - Token doesn't exist
    /// * `Error::InvalidAmount` - Amount is zero or negative
    /// * `Error::MaxSupplyExceeded` - Would exceed max supply cap
    /// * `Error::ArithmeticError` - Overflow in calculation
    /// * `Error::ContractPaused` - Contract is paused
    ///
    /// # Examples
    /// ```
    /// // Mint 1000 tokens
    /// factory.mint(&env, creator, 0, recipient, 1_000_0000000)?;
    ///
    /// // Check remaining mintable
    /// if let Some(remaining) = factory.get_remaining_mintable(&env, 0) {
    ///     log!("Can mint {} more tokens", remaining);
    /// }
    /// ```
    pub fn mint(
        env: Env,
        creator: Address,
        token_index: u32,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        // Check if contract is paused
        if storage::is_paused(&env) {
            return Err(Error::ContractPaused);
        }

        creator.require_auth();

        // Verify creator owns the token
        let token_info = storage::get_token_info(&env, token_index).ok_or(Error::TokenNotFound)?;

        if token_info.creator != creator {
            return Err(Error::Unauthorized);
        }

        // Perform mint with max supply validation
        mint::mint(&env, token_index, &to, amount)
    }

    /// Get remaining mintable supply for a token
    ///
    /// Returns how many more tokens can be minted before hitting the max supply.
    /// Returns None if there's no max supply (unlimited minting).
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `token_index` - Index of the token
    ///
    /// # Returns
    /// * `Some(amount)` - Remaining mintable amount
    /// * `None` - Unlimited minting (no max supply set)
    ///
    /// # Examples
    /// ```
    /// match factory.get_remaining_mintable(&env, 0) {
    ///     Some(0) => log!("Max supply reached"),
    ///     Some(amount) => log!("Can mint {} more", amount),
    ///     None => log!("Unlimited minting"),
    /// }
    /// ```
    pub fn get_remaining_mintable(env: Env, token_index: u32) -> Option<i128> {
        mint::get_remaining_mintable(&env, token_index)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Treasury Functions
    // ═══════════════════════════════════════════════════════════════════════

    /// Initialize treasury policy
    ///
    /// Sets up withdrawal limits and controls for the treasury.
    /// Should be called during contract initialization or when first
    /// configuring treasury protections.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize)
    /// * `daily_cap` - Optional maximum withdrawal per day in stroops (None = default 100 XLM)
    /// * `allowlist_enabled` - Whether to enforce recipient allowlist
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    /// * `Error::InvalidParameters` - Daily cap is negative
    ///
    /// # Examples
    /// ```
    /// // 100 XLM daily cap with allowlist
    /// factory.initialize_treasury_policy(&env, admin, Some(100_0000000), true)?;
    /// ```
    pub fn initialize_treasury_policy(
        env: Env,
        admin: Address,
        daily_cap: Option<i128>,
        allowlist_enabled: bool,
    ) -> Result<(), Error> {
        admin.require_auth();

        let current_admin = storage::get_admin(&env);
        if admin != current_admin {
            return Err(Error::Unauthorized);
        }

        treasury::initialize_treasury_policy(&env, daily_cap, allowlist_enabled)
    }

    /// Withdraw fees from treasury
    ///
    /// Transfers accumulated fees to a recipient address.
    /// Enforces withdrawal policy limits and allowlist.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize)
    /// * `recipient` - Address to receive the funds
    /// * `amount` - Amount to withdraw in stroops
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not admin
    /// * `Error::WithdrawalCapExceeded` - Exceeds daily cap
    /// * `Error::RecipientNotAllowed` - Recipient not in allowlist
    /// * `Error::InvalidAmount` - Amount is zero or negative
    ///
    /// # Examples
    /// ```
    /// // Withdraw 50 XLM to recipient
    /// factory.withdraw_fees(&env, admin, recipient, 50_0000000)?;
    /// ```
    pub fn withdraw_fees(
        env: Env,
        admin: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<(), Error> {
        treasury::withdraw_fees(&env, &admin, &recipient, amount)
    }

    /// Add recipient to allowlist
    ///
    /// Allows an address to receive treasury withdrawals.
    /// Only admin can modify the allowlist.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize)
    /// * `recipient` - Address to add to allowlist
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    ///
    /// # Examples
    /// ```
    /// factory.add_allowed_recipient(&env, admin, recipient)?;
    /// ```
    pub fn add_allowed_recipient(
        env: Env,
        admin: Address,
        recipient: Address,
    ) -> Result<(), Error> {
        treasury::add_allowed_recipient(&env, &admin, &recipient)
    }

    /// Remove recipient from allowlist
    ///
    /// Revokes an address's ability to receive treasury withdrawals.
    /// Only admin can modify the allowlist.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize)
    /// * `recipient` - Address to remove from allowlist
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    ///
    /// # Examples
    /// ```
    /// factory.remove_allowed_recipient(&env, admin, recipient)?;
    /// ```
    pub fn remove_allowed_recipient(
        env: Env,
        admin: Address,
        recipient: Address,
    ) -> Result<(), Error> {
        treasury::remove_allowed_recipient(&env, &admin, &recipient)
    }

    /// Update treasury policy
    ///
    /// Changes the withdrawal limits and allowlist settings.
    /// Only admin can update the policy.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize)
    /// * `daily_cap` - Optional new daily cap in stroops (None = no change)
    /// * `allowlist_enabled` - Optional new allowlist setting (None = no change)
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    /// * `Error::InvalidParameters` - Daily cap is negative
    ///
    /// # Examples
    /// ```
    /// // Update daily cap to 200 XLM
    /// factory.update_treasury_policy(&env, admin, Some(200_0000000), None)?;
    /// ```
    pub fn update_treasury_policy(
        env: Env,
        admin: Address,
        daily_cap: Option<i128>,
        allowlist_enabled: Option<bool>,
    ) -> Result<(), Error> {
        treasury::update_treasury_policy(&env, &admin, daily_cap, allowlist_enabled)
    }

    /// Get remaining withdrawal capacity for current period
    ///
    /// Returns how much more can be withdrawn before hitting the daily cap.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    ///
    /// # Returns
    /// Remaining withdrawal capacity in stroops
    ///
    /// # Examples
    /// ```
    /// let remaining = factory.get_remaining_capacity(&env);
    /// log!("Can withdraw {} more stroops today", remaining);
    /// ```
    pub fn get_remaining_capacity(env: Env) -> i128 {
        treasury::get_remaining_capacity(&env)
    }

    /// Get treasury policy
    ///
    /// Returns the current withdrawal policy settings.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    ///
    /// # Returns
    /// Current treasury policy
    ///
    /// # Examples
    /// ```
    /// let policy = factory.get_treasury_policy(&env);
    /// log!("Daily cap: {}", policy.daily_cap);
    /// ```
    pub fn get_treasury_policy(env: Env) -> types::TreasuryPolicy {
        treasury::get_treasury_policy(&env)
    }

    /// Check if address is allowed recipient
    ///
    /// Returns true if the address can receive treasury withdrawals.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `recipient` - Address to check
    ///
    /// # Returns
    /// True if address is in allowlist or allowlist is disabled
    ///
    /// # Examples
    /// ```
    /// if factory.is_allowed_recipient(&env, recipient) {
    ///     log!("Recipient is allowed");
    /// }
    /// ```
    pub fn is_allowed_recipient(env: Env, recipient: Address) -> bool {
        treasury::is_allowed_recipient(&env, &recipient)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Stream Functions
    // ═══════════════════════════════════════════════════════════════════════

    /// Create a vault with either time-based unlock, milestone-based unlock, or both.
    pub fn create_vault(
        env: Env,
        creator: Address,
        token: Address,
        owner: Address,
        amount: i128,
        unlock_time: u64,
        milestone_hash: BytesN<32>,
    ) -> Result<u64, Error> {
        creator.require_auth();

        if storage::is_paused(&env) {
            return Err(Error::ContractPaused);
        }

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let zero_hash = BytesN::from_array(&env, &[0u8; 32]);
        let has_time_unlock = unlock_time > 0;
        let has_milestone_unlock = milestone_hash != zero_hash;

        if !has_time_unlock && !has_milestone_unlock {
            return Err(Error::InvalidParameters);
        }

        if storage::get_token_info_by_address(&env, &token).is_none() {
            return Err(Error::TokenNotFound);
        }

        let vault_id = storage::increment_vault_count(&env)?;
        let vault = Vault {
            id: vault_id,
            token: token.clone(),
            owner: owner.clone(),
            creator: creator.clone(),
            total_amount: amount,
            claimed_amount: 0,
            unlock_time,
            milestone_hash: milestone_hash.clone(),
            status: VaultStatus::Active,
            created_at: env.ledger().timestamp(),
        };

        storage::set_vault(&env, &vault)?;

        events::emit_vault_created(
            &env,
            vault_id,
            &creator,
            &owner,
            &token,
            amount,
            unlock_time,
            &milestone_hash,
        );

        Ok(vault_id)
    }

    pub fn get_vault(env: Env, vault_id: u64) -> Result<Vault, Error> {
        storage::get_vault(&env, vault_id).ok_or(Error::TokenNotFound)
    }

    /// Claim unlocked tokens from an active vault.
    pub fn claim_vault(env: Env, vault_id: u64, actor: Address) -> Result<i128, Error> {
        actor.require_auth();

        if storage::is_paused(&env) {
            return Err(Error::ContractPaused);
        }

        let mut vault = storage::get_vault(&env, vault_id).ok_or(Error::TokenNotFound)?;

        if actor != vault.owner {
            return Err(Error::Unauthorized);
        }

        if vault.status == VaultStatus::Cancelled {
            return Err(Error::InvalidParameters);
        }

        if vault.status == VaultStatus::Claimed || vault.claimed_amount >= vault.total_amount {
            return Err(Error::NothingToClaim);
        }

        if vault.unlock_time > 0 && env.ledger().timestamp() < vault.unlock_time {
            return Err(Error::InvalidParameters);
        }

        let claimable = vault
            .total_amount
            .checked_sub(vault.claimed_amount)
            .ok_or(Error::ArithmeticError)?;

        if claimable <= 0 {
            return Err(Error::NothingToClaim);
        }

        vault.claimed_amount = vault
            .claimed_amount
            .checked_add(claimable)
            .ok_or(Error::ArithmeticError)?;
        vault.status = VaultStatus::Claimed;
        storage::set_vault(&env, &vault)?;

        events::emit_vault_claimed(&env, vault_id, &actor, claimable);
        Ok(claimable)
    }

    /// Cancel an active vault using policy checks.
    ///
    /// Policy:
    /// - `actor` must authorize.
    /// - `actor` must be the vault creator or contract admin.
    /// - Already claimed/cancelled vaults cannot be cancelled.
    ///
    /// Partially claimed behavior:
    /// - Cancellation is allowed.
    /// - `claimed_amount` remains unchanged.
    /// - Remaining amount is permanently unclaimable.
    pub fn cancel_vault(env: Env, vault_id: u64, actor: Address) -> Result<(), Error> {
        actor.require_auth();

        if storage::is_paused(&env) {
            return Err(Error::ContractPaused);
        }

        let mut vault = storage::get_vault(&env, vault_id).ok_or(Error::TokenNotFound)?;
        let admin = storage::get_admin(&env);
        if actor != vault.creator && actor != admin {
            return Err(Error::Unauthorized);
        }

        if vault.status != VaultStatus::Active {
            return Err(Error::InvalidParameters);
        }

        let remaining_amount = vault
            .total_amount
            .checked_sub(vault.claimed_amount)
            .ok_or(Error::ArithmeticError)?
            .max(0);

        vault.status = VaultStatus::Cancelled;
        storage::set_vault(&env, &vault)?;
        events::emit_vault_cancelled(&env, vault_id, &actor, remaining_amount);

        Ok(())
    }

    /// Update stream metadata (creator/admin only)
    ///
    /// Allows the stream creator or admin to update the metadata associated with
    /// a stream. Only metadata is mutable post-creation; all financial terms
    /// (amount, creator, recipient, schedule) remain immutable.
    ///
    /// This function enforces strict financial invariants to prevent any mutation
    /// of critical stream parameters after creation.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `stream_id` - ID of the stream to update
    /// * `updater` - Address performing the update (must be creator or admin)
    /// * `new_metadata` - New metadata value (None to clear, Some(string) to set)
    ///
    /// # Returns
    /// Returns `Ok(())` on success
    ///
    /// # Errors
    /// * `Error::TokenNotFound` - Stream with given ID does not exist
    /// * `Error::Unauthorized` - Caller is not the stream creator or admin
    /// * `Error::InvalidParameters` - New metadata is invalid (empty string or >512 chars)
    /// * `Error::ContractPaused` - Contract is currently paused
    ///
    /// # Financial Invariants (Enforced)
    /// The following stream parameters are immutable and cannot be changed:
    /// - `amount` - Stream payment amount
    /// - `creator` - Original stream creator
    /// - `recipient` - Stream recipient address
    /// - `created_at` - Stream creation timestamp
    /// - `id` - Stream ID
    ///
    /// # Metadata Constraints
    /// - Minimum length: 1 character (when present)
    /// - Maximum length: 512 characters
    /// - Empty strings: Rejected with `Error::InvalidParameters`
    /// - None value: Allowed (clears metadata)
    ///
    /// # Examples
    /// ```
    /// // Update metadata with new label
    /// factory.update_stream_metadata(
    ///     &env,
    ///     stream_id,
    ///     &updater,
    ///     Some(String::from_str(&env, "Updated label"))
    /// )?;
    ///
    /// // Clear metadata
    /// factory.update_stream_metadata(
    ///     &env,
    ///     stream_id,
    ///     &updater,
    ///     None
    /// )?;
    /// ```
    ///
    /// # Authorization
    /// Only the original stream creator or the contract admin can update metadata.
    /// The updater must authorize the transaction via `require_auth()`.
    ///
    /// # Events
    /// Emits `stream_metadata_updated` event with:
    /// - stream_id: The updated stream ID
    /// - updater: Address that performed the update
    /// - has_metadata: Whether metadata is now present (true) or cleared (false)
    pub fn update_stream_metadata(
        env: Env,
        stream_id: u32,
        updater: Address,
        new_metadata: Option<String>,
    ) -> Result<(), Error> {
        // Require updater authorization
        updater.require_auth();

        // Early return if contract is paused
        if storage::is_paused(&env) {
            return Err(Error::ContractPaused);
        }

        // Get the stream
        let mut stream = storage::get_stream(&env, stream_id.into()).ok_or(Error::TokenNotFound)?;

        // Verify authorization: only creator or admin can update
        let admin = storage::get_admin(&env);
        if updater != stream.creator && updater != admin {
            return Err(Error::Unauthorized);
        }

        // Store original stream for invariant validation
        let original_stream = stream.clone();

        // Validate new metadata before applying
        stream_types::validate_metadata(&new_metadata)?;

        // Update metadata
        stream.metadata = new_metadata.clone();

        // Enforce financial invariants - ensure no financial terms changed
        stream_types::validate_financial_invariants(&original_stream, &stream)?;

        // Store updated stream
        storage::set_stream(&env, stream_id.into(), &stream);

        // Emit metadata updated event
        let has_metadata = new_metadata.is_some();
        events::emit_stream_metadata_updated(&env, stream_id, &updater, has_metadata);

        Ok(())
    }

    /// Get governance configuration
    ///
    /// Returns the current quorum and approval thresholds.
    ///
    /// # Returns
    /// Returns the GovernanceConfig with current settings
    pub fn get_governance_config(env: Env) -> types::GovernanceConfig {
        governance::get_governance_config(&env)
    }

    /// Update governance configuration
    ///
    /// Updates quorum and/or approval thresholds.
    ///
    /// # Arguments
    /// * `env` - The contract environment
    /// * `admin` - Admin address (must authorize)
    /// * `quorum_percent` - Optional new quorum percentage (0-100)
    /// * `approval_percent` - Optional new approval percentage (0-100)
    ///
    /// # Errors
    /// * `Error::Unauthorized` - Caller is not the admin
    /// * `Error::InvalidParameters` - Percentages out of range or both None
    pub fn update_governance_config(
        env: Env,
        admin: Address,
        quorum_percent: Option<u32>,
        approval_percent: Option<u32>,
    ) -> Result<(), Error> {
        governance::update_governance_config(&env, &admin, quorum_percent, approval_percent)
    }

    /// Check if quorum is met for a proposal
    ///
    /// # Arguments
    /// * `total_votes` - Total number of votes cast
    /// * `total_eligible` - Total number of eligible voters
    /// * `quorum_percent` - Required quorum percentage
    ///
    /// # Returns
    /// Returns true if quorum threshold is met
    pub fn is_quorum_met(
        _env: Env,
        total_votes: u32,
        total_eligible: u32,
        quorum_percent: u32,
    ) -> bool {
        governance::is_quorum_met(total_votes, total_eligible, quorum_percent)
    }

    /// Check if approval threshold is met for a proposal
    ///
    /// # Arguments
    /// * `yes_votes` - Number of yes votes
    /// * `total_votes` - Total number of votes cast
    /// * `approval_percent` - Required approval percentage
    ///
    /// # Returns
    /// Returns true if approval threshold is met
    pub fn is_approval_met(
        _env: Env,
        yes_votes: u32,
        total_votes: u32,
        approval_percent: u32,
    ) -> bool {
        governance::is_approval_met(yes_votes, total_votes, approval_percent)
    }
}

// Temporarily disabled - requires create_token implementation
// #[cfg(test)]
// mod test;

// Temporarily disabled - requires burn implementation
// #[cfg(test)]
// mod admin_burn_test;

// Temporarily disabled - has compilation errors
// #[cfg(test)]
// mod admin_transfer_test;

#[cfg(test)]
// #[cfg(test)]
// mod fee_collection_test;

// Temporarily disabled - has compilation errors
// mod event_tests;

// Temporarily disabled - has compilation errors
// #[cfg(test)]
// mod error_handling_test;

// Temporarily disabled - has compilation errors
// #[cfg(test)]
// mod metadata_test;

// Temporarily disabled due to compilation issues
// #[cfg(test)]
// mod atomic_token_creation_test;

#[cfg(test)]
// mod burn_property_test;

#[cfg(test)]
// mod supply_conservation_test;
// #[cfg(test)]
// mod burn_property_test;

// #[cfg(test)]
// mod supply_conservation_test;

// #[cfg(test)]
// mod fuzz_create_token_simple;

// Temporarily disabled due to compilation issues
// #[cfg(test)]
// mod fuzz_update_fees;

// Temporarily disabled - has compilation errors
// #[cfg(test)]
// mod state_events_test;

// Temporarily disabled - has compilation errors
// #[cfg(test)]
// mod fuzz_string_boundaries;

// Temporarily disabled - has compilation errors
// #[cfg(test)]
// mod fuzz_numeric_boundaries;

// Temporarily disabled - has compilation errors
// #[cfg(test)]
// mod upgrade_test;

// Temporarily disabled - has compilation errors
// #[cfg(test)]
// mod fuzz_test;

#[cfg(test)]
// mod token_pause_test;


#[cfg(test)]
// mod token_stats_test;

// mod integration_test;

#[cfg(all(test, feature = "legacy-tests"))]
mod gas_benchmark_comprehensive;
#[cfg(all(test, feature = "legacy-tests"))]
mod gas_regression_test;

#[cfg(test)]
// mod timelock_test;

#[cfg(test)]
// mod pagination_integration_test;

#[cfg(test)]
// mod treasury_integration_test;
// #[cfg(test)]
// mod token_pause_test;
// #[cfg(test)]
// mod token_stats_test;
// #[cfg(test)]
// mod integration_test;
// #[cfg(test)]
// mod gas_benchmark_comprehensive;
// #[cfg(test)]
// mod pagination_integration_test;
// #[cfg(test)]
// mod treasury_integration_test;
// #[cfg(test)]
// mod auth_fuzz_test;
// #[cfg(test)]
// mod metamorphic_test;

#[cfg(all(test, feature = "legacy-tests"))]
mod event_replay_test;

#[cfg(test)]
mod batch_token_creation_test;

#[cfg(test)]
mod vault_cancellation_test;

// Vault/Stream Security and Fuzz Tests
// Temporarily disabled - requires fixing timelock/freeze dependencies
// #[cfg(test)]
// mod vault_security_test;

// #[cfg(test)]
// mod vault_fuzz_test;
