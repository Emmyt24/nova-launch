# Upgrade migration hook and version tracking (#2232)

`upgrade_migration.rs` stores a contract version (default 1) under a private
`MigrationKey::Version` instance key. After deploying new wasm the admin calls
`run_migration(admin, target_version)`: targets must be `stored + 1` and at most
`LATEST_CONTRACT_VERSION` (2). Repeats fail with `MigrationAlreadyApplied` (520);
skipped or unknown targets fail with `InvalidMigrationTarget` (521). Each success
emits a `migrated` event `(from, to)`. Per-version data changes go in `apply_step`.
`contract_version_number()` returns the stored version. This is separate from the
storage-schema marker in `storage_migration.rs`.
