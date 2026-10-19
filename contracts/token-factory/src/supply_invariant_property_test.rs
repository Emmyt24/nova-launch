//! Property-based tests for the total supply invariant across all mutations.
//!
//! These tests generate random sequences of mint, burn, clawback, and batch
//! operations (including edge amounts such as `0`, `1`, `i128::MAX`, and
//! `i128::MAX - 1`) and assert after each step that:
//!
//! 1. `total_supply` equals the sum of all holder balances.
//! 2. Supply conservation holds: the net change in total supply equals the
//!    sum of the net changes applied by each operation.
//!
//! The module is registered in `lib.rs` under `#[cfg(test)]`.

#![cfg(test)]

use proptest::prelude::*;
use std::collections::BTreeMap;

/// A single mutation operation applied to the token state.
#[derive(Clone, Debug)]
enum Op {
    /// Mint `amount` tokens to `holder`.
    Mint { holder: u8, amount: i128 },
    /// Burn `amount` tokens from `holder`.
    Burn { holder: u8, amount: i128 },
    /// Clawback `amount` tokens from `holder`.
    Clawback { holder: u8, amount: i128 },
    /// Batch of operations applied atomically.
    Batch { ops: Vec<Op> },
}

/// Minimal token state used to model supply accounting.
#[derive(Clone, Debug, Default)]
struct TokenState {
    total_supply: i128,
    balances: BTreeMap<u8, i128>,
}

impl TokenState {
    fn balance_of(&self, holder: u8) -> i128 {
        *self.balances.get(&holder).unwrap_or(&0)
    }

    fn set_balance(&mut self, holder: u8, value: i128) {
        if value == 0 {
            self.balances.remove(&holder);
        } else {
            self.balances.insert(holder, value);
        }
    }

    /// Sum of all holder balances.
    fn sum_balances(&self) -> i128 {
        self.balances.values().copied().sum()
    }

    /// Apply a mint. Returns the actual amount minted (saturating at i128::MAX).
    fn mint(&mut self, holder: u8, amount: i128) -> i128 {
        if amount <= 0 {
            return 0;
        }
        let current = self.balance_of(holder);
        let new_balance = current.saturating_add(amount);
        let minted = new_balance - current;
        self.set_balance(holder, new_balance);
        self.total_supply = self.total_supply.saturating_add(minted);
        minted
    }

    /// Apply a burn. Returns the actual amount burned.
    fn burn(&mut self, holder: u8, amount: i128) -> i128 {
        if amount <= 0 {
            return 0;
        }
        let current = self.balance_of(holder);
        let burned = amount.min(current);
        self.set_balance(holder, current - burned);
        self.total_supply -= burned;
        burned
    }

    /// Apply a clawback. Returns the actual amount clawed back.
    fn clawback(&mut self, holder: u8, amount: i128) -> i128 {
        // Clawback behaves like a burn from the holder's perspective for
        // supply accounting purposes.
        self.burn(holder, amount)
    }

    /// Apply an operation, returning the net supply delta.
    fn apply(&mut self, op: &Op) -> i128 {
        match op {
            Op::Mint { holder, amount } => self.mint(*holder, *amount),
            Op::Burn { holder, amount } => -self.burn(*holder, *amount),
            Op::Clawback { holder, amount } => -self.clawback(*holder, *amount),
            Op::Batch { ops } => ops.iter().map(|o| self.apply(o)).sum(),
        }
    }
}

/// Edge amounts to exercise boundary conditions.
const EDGE_AMOUNTS: &[i128] = &[0, 1, i128::MAX, i128::MAX - 1];

/// Strategy for generating an amount, biased toward edge values.
fn amount_strategy() -> impl Strategy<Value = i128> {
    prop_oneof![
        // Edge amounts.
        Just(0i128),
        Just(1i128),
        Just(i128::MAX),
        Just(i128::MAX - 1),
        // Small amounts.
        0i128..=1_000i128,
        // Large amounts.
        (i128::MAX / 2)..=i128::MAX,
        // Arbitrary non-negative amounts.
        any::<i128>().prop_map(|v| v.abs()),
    ]
}

/// Strategy for generating a holder id.
fn holder_strategy() -> impl Strategy<Value = u8> {
    0u8..8
}

/// Strategy for generating a single (non-batch) operation.
fn leaf_op_strategy() -> impl Strategy<Value = Op> {
    (holder_strategy(), amount_strategy()).prop_flat_map(|(holder, amount)| {
        prop_oneof![
            Just(Op::Mint { holder, amount }),
            Just(Op::Burn { holder, amount }),
            Just(Op::Clawback { holder, amount }),
        ]
    })
}

/// Strategy for generating an operation, including nested batches.
fn op_strategy() -> impl Strategy<Value = Op> {
    leaf_op_strategy().prop_recursive(3, 32, 4, |inner| {
        prop::collection::vec(inner, 0..4).prop_map(|ops| Op::Batch { ops })
    })
}

/// Strategy for generating a sequence of operations.
fn op_sequence_strategy() -> impl Strategy<Value = Vec<Op>> {
    prop::collection::vec(op_strategy(), 0..64)
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 256,
        ..ProptestConfig::default()
    })]

    /// After every mutation, total supply must equal the sum of balances and
    /// supply conservation must hold.
    #[test]
    fn total_supply_equals_sum_of_balances(ops in op_sequence_strategy()) {
        let mut state = TokenState::default();
        let mut expected_supply: i128 = 0;

        for op in &ops {
            let delta = state.apply(op);
            expected_supply = expected_supply.saturating_add(delta);

            // Invariant 1: total supply equals sum of balances.
            prop_assert_eq!(
                state.total_supply,
                state.sum_balances(),
                "total_supply must equal sum of balances after op {:?}",
                op
            );

            // Invariant 2: supply conservation.
            prop_assert_eq!(
                state.total_supply,
                expected_supply,
                "supply conservation violated after op {:?}",
                op
            );

            // Invariant 3: total supply is never negative.
            prop_assert!(
                state.total_supply >= 0,
                "total_supply must never be negative after op {:?}",
                op
            );

            // Invariant 4: no individual balance is negative.
            for (holder, balance) in &state.balances {
                prop_assert!(
                    *balance >= 0,
                    "balance for holder {} must never be negative after op {:?}",
                    holder,
                    op
                );
            }
        }
    }

    /// Minting then burning the same amount restores the original supply.
    #[test]
    fn mint_then_burn_roundtrip(
        holder in holder_strategy(),
        amount in 1i128..=1_000_000i128,
    ) {
        let mut state = TokenState::default();
        state.mint(holder, amount);
        prop_assert_eq!(state.total_supply, amount);
        prop_assert_eq!(state.sum_balances(), amount);

        state.burn(holder, amount);
        prop_assert_eq!(state.total_supply, 0);
        prop_assert_eq!(state.sum_balances(), 0);
    }

    /// Burning more than the holder's balance only burns what is available.
    #[test]
    fn burn_cannot_exceed_balance(
        holder in holder_strategy(),
        minted in 0i128..=1_000_000i128,
        burn_amount in 0i128..=1_000_000i128,
    ) {
        let mut state = TokenState::default();
        state.mint(holder, minted);
        let burned = state.burn(holder, burn_amount);

        prop_assert_eq!(burned, burn_amount.min(minted));
        prop_assert_eq!(state.total_supply, minted - burned);
        prop_assert_eq!(state.sum_balances(), minted - burned);
        prop_assert!(state.balance_of(holder) >= 0);
    }

    /// Clawback reduces supply by exactly the amount clawed back.
    #[test]
    fn clawback_reduces_supply(
        holder in holder_strategy(),
        minted in 1i128..=1_000_000i128,
        claw_amount in 0i128..=1_000_000i128,
    ) {
        let mut state = TokenState::default();
        state.mint(holder, minted);
        let clawed = state.clawback(holder, claw_amount);

        prop_assert_eq!(clawed, claw_amount.min(minted));
        prop_assert_eq!(state.total_supply, minted - clawed);
        prop_assert_eq!(state.sum_balances(), minted - clawed);
    }

    /// Batch operations preserve the supply invariant.
    #[test]
    fn batch_operations_preserve_invariant(ops in prop::collection::vec(leaf_op_strategy(), 0..16)) {
        let mut state = TokenState::default();
        let batch = Op::Batch { ops };
        state.apply(&batch);

        prop_assert_eq!(state.total_supply, state.sum_balances());
        prop_assert!(state.total_supply >= 0);
    }

    /// Edge amounts never break the invariant.
    #[test]
    fn edge_amounts_preserve_invariant(
        holder in holder_strategy(),
        edge_idx in 0usize..EDGE_AMOUNTS.len(),
    ) {
        let amount = EDGE_AMOUNTS[edge_idx];
        let mut state = TokenState::default();

        state.mint(holder, amount);
        prop_assert_eq!(state.total_supply, state.sum_balances());

        state.burn(holder, amount);
        prop_assert_eq!(state.total_supply, state.sum_balances());

        state.mint(holder, amount);
        state.clawback(holder, amount);
        prop_assert_eq!(state.total_supply, state.sum_balances());
    }
}