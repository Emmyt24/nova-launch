//! Cross-contract invariant fuzzing: token supply vs. voting power. (#1623)
//!
//! `invariants.rs` / `invariant_tests.rs` in `token-factory` only ever check
//! invariants that hold *within* that single contract. Nothing previously
//! fuzzed the invariant that must hold *across* token-factory and
//! governance together: total voting power derived from token balances must
//! never exceed total token supply, even under concurrent mint/burn/vote
//! sequences.
//!
//! ## Harness design
//! - token-factory is deployed **natively** in-process (this fuzz crate
//!   depends on the `token-factory` crate directly — its `crate-type`
//!   includes `rlib`, so its `TokenFactory` contract struct and generated
//!   `TokenFactoryClient` are usable like any Rust library).
//! - `governance` pins a different soroban-sdk major version (21.x vs
//!   token-factory's 26.x), so it cannot be a normal Cargo dependency of
//!   this crate without pulling two incompatible major versions of
//!   soroban-sdk into one binary. Instead it is deployed from its
//!   **pre-built `.wasm` artifact** via `soroban_sdk::contractimport!`, and
//!   called through the client that macro generates — the same interop
//!   boundary real cross-contract calls between independently-versioned
//!   Soroban contracts use in production. See `CROSS_CONTRACT_INVARIANT_FUZZING.md`
//!   in `contracts/token-factory/docs/` for the full design writeup and the
//!   `governance.wasm` build step this target requires before it will link.
//!
//! ## The invariant
//! After every fuzzed operation: `sum(governance.get_vote_power(u) for u in
//! users) <= token_factory.get_token_info(token_index).total_supply`.
//!
//! Mint/burn on token-factory are relayed into governance's own balance
//! ledger via `set_balance` (mirroring the indexer/relayer process a real
//! deployment would run), exactly as governance's own doc comment on
//! `set_balance` assumes. This isolates the property actually being
//! fuzzed: given balances are kept in sync, can any interleaving of
//! delegate/undelegate/vote/mint/burn ever make governance's own vote-power
//! bookkeeping overshoot real token supply?
#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Env, String};
use token_factory::{TokenFactory, TokenFactoryClient};

mod governance_contract {
    // Built by `cargo build -p governance --release --target wasm32-unknown-unknown`
    // from the `contracts` workspace root; see fuzz-testing.yml and
    // CROSS_CONTRACT_INVARIANT_FUZZING.md for the exact command.
    soroban_sdk::contractimport!(
        file = "../../target/wasm32-unknown-unknown/release/governance.wasm"
    );
}

const NUM_USERS: usize = 4;
const MAX_OPS_PER_RUN: usize = 200;

#[derive(Debug, Clone, Arbitrary)]
enum Action {
    Mint { holder_idx: u8, amount: u32 },
    Burn { holder_idx: u8, amount: u32 },
    Delegate { from_idx: u8, to_idx: u8 },
    Undelegate { from_idx: u8 },
    Vote { voter_idx: u8, in_favor: bool },
}

fn assert_invariant(
    tf: &TokenFactoryClient,
    gov: &governance_contract::Client,
    token_index: u32,
    users: &[Address],
) {
    let total_supply = tf.get_token_info(&token_index).total_supply;

    let mut total_vote_power: i128 = 0;
    for u in users {
        total_vote_power += gov.get_vote_power(u);
    }

    assert!(
        total_vote_power <= total_supply,
        "cross-contract invariant violated: total voting power {} exceeds token supply {}",
        total_vote_power,
        total_supply,
    );
}

fuzz_target!(|actions: Vec<Action>| {
    if actions.is_empty() {
        return;
    }

    let env = Env::default();
    env.mock_all_auths();

    // ── Deploy token-factory natively ──────────────────────────────────
    let tf_id = env.register_contract(None, TokenFactory);
    let tf = TokenFactoryClient::new(&env, &tf_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    tf.initialize(&admin, &treasury, &1_000_000_i128, &500_000_i128);

    let token_index: u32 = 0;
    tf.create_token(
        &admin,
        &String::from_str(&env, "FuzzToken"),
        &String::from_str(&env, "FZT"),
        &7u32,
        &0i128,
        &None,
        &1_000_000_i128,
    );

    // ── Deploy governance from its compiled wasm ───────────────────────
    let gov_id = env.register_contract_wasm(None, governance_contract::WASM);
    let gov = governance_contract::Client::new(&env, &gov_id);
    gov.initialize(&admin, &1_000_000_000_i128);

    let users: Vec<Address> = (0..NUM_USERS).map(|_| Address::generate(&env)).collect();

    assert_invariant(&tf, &gov, token_index, &users);

    for action in actions.into_iter().take(MAX_OPS_PER_RUN) {
        match action {
            Action::Mint { holder_idx, amount } => {
                let holder = &users[holder_idx as usize % users.len()];
                let amount = (amount % 1_000_000) as i128 + 1;
                if tf.try_mint(&admin, &token_index, holder, &amount).is_ok() {
                    let ledger = env.ledger().sequence();
                    if let Ok(Ok(balance)) = tf.try_get_balance_at(&token_index, holder, &ledger) {
                        let _ = gov.try_set_balance(&admin, holder, &balance);
                    }
                }
            }
            Action::Burn { holder_idx, amount } => {
                let holder = &users[holder_idx as usize % users.len()];
                let amount = (amount % 1_000_000) as i128 + 1;
                if tf.try_burn(holder, &token_index, &amount).is_ok() {
                    let ledger = env.ledger().sequence();
                    if let Ok(Ok(balance)) = tf.try_get_balance_at(&token_index, holder, &ledger) {
                        let _ = gov.try_set_balance(&admin, holder, &balance);
                    }
                }
            }
            Action::Delegate { from_idx, to_idx } => {
                let from = &users[from_idx as usize % users.len()];
                let to = &users[to_idx as usize % users.len()];
                if from != to {
                    let _ = gov.try_delegate(from, to);
                }
            }
            Action::Undelegate { from_idx } => {
                let from = &users[from_idx as usize % users.len()];
                let _ = gov.try_undelegate(from);
            }
            Action::Vote { voter_idx, in_favor } => {
                // Best-effort: only succeeds if an active proposal 0 exists;
                // included for coverage of vote-weight consumption, which
                // does not itself change vote power.
                let voter = &users[voter_idx as usize % users.len()];
                let _ = gov.try_cast_vote(voter, &0u32, &in_favor);
            }
        }

        assert_invariant(&tf, &gov, token_index, &users);
    }
});
