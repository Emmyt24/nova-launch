//! Acceptance timeout for two-step admin transfers (#2230).
//!
//! A pending admin proposal expires `ADMIN_TRANSFER_TIMEOUT_SECS` after it is
//! proposed. Accepting after expiry is rejected; the current admin may always
//! cancel (via `cancel_admin`) or re-propose.

use soroban_sdk::{contracttype, Env};

use crate::types::Error;

/// Seconds a pending admin proposal stays acceptable (7 days).
pub const ADMIN_TRANSFER_TIMEOUT_SECS: u64 = 604_800;

#[allow(non_upper_case_globals)]
impl Error {
    /// The pending admin proposal has expired and can no longer be accepted.
    pub const PendingAdminExpired: Self = Self(500);
}

#[contracttype]
#[derive(Clone)]
enum TimeoutKey {
    PendingAdminExpiry,
}

/// Record the expiry for a freshly created proposal.
pub fn record_proposal(env: &Env) {
    let expiry: u64 = env
        .ledger()
        .timestamp()
        .saturating_add(ADMIN_TRANSFER_TIMEOUT_SECS);
    env.storage()
        .instance()
        .set(&TimeoutKey::PendingAdminExpiry, &expiry);
}

/// Expiry timestamp of the pending proposal, if one was recorded.
pub fn get_expiry(env: &Env) -> Option<u64> {
    env.storage().instance().get(&TimeoutKey::PendingAdminExpiry)
}

/// Fail with `PendingAdminExpired` if the pending proposal has expired.
pub fn require_not_expired(env: &Env) -> Result<(), Error> {
    if let Some(expiry) = get_expiry(env) {
        if env.ledger().timestamp() > expiry {
            return Err(Error::PendingAdminExpired);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ADMIN_TRANSFER_TIMEOUT_SECS;
    use crate::{TokenFactory, TokenFactoryClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env,
    };

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let new_admin = Address::generate(&env);
        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        (env, contract_id, admin, new_admin)
    }

    #[test]
    fn accept_before_expiry_succeeds() {
        let (env, id, admin, new_admin) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        client.propose_admin(&admin, &new_admin);
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000 + ADMIN_TRANSFER_TIMEOUT_SECS - 1);
        assert!(client.try_accept_admin(&new_admin).is_ok());
        assert_eq!(client.get_state().admin, new_admin);
    }

    #[test]
    fn accept_exactly_at_expiry_succeeds() {
        let (env, id, admin, new_admin) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        client.propose_admin(&admin, &new_admin);
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000 + ADMIN_TRANSFER_TIMEOUT_SECS);
        assert!(client.try_accept_admin(&new_admin).is_ok());
    }

    #[test]
    fn accept_after_expiry_fails() {
        let (env, id, admin, new_admin) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        client.propose_admin(&admin, &new_admin);
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000 + ADMIN_TRANSFER_TIMEOUT_SECS + 1);
        assert!(client.try_accept_admin(&new_admin).is_err());
        assert_eq!(client.get_state().admin, admin);
    }

    #[test]
    fn admin_can_cancel_expired_proposal() {
        let (env, id, admin, new_admin) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        client.propose_admin(&admin, &new_admin);
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000 + ADMIN_TRANSFER_TIMEOUT_SECS + 10);
        assert!(client.try_cancel_admin(&admin).is_ok());
        assert!(client.try_accept_admin(&new_admin).is_err());
    }

    #[test]
    fn reproposal_refreshes_expiry() {
        let (env, id, admin, new_admin) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        client.propose_admin(&admin, &new_admin);
        env.ledger()
            .with_mut(|l| l.timestamp = 1_000 + ADMIN_TRANSFER_TIMEOUT_SECS + 10);
        client.propose_admin(&admin, &new_admin);
        assert!(client.try_accept_admin(&new_admin).is_ok());
    }

    #[test]
    fn expiry_getter_reports_deadline() {
        let (env, id, admin, new_admin) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        client.propose_admin(&admin, &new_admin);
        assert_eq!(
            client.pending_admin_expiry(),
            Some(1_000 + ADMIN_TRANSFER_TIMEOUT_SECS)
        );
    }
}
