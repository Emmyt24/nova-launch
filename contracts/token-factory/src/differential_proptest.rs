#[cfg(test)]
mod differential_proptest {
    use crate::differential_engine::{DifferentialEngine, SupplyTracker};
    use crate::vesting;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn prop_vesting_never_exceeds_total(
            total_amount in 1i128..=1_000_000_000i128,
            start_time in 1000u64..=100_000u64,
            cliff_duration in 0u64..=1_000u64,
            vesting_duration in 100u64..=10_000u64,
            current_time in 1000u64..=200_000u64,
        ) {
            prop_assume!(cliff_duration <= vesting_duration);
            let mut engine = DifferentialEngine::new();
            engine.add_schedule(0, total_amount, start_time, cliff_duration, vesting_duration);
            let vested = engine.get_vested(0, current_time).unwrap();
            prop_assert!(vested >= 0);
            prop_assert!(vested <= total_amount);
            let contract_vested = vesting::calculate_vested_amount(total_amount, start_time, cliff_duration, vesting_duration, current_time).unwrap();
            prop_assert_eq!(vested, contract_vested, "Reference and contract outputs differ");
        }

        #[test]
        fn prop_vesting_monotonic(
            total_amount in 1i128..=1_000_000_000i128,
            start_time in 1000u64..=100_000u64,
            cliff_duration in 0u64..=1_000u64,
            vesting_duration in 100u64..=10_000u64,
            time_delta in 1u64..=1_000u64,
        ) {
            prop_assume!(cliff_duration <= vesting_duration);
            let mut engine = DifferentialEngine::new();
            engine.add_schedule(0, total_amount, start_time, cliff_duration, vesting_duration);
            let time1 = start_time + vesting_duration / 2;
            let time2 = time1.saturating_add(time_delta);
            let vested1 = engine.get_vested(0, time1).unwrap();
            let vested2 = engine.get_vested(0, time2).unwrap();
            prop_assert!(vested2 >= vested1);
        }

        #[test]
        fn prop_supply_conservation(
            initial_supply in 1_000_000i128..=10_000_000i128,
            mint_amount in 1i128..=1_000_000i128,
            burn_amount in 1i128..=500_000i128,
        ) {
            let mut tracker = SupplyTracker::new(initial_supply);
            tracker.mint("alice", mint_amount).unwrap();
            tracker.burn("alice", burn_amount).unwrap();
            prop_assert!(tracker.verify().is_ok());
            let expected = initial_supply + mint_amount - burn_amount;
            prop_assert_eq!(tracker.total_supply, expected);
        }

        #[test]
        fn prop_rounding_consistency(
            total_amount in 1_000_000i128..=1_000_000_000i128,
            start_time in 1000u64..=10_000u64,
            vesting_duration in 1000u64..=100_000u64,
            elapsed_ratio in 0.0f64..=1.0f64,
        ) {
            let mut engine = DifferentialEngine::new();
            engine.add_schedule(0, total_amount, start_time, 0, vesting_duration);
            let elapsed = (vesting_duration as f64 * elapsed_ratio) as u64;
            let current_time = start_time + elapsed;
            let ref_vested = engine.get_vested(0, current_time).unwrap();
            let contract_vested = vesting::calculate_vested_amount(total_amount, start_time, 0, vesting_duration, current_time).unwrap();
            prop_assert_eq!(ref_vested, contract_vested);
        }

        #[test]
        fn prop_claim_idempotence(
            total_amount in 1_000_000i128..=100_000_000i128,
            start_time in 1000u64..=10_000u64,
            vesting_duration in 1000u64..=10_000u64,
        ) {
            let mut engine = DifferentialEngine::new();
            engine.add_schedule(0, total_amount, start_time, 0, vesting_duration);
            let claim_time = start_time + vesting_duration / 2;
            let claimed1 = engine.claim(0, claim_time).unwrap();
            let claimable_after = engine.get_claimable(0, claim_time).unwrap();
            prop_assert_eq!(claimable_after, 0);
            prop_assert!(claimed1 > 0);
        }
    }
}
