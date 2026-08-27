#![cfg(test)]
extern crate std;
use std::println;
use std::vec;
use std::vec::Vec;

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

// ---------------------------------------------------------------------------
// Benchmark Configuration
// ---------------------------------------------------------------------------

const ITERATIONS: usize = 100;
const REGRESSION_THRESHOLD: f64 = 0.10; // 10% increase triggers warning

// Baseline values (update these after running initial benchmarks)
const BASELINE_INITIALIZE_CPU: u64 = 0; // To be measured
const BASELINE_CREATE_TOKEN_CPU: u64 = 0; // To be measured
const BASELINE_UPDATE_FEES_CPU: u64 = 0; // To be measured
const BASELINE_SET_METADATA_CPU: u64 = 0; // To be measured

// ---------------------------------------------------------------------------
// Statistical Helpers
// ---------------------------------------------------------------------------

struct BenchmarkStats {
    min: u64,
    max: u64,
    avg: f64,
    median: u64,
    p95: u64,
    p99: u64,
    std_dev: f64,
}

impl BenchmarkStats {
    fn from_samples(mut samples: Vec<u64>) -> Self {
        samples.sort_unstable();
        let len = samples.len();
        
        let min = samples[0];
        let max = samples[len - 1];
        let sum: u64 = samples.iter().sum();
        let avg = sum as f64 / len as f64;
        
        let median = if len % 2 == 0 {
            (samples[len / 2 - 1] + samples[len / 2]) / 2
        } else {
            samples[len / 2]
        };
        
        let p95_idx = (len as f64 * 0.95) as usize;
        let p99_idx = (len as f64 * 0.99) as usize;
        let p95 = samples[p95_idx.min(len - 1)];
        let p99 = samples[p99_idx.min(len - 1)];
        
        // Calculate standard deviation
        let variance: f64 = samples
            .iter()
            .map(|&x| {
                let diff = x as f64 - avg;
                diff * diff
            })
            .sum::<f64>()
            / len as f64;
        let std_dev = variance.sqrt();
        
        Self {
            min,
            max,
            avg,
            median,
            p95,
            p99,
            std_dev,
        }
    }
    
    fn check_regression(&self, baseline: u64, operation: &str) -> bool {
        if baseline == 0 {
            println!("  [INFO] No baseline set for {}", operation);
            return false;
        }
        
        let increase = (self.avg - baseline as f64) / baseline as f64;
        if increase > REGRESSION_THRESHOLD {
            println!(
                "  [REGRESSION] {} increased by {:.1}% (threshold: {:.1}%)",
                operation,
                increase * 100.0,
                REGRESSION_THRESHOLD * 100.0
            );
            return true;
        }
        false
    }
    
    fn print(&self, operation: &str) {
        println!("\n{}", "=".repeat(70));
        println!("Benchmark: {}", operation);
        println!("{}", "=".repeat(70));
        println!("  Iterations:     {}", ITERATIONS);
        println!("  Min:            {} CPU instructions", self.min);
        println!("  Max:            {} CPU instructions", self.max);
        println!("  Average:        {:.2} CPU instructions", self.avg);
        println!("  Median:         {} CPU instructions", self.median);
        println!("  95th percentile: {} CPU instructions", self.p95);
        println!("  99th percentile: {} CPU instructions", self.p99);
        println!("  Std Deviation:  {:.2}", self.std_dev);
    }
}

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

struct BenchSetup {
    env: Env,
    admin: Address,
    treasury: Address,
    creator: Address,
}

impl BenchSetup {
    fn new() -> Self {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);
        BenchSetup {
            env,
            admin,
            treasury,
            creator,
        }
    }

    fn initialized() -> (Self, Address) {
        let setup = BenchSetup::new();
        let contract_id = setup.env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&setup.env, &contract_id);
        client.initialize(&setup.admin, &setup.treasury, &70_000_000, &30_000_000);
        (setup, contract_id)
    }
}

fn measure_cpu<F: FnOnce()>(env: &Env, f: F) -> u64 {
    env.budget().reset_unlimited();
    env.budget().reset_default();
    f();
    env.budget().cpu_instruction_cost()
}

// ---------------------------------------------------------------------------
// Benchmark Tests
// ---------------------------------------------------------------------------

#[test]
fn bench_initialize_comprehensive() {
    let mut samples = Vec::with_capacity(ITERATIONS);
    
    for _ in 0..ITERATIONS {
        let setup = BenchSetup::new();
        let contract_id = setup.env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&setup.env, &contract_id);
        
        let cpu = measure_cpu(&setup.env, || {
            client.initialize(&setup.admin, &setup.treasury, &70_000_000, &30_000_000);
        });
        
        samples.push(cpu);
    }
    
    let stats = BenchmarkStats::from_samples(samples);
    stats.print("initialize()");
    stats.check_regression(BASELINE_INITIALIZE_CPU, "initialize");
    
    assert!(stats.avg > 0.0, "Average CPU cost should be non-zero");
}

#[test]
fn bench_get_state_comprehensive() {
    let (setup, contract_id) = BenchSetup::initialized();
    let client = TokenFactoryClient::new(&setup.env, &contract_id);
    let mut samples = Vec::with_capacity(ITERATIONS);
    
    for _ in 0..ITERATIONS {
        let cpu = measure_cpu(&setup.env, || {
            let _ = client.get_state();
        });
        samples.push(cpu);
    }
    
    let stats = BenchmarkStats::from_samples(samples);
    stats.print("get_state()");
    
    assert!(stats.avg > 0.0, "Average CPU cost should be non-zero");
}

#[test]
fn bench_update_fees_comprehensive() {
    let (setup, contract_id) = BenchSetup::initialized();
    setup.env.mock_all_auths();
    let client = TokenFactoryClient::new(&setup.env, &contract_id);
    let mut samples = Vec::with_capacity(ITERATIONS);
    
    for i in 0..ITERATIONS {
        let base_fee = 70_000_000 + (i as i128 * 1000);
        let metadata_fee = 30_000_000 + (i as i128 * 500);
        
        let cpu = measure_cpu(&setup.env, || {
            client.update_fees(&setup.admin, &Some(base_fee), &Some(metadata_fee));
        });
        samples.push(cpu);
    }
    
    let stats = BenchmarkStats::from_samples(samples);
    stats.print("update_fees() [both]");
    stats.check_regression(BASELINE_UPDATE_FEES_CPU, "update_fees");
    
    assert!(stats.avg > 0.0, "Average CPU cost should be non-zero");
}

#[test]
fn bench_get_base_fee_comprehensive() {
    let (setup, contract_id) = BenchSetup::initialized();
    let client = TokenFactoryClient::new(&setup.env, &contract_id);
    let mut samples = Vec::with_capacity(ITERATIONS);
    
    for _ in 0..ITERATIONS {
        let cpu = measure_cpu(&setup.env, || {
            let _ = client.get_base_fee();
        });
        samples.push(cpu);
    }
    
    let stats = BenchmarkStats::from_samples(samples);
    stats.print("get_base_fee()");
    
    assert!(stats.avg > 0.0, "Average CPU cost should be non-zero");
}

#[test]
fn bench_get_metadata_fee_comprehensive() {
    let (setup, contract_id) = BenchSetup::initialized();
    let client = TokenFactoryClient::new(&setup.env, &contract_id);
    let mut samples = Vec::with_capacity(ITERATIONS);
    
    for _ in 0..ITERATIONS {
        let cpu = measure_cpu(&setup.env, || {
            let _ = client.get_metadata_fee();
        });
        samples.push(cpu);
    }
    
    let stats = BenchmarkStats::from_samples(samples);
    stats.print("get_metadata_fee()");
    
    assert!(stats.avg > 0.0, "Average CPU cost should be non-zero");
}

#[test]
fn bench_transfer_admin_comprehensive() {
    let mut samples = Vec::with_capacity(ITERATIONS);
    
    for _ in 0..ITERATIONS {
        let (setup, contract_id) = BenchSetup::initialized();
        setup.env.mock_all_auths();
        let client = TokenFactoryClient::new(&setup.env, &contract_id);
        let new_admin = Address::generate(&setup.env);
        
        let cpu = measure_cpu(&setup.env, || {
            client.transfer_admin(&setup.admin, &new_admin);
        });
        samples.push(cpu);
    }
    
    let stats = BenchmarkStats::from_samples(samples);
    stats.print("transfer_admin()");
    
    assert!(stats.avg > 0.0, "Average CPU cost should be non-zero");
}

#[test]
fn bench_pause_unpause_comprehensive() {
    let (setup, contract_id) = BenchSetup::initialized();
    setup.env.mock_all_auths();
    let client = TokenFactoryClient::new(&setup.env, &contract_id);
    let mut samples_pause = Vec::with_capacity(ITERATIONS / 2);
    let mut samples_unpause = Vec::with_capacity(ITERATIONS / 2);
    
    for i in 0..ITERATIONS {
        if i % 2 == 0 {
            let cpu = measure_cpu(&setup.env, || {
                client.pause(&setup.admin);
            });
            samples_pause.push(cpu);
        } else {
            let cpu = measure_cpu(&setup.env, || {
                client.unpause(&setup.admin);
            });
            samples_unpause.push(cpu);
        }
    }
    
    let stats_pause = BenchmarkStats::from_samples(samples_pause);
    stats_pause.print("pause()");
    
    let stats_unpause = BenchmarkStats::from_samples(samples_unpause);
    stats_unpause.print("unpause()");
    
    assert!(stats_pause.avg > 0.0, "Average CPU cost should be non-zero");
    assert!(stats_unpause.avg > 0.0, "Average CPU cost should be non-zero");
}

// ---------------------------------------------------------------------------
// Comprehensive Baseline Report
// ---------------------------------------------------------------------------

#[test]
fn bench_comprehensive_report() {
    println!("\n{}", "=".repeat(80));
    println!("Nova Launch Token Factory - Comprehensive Gas Benchmark Report");
    println!("Soroban SDK: 21.0.0");
    println!("Iterations per test: {}", ITERATIONS);
    println!("Regression threshold: {:.0}%", REGRESSION_THRESHOLD * 100.0);
    println!("{}", "=".repeat(80));
    
    // Initialize
    let mut init_samples = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let setup = BenchSetup::new();
        let contract_id = setup.env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&setup.env, &contract_id);
        let cpu = measure_cpu(&setup.env, || {
            client.initialize(&setup.admin, &setup.treasury, &70_000_000, &30_000_000);
        });
        init_samples.push(cpu);
    }
    let init_stats = BenchmarkStats::from_samples(init_samples);
    
    // Get State
    let (setup, contract_id) = BenchSetup::initialized();
    setup.env.mock_all_auths();
    let client = TokenFactoryClient::new(&setup.env, &contract_id);
    
    let mut state_samples = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let cpu = measure_cpu(&setup.env, || {
            let _ = client.get_state();
        });
        state_samples.push(cpu);
    }
    let state_stats = BenchmarkStats::from_samples(state_samples);
    
    // Update Fees
    let mut fees_samples = Vec::with_capacity(ITERATIONS);
    for i in 0..ITERATIONS {
        let cpu = measure_cpu(&setup.env, || {
            client.update_fees(
                &setup.admin,
                &Some(70_000_000 + i as i128),
                &Some(30_000_000 + i as i128),
            );
        });
        fees_samples.push(cpu);
    }
    let fees_stats = BenchmarkStats::from_samples(fees_samples);
    
    // Get Base Fee
    let mut base_fee_samples = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let cpu = measure_cpu(&setup.env, || {
            let _ = client.get_base_fee();
        });
        base_fee_samples.push(cpu);
    }
    let base_fee_stats = BenchmarkStats::from_samples(base_fee_samples);
    
    // Get Metadata Fee
    let mut meta_fee_samples = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let cpu = measure_cpu(&setup.env, || {
            let _ = client.get_metadata_fee();
        });
        meta_fee_samples.push(cpu);
    }
    let meta_fee_stats = BenchmarkStats::from_samples(meta_fee_samples);
    
    // Print Summary Table
    println!("\n{:<30} {:>10} {:>10} {:>10} {:>10} {:>10}", 
        "Operation", "Avg", "Min", "Max", "P95", "P99");
    println!("{}", "-".repeat(80));
    
    let operations = vec![
        ("initialize", &init_stats),
        ("get_state", &state_stats),
        ("update_fees", &fees_stats),
        ("get_base_fee", &base_fee_stats),
        ("get_metadata_fee", &meta_fee_stats),
    ];
    
    for (name, stats) in &operations {
        println!(
            "{:<30} {:>10.0} {:>10} {:>10} {:>10} {:>10}",
            name, stats.avg, stats.min, stats.max, stats.p95, stats.p99
        );
    }
    
    println!("{}", "-".repeat(80));
    println!("\nAll values in CPU instructions");
    println!("\nTo update baselines, copy these values to BASELINE_* constants:");
    println!("  BASELINE_INITIALIZE_CPU: {:.0}", init_stats.avg);
    println!("  BASELINE_UPDATE_FEES_CPU: {:.0}", fees_stats.avg);
    println!("{}", "=".repeat(80));
}

// ---------------------------------------------------------------------------
// Regression Detection Tests
// ---------------------------------------------------------------------------

#[test]
fn test_regression_detection() {
    // This test demonstrates how regression detection works
    let samples = vec![100, 105, 110, 115, 120]; // Simulated samples
    let stats = BenchmarkStats::from_samples(samples);
    
    // Test with baseline of 100
    let baseline = 100;
    let has_regression = stats.check_regression(baseline, "test_operation");
    
    // 110 avg vs 100 baseline = 10% increase, should trigger
    assert!(has_regression, "Should detect 10% regression");
}

#[test]
fn test_no_regression() {
    let samples = vec![100, 102, 104, 106, 108]; // Simulated samples
    let stats = BenchmarkStats::from_samples(samples);
    
    // Test with baseline of 100
    let baseline = 100;
    let has_regression = stats.check_regression(baseline, "test_operation");
    
    // 104 avg vs 100 baseline = 4% increase, should not trigger
    assert!(!has_regression, "Should not detect regression under threshold");
}
