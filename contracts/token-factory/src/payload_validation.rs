//! Governance Action Payload Validation Layer
//!
//! Strict payload schema checks before proposal queue/execution.
//! Defines typed parsers for each ActionType, validates bounds
//! (fees non-negative, addresses valid, policy flags coherent),
//! and rejects malformed payloads early.
//!
//! Closes #423

use crate::types::{ActionType, Error};
use soroban_sdk::address_payload::AddressPayload;
use soroban_sdk::{Address, Bytes, BytesN, Env};

/// Fee change payload: base_fee (i128) + metadata_fee (i128) = 32 bytes
const FEE_PAYLOAD_LEN: usize = 32;

/// Treasury change payload: 32-byte address
const ADDRESS_PAYLOAD_LEN: usize = 32;

/// Policy update payload: daily_cap (i128) + allowlist_enabled (u8) + period_duration (u64) = 25 bytes
const POLICY_PAYLOAD_LEN: usize = 25;

/// Validate and parse payload for the given action type.
///
/// Returns `Ok(())` if the payload is well-formed and passes all bounds checks.
/// Returns `Err(Error::InvalidParameters)` for malformed or invalid payloads.
///
/// # Payload Schemas
///
/// - **FeeChange**: 32 bytes = base_fee (i128 LE) + metadata_fee (i128 LE). Both must be >= 0.
/// - **TreasuryChange**: 32 bytes = new treasury address (BytesN<32>).
/// - **PauseContract**: 0 bytes (empty).
/// - **UnpauseContract**: 0 bytes (empty).
/// - **PolicyUpdate**: 25 bytes = daily_cap (i128 LE) + allowlist (u8) + period_duration (u64 LE).
///   daily_cap must be >= 0, allowlist is 0 or 1, period_duration must be > 0.
pub fn validate_payload(env: &Env, action_type: ActionType, payload: &Bytes) -> Result<(), Error> {
    match action_type {
        ActionType::FeeChange => validate_fee_payload(payload),
        ActionType::TreasuryChange => validate_treasury_payload(env, payload),
        ActionType::PauseContract => validate_pause_payload(payload),
        ActionType::UnpauseContract => validate_unpause_payload(payload),
        ActionType::PolicyUpdate => validate_policy_payload(payload),
        ActionType::ParameterChange => Ok(()), // Placeholder validation
    }
}

fn validate_fee_payload(payload: &Bytes) -> Result<(), Error> {
    if payload.len() != FEE_PAYLOAD_LEN as u32 {
        return Err(Error::InvalidParameters);
    }

    let mut base_buf = [0u8; 16];
    payload.slice(0..16).copy_into_slice(&mut base_buf);
    let base_fee = i128::from_le_bytes(base_buf);

    let mut meta_buf = [0u8; 16];
    payload.slice(16..32).copy_into_slice(&mut meta_buf);
    let metadata_fee = i128::from_le_bytes(meta_buf);

    if base_fee < 0 || metadata_fee < 0 {
        return Err(Error::InvalidParameters);
    }

    Ok(())
}

fn validate_treasury_payload(env: &Env, payload: &Bytes) -> Result<(), Error> {
    if payload.len() != ADDRESS_PAYLOAD_LEN as u32 {
        return Err(Error::InvalidParameters);
    }

    let mut addr_buf = [0u8; 32];
    payload.copy_into_slice(&mut addr_buf);
    let _addr = AddressPayload::ContractIdHash(BytesN::from_array(env, &addr_buf)).to_address(env);
    Ok(())
}

fn validate_pause_payload(payload: &Bytes) -> Result<(), Error> {
    if !payload.is_empty() {
        return Err(Error::InvalidParameters);
    }
    Ok(())
}

fn validate_unpause_payload(payload: &Bytes) -> Result<(), Error> {
    if !payload.is_empty() {
        return Err(Error::InvalidParameters);
    }
    Ok(())
}

fn validate_policy_payload(payload: &Bytes) -> Result<(), Error> {
    if payload.len() != POLICY_PAYLOAD_LEN as u32 {
        return Err(Error::InvalidParameters);
    }

    let mut cap_buf = [0u8; 16];
    payload.slice(0..16).copy_into_slice(&mut cap_buf);
    let daily_cap = i128::from_le_bytes(cap_buf);

    let allowlist = payload.get_unchecked(16);
    let mut period_buf = [0u8; 8];
    payload.slice(17..25).copy_into_slice(&mut period_buf);
    let period_duration = u64::from_le_bytes(period_buf);

    if daily_cap < 0 {
        return Err(Error::InvalidParameters);
    }
    if allowlist > 1 {
        return Err(Error::InvalidParameters);
    }
    if period_duration == 0 {
        return Err(Error::InvalidParameters);
    }

    Ok(())
}

/// Encode a FeeChange payload from (base_fee, metadata_fee).
///
/// Produces the canonical 32-byte little-endian encoding consumed by
/// `validate_payload`/`parse_fee_payload`. Used by the `propose_fee_update`
/// governance wrapper so callers don't need to hand-roll the byte layout.
pub fn encode_fee_payload(env: &Env, base_fee: i128, metadata_fee: i128) -> Bytes {
    let mut arr = [0u8; FEE_PAYLOAD_LEN];
    arr[0..16].copy_from_slice(&base_fee.to_le_bytes());
    arr[16..32].copy_from_slice(&metadata_fee.to_le_bytes());
    Bytes::from_array(env, &arr)
}

/// Parse FeeChange payload into (base_fee, metadata_fee).
/// Call only after validate_payload succeeds for FeeChange.
pub fn parse_fee_payload(payload: &Bytes) -> (i128, i128) {
    let mut base_buf = [0u8; 16];
    payload.slice(0..16).copy_into_slice(&mut base_buf);
    let base_fee = i128::from_le_bytes(base_buf);

    let mut meta_buf = [0u8; 16];
    payload.slice(16..32).copy_into_slice(&mut meta_buf);
    let metadata_fee = i128::from_le_bytes(meta_buf);

    (base_fee, metadata_fee)
}

/// Parse TreasuryChange payload into Address.
/// Call only after validate_payload succeeds for TreasuryChange.
pub fn parse_treasury_payload(env: &Env, payload: &Bytes) -> Address {
    let mut addr_buf = [0u8; 32];
    payload.copy_into_slice(&mut addr_buf);
    AddressPayload::ContractIdHash(BytesN::from_array(env, &addr_buf)).to_address(env)
}

/// Parse PolicyUpdate payload into (daily_cap, allowlist_enabled, period_duration).
/// Call only after validate_payload succeeds for PolicyUpdate.
pub fn parse_policy_payload(payload: &Bytes) -> (i128, bool, u64) {
    let mut cap_buf = [0u8; 16];
    payload.slice(0..16).copy_into_slice(&mut cap_buf);
    let daily_cap = i128::from_le_bytes(cap_buf);

    let allowlist = payload.get_unchecked(16) != 0;
    let mut period_buf = [0u8; 8];
    payload.slice(17..25).copy_into_slice(&mut period_buf);
    let period_duration = u64::from_le_bytes(period_buf);

    (daily_cap, allowlist, period_duration)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn fee_payload(env: &Env, base_fee: i128, metadata_fee: i128) -> Bytes {
        let mut arr = [0u8; 32];
        arr[0..16].copy_from_slice(&base_fee.to_le_bytes());
        arr[16..32].copy_from_slice(&metadata_fee.to_le_bytes());
        Bytes::from_array(env, &arr)
    }

    fn treasury_payload(env: &Env, addr: &Address) -> Bytes {
        use soroban_sdk::address_payload::AddressPayload;
        let payload = addr.to_payload().expect("Address must have payload");
        let arr: [u8; 32] = match &payload {
            AddressPayload::ContractIdHash(b) => b.to_array(),
            AddressPayload::AccountIdPublicKeyEd25519(b) => b.to_array(),
        };
        Bytes::from_array(env, &arr)
    }

    fn policy_payload(env: &Env, daily_cap: i128, allowlist: bool, period: u64) -> Bytes {
        let mut arr = [0u8; 25];
        arr[0..16].copy_from_slice(&daily_cap.to_le_bytes());
        arr[16] = if allowlist { 1 } else { 0 };
        arr[17..25].copy_from_slice(&period.to_le_bytes());
        Bytes::from_array(env, &arr)
    }

    #[test]
    fn test_encode_fee_payload_round_trips() {
        let env = Env::default();
        let encoded = encode_fee_payload(&env, 2_000_000, 750_000);
        assert_eq!(encoded, fee_payload(&env, 2_000_000, 750_000));
        assert!(validate_fee_payload(&encoded).is_ok());
        let (b, m) = parse_fee_payload(&encoded);
        assert_eq!(b, 2_000_000);
        assert_eq!(m, 750_000);
    }

    #[test]
    fn test_fee_payload_valid() {
        let env = Env::default();
        let payload = fee_payload(&env, 1_000_000, 500_000);
        assert!(validate_fee_payload(&payload).is_ok());
        let (b, m) = parse_fee_payload(&payload);
        assert_eq!(b, 1_000_000);
        assert_eq!(m, 500_000);
    }

    #[test]
    fn test_fee_payload_negative_base_rejected() {
        let env = Env::default();
        let payload = fee_payload(&env, -1, 500_000);
        assert_eq!(
            validate_fee_payload(&payload),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_fee_payload_negative_metadata_rejected() {
        let env = Env::default();
        let payload = fee_payload(&env, 1_000_000, -1);
        assert_eq!(
            validate_fee_payload(&payload),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_fee_payload_wrong_length_rejected() {
        let env = Env::default();
        let short = Bytes::from_slice(&env, &[1u8; 16]);
        assert_eq!(validate_fee_payload(&short), Err(Error::InvalidParameters));

        let long = Bytes::from_slice(&env, &[1u8; 64]);
        assert_eq!(validate_fee_payload(&long), Err(Error::InvalidParameters));
    }

    #[test]
    fn test_treasury_payload_valid() {
        let env = Env::default();
        let addr = Address::generate(&env);
        let payload = treasury_payload(&env, &addr);
        assert!(validate_treasury_payload(&env, &payload).is_ok());
        let parsed = parse_treasury_payload(&env, &payload);
        assert_eq!(parsed, addr);
    }

    #[test]
    fn test_treasury_payload_wrong_length_rejected() {
        let env = Env::default();
        let short = Bytes::from_slice(&env, &[1u8; 16]);
        assert_eq!(
            validate_treasury_payload(&env, &short),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_pause_payload_valid() {
        let env = Env::default();
        let payload = Bytes::new(&env);
        assert!(validate_pause_payload(&payload).is_ok());
    }

    #[test]
    fn test_pause_payload_non_empty_rejected() {
        let env = Env::default();
        let payload = Bytes::from_slice(&env, &[1u8]);
        assert_eq!(
            validate_pause_payload(&payload),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_unpause_payload_valid() {
        let env = Env::default();
        let payload = Bytes::new(&env);
        assert!(validate_unpause_payload(&payload).is_ok());
    }

    #[test]
    fn test_policy_payload_valid() {
        let env = Env::default();
        let payload = policy_payload(&env, 100_0000000, true, 86400);
        assert!(validate_policy_payload(&payload).is_ok());
        let (cap, allow, period) = parse_policy_payload(&payload);
        assert_eq!(cap, 100_0000000);
        assert!(allow);
        assert_eq!(period, 86400);
    }

    #[test]
    fn test_policy_payload_negative_cap_rejected() {
        let env = Env::default();
        let payload = policy_payload(&env, -1, true, 86400);
        assert_eq!(
            validate_policy_payload(&payload),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_policy_payload_invalid_allowlist_rejected() {
        let env = Env::default();
        let mut payload = policy_payload(&env, 100_0000000, true, 86400);
        payload.set(16, 2); // invalid allowlist value
        assert_eq!(
            validate_policy_payload(&payload),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_policy_payload_zero_period_rejected() {
        let env = Env::default();
        let payload = policy_payload(&env, 100_0000000, true, 0);
        assert_eq!(
            validate_policy_payload(&payload),
            Err(Error::InvalidParameters)
        );
    }

    #[test]
    fn test_validate_payload_dispatches_correctly() {
        let env = Env::default();
        assert!(validate_payload(&env, ActionType::FeeChange, &fee_payload(&env, 1, 1)).is_ok());
        assert!(validate_payload(
            &env,
            ActionType::TreasuryChange,
            &treasury_payload(&env, &Address::generate(&env))
        )
        .is_ok());
        assert!(validate_payload(&env, ActionType::PauseContract, &Bytes::new(&env)).is_ok());
        assert!(validate_payload(&env, ActionType::UnpauseContract, &Bytes::new(&env)).is_ok());
        assert!(validate_payload(
            &env,
            ActionType::PolicyUpdate,
            &policy_payload(&env, 1, false, 1)
        )
        .is_ok());
    }
}
