//! Contract upgrade migration hook and version tracking (#2232).
//!
//! The contract tracks a monotonically increasing version number. After a
//! wasm upgrade the admin calls `run_migration(admin, target_version)` once per
//! version step; steps must be applied in order (`stored + 1`), cannot be
//! repeated, and cannot exceed `LATEST_CONTRACT_VERSION`. Per-version data
//! transformations belong in `apply_step`.

use soroban_sdk::{contracttype, symbol_short, Address, Env};

use crate::storage;
use crate::types::Error;

/// Highest version this build knows how to migrate to.
pub const LATEST_CONTRACT_VERSION: u32 = 2;
/// Version assumed for contracts deployed before version tracking existed.
pub const INITIAL_CONTRACT_VERSION: u32 = 1;

#[allow(non_upper_case_globals)]
impl Error {
    /// The requested version has already been applied (or is older than the stored one).
    pub const MigrationAlreadyApplied: Self = Self(520);
    /// Target version is out of order or above the latest supported version.
    pub const InvalidMigrationTarget: Self = Self(521);
}

#[contracttype]
#[derive(Clone)]
enum MigrationKey {
    Version,
}

/// Currently stored contract version (defaults to `INITIAL_CONTRACT_VERSION`).
pub fn get_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&MigrationKey::Version)
        .unwrap_or(INITIAL_CONTRACT_VERSION)
}

/// Per-version migration hook. Add data transformations for `target` here.
fn apply_step(_env: &Env, _target: u32) {
    // v1 -> v2: no data transformation required (version marker only).
}

/// Run the migration to `target` (admin only, once per version, in order).
pub fn run_migration(env: &Env, admin: &Address, target: u32) -> Result<u32, Error> {
    admin.require_auth();
    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    let current = get_version(env);
    if target <= current {
        return Err(Error::MigrationAlreadyApplied);
    }
    if target != current + 1 || target > LATEST_CONTRACT_VERSION {
        return Err(Error::InvalidMigrationTarget);
    }

    apply_step(env, target);
    env.storage().instance().set(&MigrationKey::Version, &target);
    env.events()
        .publish((symbol_short!("migrated"),), (current, target));
    Ok(target)
}

#[cfg(test)]
mod tests {
    use crate::{TokenFactory, TokenFactoryClient};
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100_0000000, &50_0000000);
        (env, contract_id, admin)
    }

    #[test]
    fn default_version_is_initial() {
        let (env, id, _admin) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        assert_eq!(client.contract_version_number(), 1);
    }

    #[test]
    fn migrate_once_then_rejected() {
        let (env, id, admin) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        assert_eq!(client.run_migration(&admin, &2_u32), 2);
        assert_eq!(client.contract_version_number(), 2);
        assert!(client.try_run_migration(&admin, &2_u32).is_err());
        assert_eq!(client.contract_version_number(), 2);
    }

    #[test]
    fn rejects_skipped_and_unknown_versions() {
        let (env, id, admin) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        assert!(client.try_run_migration(&admin, &3_u32).is_err());
        assert!(client.try_run_migration(&admin, &0_u32).is_err());
        assert!(client.try_run_migration(&admin, &1_u32).is_err());
        assert_eq!(client.contract_version_number(), 1);
        client.run_migration(&admin, &2_u32);
        assert!(client.try_run_migration(&admin, &3_u32).is_err());
    }

    #[test]
    fn non_admin_cannot_migrate() {
        let (env, id, _admin) = setup();
        let client = TokenFactoryClient::new(&env, &id);
        let other = Address::generate(&env);
        assert!(client.try_run_migration(&other, &2_u32).is_err());
        assert_eq!(client.contract_version_number(), 1);
    }
}
