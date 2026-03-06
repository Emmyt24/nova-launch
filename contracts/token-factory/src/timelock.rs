use soroban_sdk::{Address, Env, Vec};
#[cfg(test)]
use soroban_sdk::testutils::Ledger;
use crate::types::{Error, TimelockConfig, PendingChange, ChangeType, Proposal, ActionType, VoteChoice};
use crate::storage;
use crate::events;

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
    let execute_at = current_time + config.delay_seconds;
    
    let change_id = storage::get_next_change_id(env);
    
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
pub fn schedule_pause_update(
    env: &Env,
    admin: &Address,
    paused: bool,
) -> Result<u64, Error> {
    admin.require_auth();
    
    let current_admin = storage::get_admin(env);
    if *admin != current_admin {
        return Err(Error::Unauthorized);
    }
    
    let config = storage::get_timelock_config(env);
    let current_time = env.ledger().timestamp();
    let execute_at = current_time + config.delay_seconds;
    
    let change_id = storage::get_next_change_id(env);
    
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
    let execute_at = current_time + config.delay_seconds;
    
    let change_id = storage::get_next_change_id(env);
    
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
    let mut pending_change = storage::get_pending_change(env, change_id)
        .ok_or(Error::TokenNotFound)?;
    
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
            
            let new_base = pending_change.base_fee.unwrap_or_else(|| storage::get_base_fee(env));
            let new_metadata = pending_change.metadata_fee.unwrap_or_else(|| storage::get_metadata_fee(env));
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
    
    let pending_change = storage::get_pending_change(env, change_id)
        .ok_or(Error::TokenNotFound)?;
    
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
    use soroban_sdk::{testutils::Address as _, Env};
    use soroban_sdk::testutils::Ledger;
    
    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        
        let admin = Address::generate(&env);
        storage::set_admin(&env, &admin);
        storage::set_treasury(&env, &Address::generate(&env));
        storage::set_base_fee(&env, 1_000_000);
        storage::set_metadata_fee(&env, 500_000);
        
        initialize_timelock(&env, Some(3600)).unwrap(); // 1 hour
        
        (env, admin)
    }
    
    #[test]
    fn test_schedule_fee_update() {
        let (env, admin) = setup();
        
        let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
        
        let pending = get_pending_change(&env, change_id).unwrap();
        assert_eq!(pending.base_fee, Some(2_000_000));
        assert!(!pending.executed);
    }
    
    #[test]
    fn test_execute_change_before_timelock_fails() {
        let (env, admin) = setup();
        
        let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
        
        let result = execute_change(&env, change_id);
        assert_eq!(result, Err(Error::TimelockNotExpired));
    }
    
    #[test]
    fn test_execute_change_after_timelock_succeeds() {
        let (env, admin) = setup();
        
        let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
        
        // Advance time by 1 hour + 1 second
        env.ledger().with_mut(|li| {
            li.timestamp = li.timestamp + 3601;
        });
        
        execute_change(&env, change_id).unwrap();
        
        assert_eq!(storage::get_base_fee(&env), 2_000_000);
        
        let pending = get_pending_change(&env, change_id).unwrap();
        assert!(pending.executed);
    }
    
    #[test]
    fn test_cancel_pending_change() {
        let (env, admin) = setup();
        
        let change_id = schedule_fee_update(&env, &admin, Some(2_000_000), None).unwrap();
        
        cancel_change(&env, &admin, change_id).unwrap();
        
        assert!(get_pending_change(&env, change_id).is_none());
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
    payload: Vec<u8>,
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
        start_time,
        end_time,
        eta,
        created_at: current_time,
        votes_for: 0,
        votes_against: 0,
        votes_abstain: 0,
    };

    // Persist proposal
    storage::set_proposal(env, proposal_id, &proposal);

    // Emit event
    events::emit_proposal_created(
        env,
        proposal_id,
        proposer,
        action_type,
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
    use soroban_sdk::{testutils::Address as _, Env, vec};
    use soroban_sdk::testutils::Ledger;
    
    fn setup_for_proposals() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        
        let admin = Address::generate(&env);
        storage::set_admin(&env, &admin);
        storage::set_treasury(&env, &Address::generate(&env));
        storage::set_base_fee(&env, 1_000_000);
        storage::set_metadata_fee(&env, 500_000);
        
        initialize_timelock(&env, Some(3600)).unwrap();
        
        (env, admin)
    }
    
    #[test]
    fn test_create_proposal_valid() {
        let (env, admin) = setup_for_proposals();
        
        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400; // 1 day voting period
        let eta = end_time + 3600; // 1 hour after voting ends
        
        let payload = vec![&env, 1u8, 2u8, 3u8];
        
        let proposal_id = create_proposal(
            &env,
            &admin,
            ActionType::FeeChange,
            payload.clone(),
            start_time,
            end_time,
            eta,
        ).unwrap();
        
        assert_eq!(proposal_id, 0);
        assert_eq!(storage::get_proposal_count(&env), 1);
        
        let proposal = get_proposal(&env, proposal_id).unwrap();
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
        let (env, _admin) = setup_for_proposals();
        
        let unauthorized = Address::generate(&env);
        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time + 3600;
        
        let payload = vec![&env, 1u8, 2u8, 3u8];
        
        let result = create_proposal(
            &env,
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
        let (env, admin) = setup_for_proposals();
        
        let current_time = env.ledger().timestamp();
        let start_time = current_time - 100; // In the past
        let end_time = current_time + 86400;
        let eta = end_time + 3600;
        
        let payload = vec![&env, 1u8, 2u8, 3u8];
        
        let result = create_proposal(
            &env,
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
        let (env, admin) = setup_for_proposals();
        
        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time - 10; // Before start
        let eta = end_time + 3600;
        
        let payload = vec![&env, 1u8, 2u8, 3u8];
        
        let result = create_proposal(
            &env,
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
        let (env, admin) = setup_for_proposals();
        
        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time - 100; // Before end time
        
        let payload = vec![&env, 1u8, 2u8, 3u8];
        
        let result = create_proposal(
            &env,
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
        let (env, admin) = setup_for_proposals();
        
        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time + 3600;
        
        // Create payload larger than MAX_PAYLOAD_SIZE (1024 bytes)
        let mut large_payload = vec![&env];
        for _ in 0..1025 {
            large_payload.push_back(1u8);
        }
        
        let result = create_proposal(
            &env,
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
        let (env, admin) = setup_for_proposals();
        
        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time + 3600;
        
        // Create payload exactly at MAX_PAYLOAD_SIZE (1024 bytes)
        let mut max_payload = vec![&env];
        for _ in 0..1024 {
            max_payload.push_back(1u8);
        }
        
        let proposal_id = create_proposal(
            &env,
            &admin,
            ActionType::FeeChange,
            max_payload.clone(),
            start_time,
            end_time,
            eta,
        ).unwrap();
        
        let proposal = get_proposal(&env, proposal_id).unwrap();
        assert_eq!(proposal.payload.len(), 1024);
    }
    
    #[test]
    fn test_create_multiple_proposals() {
        let (env, admin) = setup_for_proposals();
        
        let current_time = env.ledger().timestamp();
        let payload = vec![&env, 1u8, 2u8, 3u8];
        
        // Create first proposal
        let proposal_id_1 = create_proposal(
            &env,
            &admin,
            ActionType::FeeChange,
            payload.clone(),
            current_time + 100,
            current_time + 86500,
            current_time + 90100,
        ).unwrap();
        
        // Create second proposal
        let proposal_id_2 = create_proposal(
            &env,
            &admin,
            ActionType::TreasuryChange,
            payload.clone(),
            current_time + 200,
            current_time + 86600,
            current_time + 90200,
        ).unwrap();
        
        assert_eq!(proposal_id_1, 0);
        assert_eq!(proposal_id_2, 1);
        assert_eq!(storage::get_proposal_count(&env), 2);
        
        let prop1 = get_proposal(&env, proposal_id_1).unwrap();
        let prop2 = get_proposal(&env, proposal_id_2).unwrap();
        
        assert_eq!(prop1.action_type, ActionType::FeeChange);
        assert_eq!(prop2.action_type, ActionType::TreasuryChange);
    }
    
    #[test]
    fn test_create_proposal_different_action_types() {
        let (env, admin) = setup_for_proposals();
        
        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time + 3600;
        let payload = vec![&env, 1u8, 2u8, 3u8];
        
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
            let proposal_id = create_proposal(
                &env,
                &admin,
                action_type,
                payload.clone(),
                start_time + (i as u64 * 1000),
                end_time + (i as u64 * 1000),
                eta + (i as u64 * 1000),
            ).unwrap();
            
            let proposal = get_proposal(&env, proposal_id).unwrap();
            assert_eq!(proposal.action_type, action_type);
        }
        
        assert_eq!(storage::get_proposal_count(&env), 5);
    }
    
    #[test]
    fn test_get_nonexistent_proposal() {
        let (env, _admin) = setup_for_proposals();
        
        let result = get_proposal(&env, 999);
        assert!(result.is_none());
    }
    
    #[test]
    fn test_create_proposal_empty_payload() {
        let (env, admin) = setup_for_proposals();
        
        let current_time = env.ledger().timestamp();
        let start_time = current_time + 100;
        let end_time = start_time + 86400;
        let eta = end_time + 3600;
        
        let empty_payload = vec![&env];
        
        let proposal_id = create_proposal(
            &env,
            &admin,
            ActionType::PauseContract,
            empty_payload.clone(),
            start_time,
            end_time,
            eta,
        ).unwrap();
        
        let proposal = get_proposal(&env, proposal_id).unwrap();
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
    // Verify voter authentication
    voter.require_auth();

    // Get proposal
    let mut proposal = storage::get_proposal(env, proposal_id)
        .ok_or(Error::ProposalNotFound)?;

    // Validate voting window
    let current_time = env.ledger().timestamp();
    
    if current_time < proposal.start_time {
        return Err(Error::VotingNotStarted);
    }
    
    if current_time >= proposal.end_time {
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
            proposal.votes_for = proposal.votes_for.checked_add(1)
                .expect("Vote count overflow");
        }
        VoteChoice::Against => {
            proposal.votes_against = proposal.votes_against.checked_add(1)
                .expect("Vote count overflow");
        }
        VoteChoice::Abstain => {
            proposal.votes_abstain = proposal.votes_abstain.checked_add(1)
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
pub fn get_vote_counts(env: &Env, proposal_id: u64) -> Option<(u32, u32, u32)> {
    storage::get_proposal(env, proposal_id)
        .map(|p| (p.votes_for, p.votes_against, p.votes_abstain))
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
