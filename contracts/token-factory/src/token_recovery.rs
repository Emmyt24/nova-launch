//! Token Recovery Mechanism for Lost Funds
//!
//! Provides a two-step, time-locked admin transfer of token balances from
//! addresses that are provably inaccessible (lost keys, burned addresses, etc.).
//!
//! # Design
//! 1. Admin initiates a recovery request, specifying the source address,
//!    destination address, token index, and amount.
//! 2. A mandatory `RECOVERY_TIMELOCK_SECONDS` delay must elapse before the
//!    recovery can be executed, giving the community time to object.
//! 3. Admin executes the recovery after the timelock expires.
//! 4. Recovery requests can be cancelled by the admin at any time before
//!    execution.
//!
//! # Security (OWASP)
//! - Two-step process prevents accidental or malicious single-tx recovery.
//! - Timelock provides transparency and community oversight.
//! - Admin authorization enforced on every mutation.
//! - Checked arithmetic throughout.
//! - Recovery requests are append-only; executed/cancelled requests are
//!   preserved for audit.

use crate::{storage, types::Error};
use soroban_sdk::{contracttype, symbol_short, Address, Env};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Minimum delay (in seconds) between initiating and executing a recovery.
/// Default: 48 hours.
pub const RECOVERY_TIMELOCK_SECONDS: u64 = 172_800;

// ── Types ─────────────────────────────────────────────────────────────────────

/// Status of a recovery request.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryStatus {
    /// Pending execution after timelock.
    Pending,
    /// Successfully executed.
    Executed,
    /// Cancelled by admin before execution.
    Cancelled,
}

/// A recovery request record.
///
/// # Fields
/// * `request_id`   – Monotonically increasing identifier.
/// * `token_index`  – Index of the token to recover.
/// * `from`         – Source address (lost/inaccessible).
/// * `to`           – Destination address for recovered tokens.
/// * `amount`       – Amount to recover.
/// * `initiated_by` – Admin who initiated the request.
/// * `initiated_at` – Ledger timestamp of initiation.
/// * `execute_after`– Earliest timestamp at which execution is allowed.
/// * `status`       – Current status of the request.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryRequest {
    pub request_id: u64,
    pub token_index: u32,
    pub from: Address,
    pub to: Address,
    pub amount: i128,
    pub initiated_by: Address,
    pub initiated_at: u64,
    pub execute_after: u64,
    pub status: RecoveryStatus,
}

/// Storage key for recovery data.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecoveryKey {
    /// Individual request by ID.
    Request(u64),
    /// Monotonic counter for the next request ID.
    RequestCount,
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Initiate a token recovery request (admin only, step 1 of 2).
///
/// Creates a pending recovery request that can be executed after
/// `RECOVERY_TIMELOCK_SECONDS` have elapsed.
///
/// # Arguments
/// * `env`         – The contract environment.
/// * `admin`       – Admin address (must authorize and match stored admin).
/// * `token_index` – Index of the token to recover.
/// * `from`        – Source address holding the lost tokens.
/// * `to`          – Destination address for recovered tokens.
/// * `amount`      – Amount to recover (must be > 0).
///
/// # Returns
/// The `request_id` of the newly created recovery request.
///
/// # Errors
/// * `Error::Unauthorized`      – Caller is not the admin.
/// * `Error::TokenNotFound`     – Token index does not exist.
/// * `Error::InvalidParameters` – Amount ≤ 0, or `from == to`.
/// * `Error::InsufficientBalance` – Source address has insufficient balance.
/// * `Error::ArithmeticError`   – Request ID counter overflowed.
pub fn initiate_recovery(
    env: &Env,
    admin: &Address,
    token_index: u32,
    from: &Address,
    to: &Address,
    amount: i128,
) -> Result<u64, Error> {
    // ── Authorization ────────────────────────────────────────────────────────
    admin.require_auth();
    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    // ── Validate token exists ────────────────────────────────────────────────
    storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;

    // ── Input validation ─────────────────────────────────────────────────────
    if amount <= 0 {
        return Err(Error::InvalidParameters);
    }
    if from == to {
        return Err(Error::InvalidParameters);
    }

    // ── Balance check ────────────────────────────────────────────────────────
    let source_balance = storage::get_balance(env, token_index, from);
    if source_balance < amount {
        return Err(Error::InsufficientBalance);
    }

    // ── Assign request ID ────────────────────────────────────────────────────
    let request_id = next_request_id(env)?;
    let now = env.ledger().timestamp();
    let execute_after = now
        .checked_add(RECOVERY_TIMELOCK_SECONDS)
        .ok_or(Error::ArithmeticError)?;

    let request = RecoveryRequest {
        request_id,
        token_index,
        from: from.clone(),
        to: to.clone(),
        amount,
        initiated_by: admin.clone(),
        initiated_at: now,
        execute_after,
        status: RecoveryStatus::Pending,
    };

    env.storage()
        .persistent()
        .set(&RecoveryKey::Request(request_id), &request);

    emit_recovery_initiated(env, request_id, admin, token_index, from, to, amount, execute_after);

    Ok(request_id)
}

/// Execute a pending recovery request (admin only, step 2 of 2).
///
/// Transfers tokens from the source to the destination address.
/// The timelock must have expired before execution is allowed.
///
/// # Arguments
/// * `env`        – The contract environment.
/// * `admin`      – Admin address (must authorize and match stored admin).
/// * `request_id` – ID of the pending recovery request.
///
/// # Errors
/// * `Error::Unauthorized`      – Caller is not the admin.
/// * `Error::TokenNotFound`     – Request ID does not exist.
/// * `Error::InvalidParameters` – Request is not in Pending status.
/// * `Error::TimelockNotExpired`– Timelock has not yet elapsed.
/// * `Error::InsufficientBalance` – Source balance changed since initiation.
/// * `Error::ArithmeticError`   – Arithmetic overflow.
pub fn execute_recovery(env: &Env, admin: &Address, request_id: u64) -> Result<(), Error> {
    admin.require_auth();
    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    let mut request: RecoveryRequest = env
        .storage()
        .persistent()
        .get(&RecoveryKey::Request(request_id))
        .ok_or(Error::TokenNotFound)?;

    if request.status != RecoveryStatus::Pending {
        return Err(Error::InvalidParameters);
    }

    let now = env.ledger().timestamp();
    if now < request.execute_after {
        return Err(Error::TimelockNotExpired);
    }

    // Re-validate balance (may have changed since initiation)
    let source_balance = storage::get_balance(env, request.token_index, &request.from);
    if source_balance < request.amount {
        return Err(Error::InsufficientBalance);
    }

    // ── Transfer ─────────────────────────────────────────────────────────────
    let new_source = source_balance
        .checked_sub(request.amount)
        .ok_or(Error::ArithmeticError)?;
    storage::set_balance(env, request.token_index, &request.from, new_source);

    let dest_balance = storage::get_balance(env, request.token_index, &request.to);
    let new_dest = dest_balance
        .checked_add(request.amount)
        .ok_or(Error::ArithmeticError)?;
    storage::set_balance(env, request.token_index, &request.to, new_dest);

    // ── Update status ─────────────────────────────────────────────────────────
    request.status = RecoveryStatus::Executed;
    env.storage()
        .persistent()
        .set(&RecoveryKey::Request(request_id), &request);

    emit_recovery_executed(env, request_id, admin, request.token_index, &request.from, &request.to, request.amount);

    Ok(())
}

/// Cancel a pending recovery request (admin only).
///
/// # Arguments
/// * `env`        – The contract environment.
/// * `admin`      – Admin address (must authorize and match stored admin).
/// * `request_id` – ID of the pending recovery request.
///
/// # Errors
/// * `Error::Unauthorized`      – Caller is not the admin.
/// * `Error::TokenNotFound`     – Request ID does not exist.
/// * `Error::InvalidParameters` – Request is not in Pending status.
pub fn cancel_recovery(env: &Env, admin: &Address, request_id: u64) -> Result<(), Error> {
    admin.require_auth();
    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    let mut request: RecoveryRequest = env
        .storage()
        .persistent()
        .get(&RecoveryKey::Request(request_id))
        .ok_or(Error::TokenNotFound)?;

    if request.status != RecoveryStatus::Pending {
        return Err(Error::InvalidParameters);
    }

    request.status = RecoveryStatus::Cancelled;
    env.storage()
        .persistent()
        .set(&RecoveryKey::Request(request_id), &request);

    emit_recovery_cancelled(env, request_id, admin);

    Ok(())
}

/// Retrieve a recovery request by ID.
pub fn get_recovery_request(env: &Env, request_id: u64) -> Option<RecoveryRequest> {
    env.storage()
        .persistent()
        .get(&RecoveryKey::Request(request_id))
}

/// Return the total number of recovery requests initiated.
pub fn get_recovery_request_count(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&RecoveryKey::RequestCount)
        .unwrap_or(0)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn next_request_id(env: &Env) -> Result<u64, Error> {
    let current: u64 = env
        .storage()
        .persistent()
        .get(&RecoveryKey::RequestCount)
        .unwrap_or(0);
    let next = current.checked_add(1).ok_or(Error::ArithmeticError)?;
    env.storage()
        .persistent()
        .set(&RecoveryKey::RequestCount, &next);
    Ok(current)
}

fn emit_recovery_initiated(
    env: &Env,
    request_id: u64,
    admin: &Address,
    token_index: u32,
    from: &Address,
    to: &Address,
    amount: i128,
    execute_after: u64,
) {
    env.events().publish(
        (symbol_short!("rec_init"), request_id),
        (admin, token_index, from, to, amount, execute_after),
    );
}

fn emit_recovery_executed(
    env: &Env,
    request_id: u64,
    admin: &Address,
    token_index: u32,
    from: &Address,
    to: &Address,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("rec_exec"), request_id),
        (admin, token_index, from, to, amount),
    );
}

fn emit_recovery_cancelled(env: &Env, request_id: u64, admin: &Address) {
    env.events().publish(
        (symbol_short!("rec_cncl"), request_id),
        (admin,),
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        storage,
        types::{Error, TokenInfo},
        TokenFactory, TokenFactoryClient,
    };
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    fn setup(env: &Env) -> (TokenFactoryClient, Address, Address) {
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        client.initialize(&admin, &treasury, &1_000_000, &500_000);
        (client, admin, contract_id)
    }

    fn seed_token_with_balance(
        env: &Env,
        contract_id: &Address,
        token_index: u32,
        holder: &Address,
        balance: i128,
    ) {
        let info = TokenInfo {
            address: Address::generate(env),
            creator: Address::generate(env),
            name: String::from_str(env, "Test"),
            symbol: String::from_str(env, "TST"),
            decimals: 7,
            total_supply: balance,
            initial_supply: balance,
            max_supply: None,
            total_burned: 0,
            burn_count: 0,
            metadata_uri: None,
            created_at: 0,
            is_paused: false,
            clawback_enabled: false,
            freeze_enabled: false,
        };
        env.as_contract(contract_id, || {
            storage::set_token_info(env, token_index, &info);
            storage::set_balance(env, token_index, holder, balance);
        });
    }

    // ── initiate_recovery ─────────────────────────────────────────────────────

    #[test]
    fn test_initiate_recovery_success() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let (_, admin, contract_id) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &from, 1_000_000);

        let request_id = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 0, &from, &to, 500_000).unwrap()
        });

        assert_eq!(request_id, 0);
        let req = env
            .as_contract(&contract_id, || get_recovery_request(&env, 0))
            .unwrap();
        assert_eq!(req.status, RecoveryStatus::Pending);
        assert_eq!(req.amount, 500_000);
        assert_eq!(req.execute_after, 1_000_000 + RECOVERY_TIMELOCK_SECONDS);
    }

    #[test]
    fn test_initiate_recovery_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, contract_id) = setup(&env);
        let non_admin = Address::generate(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &from, 1_000_000);

        let result = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &non_admin, 0, &from, &to, 100_000)
        });
        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_initiate_recovery_zero_amount_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &from, 1_000_000);

        let result = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 0, &from, &to, 0)
        });
        assert_eq!(result, Err(Error::InvalidParameters));
    }

    #[test]
    fn test_initiate_recovery_same_from_to_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);
        let addr = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &addr, 1_000_000);

        let result = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 0, &addr, &addr, 100_000)
        });
        assert_eq!(result, Err(Error::InvalidParameters));
    }

    #[test]
    fn test_initiate_recovery_insufficient_balance_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &from, 100);

        let result = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 0, &from, &to, 200)
        });
        assert_eq!(result, Err(Error::InsufficientBalance));
    }

    #[test]
    fn test_initiate_recovery_nonexistent_token_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admin, contract_id) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);

        let result = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 99, &from, &to, 100)
        });
        assert_eq!(result, Err(Error::TokenNotFound));
    }

    // ── execute_recovery ──────────────────────────────────────────────────────

    #[test]
    fn test_execute_recovery_success() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let (_, admin, contract_id) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &from, 1_000_000);

        let request_id = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 0, &from, &to, 400_000).unwrap()
        });

        // Advance time past timelock
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000_000 + RECOVERY_TIMELOCK_SECONDS + 1);

        env.as_contract(&contract_id, || {
            execute_recovery(&env, &admin, request_id).unwrap()
        });

        // Verify balances
        let from_bal = env.as_contract(&contract_id, || storage::get_balance(&env, 0, &from));
        let to_bal = env.as_contract(&contract_id, || storage::get_balance(&env, 0, &to));
        assert_eq!(from_bal, 600_000);
        assert_eq!(to_bal, 400_000);

        // Verify status
        let req = env
            .as_contract(&contract_id, || get_recovery_request(&env, request_id))
            .unwrap();
        assert_eq!(req.status, RecoveryStatus::Executed);
    }

    #[test]
    fn test_execute_recovery_before_timelock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let (_, admin, contract_id) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &from, 1_000_000);

        let request_id = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 0, &from, &to, 100_000).unwrap()
        });

        // Do NOT advance time
        let result = env.as_contract(&contract_id, || execute_recovery(&env, &admin, request_id));
        assert_eq!(result, Err(Error::TimelockNotExpired));
    }

    #[test]
    fn test_execute_recovery_double_execution_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let (_, admin, contract_id) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &from, 1_000_000);

        let request_id = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 0, &from, &to, 100_000).unwrap()
        });

        env.ledger()
            .with_mut(|l| l.timestamp = 1_000_000 + RECOVERY_TIMELOCK_SECONDS + 1);

        env.as_contract(&contract_id, || {
            execute_recovery(&env, &admin, request_id).unwrap()
        });

        let result =
            env.as_contract(&contract_id, || execute_recovery(&env, &admin, request_id));
        assert_eq!(result, Err(Error::InvalidParameters));
    }

    // ── cancel_recovery ───────────────────────────────────────────────────────

    #[test]
    fn test_cancel_recovery_success() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let (_, admin, contract_id) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &from, 1_000_000);

        let request_id = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 0, &from, &to, 100_000).unwrap()
        });

        env.as_contract(&contract_id, || {
            cancel_recovery(&env, &admin, request_id).unwrap()
        });

        let req = env
            .as_contract(&contract_id, || get_recovery_request(&env, request_id))
            .unwrap();
        assert_eq!(req.status, RecoveryStatus::Cancelled);
    }

    #[test]
    fn test_cancel_executed_recovery_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let (_, admin, contract_id) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &from, 1_000_000);

        let request_id = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 0, &from, &to, 100_000).unwrap()
        });

        env.ledger()
            .with_mut(|l| l.timestamp = 1_000_000 + RECOVERY_TIMELOCK_SECONDS + 1);
        env.as_contract(&contract_id, || {
            execute_recovery(&env, &admin, request_id).unwrap()
        });

        let result =
            env.as_contract(&contract_id, || cancel_recovery(&env, &admin, request_id));
        assert_eq!(result, Err(Error::InvalidParameters));
    }

    // ── admin_transfer_test compatibility ─────────────────────────────────────

    /// Mirrors the admin_transfer_test pattern: verifies recovery is admin-only.
    #[test]
    fn admin_transfer_test_recovery_requires_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, _, contract_id) = setup(&env);
        let impostor = Address::generate(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &from, 1_000_000);

        let result = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &impostor, 0, &from, &to, 100_000)
        });
        assert_eq!(result, Err(Error::Unauthorized));
    }

    // ── Event emission ────────────────────────────────────────────────────────

    #[test]
    fn test_initiate_recovery_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let (_, admin, contract_id) = setup(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        seed_token_with_balance(&env, &contract_id, 0, &from, 1_000_000);

        let before = env.events().all().len();
        env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 0, &from, &to, 100_000).unwrap()
        });
        assert_eq!(env.events().all().len(), before + 1);
    }

    // ── Integration ───────────────────────────────────────────────────────────

    #[test]
    fn integration_test_full_recovery_lifecycle() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);
        let (_, admin, contract_id) = setup(&env);
        let lost_wallet = Address::generate(&env);
        let recovery_wallet = Address::generate(&env);
        let initial_balance = 5_000_000_i128;
        seed_token_with_balance(&env, &contract_id, 0, &lost_wallet, initial_balance);

        // Step 1: initiate
        let request_id = env.as_contract(&contract_id, || {
            initiate_recovery(&env, &admin, 0, &lost_wallet, &recovery_wallet, initial_balance)
                .unwrap()
        });

        // Verify pending
        let req = env
            .as_contract(&contract_id, || get_recovery_request(&env, request_id))
            .unwrap();
        assert_eq!(req.status, RecoveryStatus::Pending);

        // Step 2: advance time and execute
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000_000 + RECOVERY_TIMELOCK_SECONDS + 100);

        env.as_contract(&contract_id, || {
            execute_recovery(&env, &admin, request_id).unwrap()
        });

        // Verify final state
        let lost_bal =
            env.as_contract(&contract_id, || storage::get_balance(&env, 0, &lost_wallet));
        let recovery_bal =
            env.as_contract(&contract_id, || storage::get_balance(&env, 0, &recovery_wallet));

        assert_eq!(lost_bal, 0);
        assert_eq!(recovery_bal, initial_balance);

        let req = env
            .as_contract(&contract_id, || get_recovery_request(&env, request_id))
            .unwrap();
        assert_eq!(req.status, RecoveryStatus::Executed);
    }
}
