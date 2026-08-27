// Storage Migration Module for Contract Upgrades (#1147)
//
// This module provides a mechanism for migrating persistent storage entries
// when the contract is upgraded, ensuring data layout changes are safe.
//
// Key features:
// - Versioned storage schema marker
// - Migration entrypoint that upgrades old entries to new layout
// - Admin-gated execution (runs once)
//
// The migration pattern:
// 1. Store the current schema version in persistent storage
// 2. On upgrade, check if migration is needed
// 3. Admin calls migrate() to perform the migration
// 4. Migration runs once and updates the version marker

use crate::storage;
use crate::types::{ContractVersion, DataKey, Error};
use soroban_sdk::{Address, Bytes, Env, Vec};

// Current schema version - increment when storage layout changes
const CURRENT_SCHEMA_VERSION: u32 = 2;

/// Report of changes that would occur in a storage migration.
///
/// Returned by `migrate_dry_run()` to show exactly what would change
/// without committing any writes to storage.
#[derive(Debug, Clone)]
pub struct DryRunDiff {
    pub old_version: u32,
    pub new_version: u32,
    pub changes_summary: Bytes,
}

/// Check if storage migration is required
///
/// Returns true if the stored schema version is older than current.
pub fn is_migration_required(env: &Env) -> bool {
    let stored_version = get_storage_version(env);
    stored_version < CURRENT_SCHEMA_VERSION
}

/// Get the current storage schema version
pub fn get_storage_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::StorageVersion)
        .unwrap_or(1) // Default to version 1 for uninitialized contracts
}

/// Set the storage schema version
fn set_storage_version(env: &Env, version: u32) {
    env.storage()
        .instance()
        .set(&DataKey::StorageVersion, &version);
}

/// Initialize storage version on first deploy
pub fn initialize_storage_version(env: &Env) {
    if !env.storage().instance().has(&DataKey::StorageVersion) {
        set_storage_version(env, CURRENT_SCHEMA_VERSION);
    }
}

/// Execute storage migration (admin-gated, runs once)
///
/// This function migrates storage from old schema to new schema.
/// It can only be called by the admin and will only run if migration
/// is actually required.
///
/// # Arguments
/// * `env` - The contract environment
/// * `admin` - Admin address (must authorize)
///
/// # Returns
/// * `Ok(())` on success
/// * `Err(Error::Unauthorized)` if caller is not admin
/// * `Err(Error::StorageMigrationAlreadyRun)` if migration already completed
///
/// # Events
/// Emits `StorageMigrated` event with old and new version numbers
pub fn migrate(env: &Env, admin: Address) -> Result<(), Error> {
    admin.require_auth();

    // Verify caller is admin
    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if admin != current_admin {
        return Err(Error::Unauthorized);
    }

    // Check if migration is required
    let old_version = get_storage_version(env);
    if old_version >= CURRENT_SCHEMA_VERSION {
        return Err(Error::StorageMigrationAlreadyRun);
    }

    // Perform migration from v1 to v2
    // Add your migration logic here based on what changed in the schema
    // Example: migrate_token_data_format(env);
    //          migrate_governance_data(env);

    // Update version marker
    set_storage_version(env, CURRENT_SCHEMA_VERSION);

    // Emit migration event
    emit_storage_migrated(env, old_version, CURRENT_SCHEMA_VERSION);

    Ok(())
}

/// Execute a dry-run of storage migration without committing writes.
///
/// This function computes what the migration would do and returns a diff report
/// without making any changes to actual storage. Useful for validating migrations
/// against production data before running the real migration.
///
/// # Arguments
/// * `env` - The contract environment (read-only for migration logic)
/// * `admin` - Admin address (must authorize)
///
/// # Returns
/// * `Ok(DryRunDiff)` containing the migration diff report
/// * `Err(Error::Unauthorized)` if caller is not admin
/// * `Err(Error::StorageMigrationAlreadyRun)` if migration already completed
pub fn migrate_dry_run(env: &Env, admin: Address) -> Result<DryRunDiff, Error> {
    admin.require_auth();

    // Verify caller is admin
    let current_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if admin != current_admin {
        return Err(Error::Unauthorized);
    }

    // Check if migration is required
    let old_version = get_storage_version(env);
    if old_version >= CURRENT_SCHEMA_VERSION {
        return Err(Error::StorageMigrationAlreadyRun);
    }

    // Compute migration changes (in dry-run mode, no writes)
    // This would be the same logic as migrate(), but we collect changes into a report
    // and return them without persisting to storage.

    // For v1->v2, we would analyze what changes would occur
    // Add your dry-run logic here that mirrors the actual migration logic
    // but collects results in a summary instead of writing to storage
    let summary = soroban_sdk::Bytes::new(env);

    Ok(DryRunDiff {
        old_version,
        new_version: CURRENT_SCHEMA_VERSION,
        changes_summary: summary,
    })
}

/// Get the contract version info
pub fn get_contract_version(env: &Env) -> ContractVersion {
    env.storage()
        .instance()
        .get(&DataKey::ContractVersion)
        .unwrap_or(ContractVersion {
            major: 1,
            minor: 0,
            patch: 0,
            migrated_at: 0,
        })
}

/// Set the contract version info
pub fn set_contract_version(env: &Env, version: ContractVersion) {
    env.storage()
        .instance()
        .set(&DataKey::ContractVersion, &version);
}

// ─────────────────────────────────────────────
// Event emission
// ─────────────────────────────────────────────

/// Emit storage migrated event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: stor_mig
///
/// **Topics** (indexed):
/// - Event name: "stor_mig"
///
/// **Payload** (non-indexed):
/// - old_version: u32 - The previous schema version
/// - new_version: u32 - The new schema version
///
/// Emitted when storage migration is completed
fn emit_storage_migrated(env: &Env, old_version: u32, new_version: u32) {
    use soroban_sdk::symbol_short;
    env.events().publish(
        (symbol_short!("stor_mig"),),
        (old_version, new_version),
    );
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

#[cfg(test)]
mod storage_migration_test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        (env, admin)
    }

    #[test]
    fn test_initial_version_is_one() {
        let (env, _admin) = setup();
        // Fresh contract should have version 1 (default)
        assert_eq!(get_storage_version(&env), 1);
    }

    #[test]
    fn test_migration_requires_admin() {
        let (env, admin) = setup();
        let unauthorized = Address::generate(&env);

        // Register contract to have admin set
        env.register_contract(None, crate::TokenFactory);
        storage::set_admin(&env, &admin);

        // Migration should fail with unauthorized
        let result = migrate(&env, unauthorized);
        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_migration_already_run() {
        let (env, admin) = setup();
        env.register_contract(None, crate::TokenFactory);
        storage::set_admin(&env, &admin);

        // Set version to current to simulate already migrated
        set_storage_version(&env, CURRENT_SCHEMA_VERSION);

        let result = migrate(&env, admin);
        assert_eq!(result, Err(Error::StorageMigrationAlreadyRun));
    }

    #[test]
    fn test_migration_success() {
        let (env, admin) = setup();
        env.register_contract(None, crate::TokenFactory);
        storage::set_admin(&env, &admin);

        // Ensure we're at old version
        set_storage_version(&env, 1);
        assert!(is_migration_required(&env));

        // Run migration
        let result = migrate(&env, admin);
        assert!(result.is_ok());

        // Verify version updated
        assert_eq!(get_storage_version(&env), CURRENT_SCHEMA_VERSION);
        assert!(!is_migration_required(&env));
    }

    #[test]
    fn test_initialize_storage_version() {
        let (env, _admin) = setup();
        env.register_contract(None, crate::TokenFactory);

        // Should initialize to current version
        initialize_storage_version(&env);
        assert_eq!(get_storage_version(&env), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn test_dry_run_migration_requires_admin() {
        let (env, admin) = setup();
        let unauthorized = Address::generate(&env);

        env.register_contract(None, crate::TokenFactory);
        storage::set_admin(&env, &admin);

        // Dry-run should fail with unauthorized
        let result = migrate_dry_run(&env, unauthorized);
        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_dry_run_migration_already_run() {
        let (env, admin) = setup();
        env.register_contract(None, crate::TokenFactory);
        storage::set_admin(&env, &admin);

        // Set version to current to simulate already migrated
        set_storage_version(&env, CURRENT_SCHEMA_VERSION);

        let result = migrate_dry_run(&env, admin);
        assert_eq!(result, Err(Error::StorageMigrationAlreadyRun));
    }

    #[test]
    fn test_dry_run_migration_success() {
        let (env, admin) = setup();
        env.register_contract(None, crate::TokenFactory);
        storage::set_admin(&env, &admin);

        // Ensure we're at old version
        set_storage_version(&env, 1);

        // Run dry-run
        let result = migrate_dry_run(&env, admin);
        assert!(result.is_ok());

        let diff = result.unwrap();
        assert_eq!(diff.old_version, 1);
        assert_eq!(diff.new_version, CURRENT_SCHEMA_VERSION);

        // Verify storage was NOT modified (dry-run has zero side effects)
        assert_eq!(get_storage_version(&env), 1);
    }

    #[test]
    fn test_dry_run_has_zero_side_effects() {
        let (env, admin) = setup();
        env.register_contract(None, crate::TokenFactory);
        storage::set_admin(&env, &admin);

        // Set to old version
        set_storage_version(&env, 1);
        let initial_version = get_storage_version(&env);

        // Run dry-run multiple times
        for _ in 0..3 {
            let result = migrate_dry_run(&env, admin.clone());
            assert!(result.is_ok());
        }

        // Storage should be completely unchanged
        assert_eq!(get_storage_version(&env), initial_version);
        assert_eq!(get_storage_version(&env), 1);
    }
}