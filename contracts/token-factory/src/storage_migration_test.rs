#![cfg(test)]

use crate::{
    storage, storage_migration, types::{DataKey, Error, ContractVersion},
    TokenFactory, TokenFactoryClient,
};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    let client = TokenFactoryClient::new(&env, &contract_id);
    client.initialize(&admin, &treasury, &1_000_000, &500_000);

    (env, admin)
}

#[test]
fn test_migrating_populated_pre_upgrade_storage_preserves_all_data() {
    let (env, admin) = setup();

    env.as_contract(&env.current_contract_address(), || {
        // Simulate pre-migration storage state (version 1)
        storage_migration::set_storage_version(&env, 1);

        // Populate storage with test data that should survive migration
        let token_index = 0u32;
        let holder1 = Address::generate(&env);
        let holder2 = Address::generate(&env);

        // Set multiple balances
        storage::set_balance(&env, token_index, &holder1, 1_000_000i128);
        storage::set_balance(&env, token_index, &holder2, 5_000_000i128);

        // Verify pre-migration state
        let pre_balance1 = storage::get_balance(&env, token_index, &holder1);
        let pre_balance2 = storage::get_balance(&env, token_index, &holder2);
        assert_eq!(pre_balance1, 1_000_000i128);
        assert_eq!(pre_balance2, 5_000_000i128);

        // Store some metadata
        storage::set_base_fee(&env, 2_000_000i128);
        storage::set_metadata_fee(&env, 1_500_000i128);

        // Verify metadata pre-migration
        assert_eq!(storage::get_base_fee(&env), 2_000_000i128);
        assert_eq!(storage::get_metadata_fee(&env), 1_500_000i128);

        // Run migration
        let migration_result = storage_migration::migrate(&env, admin);
        assert!(migration_result.is_ok(), "Migration should succeed");

        // Verify storage version was updated
        assert_eq!(
            storage_migration::get_storage_version(&env),
            storage_migration::CURRENT_SCHEMA_VERSION,
            "Version should be updated to current"
        );

        // Verify all balance data is preserved post-migration
        let post_balance1 = storage::get_balance(&env, token_index, &holder1);
        let post_balance2 = storage::get_balance(&env, token_index, &holder2);
        assert_eq!(post_balance1, 1_000_000i128, "Holder1 balance should be preserved");
        assert_eq!(post_balance2, 5_000_000i128, "Holder2 balance should be preserved");

        // Verify metadata is preserved
        assert_eq!(storage::get_base_fee(&env), 2_000_000i128, "Base fee should be preserved");
        assert_eq!(storage::get_metadata_fee(&env), 1_500_000i128, "Metadata fee should be preserved");
    });
}

#[test]
fn test_migrating_empty_storage_completes_successfully() {
    let (env, admin) = setup();

    env.as_contract(&env.current_contract_address(), || {
        // Set to pre-migration version
        storage_migration::set_storage_version(&env, 1);

        // Verify migration is required
        assert!(
            storage_migration::is_migration_required(&env),
            "Migration should be required for version 1"
        );

        // Run migration on empty storage
        let result = storage_migration::migrate(&env, admin);
        assert!(result.is_ok(), "Migration should succeed even with empty storage");

        // Verify version was updated
        assert_eq!(
            storage_migration::get_storage_version(&env),
            storage_migration::CURRENT_SCHEMA_VERSION
        );

        // Verify no migration is required anymore
        assert!(
            !storage_migration::is_migration_required(&env),
            "Migration should not be required after running"
        );
    });
}

#[test]
fn test_running_migration_twice_is_safe_no_op() {
    let (env, admin) = setup();

    env.as_contract(&env.current_contract_address(), || {
        // Set to pre-migration version
        storage_migration::set_storage_version(&env, 1);

        // Populate some data
        let token_index = 0u32;
        let holder = Address::generate(&env);
        storage::set_balance(&env, token_index, &holder, 1_000_000i128);

        // Run migration first time
        let result1 = storage_migration::migrate(&env, admin.clone());
        assert!(result1.is_ok());

        let version_after_first = storage_migration::get_storage_version(&env);
        assert_eq!(
            version_after_first,
            storage_migration::CURRENT_SCHEMA_VERSION
        );

        // Verify data is intact after first migration
        let balance_after_first = storage::get_balance(&env, token_index, &holder);
        assert_eq!(balance_after_first, 1_000_000i128);

        // Attempt to run migration a second time
        let result2 = storage_migration::migrate(&env, admin);

        // Second migration should fail with StorageMigrationAlreadyRun
        assert!(result2.is_err());
        assert_eq!(
            result2.unwrap_err(),
            Error::StorageMigrationAlreadyRun,
            "Second migration should be rejected"
        );

        // Verify version is still correct
        assert_eq!(
            storage_migration::get_storage_version(&env),
            storage_migration::CURRENT_SCHEMA_VERSION
        );

        // Verify data was not modified by second attempt
        let balance_after_second = storage::get_balance(&env, token_index, &holder);
        assert_eq!(
            balance_after_second, 1_000_000i128,
            "Data should not be corrupted by re-running migration"
        );
    });
}

#[test]
fn test_migration_requires_admin_authorization() {
    let (env, _admin) = setup();

    let non_admin = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        storage_migration::set_storage_version(&env, 1);

        // Attempt migration with non-admin account
        let result = storage_migration::migrate(&env, non_admin);

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            Error::Unauthorized,
            "Non-admin should not be able to run migration"
        );

        // Verify version was not changed
        assert_eq!(storage_migration::get_storage_version(&env), 1);
    });
}

#[test]
fn test_migration_field_mapping_correctness() {
    let (env, admin) = setup();

    env.as_contract(&env.current_contract_address(), || {
        storage_migration::set_storage_version(&env, 1);

        // Create comprehensive test data with various field types
        let holder = Address::generate(&env);
        let token_index = 0u32;

        // Test balance preservation (i128)
        storage::set_balance(&env, token_index, &holder, i128::MAX / 2);

        // Test count preservation
        let test_count = 42u32;
        env.storage()
            .persistent()
            .set(&DataKey::BalanceSnapshotCount(token_index, holder.clone()), &test_count);

        // Run migration
        let result = storage_migration::migrate(&env, admin);
        assert!(result.is_ok());

        // Verify all fields preserved correctly
        let preserved_balance = storage::get_balance(&env, token_index, &holder);
        assert_eq!(preserved_balance, i128::MAX / 2, "Large balance should be preserved exactly");

        let preserved_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::BalanceSnapshotCount(token_index, holder))
            .unwrap_or(0);
        assert_eq!(preserved_count, test_count, "Snapshot count should be preserved exactly");
    });
}

#[test]
fn test_migration_initializes_version_on_fresh_contract() {
    let env = Env::default();
    env.mock_all_auths();

    env.register_contract(None, TokenFactory);

    env.as_contract(&env.current_contract_address(), || {
        // Fresh contract - no version set yet
        storage_migration::initialize_storage_version(&env);

        // Should be set to current version
        let version = storage_migration::get_storage_version(&env);
        assert_eq!(
            version,
            storage_migration::CURRENT_SCHEMA_VERSION,
            "Fresh contract should initialize to current schema version"
        );

        // Verify no migration is required
        assert!(
            !storage_migration::is_migration_required(&env),
            "Fresh contract should not require migration"
        );
    });
}

#[test]
fn test_contract_version_info_preserved_through_migration() {
    let (env, admin) = setup();

    env.as_contract(&env.current_contract_address(), || {
        storage_migration::set_storage_version(&env, 1);

        // Set contract version info pre-migration
        let version_info = ContractVersion {
            major: 1,
            minor: 5,
            patch: 3,
            migrated_at: 12_345,
        };
        storage_migration::set_contract_version(&env, version_info.clone());

        // Run migration
        let result = storage_migration::migrate(&env, admin);
        assert!(result.is_ok());

        // Verify contract version info is preserved
        let post_migration_version = storage_migration::get_contract_version(&env);
        assert_eq!(post_migration_version.major, 1);
        assert_eq!(post_migration_version.minor, 5);
        assert_eq!(post_migration_version.patch, 3);
        assert_eq!(post_migration_version.migrated_at, 12_345);
    });
}

#[test]
fn test_multiple_account_migrations_preserve_isolation() {
    let (env, admin) = setup();

    env.as_contract(&env.current_contract_address(), || {
        storage_migration::set_storage_version(&env, 1);

        let token_index = 0u32;
        let holder1 = Address::generate(&env);
        let holder2 = Address::generate(&env);
        let holder3 = Address::generate(&env);

        // Create distinct balances for each holder
        storage::set_balance(&env, token_index, &holder1, 100_000i128);
        storage::set_balance(&env, token_index, &holder2, 200_000i128);
        storage::set_balance(&env, token_index, &holder3, 300_000i128);

        // Run migration
        let result = storage_migration::migrate(&env, admin);
        assert!(result.is_ok());

        // Verify each balance is preserved independently
        assert_eq!(
            storage::get_balance(&env, token_index, &holder1),
            100_000i128,
            "Holder 1 balance must be preserved exactly"
        );
        assert_eq!(
            storage::get_balance(&env, token_index, &holder2),
            200_000i128,
            "Holder 2 balance must be preserved exactly"
        );
        assert_eq!(
            storage::get_balance(&env, token_index, &holder3),
            300_000i128,
            "Holder 3 balance must be preserved exactly"
        );
    });
}
