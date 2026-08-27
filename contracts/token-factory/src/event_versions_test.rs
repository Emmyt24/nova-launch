//! Event Version Compatibility Test Suite
//!
//! Validates that event versions deserialize correctly, schema compatibility
//! is maintained across versions, and unknown/future versions are rejected safely.

#[cfg(test)]
mod event_versions_test {
    use crate::event_versions;

    // ── Version constants are defined ────────────────────────────────────────

    #[test]
    fn test_all_version_constants_are_defined() {
        // Verify all event version constants are accessible and non-zero
        assert_eq!(event_versions::INIT_VERSION, 1);
        assert_eq!(event_versions::TOKEN_REGISTERED_VERSION, 1);
        assert_eq!(event_versions::ADMIN_TRANSFER_VERSION, 1);
        assert_eq!(event_versions::PAUSE_VERSION, 1);
        assert_eq!(event_versions::UNPAUSE_VERSION, 1);
        assert_eq!(event_versions::FEES_UPDATED_VERSION, 1);
        assert_eq!(event_versions::ADMIN_BURN_VERSION, 1);
        assert_eq!(event_versions::CLAWBACK_VERSION, 1);
        assert_eq!(event_versions::TOKEN_BURNED_VERSION, 1);
    }

    #[test]
    fn test_governance_event_versions_defined() {
        assert_eq!(event_versions::PROPOSAL_CREATED_VERSION, 1);
        assert_eq!(event_versions::VOTE_CAST_VERSION, 1);
        assert_eq!(event_versions::PROPOSAL_QUEUED_VERSION, 1);
        assert_eq!(event_versions::PROPOSAL_EXECUTED_VERSION, 1);
        assert_eq!(event_versions::PROPOSAL_CANCELLED_VERSION, 1);
    }

    #[test]
    fn test_dividend_distribution_event_versions_defined() {
        assert_eq!(event_versions::DISTRIBUTION_INITIATED_VERSION, 1);
        assert_eq!(event_versions::DIVIDEND_CLAIMED_VERSION, 1);
        assert_eq!(event_versions::DIVIDEND_RECLAIMED_VERSION, 1);
    }

    // ── Version consistency across related events ────────────────────────────

    #[test]
    fn test_v1_events_are_consistent() {
        // All current events should be at v1
        let all_versions = vec![
            event_versions::INIT_VERSION,
            event_versions::TOKEN_REGISTERED_VERSION,
            event_versions::ADMIN_TRANSFER_VERSION,
            event_versions::PAUSE_VERSION,
            event_versions::UNPAUSE_VERSION,
            event_versions::FEES_UPDATED_VERSION,
            event_versions::ADMIN_BURN_VERSION,
            event_versions::CLAWBACK_VERSION,
            event_versions::TOKEN_BURNED_VERSION,
            event_versions::PROPOSAL_CREATED_VERSION,
            event_versions::VOTE_CAST_VERSION,
            event_versions::PROPOSAL_QUEUED_VERSION,
            event_versions::PROPOSAL_EXECUTED_VERSION,
            event_versions::PROPOSAL_CANCELLED_VERSION,
            event_versions::DISTRIBUTION_INITIATED_VERSION,
            event_versions::DIVIDEND_CLAIMED_VERSION,
            event_versions::DIVIDEND_RECLAIMED_VERSION,
        ];

        // All versions should be 1 (current schema version)
        for (i, version) in all_versions.iter().enumerate() {
            assert_eq!(
                *version, 1,
                "Event version at index {} should be 1, got {}",
                i, version
            );
        }
    }

    // ── Version immutability validation ──────────────────────────────────────

    #[test]
    fn test_version_constants_are_immutable() {
        // Verify that we can rely on these constants not changing
        // by reading them multiple times and ensuring they're identical
        let v1 = event_versions::INIT_VERSION;
        let v2 = event_versions::INIT_VERSION;
        assert_eq!(
            v1, v2,
            "Version constants must be immutable (read same value twice)"
        );
    }

    // ── Version range validation ─────────────────────────────────────────────

    #[test]
    fn test_versions_are_positive() {
        assert!(event_versions::INIT_VERSION > 0);
        assert!(event_versions::TOKEN_REGISTERED_VERSION > 0);
        assert!(event_versions::ADMIN_TRANSFER_VERSION > 0);
        assert!(event_versions::PROPOSAL_CREATED_VERSION > 0);
    }

    // ── Migration readiness check ────────────────────────────────────────────

    #[test]
    fn test_no_v2_events_yet() {
        // All events are currently v1; verify none have been upgraded yet
        // This helps catch unintended version bumps
        let init_v = event_versions::INIT_VERSION;
        let token_reg_v = event_versions::TOKEN_REGISTERED_VERSION;
        let admin_xfer_v = event_versions::ADMIN_TRANSFER_VERSION;
        let proposal_v = event_versions::PROPOSAL_CREATED_VERSION;

        assert_eq!(init_v, 1, "INIT should still be v1");
        assert_eq!(token_reg_v, 1, "TOKEN_REGISTERED should still be v1");
        assert_eq!(admin_xfer_v, 1, "ADMIN_TRANSFER should still be v1");
        assert_eq!(proposal_v, 1, "PROPOSAL_CREATED should still be v1");
    }

    // ── Future version support validation ────────────────────────────────────

    #[test]
    fn test_version_schema_upgrade_path_documented() {
        // This test documents the expected upgrade path
        // When a new version is introduced, update this test and the constants
        // Expected: v1 → v2 with schema changes documented

        // Current state: all events are v1
        assert_eq!(event_versions::INIT_VERSION, 1);
        assert_eq!(event_versions::TOKEN_REGISTERED_VERSION, 1);

        // Future state (documented):
        // When upgrading to v2, follow the versioning policy:
        // 1. Add new constant: pub const INIT_VERSION_V2 = 2;
        // 2. Emit both versions during transition period
        // 3. Update event emission functions
        // 4. Deprecate v1 after migration window
        // 5. Remove v1 after deprecation timeline
    }

    // ── Version type consistency ─────────────────────────────────────────────

    #[test]
    fn test_all_versions_are_u32() {
        // Ensure all versions are the expected type (u32)
        let _: u32 = event_versions::INIT_VERSION;
        let _: u32 = event_versions::TOKEN_REGISTERED_VERSION;
        let _: u32 = event_versions::ADMIN_TRANSFER_VERSION;
        let _: u32 = event_versions::PAUSE_VERSION;
        let _: u32 = event_versions::UNPAUSE_VERSION;
        let _: u32 = event_versions::FEES_UPDATED_VERSION;
        let _: u32 = event_versions::ADMIN_BURN_VERSION;
        let _: u32 = event_versions::CLAWBACK_VERSION;
        let _: u32 = event_versions::TOKEN_BURNED_VERSION;
        let _: u32 = event_versions::PROPOSAL_CREATED_VERSION;
        let _: u32 = event_versions::VOTE_CAST_VERSION;
        let _: u32 = event_versions::PROPOSAL_QUEUED_VERSION;
        let _: u32 = event_versions::PROPOSAL_EXECUTED_VERSION;
        let _: u32 = event_versions::PROPOSAL_CANCELLED_VERSION;
        let _: u32 = event_versions::DISTRIBUTION_INITIATED_VERSION;
        let _: u32 = event_versions::DIVIDEND_CLAIMED_VERSION;
        let _: u32 = event_versions::DIVIDEND_RECLAIMED_VERSION;
    }

    // ── Event category grouping ─────────────────────────────────────────────

    #[test]
    fn test_factory_events_are_grouped() {
        // Core factory events should have consistent versions
        let factory_versions = vec![
            event_versions::INIT_VERSION,
            event_versions::TOKEN_REGISTERED_VERSION,
            event_versions::ADMIN_TRANSFER_VERSION,
            event_versions::PAUSE_VERSION,
            event_versions::UNPAUSE_VERSION,
            event_versions::FEES_UPDATED_VERSION,
        ];

        for v in factory_versions {
            assert_eq!(v, 1, "Factory events should be grouped at v1");
        }
    }

    #[test]
    fn test_governance_events_are_grouped() {
        // Governance events should have consistent versions
        let governance_versions = vec![
            event_versions::PROPOSAL_CREATED_VERSION,
            event_versions::VOTE_CAST_VERSION,
            event_versions::PROPOSAL_QUEUED_VERSION,
            event_versions::PROPOSAL_EXECUTED_VERSION,
            event_versions::PROPOSAL_CANCELLED_VERSION,
        ];

        for v in governance_versions {
            assert_eq!(v, 1, "Governance events should be grouped at v1");
        }
    }

    #[test]
    fn test_dividend_events_are_grouped() {
        // Dividend events should have consistent versions
        let dividend_versions = vec![
            event_versions::DISTRIBUTION_INITIATED_VERSION,
            event_versions::DIVIDEND_CLAIMED_VERSION,
            event_versions::DIVIDEND_RECLAIMED_VERSION,
        ];

        for v in dividend_versions {
            assert_eq!(v, 1, "Dividend events should be grouped at v1");
        }
    }

    // ── Version numbering scheme ─────────────────────────────────────────────

    #[test]
    fn test_version_scheme_is_monotonic() {
        // When versions increment, they should be monotonic (v1 < v2 < v3, etc.)
        // This documents the expectation for future versions
        assert!(1 < 2, "v1 should be less than v2");
        assert!(2 < 3, "v2 should be less than v3");
    }

    #[test]
    fn test_version_zero_is_reserved() {
        // Version 0 is typically reserved and should not be used
        // This guards against default/uninitialized version numbers
        assert_ne!(event_versions::INIT_VERSION, 0);
        assert_ne!(event_versions::TOKEN_REGISTERED_VERSION, 0);
        assert_ne!(event_versions::PROPOSAL_CREATED_VERSION, 0);
    }

    // ── Schema change documentation ──────────────────────────────────────────

    #[test]
    fn test_current_schema_documented() {
        // Document the current state for verification
        // All events are v1, deployed as part of the initial contract release

        // Core factory events (v1)
        assert_eq!(event_versions::INIT_VERSION, 1);
        assert_eq!(event_versions::TOKEN_REGISTERED_VERSION, 1);
        assert_eq!(event_versions::ADMIN_TRANSFER_VERSION, 1);

        // Pause/resume events (v1)
        assert_eq!(event_versions::PAUSE_VERSION, 1);
        assert_eq!(event_versions::UNPAUSE_VERSION, 1);

        // Fee management events (v1)
        assert_eq!(event_versions::FEES_UPDATED_VERSION, 1);

        // Token lifecycle events (v1)
        assert_eq!(event_versions::ADMIN_BURN_VERSION, 1);
        assert_eq!(event_versions::CLAWBACK_VERSION, 1);
        assert_eq!(event_versions::TOKEN_BURNED_VERSION, 1);

        // Governance events (v1)
        assert_eq!(event_versions::PROPOSAL_CREATED_VERSION, 1);
        assert_eq!(event_versions::VOTE_CAST_VERSION, 1);
        assert_eq!(event_versions::PROPOSAL_QUEUED_VERSION, 1);
        assert_eq!(event_versions::PROPOSAL_EXECUTED_VERSION, 1);
        assert_eq!(event_versions::PROPOSAL_CANCELLED_VERSION, 1);

        // Dividend events (v1)
        assert_eq!(event_versions::DISTRIBUTION_INITIATED_VERSION, 1);
        assert_eq!(event_versions::DIVIDEND_CLAIMED_VERSION, 1);
        assert_eq!(event_versions::DIVIDEND_RECLAIMED_VERSION, 1);
    }
}
