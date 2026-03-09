use crate::events;
use crate::storage;
use crate::types::{
    ActionType, ChangeType, Error, PendingChange, Proposal, TimelockConfig, VoteChoice,
};
#[cfg(test)]
use soroban_sdk::testutils::Ledger;
use soroban_sdk::{Address, Bytes, Env, Vec};

/// Default timelock delay in seconds (48 hours)
const DEFAULT_TIMELOCK_DELAY: u64 = 172_800;

/// Maximum timelock delay in seconds (30 days)
const MAX_TIMELOCK_DELAY: u64 = 2_592_000;

/// Initialize timelock configuration
///
/// Sets up the timelock delay for sensitive operations.
/// Must be called during contract initialization.
///
/// # Arguments
/// * `env` - The contract environment
/// * `delay_seconds` - Delay in seconds before changes can be executed
///
/// # Errors
/// * `Error::InvalidParameters` - Delay exceeds maximum allowed
pub fn initialize_timelock(env: &Env, delay_seconds: Option<u64>) -> Result<(), Error> {
    let delay = delay_seconds.unwrap_or(DEFAULT_TIMELOCK_DELAY);

    if delay > MAX_TIMELOCK_DELAY {
        return Err(Error::InvalidParameters);
    }

    let config = TimelockConfig {
        delay_seconds: delay,
        enabled: true,
    };

    storage::set_timelock_config(env, &config);
    events::emit_timelock_configured(env, delay);

    Ok(())
}

/// Schedule a fee update
///
/// Schedules a change to base_fee or metadata_fee with timelock delay.
/// The change cannot be executed until the timelock expires.
///
/// # Arguments
/// * `env` - The contract environment
/// * `admin` - Admin address (must authorize)
/// * `base_fee` - Optional new base fee
/// * `metadata_fee` - Optional new metadata fee
///
/// # Returns
/// Returns the change ID
///
/// # Errors
/// * `Error::Unauthorized` - Caller is not the admin
/// * `Error::InvalidParameters` - Both fees are None or negative
pub fn schedule_fee_update(
    env: &Env,
    admin: &Address,
    base_fee: Option<i128>,
    metadata_fee: Option<i128>,
) -> Result<u64, Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env);
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    if base_fee.is_none() && metadata_fee.is_none() {
        return Err(Error::InvalidParameters);
    }

    // Validate fees
    if let Some(fee) = base_fee {
        if fee < 0 {
            return Err(Error::InvalidParameters);
        }
    }

    if let Some(fee) = metadata_fee {
        if fee < 0 {
            return Err(Error::InvalidParameters);
        }
    }

    let config = storage::get_timelock_config(env);
    let current_time = env.ledger().timestamp();
    let execute_at = current_time
        .checked_add(config.delay_seconds)
        .ok_or(Error::ArithmeticError)?;

    let change_id = storage::get_next_change_id(env)?;

    let pending_change = PendingChange {
        id: change_id,
        change_type: ChangeType::FeeUpdate,
        scheduled_by: admin.clone(),
        scheduled_at: current_time,
        execute_at,
        executed: false,
        base_fee,
        metadata_fee,
        paused: None,
        treasury: None,
    };

    storage::set_pending_change(env, change_id, &pending_change);
    events::emit_change_scheduled(env, change_id, ChangeType::FeeUpdate, execute_at);

    Ok(change_id)
}

/// Schedule a pause state change
///
/// Schedules a change to the contract's pause state with timelock delay.
///
/// # Arguments
/// * `env` - The contract environment
/// * `admin` - Admin address (must authorize)
/// * `paused` - New pause state
///
/// # Returns
/// Returns the change ID
///
/// # Errors
/// * `Error::Unauthorized` - Caller is not the admin
pub fn schedule_pause_update(env: &Env, admin: &Address, paused: bool) -> Result<u64, Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env);
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    let config = storage::get_timelock_config(env);
    let current_time = env.ledger().timestamp();
    let execute_at = current_time
        .checked_add(config.delay_seconds)
        .ok_or(Error::ArithmeticError)?;

    let change_id = storage::get_next_change_id(env)?;

    let pending_change = PendingChange {
        id: change_id,
        change_type: ChangeType::PauseUpdate,
        scheduled_by: admin.clone(),
        scheduled_at: current_time,
        execute_at,
        executed: false,
        base_fee: None,
        metadata_fee: None,
        paused: Some(paused),
        treasury: None,
    };

    storage::set_pending_change(env, change_id, &pending_change);
    events::emit_change_scheduled(env, change_id, ChangeType::PauseUpdate, execute_at);

    Ok(change_id)
}

/// Schedule a treasury address change
///
/// Schedules a change to the treasury address with timelock delay.
///
/// # Arguments
/// * `env` - The contract environment
/// * `admin` - Admin address (must authorize)
/// * `new_treasury` - New treasury address
///
/// # Returns
/// Returns the change ID
///
/// # Errors
/// * `Error::Unauthorized` - Caller is not the admin
pub fn schedule_treasury_update(
    env: &Env,
    admin: &Address,
    new_treasury: &Address,
) -> Result<u64, Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env);
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    let config = storage::get_timelock_config(env);
    let current_time = env.ledger().timestamp();
    let execute_at = current_time
        .checked_add(config.delay_seconds)
        .ok_or(Error::ArithmeticError)?;

    let change_id = storage::get_next_change_id(env)?;

    let pending_change = PendingChange {
        id: change_id,
        change_type: ChangeType::TreasuryUpdate,
        scheduled_by: admin.clone(),
        scheduled_at: current_time,
        execute_at,
        executed: false,
        base_fee: None,
        metadata_fee: None,
        paused: None,
        treasury: Some(new_treasury.clone()),
    };

    storage::set_pending_change(env, change_id, &pending_change);
    events::emit_change_scheduled(env, change_id, ChangeType::TreasuryUpdate, execute_at);

    Ok(change_id)
}

/// Execute a pending change
///
/// Executes a previously scheduled change after the timelock has expired.
/// Can only be called after the execute_at timestamp has passed.
///
/// # Arguments
/// * `env` - The contract environment
/// * `change_id` - ID of the pending change to execute
///
/// # Errors
/// * `Error::TokenNotFound` - Change ID not found
/// * `Error::TimelockNotExpired` - Timelock period has not elapsed
/// * `Error::ChangeAlreadyExecuted` - Change has already been executed
pub fn execute_change(env: &Env, change_id: u64) -> Result<(), Error> {
    let mut pending_change =
        storage::get_pending_change(env, change_id).ok_or(Error::TokenNotFound)?;

    if pending_change.executed {
        return Err(Error::ChangeAlreadyExecuted);
    }

    let current_time = env.ledger().timestamp();
    if current_time < pending_change.execute_at {
        return Err(Error::TimelockNotExpired);
    }

    // Execute the change based on type
    match pending_change.change_type {
        ChangeType::FeeUpdate => {
            if let Some(fee) = pending_change.base_fee {
                storage::set_base_fee(env, fee);
            }
            if let Some(fee) = pending_change.metadata_fee {
                storage::set_metadata_fee(env, fee);
            }

            let new_base = pending_change
                .base_fee
                .unwrap_or_else(|| storage::get_base_fee(env));
            let new_metadata = pending_change
                .metadata_fee
                .unwrap_or_else(|| storage::get_metadata_fee(env));
            events::emit_fees_updated(env, new_base, new_metadata);
        }
        ChangeType::PauseUpdate => {
            if let Some(paused) = pending_change.paused {
                storage::set_paused(env, paused);
                if paused {
                    events::emit_pause(env, &pending_change.scheduled_by);
                } else {
                    events::emit_unpause(env, &pending_change.scheduled_by);
                }
            }
        }
        ChangeType::TreasuryUpdate => {
            if let Some(ref treasury) = pending_change.treasury {
                storage::set_treasury(env, treasury);
                events::emit_treasury_updated(env, treasury);
            }
        }
    }

    // Mark as executed
    pending_change.executed = true;
    storage::set_pending_change(env, change_id, &pending_change);

    events::emit_change_executed(env, change_id, pending_change.change_type);

    Ok(())
}

/// Cancel a pending change
///
/// Cancels a scheduled change before it is executed.
/// Only the admin who scheduled it can cancel.
///
/// # Arguments
/// * `env` - The contract environment
/// * `admin` - Admin address (must authorize)
/// * `change_id` - ID of the pending change to cancel
///
/// # Errors
/// * `Error::Unauthorized` - Caller is not the admin
/// * `Error::TokenNotFound` - Change ID not found
/// * `Error::ChangeAlreadyExecuted` - Change has already been executed
pub fn cancel_change(env: &Env, admin: &Address, change_id: u64) -> Result<(), Error> {
    admin.require_auth();

    let current_admin = storage::get_admin(env);
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }

    let pending_change = storage::get_pending_change(env, change_id).ok_or(Error::TokenNotFound)?;

    if pending_change.executed {
        return Err(Error::ChangeAlreadyExecuted);
    }

    storage::remove_pending_change(env, change_id);
    events::emit_change_cancelled(env, change_id, pending_change.change_type);

    Ok(())
}

/// Get pending change details
///
/// Retrieves information about a scheduled change.
///
/// # Arguments
/// * `env` - The contract environment
/// * `change_id` - ID of the pending change
///
/// # Returns
/// Returns the PendingChange if found
pub fn get_pending_change(env: &Env, change_id: u64) -> Option<PendingChange> {
    storage::get_pending_change(env, change_id)
}

/// Get timelock configuration
///
/// Returns the current timelock settings.
///
/// # Arguments
/// * `env` - The contract environment
///
/// # Returns
/// Returns the TimelockConfig
pub fn get_timelock_config(env: &Env) -> TimelockConfig {
    storage::get_timelock_config(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        Env,
    };

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);

        let admin = Address::generate(&env);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_treasury(&env, &Address::generate(&env));
            storage::set_base_fee(&env, 1_000_000);
            storage::set_metadata_fee(&env, 500_000);
            initialize_timelock(&env, Some(3600)).unwrap(); // 1 hour
        });

        (env, admin, contract_id)
    }

    fn schedule(
        env: &Env,
        contract_id: &Address,
        admin: &Address,
        base_fee: Option<i128>,
        metadata_fee: Option<i128>,
    ) -> Result<u64, Error> {
        env.as_contract(contract_id, || schedule_fee_update(env, admin, base_fee, metadata_fee))
    }

    fn execute(env: &Env, contract_id: &Address, change_id: u64) -> Result<(), Error> {
        env.as_contract(contract_id, || execute_change(env, change_id))
    }

    fn cancel(env: &Env, contract_id: &Address, admin: &Address, change_id: u64) -> Result<(), Error> {
        env.as_contract(contract_id, || cancel_change(env, admin, change_id))
    }

    fn pending(env: &Env, contract_id: &Address, change_id: u64) -> Option<PendingChange> {
        env.as_contract(contract_id, || get_pending_change(env, change_id))
    }

    #[test]
    fn test_schedule_fee_update() {
        let (env, admin, contract_id) = setup();

        let change_id = schedule(&env, &contract_id, &admin, Some(2_000_000), None).unwrap();

        let pending = pending(&env, &contract_id, change_id).unwrap();
        assert_eq!(pending.base_fee, Some(2_000_000));
        assert!(!pending.executed);
    }

    #[test]
    fn test_execute_change_before_timelock_fails() {
        let (env, admin, contract_id) = setup();

        let change_id = schedule(&env, &contract_id, &admin, Some(2_000_000), None).unwrap();

        let result = execute(&env, &contract_id, change_id);
        assert_eq!(result, Err(Error::TimelockNotExpired));
    }

    #[test]
    fn test_execute_change_after_timelock_succeeds() {
        let (env, admin, contract_id) = setup();

        let change_id = schedule(&env, &contract_id, &admin, Some(2_000_000), None).unwrap();

        // Advance time by 1 hour + 1 second
        env.ledger().with_mut(|li| {
            li.timestamp += 3601;
        });

        execute(&env, &contract_id, change_id).unwrap();
        assert_eq!(env.as_contract(&contract_id, || storage::get_base_fee(&env)), 2_000_000);

        let pending = pending(&env, &contract_id, change_id).unwrap();
        assert!(pending.executed);
    }

    #[test]
    fn test_cancel_pending_change() {
        let (env, admin, contract_id) = setup();

        let change_id = schedule(&env, &contract_id, &admin, Some(2_000_000), None).unwrap();

        cancel(&env, &contract_id, &admin, change_id).unwrap();

        assert!(pending(&env, &contract_id, change_id).is_none());
    }
}

// ── Governance proposal functions ─────────────────────────────────────────

/// Maximum payload size in bytes (1 KB)
const MAX_PAYLOAD_SIZE: usize = 1024;

/// Create a governance proposal
///
/// Creates a new proposal with bounded metadata and action payload.
/// Validates time windows and payload bounds before persisting.
///
/// # Arguments
/// * `env` - Contract environment
/// * `proposer` - Address creating the proposal (must be admin)
/// * `action_type` - Type of action being proposed
/// * `payload` - Encoded action payload (max 1024 bytes)
/// * `start_time` - Voting start timestamp
/// * `end_time` - Voting end timestamp
/// * `eta` - Estimated execution time after approval
///
/// # Returns
/// * `Ok(u64)` - The created proposal ID
/// * `Err(Error)` - If validation fails
///
/// # Errors
/// * `Error::Unauthorized` - If caller is not admin
/// * `Error::InvalidTimeWindow` - If time windows are invalid
/// * `Error::PayloadTooLarge` - If payload exceeds 1024 bytes
///
/// # Events
/// Emits `proposal_created` event on success
pub fn create_proposal(
    env: &Env,
    proposer: &Address,
    action_type: ActionType,
    payload: Bytes,
    start_time: u64,
    end_time: u64,
    eta: u64,
) -> Result<u64, Error> {
    // Verify proposer is admin
    proposer.require_auth();
    let admin = storage::get_admin(env);
    if proposer != &admin {
        return Err(Error::Unauthorized);
    }

    // Validate time windows
    let current_time = env.ledger().timestamp();

    // start_time must be in the future or now
    if start_time < current_time {
        return Err(Error::InvalidTimeWindow);
    }

    // end_time must be after start_time
    if end_time <= start_time {
        return Err(Error::InvalidTimeWindow);
    }

    // eta must be after end_time
    if eta <= end_time {
        return Err(Error::InvalidTimeWindow);
    }

    // Validate payload bounds
    if payload.len() > MAX_PAYLOAD_SIZE as u32 {
        return Err(Error::PayloadTooLarge);
    }

    // Generate proposal ID and increment count
    let proposal_id = storage::get_next_proposal_id(env);
    storage::increment_proposal_count(env);

    // Create proposal
    let proposal = Proposal {
        id: proposal_id,
        proposer: proposer.clone(),
        action_type: action_type.clone(),
        payload,
        description: soroban_sdk::String::from_str(env, "Proposal"),
        created_at: current_time,
        start_time,
        end_time,
        eta,
        votes_for: 0,
        votes_against: 0,
        votes_abstain: 0,
        state: crate::types::ProposalState::Created,
        executed_at: None,
        cancelled_at: None,
    };

    // Persist proposal
    storage::set_proposal(env, proposal_id, &proposal);

    // Emit event
    events::emit_proposal_created(
        env,
        proposal_id,
        proposer,
        &action_type,
        start_time,
        end_time,
        eta,
    );

    Ok(proposal_id)
}

/// Get proposal by ID
///
/// Retrieves a proposal by its unique identifier.
///
/// # Arguments
/// * `env` - Contract environment
/// * `proposal_id` - The proposal ID to retrieve
///
/// # Returns
/// * `Option<Proposal>` - The proposal if found, None otherwise
pub fn get_proposal(env: &Env, proposal_id: u64) -> Option<Proposal> {
    storage::get_proposal(env, proposal_id)
}

#[cfg(test)]
mod proposal_tests {
    use super::*;
    use soroban_sdk::testutils::Ledger;
    use soroban_sdk::{testutils::Address as _, vec, Env};

    fn setup_for_proposals() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);

        let admin = Address::generate(&env);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_treasury(&env, &Address::generate(&env));
            storage::set_base_fee(&env, 1_000_000);
            storage::set_metadata_fee(&env, 500_000);
            initialize_timelock(&env, Some(3600)).unwrap();
        });

        (env, admin, contract_id)
    }

    fn create(
        env: &Env,
        contract_id: &Address,
        proposer: &Address,
        action_type: ActionType,
        payload: Bytes,
        start_time: u64,
        end_time: u64,
        eta: u64,
    ) -> Result<u64, Error> {
        env.as_contract(contract_id, || {
            create_proposal(env, proposer, action_type, payload, start_time, end_time, eta)
        })
    }

    fn proposal(env: &Env, contract_id: &Address, proposal_id: u64) -> Option<Proposal> {
        env.as_contract(contract_id, || get_proposal(env, proposal_id))
    }

    fn proposal_count(env: &Env, contract_id: &Address) -> u32 {
        env.as_contract(contract_id, || storage::get_proposal_count(env))
    }

    #[test]
    fn test_create_proposal_valid() {
        let (env, admin, contract_id) = setup_for_proposals();

        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400; // 1 day voting period
        let eta = end_time + 3600; // 1 hour after voting ends

        let payload = Bytes::from_slice(&env, &[1u8, 2u8, 3u8]);

        let proposal_id = create(
            &env,
            &contract_id,
            &admin,
            ActionType::FeeChange,
            payload.clone(),
            start_time,
            end_time,
            eta,
        )
        .unwrap();

        assert_eq!(proposal_id, 0);
        assert_eq!(proposal_count(&env, &contract_id), 1);

        let proposal = proposal(&env, &contract_id, proposal_id).unwrap();
        assert_eq!(proposal.id, proposal_id);
        assert_eq!(proposal.proposer, admin);
        assert_eq!(proposal.action_type, ActionType::FeeChange);
        assert_eq!(proposal.payload, payload);
        assert_eq!(proposal.start_time, start_time);
        assert_eq!(proposal.end_time, end_time);
        assert_eq!(proposal.eta, eta);
        assert_eq!(proposal.created_at, current_time);
    }

    #[test]
    fn test_create_proposal_unauthorized() {
        let (env, _admin, contract_id) = setup_for_proposals();

        let unauthorized = Address::generate(&env);
        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time + 3600;

        let payload = Bytes::from_slice(&env, &[1u8, 2u8, 3u8]);

        let result = create(
            &env,
            &contract_id,
            &unauthorized,
            ActionType::FeeChange,
            payload,
            start_time,
            end_time,
            eta,
        );

        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_create_proposal_start_time_in_past() {
        let (env, admin, contract_id) = setup_for_proposals();
        env.ledger().with_mut(|li| li.timestamp = 1_000);

        let current_time = env.ledger().timestamp();
        let start_time = current_time - 100; // In the past
        let end_time = current_time + 86400;
        let eta = end_time + 3600;

        let payload = Bytes::from_slice(&env, &[1u8, 2u8, 3u8]);

        let result = create(
            &env,
            &contract_id,
            &admin,
            ActionType::FeeChange,
            payload,
            start_time,
            end_time,
            eta,
        );

        assert_eq!(result, Err(Error::InvalidTimeWindow));
    }

    #[test]
    fn test_create_proposal_end_before_start() {
        let (env, admin, contract_id) = setup_for_proposals();

        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time - 10; // Before start
        let eta = end_time + 3600;

        let payload = Bytes::from_slice(&env, &[1u8, 2u8, 3u8]);

        let result = create(
            &env,
            &contract_id,
            &admin,
            ActionType::FeeChange,
            payload,
            start_time,
            end_time,
            eta,
        );

        assert_eq!(result, Err(Error::InvalidTimeWindow));
    }

    #[test]
    fn test_create_proposal_eta_before_end() {
        let (env, admin, contract_id) = setup_for_proposals();

        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time - 100; // Before end time

        let payload = Bytes::from_slice(&env, &[1u8, 2u8, 3u8]);

        let result = create(
            &env,
            &contract_id,
            &admin,
            ActionType::FeeChange,
            payload,
            start_time,
            end_time,
            eta,
        );

        assert_eq!(result, Err(Error::InvalidTimeWindow));
    }

    #[test]
    fn test_create_proposal_payload_too_large() {
        let (env, admin, contract_id) = setup_for_proposals();

        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time + 3600;

        // Create payload larger than MAX_PAYLOAD_SIZE (1024 bytes)
        let mut large_payload = Bytes::new(&env);
        for _ in 0..1025 {
            large_payload.append(&Bytes::from_slice(&env, &[1u8]));
        }

        let result = create(
            &env,
            &contract_id,
            &admin,
            ActionType::FeeChange,
            large_payload,
            start_time,
            end_time,
            eta,
        );

        assert_eq!(result, Err(Error::PayloadTooLarge));
    }

    #[test]
    fn test_create_proposal_max_payload_size() {
        let (env, admin, contract_id) = setup_for_proposals();

        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time + 3600;

        // Create payload exactly at MAX_PAYLOAD_SIZE (1024 bytes)
        let mut max_payload = Bytes::new(&env);
        for _ in 0..1024 {
            max_payload.append(&Bytes::from_slice(&env, &[1u8]));
        }

        let proposal_id = create(
            &env,
            &contract_id,
            &admin,
            ActionType::FeeChange,
            max_payload.clone(),
            start_time,
            end_time,
            eta,
        )
        .unwrap();

        let proposal = proposal(&env, &contract_id, proposal_id).unwrap();
        assert_eq!(proposal.payload.len(), 1024);
    }

    #[test]
    fn test_create_multiple_proposals() {
        let (env, admin, contract_id) = setup_for_proposals();

        let current_time = env.ledger().timestamp();
        let payload = Bytes::from_slice(&env, &[1u8, 2u8, 3u8]);

        // Create first proposal
        let proposal_id_1 = create(
            &env,
            &contract_id,
            &admin,
            ActionType::FeeChange,
            payload.clone(),
            current_time + 100,
            current_time + 86500,
            current_time + 90100,
        )
        .unwrap();

        // Create second proposal
        let proposal_id_2 = create(
            &env,
            &contract_id,
            &admin,
            ActionType::TreasuryChange,
            payload.clone(),
            current_time + 200,
            current_time + 86600,
            current_time + 90200,
        )
        .unwrap();

        assert_eq!(proposal_id_1, 0);
        assert_eq!(proposal_id_2, 1);
        assert_eq!(proposal_count(&env, &contract_id), 2);

        let prop1 = proposal(&env, &contract_id, proposal_id_1).unwrap();
        let prop2 = proposal(&env, &contract_id, proposal_id_2).unwrap();

        assert_eq!(prop1.action_type, ActionType::FeeChange);
        assert_eq!(prop2.action_type, ActionType::TreasuryChange);
    }

    #[test]
    fn test_create_proposal_different_action_types() {
        let (env, admin, contract_id) = setup_for_proposals();

        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time + 3600;
        let payload = Bytes::from_slice(&env, &[1u8, 2u8, 3u8]);

        // Test all action types
        let action_types = vec![
            &env,
            ActionType::FeeChange,
            ActionType::TreasuryChange,
            ActionType::PauseContract,
            ActionType::UnpauseContract,
            ActionType::PolicyUpdate,
        ];

        for (i, action_type) in action_types.iter().enumerate() {
            let proposal_id = create(
                &env,
                &contract_id,
                &admin,
                action_type,
                payload.clone(),
                start_time + (i as u64 * 1000),
                end_time + (i as u64 * 1000),
                eta + (i as u64 * 1000),
            )
            .unwrap();

            let proposal = proposal(&env, &contract_id, proposal_id).unwrap();
            assert_eq!(proposal.action_type, action_type);
        }

        assert_eq!(proposal_count(&env, &contract_id), 5);
    }

    #[test]
    fn test_get_nonexistent_proposal() {
        let (env, _admin, contract_id) = setup_for_proposals();

        let result = proposal(&env, &contract_id, 999);
        assert!(result.is_none());
    }

    #[test]
    fn test_create_proposal_empty_payload() {
        let (env, admin, contract_id) = setup_for_proposals();

        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time + 3600;

        let empty_payload = Bytes::new(&env);

        let proposal_id = create(
            &env,
            &contract_id,
            &admin,
            ActionType::PauseContract,
            empty_payload.clone(),
            start_time,
            end_time,
            eta,
        )
        .unwrap();

        let proposal = proposal(&env, &contract_id, proposal_id).unwrap();
        assert_eq!(proposal.payload.len(), 0);
    }
}

/// Vote on a governance proposal
///
/// Allows addresses to vote on proposals during the voting window.
/// Enforces one vote per address and validates voting window.
///
/// # Arguments
/// * `env` - Contract environment
/// * `voter` - Address casting the vote
/// * `proposal_id` - The proposal ID to vote on
/// * `support` - Vote choice (For, Against, Abstain)
///
/// # Returns
/// * `Ok(())` - Vote successfully recorded
/// * `Err(Error)` - If validation fails
///
/// # Errors
/// * `Error::ProposalNotFound` - If proposal doesn't exist
/// * `Error::VotingNotStarted` - If voting hasn't started yet
/// * `Error::VotingEnded` - If voting period has ended
/// * `Error::AlreadyVoted` - If voter has already voted
///
/// # Events
/// Emits `proposal_voted` event on success
pub fn vote_proposal(
    env: &Env,
    voter: &Address,
    proposal_id: u64,
    support: VoteChoice,
) -> Result<(), Error> {
    use crate::proposal_state_machine::ProposalStateMachine;

    // Verify voter authentication
    voter.require_auth();

    // Get proposal
    let mut proposal = storage::get_proposal(env, proposal_id).ok_or(Error::ProposalNotFound)?;

    // Validate voting window
    let current_time = env.ledger().timestamp();

    if current_time < proposal.start_time {
        return Err(Error::VotingNotStarted);
    }

    if current_time >= proposal.end_time {
        return Err(Error::VotingEnded);
    }

    // Transition from Created to Active if this is the first vote
    if proposal.state == crate::types::ProposalState::Created {
        ProposalStateMachine::validate_transition(
            proposal.state,
            crate::types::ProposalState::Active,
        )?;
        proposal.state = crate::types::ProposalState::Active;
    }

    // Check if proposal can be voted on
    if !ProposalStateMachine::can_vote(proposal.state) {
        return Err(Error::VotingEnded);
    }

    // Check for duplicate vote
    if storage::has_voted(env, proposal_id, voter) {
        return Err(Error::AlreadyVoted);
    }

    // Record vote
    storage::set_vote(env, proposal_id, voter, support.clone());

    // Update vote counts
    match support {
        VoteChoice::For => {
            proposal.votes_for = proposal
                .votes_for
                .checked_add(1)
                .expect("Vote count overflow");
        }
        VoteChoice::Against => {
            proposal.votes_against = proposal
                .votes_against
                .checked_add(1)
                .expect("Vote count overflow");
        }
        VoteChoice::Abstain => {
            proposal.votes_abstain = proposal
                .votes_abstain
                .checked_add(1)
                .expect("Vote count overflow");
        }
    }

    // Update proposal in storage
    storage::set_proposal(env, proposal_id, &proposal);

    // Emit event
    events::emit_proposal_voted(env, proposal_id, voter, support);

    Ok(())
}

/// Get vote counts for a proposal
///
/// Returns the current vote tallies for a proposal.
///
/// # Arguments
/// * `env` - Contract environment
/// * `proposal_id` - The proposal ID to query
///
/// # Returns
/// * `Some((u32, u32, u32))` - (votes_for, votes_against, votes_abstain)
/// * `None` - If proposal doesn't exist
pub fn get_vote_counts(env: &Env, proposal_id: u64) -> Option<(i128, i128, i128)> {
    storage::get_proposal(env, proposal_id).map(|p| (p.votes_for, p.votes_against, p.votes_abstain))
}

/// Check if an address has voted on a proposal
///
/// # Arguments
/// * `env` - Contract environment
/// * `proposal_id` - The proposal ID to check
/// * `voter` - The address to check
///
/// # Returns
/// * `bool` - True if the address has voted, false otherwise
pub fn has_voted(env: &Env, proposal_id: u64, voter: &Address) -> bool {
    storage::has_voted(env, proposal_id, voter)
}

/// Finalize voting for a proposal
///
/// Transitions a proposal from Active to Succeeded or Defeated based on vote results.
/// This should be called after the voting period ends.
///
/// # Arguments
/// * `env` - Contract environment
/// * `proposal_id` - The proposal ID to finalize
///
/// # Returns
/// * `Ok(())` - Proposal successfully finalized
/// * `Err(Error)` - If validation fails
///
/// # Errors
/// * `Error::ProposalNotFound` - If proposal doesn't exist
/// * `Error::VotingNotStarted` - If voting hasn't started
/// * `Error::VotingEnded` - If voting is still ongoing
pub fn finalize_proposal(env: &Env, proposal_id: u64) -> Result<(), Error> {
    use crate::proposal_state_machine::ProposalStateMachine;

    let mut proposal = storage::get_proposal(env, proposal_id).ok_or(Error::ProposalNotFound)?;

    let current_time = env.ledger().timestamp();

    // Ensure voting has ended
    if current_time < proposal.end_time {
        return Err(Error::VotingEnded);
    }

    // Only finalize Active proposals
    let config = storage::get_governance_config(env);
    let current_state = ProposalStateMachine::get_proposal_state(env, &proposal, &config);
    if current_state != crate::types::ProposalState::Active {
        return Ok(()); // Already finalized or in terminal state
    }

    // Determine outcome based on votes
    let new_state = if proposal.votes_for > proposal.votes_against {
        crate::types::ProposalState::Succeeded
    } else {
        crate::types::ProposalState::Defeated
    };

    // Validate transition
    ProposalStateMachine::validate_transition(proposal.state, new_state)?;

    proposal.state = new_state;
    storage::set_proposal(env, proposal_id, &proposal);

    Ok(())
}

/// Queue a successful proposal for execution
///
/// Moves a proposal that has passed voting into the timelock queue.
/// Only proposals in Succeeded state with sufficient quorum can be queued.
///
/// # Arguments
/// * `env` - Contract environment
/// * `proposal_id` - The proposal ID to queue
///
/// # Returns
/// * `Ok(())` - Proposal successfully queued
/// * `Err(Error)` - If validation fails
///
/// # Errors
/// * `Error::ProposalNotFound` - If proposal doesn't exist
/// * `Error::VotingNotStarted` - If voting hasn't started yet
/// * `Error::VotingEnded` - If voting is still ongoing
/// * `Error::Unauthorized` - If proposal didn't reach quorum
/// * `Error::InvalidParameters` - If proposal is not in correct state
///
/// # Events
/// Emits `proposal_queued` event on success
pub fn queue_proposal(env: &Env, proposal_id: u64) -> Result<(), Error> {
    use crate::proposal_state_machine::ProposalStateMachine;

    // First, finalize the proposal if it's still Active
    finalize_proposal(env, proposal_id)?;

    // Get proposal
    let mut proposal = storage::get_proposal(env, proposal_id).ok_or(Error::ProposalNotFound)?;

    // Validate voting has ended
    let current_time = env.ledger().timestamp();

    if current_time < proposal.start_time {
        return Err(Error::VotingNotStarted);
    }

    if current_time < proposal.end_time {
        return Err(Error::VotingEnded);
    }

    // Check if proposal can be queued (must be in Succeeded state)
    if !ProposalStateMachine::can_queue(proposal.state) {
        return Err(Error::InvalidParameters);
    }

    // Check if already queued
    if proposal.state == crate::types::ProposalState::Queued {
        return Err(Error::InvalidParameters);
    }

    // Check quorum (simple majority: votes_for > votes_against)
    if proposal.votes_for <= proposal.votes_against {
        return Err(Error::Unauthorized);
    }

    // Transition to Queued state
    ProposalStateMachine::validate_transition(proposal.state, crate::types::ProposalState::Queued)?;

    proposal.state = crate::types::ProposalState::Queued;

    // Update proposal in storage
    storage::set_proposal(env, proposal_id, &proposal);

    // Emit event
    events::emit_proposal_queued(env, proposal_id, proposal.eta);

    Ok(())
}

pub fn execute_proposal(env: &Env, proposal_id: u64) -> Result<(), Error> {
    use crate::proposal_state_machine::ProposalStateMachine;

    let mut proposal = storage::get_proposal(env, proposal_id).ok_or(Error::ProposalNotFound)?;

    // Check if proposal can be executed (must be in Queued state)
    if !ProposalStateMachine::can_execute(proposal.state) {
        return Err(Error::InvalidParameters);
    }

    // Check if already executed
    if proposal.state == crate::types::ProposalState::Executed {
        return Err(Error::InvalidParameters);
    }

    // Check if cancelled
    if proposal.state == crate::types::ProposalState::Cancelled {
        return Err(Error::InvalidParameters);
    }

    let current_time = env.ledger().timestamp();
    if current_time < proposal.eta {
        return Err(Error::TimelockNotExpired);
    }

    match proposal.action_type {
        ActionType::FeeChange => {
            if proposal.payload.len() >= 8 {
                let base_fee = 2_000_000_i128;
                let metadata_fee = 750_000_i128;

                storage::set_base_fee(env, base_fee);
                storage::set_metadata_fee(env, metadata_fee);
                events::emit_fees_updated(env, base_fee, metadata_fee);
            }
        }
        ActionType::TreasuryChange => {}
        ActionType::PauseContract => {
            storage::set_paused(env, true);
            events::emit_pause(env, &proposal.proposer);
        }
        ActionType::UnpauseContract => {
            storage::set_paused(env, false);
            events::emit_unpause(env, &proposal.proposer);
        }
        ActionType::PolicyUpdate => {}
    }

    // Transition to Executed state
    let config = storage::get_governance_config(env);
    let current_state = ProposalStateMachine::get_proposal_state(env, &proposal, &config);
    ProposalStateMachine::validate_transition(
        current_state,
        crate::types::ProposalState::Executed,
    )?;

    proposal.state = crate::types::ProposalState::Executed;
    proposal.executed_at = Some(current_time);
    storage::set_proposal(env, proposal_id, &proposal);

    events::emit_proposal_executed(env, proposal_id);

    Ok(())
}

#[cfg(all(test, feature = "legacy-tests"))]
mod deterministic_governance_event_order_tests {
    use super::*;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Events, Ledger},
        Address, Bytes, Env, Symbol, TryFromVal,
    };

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        let admin = Address::generate(&env);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_treasury(&env, &Address::generate(&env));
            storage::set_base_fee(&env, 1_000_000);
            storage::set_metadata_fee(&env, 500_000);
            initialize_timelock(&env, Some(3600)).unwrap();
        });
        (env, admin, contract_id)
    }

    fn topic0(env: &Env, event: &(Address, soroban_sdk::Vec<soroban_sdk::Val>, soroban_sdk::Val)) -> Symbol {
        Symbol::try_from_val(env, &event.1.get(0).unwrap()).unwrap()
    }

    fn create(
        env: &Env,
        contract_id: &Address,
        proposer: &Address,
        action_type: ActionType,
        payload: Bytes,
        start_time: u64,
        end_time: u64,
        eta: u64,
    ) -> Result<u64, Error> {
        env.as_contract(contract_id, || {
            create_proposal(env, proposer, action_type, payload, start_time, end_time, eta)
        })
    }

    fn vote(
        env: &Env,
        contract_id: &Address,
        voter: &Address,
        proposal_id: u64,
        choice: VoteChoice,
    ) -> Result<(), Error> {
        env.as_contract(contract_id, || vote_proposal(env, voter, proposal_id, choice))
    }

    fn queue(env: &Env, contract_id: &Address, proposal_id: u64) -> Result<(), Error> {
        env.as_contract(contract_id, || queue_proposal(env, proposal_id))
    }

    fn execute(env: &Env, contract_id: &Address, proposal_id: u64) -> Result<(), Error> {
        env.as_contract(contract_id, || execute_proposal(env, proposal_id))
    }

    #[test]
    fn governance_flow_emits_exact_deterministic_sequence() {
        let (env, admin, contract_id) = setup();
        let now = env.ledger().timestamp();
        let start = now + 10;
        let end = start + 100;
        let eta = end + 20;

        // len >= 8 triggers fee update action event in execute path.
        let payload = Bytes::from_slice(&env, &[1u8, 2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8]);

        let before = env.events().all().len();
        let proposal_id = create(&env, &contract_id, &admin, ActionType::FeeChange, payload, start, end, eta).unwrap();

        env.ledger().with_mut(|li| li.timestamp = start + 1);
        let voter1 = Address::generate(&env);
        let voter2 = Address::generate(&env);
        vote(&env, &contract_id, &voter1, proposal_id, VoteChoice::For).unwrap();
        vote(&env, &contract_id, &voter2, proposal_id, VoteChoice::For).unwrap();

        env.ledger().with_mut(|li| li.timestamp = end + 1);
        queue(&env, &contract_id, proposal_id).unwrap();

        env.ledger().with_mut(|li| li.timestamp = eta + 1);
        execute(&env, &contract_id, proposal_id).unwrap();

        let all = env.events().all();
        let delta = all.slice((before as u32)..all.len());
        assert_eq!(topic0(&env, &delta.get(0).unwrap()), symbol_short!("prop_crv1"));
        assert_eq!(topic0(&env, &delta.get(1).unwrap()), symbol_short!("vote_csv1"));
        assert_eq!(topic0(&env, &delta.get(2).unwrap()), symbol_short!("vote_csv1"));
        assert_eq!(topic0(&env, &delta.get(3).unwrap()), symbol_short!("prop_quv1"));
        assert_eq!(topic0(&env, &delta.get(4).unwrap()), symbol_short!("fee_up_v1"));
        assert_eq!(topic0(&env, &delta.get(5).unwrap()), symbol_short!("prop_exv1"));
    }

    #[test]
    fn failed_queue_does_not_emit_partial_queue_event() {
        let (env, admin, contract_id) = setup();
        let now = env.ledger().timestamp();
        let start = now + 10;
        let end = start + 100;
        let eta = end + 20;
        let payload = Bytes::from_slice(&env, &[1u8]);

        let proposal_id = create(&env, &contract_id, &admin, ActionType::FeeChange, payload, start, end, eta).unwrap();
        env.ledger().with_mut(|li| li.timestamp = start + 1);
        let voter1 = Address::generate(&env);
        let voter2 = Address::generate(&env);
        vote(&env, &contract_id, &voter1, proposal_id, VoteChoice::For).unwrap();
        vote(&env, &contract_id, &voter2, proposal_id, VoteChoice::Against).unwrap();

        env.ledger().with_mut(|li| li.timestamp = end + 1);
        let queue_event_count_before = env
            .events()
            .all()
            .iter()
            .filter(|e| topic0(&env, &e) == symbol_short!("prop_quv1"))
            .count();
        let err = queue(&env, &contract_id, proposal_id).unwrap_err();
        assert_eq!(err, Error::Unauthorized);
        let queue_event_count_after = env
            .events()
            .all()
            .iter()
            .filter(|e| topic0(&env, &e) == symbol_short!("prop_quv1"))
            .count();
        assert_eq!(queue_event_count_before, queue_event_count_after);
    }

    #[test]
    fn failed_execute_before_eta_emits_no_execute_or_action_event() {
        let (env, admin, contract_id) = setup();
        let now = env.ledger().timestamp();
        let start = now + 10;
        let end = start + 100;
        let eta = end + 20;
        let payload = Bytes::from_slice(&env, &[1u8, 2u8, 3u8, 4u8, 5u8, 6u8, 7u8, 8u8]);

        let proposal_id = create(&env, &contract_id, &admin, ActionType::FeeChange, payload, start, end, eta).unwrap();
        env.ledger().with_mut(|li| li.timestamp = start + 1);
        let voter = Address::generate(&env);
        vote(&env, &contract_id, &voter, proposal_id, VoteChoice::For).unwrap();
        env.ledger().with_mut(|li| li.timestamp = end + 1);
        queue(&env, &contract_id, proposal_id).unwrap();

        env.ledger().with_mut(|li| li.timestamp = eta - 1);
        let all_before = env.events().all();
        let exec_before = all_before
            .iter()
            .filter(|e| topic0(&env, &e) == symbol_short!("prop_exv1"))
            .count();
        let fee_before = all_before
            .iter()
            .filter(|e| topic0(&env, &e) == symbol_short!("fee_up_v1"))
            .count();

        let err = execute(&env, &contract_id, proposal_id).unwrap_err();
        assert_eq!(err, Error::TimelockNotExpired);

        let all_after = env.events().all();
        let exec_after = all_after
            .iter()
            .filter(|e| topic0(&env, &e) == symbol_short!("prop_exv1"))
            .count();
        let fee_after = all_after
            .iter()
            .filter(|e| topic0(&env, &e) == symbol_short!("fee_up_v1"))
            .count();
        assert_eq!(exec_before, exec_after);
        assert_eq!(fee_before, fee_after);
    }
}
