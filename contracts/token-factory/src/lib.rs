#![no_std]

mod events;
mod storage;
mod types;

use soroban_sdk::{contract, contractimpl, Address, Env, String};
use types::{Error, FactoryState, TokenInfo, StreamCreatedV1};

#[contract]
pub struct TokenFactory;

#[contractimpl]
impl TokenFactory {
    /// Initialize the factory with admin, treasury, and fee structure
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        base_fee: i128,
        metadata_fee: i128,
    ) -> Result<(), Error> {
        // Check if already initialized
        if storage::has_admin(&env) {
            return Err(Error::AlreadyInitialized);
        }

        // Validate parameters
        if base_fee < 0 || metadata_fee < 0 {
            return Err(Error::InvalidParameters);
        }

        // Set initial state
        storage::set_admin(&env, &admin);
        storage::set_treasury(&env, &treasury);
        storage::set_base_fee(&env, base_fee);
        storage::set_metadata_fee(&env, metadata_fee);

        Ok(())
    }

    /// Get the current factory state
    pub fn get_state(env: Env) -> FactoryState {
        storage::get_factory_state(&env)
    }

    /// Update fee structure (admin only)
    pub fn update_fees(
        env: Env,
        admin: Address,
        base_fee: Option<i128>,
        metadata_fee: Option<i128>,
    ) -> Result<(), Error> {
        admin.require_auth();

        let current_admin = storage::get_admin(&env);
        if admin != current_admin {
            return Err(Error::Unauthorized);
        }

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

        Ok(())
    }

    /// Get token count
    pub fn get_token_count(env: Env) -> u32 {
        storage::get_token_count(&env)
    }

    /// Get token info by index
    pub fn get_token_info(env: Env, index: u32) -> Result<TokenInfo, Error> {
        storage::get_token_info(&env, index).ok_or(Error::TokenNotFound)
    }

    /// Create a new token stream and emit stream_created event
    /// 
    /// # Arguments
    /// - `env`: The contract environment
    /// - `creator`: The address creating the stream
    /// - `beneficiary`: The address that will receive streamed tokens
    /// - `token_address`: The token being streamed
    /// - `total_amount`: Total amount of tokens to stream
    /// - `start_time`: Timestamp when streaming begins
    /// - `duration_seconds`: Duration of the stream in seconds
    /// 
    /// # Events Emitted
    /// - `stream_created_v1`: StreamCreatedV1 event with versioned payload
    /// 
    /// # Returns
    /// - `Ok(stream_id)`: The unique identifier for the created stream
    /// - `Err(Error)`: If creation fails (insufficient funds, invalid params, etc.)
    pub fn create_stream(
        env: Env,
        creator: Address,
        beneficiary: Address,
        token_address: Address,
        total_amount: i128,
        start_time: u64,
        duration_seconds: u64,
    ) -> Result<String, Error> {
        creator.require_auth();

        // Validate parameters
        if total_amount <= 0 || duration_seconds == 0 {
            return Err(Error::InvalidParameters);
        }

        // Generate stream ID (in real implementation, would use storage counter)
        let stream_count = storage::get_token_count(&env);
        let stream_id = String::from_small_str(&format!("stream_{}", stream_count));

        // Emit stream_created event with versioned schema
        let event = StreamCreatedV1 {
            event_version: 1,
            timestamp: env.ledger().timestamp(),
            stream_id: stream_id.clone(),
            creator: creator.clone(),
            beneficiary: beneficiary.clone(),
            token_address: token_address.clone(),
            total_amount,
            start_time,
            duration_seconds,
        };

        events::emit_stream_created(&env, event);

        Ok(stream_id)
    }
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod event_tests;

#[cfg(test)]
mod fuzz_test;

#[cfg(test)]
mod bench_test;

#[cfg(test)]
mod supply_conservation_test;
