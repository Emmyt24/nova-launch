#[cfg(test)]
mod comprehensive_differential_tests {
    use crate::differential_engine::{DifferentialEngine, SupplyTracker};
    use crate::vesting;
    use soroban_sdk::{Env, Address, testutils::Address as _};
    use crate::storage;

    #[derive(Debug)]
    struct MismatchReport {
        test_name: String,
        input_vector: String,
        contract_output: String,
        reference_output: String,
        difference: String,
    }

    impl MismatchReport {
        fn new(test_name: &str, input: &str, contract: &str, reference: &str, diff: &str) -> Self {
            Self {
                test_name: test_name.to_string(),
                input_vector: input.to_string(),
                contract_output: contract.to_string(),
                reference_output: reference.to_string(),
                difference: diff.to_string(),
            }
        }

        fn print(&self) {
            eprintln!("\n=== DIFFERENTIAL MISMATCH ===");
            eprintln!("Test: {}", self.test_name);
            eprintln!("Input: {}", self.input_vector);
            eprintln!("Contract: {}", self.contract_output);
            eprintln!("Reference: {}", self.reference_output);
            eprintln!("Difference: {}", self.difference);
            eprintln!("=============================\n");
        }
    }

    fn setup_vesting_schedule(env: &Env, token_idx: u32, schedule_id: u32, total: i128, start: u64, cliff: u64, duration: u64) {
        let beneficiary = Address::generate(env);
        let schedule = vesting::VestingSchedule {
            beneficiary: beneficiary.clone(),
            total_amount: total,
            start_time: start,
            cliff_duration: cliff,
            vesting_duration: duration,
            claimed_amount: 0,
        };
        storage::set_vesting_schedule(env, token_idx, schedule_id, &schedule);
    }

    #[test]
    fn test_differential_vesting_linear_progression() {
        let env = Env::default();
        let mut ref_engine = DifferentialEngine::new();
        
        let total = 1_000_000i128;
        let start = 1000u64;
        let cliff = 100u64;
        let duration = 1000u64;
        
        setup_vesting_schedule(&env, 0, 0, total, start, cliff, duration);
        ref_engine.add_schedule(0, total, start, cliff, duration);
        
        let test_times = vec![1000, 1100, 1500, 2000, 2500];
        
        for time in test_times {
            let contract_vested = vesting::calculate_vested_amount(total, start, cliff, duration, time).unwrap();
            let ref_vested = ref_engine.get_vested(0, time).unwrap();
            
            if contract_vested != ref_vested {
                let report = MismatchReport::new(
                    "linear_progression",
                    &format!("total={}, start={}, cliff={}, duration={}, time={}", total, start, cliff, duration, time),
                    &format!("{}", contract_vested),
                    &format!("{}", ref_vested),
                    &format!("{}", (contract_vested - ref_vested).abs()),
                );
                report.print();
                panic!("Mismatch detected");
            }
        }
    }

    #[test]
    fn test_differential_vesting_boundary_timestamps() {
        let env = Env::default();
        let mut ref_engine = DifferentialEngine::new();
        
        let test_cases = vec![
            (1_000_000i128, 0u64, 0u64, 1000u64),
            (1_000_000i128, u64::MAX - 10000, 100u64, 1000u64),
            (1_000_000i128, 1000u64, 0u64, 1u64),
            (1_000_000i128, 1000u64, 999u64, 1000u64),
        ];
        
        for (idx, (total, start, cliff, duration)) in test_cases.iter().enumerate() {
            let id = idx as u32;
            setup_vesting_schedule(&env, 0, id, *total, *start, *cliff, *duration);
            ref_engine.add_schedule(id, *total, *start, *cliff, *duration);
            
            let test_time = start.saturating_add(*duration / 2);
            
            let contract_vested = vesting::calculate_vested_amount(*total, *start, *cliff, *duration, test_time).unwrap();
            let ref_vested = ref_engine.get_vested(id, test_time).unwrap();
            
            if contract_vested != ref_vested {
                let report = MismatchReport::new(
                    "boundary_timestamps",
                    &format!("total={}, start={}, cliff={}, duration={}, time={}", total, start, cliff, duration, test_time),
                    &format!("{}", contract_vested),
                    &format!("{}", ref_vested),
                    &format!("{}", (contract_vested - ref_vested).abs()),
                );
                report.print();
                panic!("Mismatch detected");
            }
        }
    }

    #[test]
    fn test_differential_vesting_large_amounts() {
        let env = Env::default();
        let mut ref_engine = DifferentialEngine::new();
        
        let large_amounts = vec![i128::MAX / 2, i128::MAX / 10, 1_000_000_000_000_000i128];
        
        for (idx, total) in large_amounts.iter().enumerate() {
            let id = idx as u32;
            let start = 1000u64;
            let cliff = 0u64;
            let duration = 10000u64;
            
            setup_vesting_schedule(&env, 0, id, *total, start, cliff, duration);
            ref_engine.add_schedule(id, *total, start, cliff, duration);
            
            let test_time = start + duration / 2;
            
            let contract_vested = vesting::calculate_vested_amount(*total, start, cliff, duration, test_time).unwrap();
            let ref_vested = ref_engine.get_vested(id, test_time).unwrap();
            
            let tolerance = total / 1000;
            let diff = (contract_vested - ref_vested).abs();
            
            if diff > tolerance {
                let report = MismatchReport::new(
                    "large_amounts",
                    &format!("total={}, start={}, cliff={}, duration={}, time={}", total, start, cliff, duration, test_time),
                    &format!("{}", contract_vested),
                    &format!("{}", ref_vested),
                    &format!("{} (tolerance: {})", diff, tolerance),
                );
                report.print();
                panic!("Mismatch exceeds tolerance");
            }
        }
    }

    #[test]
    fn test_differential_supply_conservation() {
        let mut ref_tracker = SupplyTracker::new(1_000_000);
        
        let operations = vec![
            ("mint", "alice", 500_000i128),
            ("mint", "bob", 300_000i128),
            ("burn", "alice", 200_000i128),
            ("mint", "charlie", 100_000i128),
            ("burn", "bob", 150_000i128),
        ];
        
        for (op, user, amount) in operations {
            match op {
                "mint" => ref_tracker.mint(user, amount).unwrap(),
                "burn" => ref_tracker.burn(user, amount).unwrap(),
                _ => panic!("Unknown operation"),
            }
            
            if let Err(e) = ref_tracker.verify() {
                let report = MismatchReport::new(
                    "supply_conservation",
                    &format!("After {} {} {}", op, user, amount),
                    &format!("total_supply={}", ref_tracker.total_supply),
                    &format!("minted={}, burned={}", ref_tracker.total_minted, ref_tracker.total_burned),
                    &e,
                );
                report.print();
                panic!("Supply conservation violated");
            }
        }
    }
}

    #[test]
    fn test_differential_vesting_large_amounts() {
        let env = Env::default();
        let mut ref_engine = DifferentialEngine::new();
        
        let large_amounts = vec![i128::MAX / 2, i128::MAX / 10, 1_000_000_000_000_000i128];
        
        for (idx, total) in large_amounts.iter().enumerate() {
            let id = idx as u32;
            let start = 1000u64;
            let cliff = 0u64;
            let duration = 10000u64;
            
            setup_vesting_schedule(&env, 0, id, *total, start, cliff, duration);
            ref_engine.add_schedule(id, *total, start, cliff, duration);
            
            let test_time = start + duration / 2;
            
            let contract_vested = vesting::calculate_vested_amount(*total, start, cliff, duration, test_time).unwrap();
            let ref_vested = ref_engine.get_vested(id, test_time).unwrap();
            
            let tolerance = total / 1000;
            let diff = (contract_vested - ref_vested).abs();
            
            if diff > tolerance {
                let report = MismatchReport::new(
                    "large_amounts",
                    &format!("total={}, start={}, cliff={}, duration={}, time={}", total, start, cliff, duration, test_time),
                    &format!("{}", contract_vested),
                    &format!("{}", ref_vested),
                    &format!("{} (tolerance: {})", diff, tolerance),
                );
                report.print();
                panic!("Mismatch exceeds tolerance");
            }
        }
    }

    #[test]
    fn test_differential_supply_conservation() {
        let mut ref_tracker = SupplyTracker::new(1_000_000);
        
        let operations = vec![
            ("mint", "alice", 500_000i128),
            ("mint", "bob", 300_000i128),
            ("burn", "alice", 200_000i128),
            ("mint", "charlie", 100_000i128),
            ("burn", "bob", 150_000i128),
        ];
        
        for (op, user, amount) in operations {
            match op {
                "mint" => ref_tracker.mint(user, amount).unwrap(),
                "burn" => ref_tracker.burn(user, amount).unwrap(),
                _ => panic!("Unknown operation"),
            }
            
            if let Err(e) = ref_tracker.verify() {
                let report = MismatchReport::new(
                    "supply_conservation",
                    &format!("After {} {} {}", op, user, amount),
                    &format!("total_supply={}", ref_tracker.total_supply),
                    &format!("minted={}, burned={}", ref_tracker.total_minted, ref_tracker.total_burned),
                    &e,
                );
                report.print();
                panic!("Supply conservation violated");
            }
        }
    }
}

    #[test]
    fn test_differential_vesting_large_amounts() {
        let env = Env::default();
        let mut ref_engine = DifferentialEngine::new();
        let large_amounts = vec![i128::MAX / 2, i128::MAX / 10, 1_000_000_000_000_000i128];
        for (idx, total) in large_amounts.iter().enumerate() {
            let id = idx as u32;
            let start = 1000u64;
            let duration = 10000u64;
            setup_vesting_schedule(&env, 0, id, *total, start, 0, duration);
            ref_engine.add_schedule(id, *total, start, 0, duration);
            let test_time = start + duration / 2;
            let contract_vested = vesting::calculate_vested_amount(*total, start, 0, duration, test_time).unwrap();
            let ref_vested = ref_engine.get_vested(id, test_time).unwrap();
            let tolerance = total / 1000;
            let diff = (contract_vested - ref_vested).abs();
            if diff > tolerance {
                let report = MismatchReport::new("large_amounts", &format!("total={}, time={}", total, test_time), &format!("{}", contract_vested), &format!("{}", ref_vested), &format!("{}", diff));
                report.print();
                panic!("Mismatch exceeds tolerance");
            }
        }
    }

    #[test]
    fn test_differential_supply_conservation() {
        let mut ref_tracker = SupplyTracker::new(1_000_000);
        let operations = vec![("mint", "alice", 500_000i128), ("mint", "bob", 300_000i128), ("burn", "alice", 200_000i128), ("mint", "charlie", 100_000i128), ("burn", "bob", 150_000i128)];
        for (op, user, amount) in operations {
            match op {
                "mint" => ref_tracker.mint(user, amount).unwrap(),
                "burn" => ref_tracker.burn(user, amount).unwrap(),
                _ => panic!("Unknown operation"),
            }
            if let Err(e) = ref_tracker.verify() {
                let report = MismatchReport::new("supply_conservation", &format!("After {} {} {}", op, user, amount), &format!("total_supply={}", ref_tracker.total_supply), &format!("minted={}, burned={}", ref_tracker.total_minted, ref_tracker.total_burned), &e);
                report.print();
                panic!("Supply conservation violated");
            }
        }
    }
}

    #[test]
    fn test_differential_supply_conservation() {
        let mut ref_tracker = SupplyTracker::new(1_000_000);
        ref_tracker.mint("alice", 500_000).unwrap();
        ref_tracker.mint("bob", 300_000).unwrap();
        ref_tracker.burn("alice", 200_000).unwrap();
        assert!(ref_tracker.verify().is_ok());
    }
}

    #[test]
    fn test_differential_supply_conservation() {
        let mut ref_tracker = SupplyTracker::new(1_000_000);
        ref_tracker.mint("alice", 500_000).unwrap();
        ref_tracker.mint("bob", 300_000).unwrap();
        ref_tracker.burn("alice", 200_000).unwrap();
        assert!(ref_tracker.verify().is_ok());
    }
}
