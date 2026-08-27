#![cfg(test)]
extern crate std;
use std::println;

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark Setup
// ─────────────────────────────────────────────────────────────────────────────

struct ProposalQueueBenchSetup {
    env: Env,
    admin: Address,
    treasury: Address,
    contract_id: Address,
}

impl ProposalQueueBenchSetup {
    fn new() -> Self {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        ProposalQueueBenchSetup {
            env,
            admin,
            treasury,
            contract_id,
        }
    }
}

fn measure<F: FnOnce()>(env: &Env, f: F) -> (u64, u64) {
    env.budget().reset_unlimited();
    env.budget().reset_default();
    f();
    (
        env.budget().cpu_instruction_cost(),
        env.budget().memory_bytes_cost(),
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposal Queue Benchmarks
// ─────────────────────────────────────────────────────────────────────────────

/// Benchmark: enqueue_proposal with small queue (1-5 entries)
#[test]
#[ignore]
fn bench_enqueue_small_queue() {
    let setup = ProposalQueueBenchSetup::new();
    setup.env.mock_all_auths();

    let proposer = Address::generate(&setup.env);

    // Create a proposal first
    let client = TokenFactoryClient::new(&setup.env, &setup.contract_id);
    let proposal_id = setup.env.as_contract(&setup.contract_id, || {
        let id: u64 = client.create_proposal(
            &proposer,
            &types::ActionType::FeeChange,
            &soroban_sdk::Bytes::default(&setup.env),
            &String::from_str(&setup.env, "Test proposal"),
            &100u64,
            &200u64,
        ).unwrap();
        id
    });

    // Queue the proposal
    setup.env.as_contract(&setup.contract_id, || {
        client.queue_proposal(&setup.admin, &proposal_id).ok();
    });

    let (cpu, mem) = measure(&setup.env, || {
        setup.env.as_contract(&setup.contract_id, || {
            let _ = proposal_queue::enqueue_proposal(
                &setup.env,
                proposal_id,
                types::ProposalPriority::Normal,
            );
        });
    });

    println!("[bench_enqueue_small_queue] cpu_instructions={cpu}, memory_bytes={mem}");
    assert!(cpu > 0, "CPU cost should be non-zero");
}

/// Benchmark: dequeue_proposal with small queue
#[test]
#[ignore]
fn bench_dequeue_small_queue() {
    let setup = ProposalQueueBenchSetup::new();
    setup.env.mock_all_auths();

    let proposer = Address::generate(&setup.env);

    let client = TokenFactoryClient::new(&setup.env, &setup.contract_id);

    // Create and queue a proposal
    let proposal_id = setup.env.as_contract(&setup.contract_id, || {
        let id: u64 = client.create_proposal(
            &proposer,
            &types::ActionType::FeeChange,
            &soroban_sdk::Bytes::default(&setup.env),
            &String::from_str(&setup.env, "Test proposal"),
            &100u64,
            &200u64,
        ).unwrap();

        client.queue_proposal(&setup.admin, &id).ok();
        proposal_queue::enqueue_proposal(&setup.env, id, types::ProposalPriority::Normal).ok();

        id
    });

    // Advance time past ETA
    setup.env.ledger().with_mut(|l| l.timestamp = 300);

    let (cpu, mem) = measure(&setup.env, || {
        setup.env.as_contract(&setup.contract_id, || {
            let _ = proposal_queue::dequeue_next(&setup.env);
        });
    });

    println!("[bench_dequeue_small_queue] cpu_instructions={cpu}, memory_bytes={mem}");
    assert!(cpu > 0, "CPU cost should be non-zero");
}

/// Benchmark: peek_next with small queue
#[test]
#[ignore]
fn bench_peek_small_queue() {
    let setup = ProposalQueueBenchSetup::new();
    setup.env.mock_all_auths();

    let proposer = Address::generate(&setup.env);
    let client = TokenFactoryClient::new(&setup.env, &setup.contract_id);

    // Create and queue a proposal
    setup.env.as_contract(&setup.contract_id, || {
        let id: u64 = client.create_proposal(
            &proposer,
            &types::ActionType::FeeChange,
            &soroban_sdk::Bytes::default(&setup.env),
            &String::from_str(&setup.env, "Test proposal"),
            &100u64,
            &200u64,
        ).unwrap();

        client.queue_proposal(&setup.admin, &id).ok();
        proposal_queue::enqueue_proposal(&setup.env, id, types::ProposalPriority::Normal).ok();
    });

    let (cpu, mem) = measure(&setup.env, || {
        setup.env.as_contract(&setup.contract_id, || {
            let _ = proposal_queue::peek_next(&setup.env);
        });
    });

    println!("[bench_peek_small_queue] cpu_instructions={cpu}, memory_bytes={mem}");
    assert!(cpu > 0, "CPU cost should be non-zero");
}

/// Baseline report for proposal queue operations
#[test]
#[ignore]
fn bench_proposal_queue_baseline() {
    let setup = ProposalQueueBenchSetup::new();
    setup.env.mock_all_auths();

    let proposer = Address::generate(&setup.env);
    let client = TokenFactoryClient::new(&setup.env, &setup.contract_id);

    // Measure enqueue
    let proposal_id_1 = setup.env.as_contract(&setup.contract_id, || {
        let id: u64 = client.create_proposal(
            &proposer,
            &types::ActionType::FeeChange,
            &soroban_sdk::Bytes::default(&setup.env),
            &String::from_str(&setup.env, "Test proposal 1"),
            &100u64,
            &200u64,
        ).unwrap();

        client.queue_proposal(&setup.admin, &id).ok();
        id
    });

    let (cpu_enqueue, mem_enqueue) = measure(&setup.env, || {
        setup.env.as_contract(&setup.contract_id, || {
            let _ = proposal_queue::enqueue_proposal(
                &setup.env,
                proposal_id_1,
                types::ProposalPriority::Normal,
            );
        });
    });

    // Measure peek
    let (cpu_peek, mem_peek) = measure(&setup.env, || {
        setup.env.as_contract(&setup.contract_id, || {
            let _ = proposal_queue::peek_next(&setup.env);
        });
    });

    println!();
    println!("Proposal Queue Gas Benchmark Baseline");
    println!();
    println!("{:<25} {:>18} {:>14}", "Operation", "CPU Instructions", "Memory Bytes");
    println!("{}", "-".repeat(60));
    println!("{:<25} {:>18} {:>14}", "enqueue (1 entry)", cpu_enqueue, mem_enqueue);
    println!("{:<25} {:>18} {:>14}", "peek (1 entry)", cpu_peek, mem_peek);
    println!("{}", "-".repeat(60));
    println!();
}
