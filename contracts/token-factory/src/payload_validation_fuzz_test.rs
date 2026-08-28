#![cfg(test)]

//! Fuzz tests for governance action payload validation.
//!
//! Tests malformed and oversized payloads are rejected deterministically.
//! Closes #423

extern crate alloc;
use alloc::vec::Vec;

use crate::payload_validation::validate_payload;
use crate::test_helpers::{
    fee_change_payload, pause_payload, policy_update_payload, treasury_change_payload,
};
use crate::types::{ActionType, Error};
use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, Env};

fn env() -> Env {
    Env::default()
}

proptest! {
    /// Malformed FeeChange payloads (wrong length) are rejected
    #[test]
    fn fuzz_fee_payload_wrong_len_rejected(len in 0usize..2048) {
        let env = env();
        if len == 32 {
            return Ok(());
        }
        let mut arr = Vec::from_iter(core::iter::repeat(0u8).take(len));
        for b in &mut arr {
            *b = 0;
        }
        let payload = if arr.is_empty() {
            Bytes::new(&env)
        } else {
            Bytes::from_slice(&env, &arr)
        };
        let result = validate_payload(&env, ActionType::FeeChange, &payload);
        prop_assert_eq!(result, Err(Error::InvalidParameters));
    }

    /// Oversized FeeChange payloads are rejected
    #[test]
    fn fuzz_fee_payload_oversized_rejected(base_fee in 0i128..i128::MAX, meta_fee in 0i128..i128::MAX) {
        let env = env();
        let mut payload = fee_change_payload(&env, base_fee, meta_fee);
        // Append extra bytes to make it oversized
        payload.append(&Bytes::from_slice(&env, &[1u8; 100]));
        let result = validate_payload(&env, ActionType::FeeChange, &payload);
        prop_assert_eq!(result, Err(Error::InvalidParameters));
    }

    /// Negative fees in FeeChange are rejected
    #[test]
    fn fuzz_fee_payload_negative_rejected(base_fee in i128::MIN..0i128, meta_fee in 0i128..i128::MAX) {
        let env = env();
        let payload = fee_change_payload(&env, base_fee, meta_fee);
        let result = validate_payload(&env, ActionType::FeeChange, &payload);
        prop_assert_eq!(result, Err(Error::InvalidParameters));
    }

    /// TreasuryChange with wrong length is rejected
    #[test]
    fn fuzz_treasury_payload_wrong_len_rejected(len in 0usize..2048) {
        let env = env();
        if len == 32 {
            return Ok(());
        }
        let arr = Vec::from_iter(core::iter::repeat(0u8).take(len));
        let payload = if arr.is_empty() {
            Bytes::new(&env)
        } else {
            Bytes::from_slice(&env, &arr)
        };
        let result = validate_payload(&env, ActionType::TreasuryChange, &payload);
        prop_assert_eq!(result, Err(Error::InvalidParameters));
    }

    /// PauseContract with non-empty payload is rejected
    #[test]
    fn fuzz_pause_payload_non_empty_rejected(len in 1usize..1024) {
        let env = env();
        let arr = Vec::from_iter(core::iter::repeat(0u8).take(len));
        let payload = Bytes::from_slice(&env, &arr);
        let result = validate_payload(&env, ActionType::PauseContract, &payload);
        prop_assert_eq!(result, Err(Error::InvalidParameters));
    }

    /// PolicyUpdate with wrong length is rejected
    #[test]
    fn fuzz_policy_payload_wrong_len_rejected(len in 0usize..2048) {
        let env = env();
        if len == 25 {
            return Ok(());
        }
        let arr = Vec::from_iter(core::iter::repeat(0u8).take(len));
        let payload = if arr.is_empty() {
            Bytes::new(&env)
        } else {
            Bytes::from_slice(&env, &arr)
        };
        let result = validate_payload(&env, ActionType::PolicyUpdate, &payload);
        prop_assert_eq!(result, Err(Error::InvalidParameters));
    }

    /// PolicyUpdate with zero period_duration is rejected
    #[test]
    fn fuzz_policy_zero_period_rejected(daily_cap in 0i128..i128::MAX) {
        let env = env();
        let payload = policy_update_payload(&env, daily_cap, true, 0);
        let result = validate_payload(&env, ActionType::PolicyUpdate, &payload);
        prop_assert_eq!(result, Err(Error::InvalidParameters));
    }
}

#[test]
fn fuzz_valid_fee_payload_accepted() {
    let env = env();
    for (base, meta) in [(0, 0), (1, 1), (1_000_000, 500_000), (i128::MAX, i128::MAX)] {
        let payload = fee_change_payload(&env, base, meta);
        assert!(validate_payload(&env, ActionType::FeeChange, &payload).is_ok());
    }
}

#[test]
fn fuzz_valid_pause_payload_accepted() {
    let env = env();
    let payload = pause_payload(&env);
    assert!(validate_payload(&env, ActionType::PauseContract, &payload).is_ok());
    assert!(validate_payload(&env, ActionType::UnpauseContract, &payload).is_ok());
}

#[test]
fn fuzz_valid_treasury_payload_accepted() {
    let env = env();
    let addr = Address::generate(&env);
    let payload = treasury_change_payload(&env, &addr);
    assert!(validate_payload(&env, ActionType::TreasuryChange, &payload).is_ok());
}
