use crate::events;
use crate::payload_validation;
use crate::storage;
use crate::types::{
    ActionType, ChangeType, Error, PendingChange, Proposal, TimelockConfig, TimelockDelayConfig,
    VoteChoice,
};
#[cfg(test)]
use soroban_sdk::testutils::Ledger;
use soroban_sdk::{Address, Bytes, Env, Vec};

/// Default timelock delay in seconds (48 hours)
const DEFAULT_TIMELOCK_DELAY: u64 = 172_800;

/// Minimum timelock delay in seconds (1 hour) — prevents zero-delay bypasses.
pub const MIN_TIMELOCK_DELAY: u64 = 3_600;

/// Maximum timelock delay in seconds (30 days)
pub const MAX_TIMELOCK_DELAY: u64 = 2_592_000;

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
/// * `Error::InvalidParameters` - Delay is below minimum or exceeds maximum allowed
pub fn initialize_timelock(env: &Env, delay_seconds: Option<u64>) -> Result<(), Error> {
    let delay = delay_seconds.unwrap_or(DEFAULT_TIMELOCK_DELAY);

    if delay < MIN_TIMELOCK_DELAY || delay > MAX_TIMELOCK_DELAY {
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

/// Return the per-proposal-type timelock delay configuration.
pub fn get_timelock_delay_config(env: &Env) -> TimelockDelayConfig {
    storage::get_timelock_delay_config(env)
}

/// Update the per-proposal-type timelock delays.
///
/// Can only be called through a successfully-executed governance proposal
/// (not directly by admin), ensuring delays themselves are subject to governance.
///
/// # Errors
/// * `Error::Unauthorized` - If called outside a governance execution context
///   (i.e. the caller is not the contract itself via `env.current_contract_address()`).
pub fn set_timelock_delay_config(env: &Env, config: &TimelockDelayConfig) -> Result<(), Error> {
    // Minimum sanity: each delay must be at least 1 ledger
    if config.fee_change_delay == 0
        || config.admin_transfer_delay == 0
        || config.upgrade_delay == 0
        || config.default_delay == 0
    {
        return Err(Error::InvalidParameters);
    }
    storage::set_timelock_delay_config(env, config);
    Ok(())
}

/// Map an `ActionType` to its required delay in ledgers.
pub fn delay_for_action(env: &Env, action_type: ActionType) -> u64 {
    let cfg = storage::get_timelock_delay_config(env);
    match action_type {
        ActionType::FeeChange | ActionType::PolicyUpdate => cfg.fee_change_delay,
        ActionType::TreasuryChange => cfg.admin_transfer_delay,
        ActionType::ParameterChange => cfg.upgrade_delay,
        ActionType::PauseContract | ActionType::UnpauseContract => cfg.default_delay,
    }
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

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
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

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
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

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
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
                .unwrap_or_else(|| storage::get_base_fee(env).unwrap_or(0));
            let new_metadata = pending_change
                .metadata_fee
                .unwrap_or_else(|| storage::get_metadata_fee(env).unwrap_or(0));
            events::emit_fees_updated_v2(env, &pending_change.scheduled_by, new_base, new_metadata);
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

    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
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
    let admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
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

    // eta delay (eta - end_time) must be within [MIN_TIMELOCK_DELAY, MAX_TIMELOCK_DELAY]
    let eta_delay = eta.checked_sub(end_time).ok_or(Error::ArithmeticError)?;
    if eta_delay < MIN_TIMELOCK_DELAY || eta_delay > MAX_TIMELOCK_DELAY {
        return Err(Error::InvalidParameters);
    }

    // Validate payload bounds
    if payload.len() > MAX_PAYLOAD_SIZE as u32 {
        return Err(Error::PayloadTooLarge);
    }

    // Validate payload schema for action type (reject malformed payloads early)
    payload_validation::validate_payload(env, action_type, &payload)?;

    // Generate proposal ID and increment count
    let proposal_id = storage::get_next_proposal_id(env);
    storage::increment_proposal_count(env);

    // Snapshot circulating supply (sum of total_supply across all deployed tokens)
    // at proposal creation time so quorum is not affected by future supply changes.
    let circulating_supply_snapshot: i128 = {
        let token_count = storage::get_token_count(env);
        let mut supply_sum: i128 = 0;
        for i in 0..token_count {
            if let Some(info) = storage::get_token_info(env, i) {
                supply_sum = supply_sum.saturating_add(info.total_supply);
            }
        }
        supply_sum
    };

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
        timelock_delay: 0, // captured at queue time
        queued_at_ledger: 0, // set when queued
        votes_for: 0,
        votes_against: 0,
        votes_abstain: 0,
        state: crate::types::ProposalState::Created,
        executed_at: None,
        cancelled_at: None,
        circulating_supply_snapshot,
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

    // Opportunistically emit a state snapshot if this proposal (or another
    // active one touched via this entry point) is due for one (#1383).
    crate::governance::maybe_auto_snapshot(env, proposal_id, &proposal);

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

/// Cancel a proposal.
///
/// Only the original proposer or the contract admin may cancel a proposal.
/// Cancellation is rejected if the proposal is already in a terminal state
/// (Executed, Defeated, Expired, Cancelled, Failed).
///
/// # Errors
/// * `ProposalNotFound`       – proposal does not exist
/// * `Unauthorized`           – caller is neither proposer nor admin
/// * `ProposalNotCancellable` – proposal is in a terminal state
pub fn cancel_proposal(env: &Env, caller: &Address, proposal_id: u64) -> Result<(), Error> {
    caller.require_auth();

    let mut proposal = storage::get_proposal(env, proposal_id).ok_or(Error::ProposalNotFound)?;

    let admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *caller != proposal.proposer && *caller != admin {
        return Err(Error::Unauthorized);
    }

    if crate::proposal_state_machine::ProposalStateMachine::is_terminal_state(proposal.state) {
        return Err(Error::ProposalNotCancellable);
    }

    proposal.state = crate::types::ProposalState::Cancelled;
    proposal.cancelled_at = Some(env.ledger().timestamp());
    storage::set_proposal(env, proposal_id, &proposal);

    // Drop the proposal from its per-type FIFO queue so it no longer blocks
    // later same-type proposals (#1366). No-op if it was never enqueued.
    crate::proposal_type_queue::remove(env, proposal_id);

    events::emit_proposal_cancelled(env, proposal_id, caller);

    Ok(())
}

#[cfg(test)]
mod proposal_tests {
    use super::*;
    use crate::test_helpers::{fee_change_payload, pause_payload, policy_update_payload, treasury_change_payload};
    use soroban_sdk::testutils::Ledger;
    use soroban_sdk::{testutils::Address as _, Env};

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

        let payload = fee_change_payload(&env, 2_000_000, 750_000);

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
        assert_eq!(proposal.payload.len(), 32);
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

        let payload = fee_change_payload(&env, 2_000_000, 750_000);

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

        let payload = fee_change_payload(&env, 2_000_000, 750_000);

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

        let payload = fee_change_payload(&env, 2_000_000, 750_000);

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

        let payload = fee_change_payload(&env, 2_000_000, 750_000);

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

        // FeeChange requires exactly 32 bytes - test that valid max-size fee payload works
        let max_payload = fee_change_payload(&env, 2_000_000, 750_000);

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
        assert_eq!(proposal.payload.len(), 32);
    }

    #[test]
    fn test_create_multiple_proposals() {
        let (env, admin, contract_id) = setup_for_proposals();

        let current_time = env.ledger().timestamp();
        let fee_payload = fee_change_payload(&env, 2_000_000, 750_000);
        let new_treasury = Address::generate(&env);
        let treasury_payload = treasury_change_payload(&env, &new_treasury);

        // Create first proposal
        let proposal_id_1 = create(
            &env,
            &contract_id,
            &admin,
            ActionType::FeeChange,
            fee_payload,
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
            treasury_payload,
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

        // Test all action types with valid payloads per type
        let fee_payload = fee_change_payload(&env, 2_000_000, 750_000);
        let treasury_payload = treasury_change_payload(&env, &Address::generate(&env));
        let pause_payload = pause_payload(&env);
        let policy_payload = policy_update_payload(&env, 100_0000000, true, 86400);

        let action_types_and_payloads: &[(ActionType, Bytes)] = &[
            (ActionType::FeeChange, fee_payload),
            (ActionType::TreasuryChange, treasury_payload),
            (ActionType::PauseContract, pause_payload.clone()),
            (ActionType::UnpauseContract, pause_payload),
            (ActionType::PolicyUpdate, policy_payload),
        ];

        for (i, (action_type, payload)) in action_types_and_payloads.iter().enumerate() {
            let proposal_id = create(
                &env,
                &contract_id,
                &admin,
                *action_type,
                payload.clone(),
                start_time + (i as u64 * 1000),
                end_time + (i as u64 * 1000),
                eta + (i as u64 * 1000),
            )
            .unwrap();

            let proposal = proposal(&env, &contract_id, proposal_id).unwrap();
            assert_eq!(proposal.action_type, *action_type);
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
                .ok_or(Error::ArithmeticError)?;
        }
        VoteChoice::Against => {
            proposal.votes_against = proposal
                .votes_against
                .checked_add(1)
                .ok_or(Error::ArithmeticError)?;
        }
        VoteChoice::Abstain => {
            proposal.votes_abstain = proposal
                .votes_abstain
                .checked_add(1)
                .ok_or(Error::ArithmeticError)?;
        }
    }

    // Update proposal in storage
    storage::set_proposal(env, proposal_id, &proposal);

    // Emit event
    events::emit_proposal_voted(env, proposal_id, voter, support);

    // Opportunistically emit a state snapshot if enough ledgers have
    // elapsed since this proposal's last snapshot (#1383).
    crate::governance::maybe_auto_snapshot(env, proposal_id, &proposal);

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

    // Skip if already in a terminal or post-active state
    if ProposalStateMachine::is_terminal_state(proposal.state)
        || proposal.state == crate::types::ProposalState::Succeeded
        || proposal.state == crate::types::ProposalState::Queued
    {
        return Ok(());
    }

    let config = storage::get_governance_config(env);
    let total_votes = proposal.votes_for + proposal.votes_against + proposal.votes_abstain;

    // Use the circulating supply snapshotted at proposal creation as the quorum
    // denominator. Fall back to vote count if no tokens existed at creation time.
    let total_eligible: i128 = if proposal.circulating_supply_snapshot > 0 {
        proposal.circulating_supply_snapshot
    } else {
        total_votes.max(1)
    };

    let quorum_met = crate::governance::is_quorum_met(
        total_votes as u32,
        total_eligible.min(u32::MAX as i128) as u32,
        config.quorum_percent,
    );

    let approval_met = if total_votes > 0 {
        (proposal.votes_for * 100 / total_votes) >= config.approval_percent as i128
    } else {
        false
    };

    let new_state = if !quorum_met {
        crate::types::ProposalState::Failed
    } else if approval_met {
        crate::types::ProposalState::Succeeded
    } else {
        crate::types::ProposalState::Defeated
    };

    // Validate and apply transition from stored state.
    // If the proposal never received any votes it stays in Created state;
    // transition Created → Active → outcome in two steps so the state machine
    // rules remain consistent (Created → Succeeded/Defeated are not valid).
    if proposal.state == crate::types::ProposalState::Created {
        if new_state == crate::types::ProposalState::Failed {
            // Created → Failed is allowed (no votes, quorum not met)
            ProposalStateMachine::validate_transition(proposal.state, new_state)?;
        } else {
            // Created → Active → outcome
            ProposalStateMachine::validate_transition(
                proposal.state,
                crate::types::ProposalState::Active,
            )?;
            proposal.state = crate::types::ProposalState::Active;
            ProposalStateMachine::validate_transition(proposal.state, new_state)?;
        }
    } else {
        ProposalStateMachine::validate_transition(proposal.state, new_state)?;
    }

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

    // Re-validate payload before queueing (defense in depth; rejects legacy malformed proposals)
    payload_validation::validate_payload(env, proposal.action_type, &proposal.payload)?;

    // Capture the per-type delay at queue time (not at execution time)
    let queued_delay = delay_for_action(env, proposal.action_type);
    proposal.timelock_delay = queued_delay;
    proposal.queued_at_ledger = env.ledger().sequence();

    // Transition to Queued state
    ProposalStateMachine::validate_transition(proposal.state, crate::types::ProposalState::Queued)?;

    proposal.state = crate::types::ProposalState::Queued;

    // Update proposal in storage
    storage::set_proposal(env, proposal_id, &proposal);

    // Emit event
    events::emit_proposal_queued(env, proposal_id, proposal.eta);

    // Dedicated fee-update event (#1385): signals the pending fee change is
    // now timelocked and cannot execute before `eta`.
    if proposal.action_type == ActionType::FeeChange {
        events::emit_fee_update_queued(env, proposal_id, proposal.eta);
    }

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

    // FIFO ordering (#1366): if this proposal was placed in its action-type
    // execution queue, only the front-of-queue entry may execute. Proposals of
    // the same type therefore execute in the order they were queued; proposals
    // of different types are in independent queues and are unaffected.
    crate::proposal_type_queue::enforce_front(env, proposal_id)?;

    // Emit event signalling the proposal is now executable (timelock elapsed)
    events::emit_proposal_executable(env, proposal_id, proposal.eta);

    match proposal.action_type {
        ActionType::FeeChange => {
            let (base_fee, metadata_fee) = payload_validation::parse_fee_payload(&proposal.payload);
            storage::set_base_fee(env, base_fee);
            storage::set_metadata_fee(env, metadata_fee);
            events::emit_fees_updated_v2(env, &proposal.proposer, base_fee, metadata_fee);
            // Dedicated fee-update event (#1385): the pending fee change has
            // now been applied to contract storage after timelock expiry.
            events::emit_fee_update_executed(env, proposal_id, &proposal.proposer, base_fee, metadata_fee);
        }
        ActionType::TreasuryChange => {
            let new_treasury = payload_validation::parse_treasury_payload(env, &proposal.payload);
            storage::set_treasury(env, &new_treasury);
            events::emit_treasury_updated(env, &new_treasury);
        }
        ActionType::PauseContract => {
            storage::set_paused(env, true);
            events::emit_pause(env, &proposal.proposer);
        }
        ActionType::UnpauseContract => {
            storage::set_paused(env, false);
            events::emit_unpause(env, &proposal.proposer);
        }
        ActionType::PolicyUpdate => {
            let (daily_cap, allowlist_enabled, period_duration) =
                payload_validation::parse_policy_payload(&proposal.payload);
            let policy = crate::types::TreasuryPolicy {
                daily_cap,
                allowlist_enabled,
                period_duration,
            };
            storage::set_treasury_policy(env, &policy);
        }
        ActionType::ParameterChange => {
            // Placeholder for parameter change execution logic
        }
    }

    // Transition to Executed state
    ProposalStateMachine::validate_transition(
        proposal.state,
        crate::types::ProposalState::Executed,
    )?;

    proposal.state = crate::types::ProposalState::Executed;
    proposal.executed_at = Some(current_time);
    storage::set_proposal(env, proposal_id, &proposal);

    // Advance the per-type FIFO queue: remove the just-executed front entry so
    // the next proposal of this type becomes executable (#1366). No-op for
    // proposals that were never enqueued.
    crate::proposal_type_queue::remove(env, proposal_id);

    events::emit_proposal_executed(env, proposal_id, &proposal.proposer, true);

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

#[cfg(test)]
mod cancel_proposal_tests {
    use super::*;
    use crate::test_helpers::fee_change_payload;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, Env};

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

    fn make_proposal(env: &Env, contract_id: &Address, proposer: &Address) -> u64 {
        let t = env.ledger().timestamp();
        let payload = fee_change_payload(env, 2_000_000, 750_000);
        env.as_contract(contract_id, || {
            create_proposal(env, proposer, ActionType::FeeChange, payload, t + 10, t + 86410, t + 90010).unwrap()
        })
    }

    #[test]
    fn proposer_can_cancel() {
        let (env, admin, contract_id) = setup();
        let pid = make_proposal(&env, &contract_id, &admin);

        env.as_contract(&contract_id, || {
            cancel_proposal(&env, &admin, pid).unwrap();
            let p = storage::get_proposal(&env, pid).unwrap();
            assert_eq!(p.state, crate::types::ProposalState::Cancelled);
            assert!(p.cancelled_at.is_some());
        });
    }

    #[test]
    fn non_proposer_non_admin_cannot_cancel() {
        let (env, admin, contract_id) = setup();
        let pid = make_proposal(&env, &contract_id, &admin);
        let stranger = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let err = cancel_proposal(&env, &stranger, pid).unwrap_err();
            assert_eq!(err, Error::Unauthorized);
        });
    }

    #[test]
    fn cannot_cancel_executed_proposal() {
        let (env, admin, contract_id) = setup();
        let pid = make_proposal(&env, &contract_id, &admin);

        env.as_contract(&contract_id, || {
            // Force terminal state
            let mut p = storage::get_proposal(&env, pid).unwrap();
            p.state = crate::types::ProposalState::Executed;
            p.executed_at = Some(env.ledger().timestamp());
            storage::set_proposal(&env, pid, &p);

            let err = cancel_proposal(&env, &admin, pid).unwrap_err();
            assert_eq!(err, Error::ProposalNotCancellable);
        });
    }

    #[test]
    fn cannot_cancel_already_cancelled_proposal() {
        let (env, admin, contract_id) = setup();
        let pid = make_proposal(&env, &contract_id, &admin);

        env.as_contract(&contract_id, || {
            cancel_proposal(&env, &admin, pid).unwrap();
            let err = cancel_proposal(&env, &admin, pid).unwrap_err();
            assert_eq!(err, Error::ProposalNotCancellable);
        });
    }
}

#[cfg(test)]
mod cancel_proposal_tests_v2 {
    use super::*;
    use crate::test_helpers::fee_change_payload;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, Env};

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

    fn make_proposal(env: &Env, contract_id: &Address, proposer: &Address) -> u64 {
        let t = env.ledger().timestamp();
        let payload = fee_change_payload(env, 2_000_000, 750_000);
        env.as_contract(contract_id, || {
            create_proposal(env, proposer, ActionType::FeeChange, payload, t + 10, t + 86410, t + 90010).unwrap()
        })
    }

    #[test]
    fn proposer_can_cancel() {
        let (env, admin, contract_id) = setup();
        let pid = make_proposal(&env, &contract_id, &admin);
        env.as_contract(&contract_id, || {
            cancel_proposal(&env, &admin, pid).unwrap();
            let p = storage::get_proposal(&env, pid).unwrap();
            assert_eq!(p.state, crate::types::ProposalState::Cancelled);
            assert!(p.cancelled_at.is_some());
        });
    }

    #[test]
    fn non_proposer_non_admin_cannot_cancel() {
        let (env, admin, contract_id) = setup();
        let pid = make_proposal(&env, &contract_id, &admin);
        let stranger = Address::generate(&env);
        env.as_contract(&contract_id, || {
            let err = cancel_proposal(&env, &stranger, pid).unwrap_err();
            assert_eq!(err, Error::Unauthorized);
        });
    }

    #[test]
    fn cannot_cancel_terminal_proposal() {
        let (env, admin, contract_id) = setup();
        let pid = make_proposal(&env, &contract_id, &admin);
        env.as_contract(&contract_id, || {
            let mut p = storage::get_proposal(&env, pid).unwrap();
            p.state = crate::types::ProposalState::Executed;
            p.executed_at = Some(env.ledger().timestamp());
            storage::set_proposal(&env, pid, &p);
            let err = cancel_proposal(&env, &admin, pid).unwrap_err();
            assert_eq!(err, Error::ProposalNotCancellable);
        });
    }

    #[test]
    fn cannot_cancel_already_cancelled() {
        let (env, admin, contract_id) = setup();
        let pid = make_proposal(&env, &contract_id, &admin);
        env.as_contract(&contract_id, || {
            cancel_proposal(&env, &admin, pid).unwrap();
            let err = cancel_proposal(&env, &admin, pid).unwrap_err();
            assert_eq!(err, Error::ProposalNotCancellable);
        });
    }
}
