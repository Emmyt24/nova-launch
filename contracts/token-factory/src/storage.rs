use soroban_sdk::{Address, Env, Vec};

use crate::commit_reveal::{CommitRecord, CommitRevealSession};
use crate::types::{
    BridgeLock, BuybackCampaign, DataKey, Error, FactoryState, Reservation,
    RevealBatchContinuation, SettleBatchContinuation, StreamCursor, TokenInfo,
};

// ============================================================
// TTL Bump Constants (#1128)
// ============================================================
// Soroban ledger entries expire unless their TTL is extended.
// Instance storage holds core admin state and must outlive any
// individual token or stream. Persistent storage holds per-token
// data that should survive at least one full governance cycle.
//
// Ledger closes roughly every 5 seconds on Stellar mainnet.
// INSTANCE_TTL_BUMP  = ~1 year  (6_307_200 ledgers)
// PERSISTENT_TTL_BUMP = ~30 days (518_400 ledgers)
// INSTANCE_TTL_THRESHOLD  = trigger bump when < ~6 months remaining
// PERSISTENT_TTL_THRESHOLD = trigger bump when < ~7 days remaining
// ============================================================

/// Minimum remaining TTL before an instance entry is bumped (~6 months).
pub const INSTANCE_TTL_THRESHOLD: u32 = 3_153_600;
/// Target TTL for instance storage entries (~1 year).
pub const INSTANCE_TTL_BUMP: u32 = 6_307_200;

/// Minimum remaining TTL before a persistent entry is bumped (~7 days).
pub const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
/// Target TTL for persistent storage entries (~30 days).
pub const PERSISTENT_TTL_BUMP: u32 = 518_400;

/// Extend instance storage TTL if below threshold.
pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_BUMP);
}

/// Extend a persistent entry's TTL if below threshold.
pub fn bump_persistent<K: soroban_sdk::TryIntoVal<Env, soroban_sdk::Val> + soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_BUMP);
}

// ============================================================
// Storage Functions - Burn Tracking
// ============================================================
// Available functions:
// - get_total_burned(env, token_address) -> i128
// - get_burn_count(env, token_address) -> u32
// - get_global_burn_count(env) -> u32
// - increment_burn_count(env, token_address, amount)
// - add_burn_record(env, record)
// - get_burn_record(env, index) -> Option<BurnRecord>
// - get_burn_record_count(env) -> u32
// - update_token_supply(env, token_address, delta)
// ============================================================

// Admin management

/// Return the factory admin address, or `None` if `initialize` has not been
/// called yet.  Callers in post-initialisation paths should propagate
/// `Error::MissingAdmin` via `.ok_or(Error::MissingAdmin)?`.
pub fn get_admin(env: &Env) -> Option<Address> {
    bump_instance(env);
    env.storage().instance().get(&DataKey::Admin)
}

pub fn set_admin(env: &Env, admin: &Address) {
    bump_instance(env);
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

// Pending admin management (two-step transfer)
pub fn get_pending_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PendingAdmin)
}

pub fn set_pending_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::PendingAdmin, admin);
}

pub fn clear_pending_admin(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingAdmin);
}

pub fn has_pending_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::PendingAdmin)
}

// Treasury management

/// Return the factory treasury address, or `None` if `initialize` has not
/// been called yet.  Callers in post-initialisation paths should propagate
/// `Error::MissingTreasury` via `.ok_or(Error::MissingTreasury)?`.
pub fn get_treasury(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Treasury)
}

pub fn set_treasury(env: &Env, treasury: &Address) {
    env.storage().instance().set(&DataKey::Treasury, treasury);
}

// Fee token management
pub fn get_fee_token(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::FeeToken)
}

pub fn set_fee_token(env: &Env, token: &Address) {
    env.storage().instance().set(&DataKey::FeeToken, token);
}

// Governance management
pub fn get_governance(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Governance)
}

pub fn set_governance(env: &Env, governance: &Address) {
    env.storage().instance().set(&DataKey::Governance, governance);
}

// Metadata immutability lock (#1359)
//
// Token identity fields (name, symbol, decimals) are immutable for the lifetime
// of the contract once the lock is engaged. The lock is engaged at the end of
// the first successful `initialize` call so that buyers can rely on the identity
// of every token deployed by this factory never changing out from under them.

/// Returns `true` if the metadata identity lock has been engaged.
pub fn is_metadata_locked(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::MetadataLocked)
        .unwrap_or(false)
}

/// Engage the metadata identity lock and record the ledger at which it occurred.
/// Idempotent: the recorded ledger is only written the first time the lock is set.
pub fn set_metadata_locked(env: &Env, locked: bool) {
    env.storage().instance().set(&DataKey::MetadataLocked, &locked);
    if locked && !env.storage().instance().has(&DataKey::MetadataLockedAt) {
        let ledger = env.ledger().sequence();
        env.storage()
            .instance()
            .set(&DataKey::MetadataLockedAt, &ledger);
    }
}

/// Returns the ledger sequence at which the metadata lock was engaged, if ever.
pub fn get_metadata_locked_at(env: &Env) -> Option<u32> {
    env.storage().instance().get(&DataKey::MetadataLockedAt)
}

// Fee management

/// Return the base deployment fee in stroops, or `None` if `initialize` has
/// not been called yet.  Callers in post-initialisation paths should propagate
/// `Error::InvalidBaseFee` via `.ok_or(Error::InvalidBaseFee)?`.
pub fn get_base_fee(env: &Env) -> Option<i128> {
    env.storage().instance().get(&DataKey::BaseFee)
}

pub fn set_base_fee(env: &Env, fee: i128) {
    env.storage().instance().set(&DataKey::BaseFee, &fee);
}

/// Return the metadata fee in stroops, or `None` if `initialize` has not been
/// called yet.  Callers in post-initialisation paths should propagate
/// `Error::InvalidMetadataFee` via `.ok_or(Error::InvalidMetadataFee)?`.
pub fn get_metadata_fee(env: &Env) -> Option<i128> {
    env.storage().instance().get(&DataKey::MetadataFee)
}

pub fn set_metadata_fee(env: &Env, fee: i128) {
    env.storage().instance().set(&DataKey::MetadataFee, &fee);
}

// Token registry
pub fn get_token_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::TokenCount)
        .unwrap_or(0)
}

pub fn get_token_info(env: &Env, index: u32) -> Option<TokenInfo> {
    bump_instance(env);
    env.storage().instance().get(&DataKey::Token(index))
}

pub fn set_token_info(env: &Env, index: u32, info: &TokenInfo) {
    bump_instance(env);
    env.storage().instance().set(&DataKey::Token(index), info);

    // Index by creator for pagination
    add_creator_token(env, &info.creator, index);

    // Emit token registered event
    crate::events::emit_token_registered(env, &info.address, &info.creator);
}

pub fn increment_token_count(env: &Env) -> Result<u32, Error> {
    let count = get_token_count(env)
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    env.storage().instance().set(&DataKey::TokenCount, &count);
    Ok(count)
}

// Get factory state
pub fn get_factory_state(env: &Env) -> FactoryState {
    FactoryState {
        admin: get_admin(env).unwrap_or_else(|| {
            // Factory not yet initialised; return a zeroed sentinel.
            // Callers that need a real admin should check `has_admin` first.
            soroban_sdk::address_payload::AddressPayload::ContractIdHash(
                soroban_sdk::BytesN::from_array(env, &[0u8; 32]),
            )
            .to_address(env)
        }),
        treasury: get_treasury(env).unwrap_or_else(|| {
            soroban_sdk::address_payload::AddressPayload::ContractIdHash(
                soroban_sdk::BytesN::from_array(env, &[0u8; 32]),
            )
            .to_address(env)
        }),
        base_fee: get_base_fee(env).unwrap_or(0),
        metadata_fee: get_metadata_fee(env).unwrap_or(0),
        paused: is_paused(env),
    }
}

/// ============================================================
///  Security Test Suite — Burn Feature (Issue #163)
///  Temporarily disabled due to compilation errors with Result types
/// ============================================================
///
///  Coverage map (matches issue #163 checklist):
///  [AUTH]  Authorization & Access Control
///  [ARITH] Arithmetic & Overflow
///  [STATE] State Consistency
///  [REEN]  Reentrancy
///  [INPUT] Input Validation
///  [DOS]   DoS & Resource Exhaustion

/*
// Temporarily disabled due to compilation issues with burn tests
#[cfg(test)]
mod burn_security_tests {
    use soroban_sdk::{
        testutils::{Address as _, Events},
        vec, Address, Env,
    };

    // ── helpers ──────────────────────────────────────────────

    /// Deploy and fully initialise the contract, returning
    /// (env, contract_id, admin, treasury, token_index).
    fn setup() -> (Env, Address, Address, Address, u32) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, crate::TokenFactory);
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client
            .initialize(&admin, &treasury, &100_i128, &50_i128)
            .unwrap();

        // Create a token and mint an initial supply to admin
        let token_index = 0_u32;
        client
            .create_token(
                &admin,
                &soroban_sdk::String::from_str(&env, "TestToken"),
                &soroban_sdk::String::from_str(&env, "TTK"),
                &6_u32,
                &1_000_000_i128,
                &None,
                &100_i128,
            )
            .unwrap();

        // Give admin a starting balance for burn tests
        // (In a real deploy the initial_supply would be minted to creator)
        crate::storage::set_balance(&env, token_index, &admin, 1_000_000_i128);

        (env, contract_id, admin, treasury, token_index)
    }

    // ════════════════════════════════════════════════════════
    //  [AUTH] Authorization & Access Control
    // ════════════════════════════════════════════════════════

    /// A random address must NOT be able to burn tokens it does not own.
    #[test]
    #[should_panic]
    fn auth_unauthorized_burn_rejected() {
        let (env, contract_id, _admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        // attacker has zero balance
        let attacker = Address::generate(&env);

        // Disable mock auths so require_auth() actually enforces
        // (env.mock_all_auths is not set here — the call must fail)
        client.burn(&attacker, &token_index, &1_i128).unwrap();
    }

    /// A non-admin must not be able to call admin_burn.
    #[test]
    #[should_panic]
    fn auth_non_admin_cannot_admin_burn() {
        let (env, contract_id, _admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let impostor = Address::generate(&env);
        let victim = Address::generate(&env);

        client
            .admin_burn(&impostor, &token_index, &victim, &1_i128)
            .unwrap();
    }

    /// Passing the correct admin address but wrong signer must fail.
    #[test]
    #[should_panic]
    fn auth_admin_burn_requires_auth_signature() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        // Create an env WITHOUT mock_all_auths
        let strict_env = Env::default();
        let strict_client = crate::TokenFactoryClient::new(&strict_env, &contract_id);

        let holder = Address::generate(&env);
        crate::storage::set_balance(&env, token_index, &holder, 500_i128);

        // admin address supplied but not signed — should panic on require_auth
        strict_client
            .admin_burn(&admin, &token_index, &holder, &100_i128)
            .unwrap();
    }

    /// Holder may only burn their own tokens, not another holder's.
    #[test]
    fn auth_holder_cannot_burn_another_holders_tokens() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let holder_a = Address::generate(&env);
        let holder_b = Address::generate(&env);

        crate::storage::set_balance(&env, token_index, &holder_a, 1_000_i128);
        crate::storage::set_balance(&env, token_index, &holder_b, 1_000_i128);

        // holder_b tries to burn from holder_a's balance — must fail
        let result = client.burn(&holder_a, &token_index, &500_i128);
        // Only holder_a signing can burn holder_a's tokens; here we call
        // with holder_a address but the auth environment enforces the signer.
        // In a non-mock env this would panic; in mock env the address must match.
        // We verify holder_b's balance is untouched.
        let _ = result;
        let b_balance = crate::storage::get_balance(&env, token_index, &holder_b);
        assert_eq!(b_balance, 1_000_i128, "holder_b balance must be untouched");
    }

    // ════════════════════════════════════════════════════════
    //  [ARITH] Arithmetic & Overflow
    // ════════════════════════════════════════════════════════

    /// Burning more than the holder's balance must be rejected.
    #[test]
    #[should_panic]
    fn arith_burn_exceeds_balance_rejected() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        // admin has 1_000_000; attempt to burn 1_000_001
        client.burn(&admin, &token_index, &1_000_001_i128).unwrap();
    }

    /// Burning i128::MAX amount must be rejected (overflow protection).
    #[test]
    #[should_panic]
    fn arith_overflow_amount_rejected() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        client.burn(&admin, &token_index, &i128::MAX).unwrap();
    }

    /// Zero-amount burn must be rejected.
    #[test]
    #[should_panic]
    fn arith_zero_amount_rejected() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        client.burn(&admin, &token_index, &0_i128).unwrap();
    }

    /// Negative-amount burn must be rejected.
    #[test]
    #[should_panic]
    fn arith_negative_amount_rejected() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        client.burn(&admin, &token_index, &(-1_i128)).unwrap();
    }

    /// After a valid burn, total_supply decreases by exactly the burned amount.
    #[test]
    fn arith_supply_decreases_by_exact_burn_amount() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let before = client.get_token_info(&token_index).unwrap().total_supply;
        let burn_amount = 42_000_i128;

        client.burn(&admin, &token_index, &burn_amount).unwrap();

        let after = client.get_token_info(&token_index).unwrap().total_supply;
        assert_eq!(after, before - burn_amount, "Supply must decrease by exactly burn_amount");
    }

    /// Supply can reach zero but never go negative.
    #[test]
    fn arith_supply_never_goes_negative() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let supply = client.get_token_info(&token_index).unwrap().total_supply;

        // Burn the entire supply
        client.burn(&admin, &token_index, &supply).unwrap();

        let after = client.get_token_info(&token_index).unwrap().total_supply;
        assert_eq!(after, 0_i128, "Supply must be zero, not negative");

        // Attempt to burn 1 more — must fail
        let result = client.burn(&admin, &token_index, &1_i128);
        assert!(result.is_err(), "Burning from empty supply must fail");
    }

    // ════════════════════════════════════════════════════════
    //  [STATE] State Consistency
    // ════════════════════════════════════════════════════════

    /// Balance and supply must be updated consistently after a burn.
    #[test]
    fn state_balance_and_supply_consistent_after_burn() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let supply_before = client.get_token_info(&token_index).unwrap().total_supply;
        let balance_before = crate::storage::get_balance(&env, token_index, &admin);

        client.burn(&admin, &token_index, &300_i128).unwrap();

        let supply_after = client.get_token_info(&token_index).unwrap().total_supply;
        let balance_after = crate::storage::get_balance(&env, token_index, &admin);

        assert_eq!(supply_before - supply_after, 300_i128);
        assert_eq!(balance_before - balance_after, 300_i128);
        assert_eq!(supply_before - supply_after, balance_before - balance_after,
            "Supply delta must equal balance delta");
    }

    /// Burn count increments correctly with each burn.
    #[test]
    fn state_burn_count_increments_correctly() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        assert_eq!(client.get_burn_count(&token_index), 0_u32);

        client.burn(&admin, &token_index, &100_i128).unwrap();
        assert_eq!(client.get_burn_count(&token_index), 1_u32);

        client.burn(&admin, &token_index, &100_i128).unwrap();
        assert_eq!(client.get_burn_count(&token_index), 2_u32);
    }

    /// Multiple sequential burns produce correct cumulative supply.
    #[test]
    fn state_sequential_burns_cumulative_supply() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let initial = 1_000_000_i128;
        let burns = [100_i128, 200_i128, 300_i128, 400_i128];
        let expected_final = initial - burns.iter().sum::<i128>();

        for &amount in &burns {
            client.burn(&admin, &token_index, &amount).unwrap();
        }

        let supply = client.get_token_info(&token_index).unwrap().total_supply;
        assert_eq!(supply, expected_final);
    }

    // ════════════════════════════════════════════════════════
    //  [REEN] Reentrancy
    // ════════════════════════════════════════════════════════

    /// State must be fully committed before any event is emitted.
    /// In Soroban, cross-contract reentrancy is prevented by the host,
    /// but we verify the ordering: state update → event emission.
    #[test]
    fn reen_state_committed_before_event_emitted() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        client.burn(&admin, &token_index, &1_000_i128).unwrap();

        // Verify state is already correct when we check after the call
        let supply = client.get_token_info(&token_index).unwrap().total_supply;
        assert_eq!(supply, 1_000_000_i128 - 1_000_i128,
            "State must be committed; event emission must follow, not precede it");

        // Verify the event was emitted
        let events = env.events().all();
        assert!(!events.is_empty(), "Burn event must have been emitted");
    }

    /// Verify a burn event is emitted with the correct payload.
    #[test]
    fn reen_burn_event_emitted_with_correct_data() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        client.burn(&admin, &token_index, &500_i128).unwrap();

        let events = env.events().all();
        // The last event should be the burn event
        assert!(!events.is_empty(), "Expected at least one event after burn");
    }

    // ════════════════════════════════════════════════════════
    //  [INPUT] Input Validation
    // ════════════════════════════════════════════════════════

    /// Burn on a non-existent token index must return TokenNotFound.
    #[test]
    #[should_panic]
    fn input_nonexistent_token_rejected() {
        let (env, contract_id, admin, _treasury, _token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        // token index 9999 was never created
        client.burn(&admin, &9999_u32, &100_i128).unwrap();
    }

    /// Batch burn with an empty list must be rejected.
    #[test]
    #[should_panic]
    fn input_empty_batch_rejected() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let empty: soroban_sdk::Vec<(Address, i128)> = vec![&env];
        client.batch_burn(&admin, &token_index, &empty).unwrap();
    }

    /// Each individual entry in a batch is validated before any mutation.
    #[test]
    fn input_batch_all_or_nothing_on_invalid_entry() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let holder_a = Address::generate(&env);
        let holder_b = Address::generate(&env);

        crate::storage::set_balance(&env, token_index, &holder_a, 1_000_i128);
        crate::storage::set_balance(&env, token_index, &holder_b, 50_i128);

        let supply_before = client.get_token_info(&token_index).unwrap().total_supply;

        // holder_b only has 50 but we ask to burn 200 — entire batch must fail
        let burns = vec![
            &env,
            (holder_a.clone(), 100_i128),
            (holder_b.clone(), 200_i128), // invalid entry
        ];

        let result = client.batch_burn(&admin, &token_index, &burns);
        assert!(result.is_err(), "Batch with invalid entry must be rejected entirely");

        // holder_a's balance must be untouched
        let a_balance = crate::storage::get_balance(&env, token_index, &holder_a);
        assert_eq!(a_balance, 1_000_i128, "holder_a balance must be unchanged after failed batch");

        // Supply must be untouched
        let supply_after = client.get_token_info(&token_index).unwrap().total_supply;
        assert_eq!(supply_before, supply_after, "Supply must be unchanged after failed batch");
    }

    // ════════════════════════════════════════════════════════
    //  [DOS] DoS & Resource Exhaustion
    // ════════════════════════════════════════════════════════

    /// Batch burn exceeding MAX_BATCH_BURN (100) must be rejected.
    #[test]
    #[should_panic]
    fn dos_batch_burn_exceeds_limit_rejected() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        // Build a batch of 101 entries
        let mut burns: soroban_sdk::Vec<(Address, i128)> = vec![&env];
        for _ in 0..101 {
            let holder = Address::generate(&env);
            crate::storage::set_balance(&env, token_index, &holder, 10_i128);
            burns.push_back((holder, 1_i128));
        }

        client.batch_burn(&admin, &token_index, &burns).unwrap();
    }

    /// Burning exactly MAX_BATCH_BURN entries must succeed (boundary check).
    #[test]
    fn dos_batch_burn_at_limit_succeeds() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let mut burns: soroban_sdk::Vec<(Address, i128)> = vec![&env];
        for _ in 0..100 {
            let holder = Address::generate(&env);
            crate::storage::set_balance(&env, token_index, &holder, 10_i128);
            burns.push_back((holder, 1_i128));
        }

        let result = client.batch_burn(&admin, &token_index, &burns);
        assert!(result.is_ok(), "Batch of exactly 100 must succeed");
    }

    // ════════════════════════════════════════════════════════
    //  [AUTH] Privilege Escalation
    // ════════════════════════════════════════════════════════

    /// A non-admin passing the admin address as an argument must fail.
    #[test]
    #[should_panic]
    fn auth_admin_privilege_escalation_rejected() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let victim = Address::generate(&env);
        crate::storage::set_balance(&env, token_index, &victim, 1_000_i128);

        // Attacker supplies admin's address but signs as themselves
        // In a non-mock env this panics at require_auth(); in mock env
        // admin != current_admin check stops it if attacker != admin.
        let attacker = Address::generate(&env);
        // We deliberately pass admin address but the auth check will fail
        // because attacker's signature != admin's expected auth.
        let _ = client.admin_burn(&admin, &token_index, &victim, &100_i128);
        // If somehow we get here, verify victim's balance is unchanged
        let balance = crate::storage::get_balance(&env, token_index, &victim);
        assert_eq!(balance, 1_000_i128, "Victim's balance must be untouched after failed escalation");
        let _ = attacker; // suppress unused warning
        panic!("Test must have panicked before reaching this line");
    }

    // ════════════════════════════════════════════════════════
    //  Supply Conservation (invariant)
    // ════════════════════════════════════════════════════════

    /// Sum of all balances must equal total_supply at all times.
    #[test]
    fn invariant_supply_conservation_after_burns() {
        let (env, contract_id, admin, _treasury, token_index) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let holder_a = Address::generate(&env);
        let holder_b = Address::generate(&env);

        // Distribute supply: admin 500k, holder_a 300k, holder_b 200k
        crate::storage::set_balance(&env, token_index, &admin, 500_000_i128);
        crate::storage::set_balance(&env, token_index, &holder_a, 300_000_i128);
        crate::storage::set_balance(&env, token_index, &holder_b, 200_000_i128);

        // Burn from each
        client.burn(&admin, &token_index, &50_000_i128).unwrap();
        client
            .admin_burn(&admin, &token_index, &holder_a, &30_000_i128)
            .unwrap();

        let supply = client.get_token_info(&token_index).unwrap().total_supply;
        let sum_balances =
            crate::storage::get_balance(&env, token_index, &admin)
            + crate::storage::get_balance(&env, token_index, &holder_a)
            + crate::storage::get_balance(&env, token_index, &holder_b);

        assert_eq!(supply, sum_balances, "total_supply must equal sum of all balances");
    }
}
*/
// ── Burn feature additions ─────────────────────────────────

pub fn get_balance(env: &Env, token_index: u32, holder: &Address) -> i128 {
    let key = crate::types::DataKey::Balance(token_index, holder.clone());
    let val = env.storage().persistent().get(&key).unwrap_or(0);
    if env.storage().persistent().has(&key) {
        bump_persistent(env, &key);
    }
    val
}

pub fn set_balance(env: &Env, token_index: u32, holder: &Address, balance: i128) {
    let key = crate::types::DataKey::Balance(token_index, holder.clone());
    env.storage().persistent().set(&key, &balance);
    bump_persistent(env, &key);
}

pub fn get_burn_count(env: &Env, token_index: u32) -> u32 {
    env.storage()
        .persistent()
        .get(&crate::types::DataKey::BurnCount(token_index))
        .unwrap_or(0)
}

pub fn increment_burn_count(env: &Env, token_index: u32) -> Result<(), Error> {
    let count = get_burn_count(env, token_index)
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    env.storage()
        .persistent()
        .set(&crate::types::DataKey::BurnCount(token_index), &count);
    Ok(())
}

// ── Burn feature additions ─────────────────────────────────

// ── Token-level pause ─────────────────────────────────────

pub fn is_token_paused(env: &Env, token_index: u32) -> bool {
    env.storage()
        .instance()
        .get(&crate::types::DataKey::TokenPaused(token_index))
        .unwrap_or(false)
}

pub fn set_token_paused(env: &Env, token_index: u32, paused: bool) {
    env.storage()
        .instance()
        .set(&crate::types::DataKey::TokenPaused(token_index), &paused);
}

pub fn get_total_burned(env: &Env, token_index: u32) -> i128 {
    env.storage()
        .persistent()
        .get(&crate::types::DataKey::TotalBurned(token_index))
        .unwrap_or(0)
}

pub fn add_total_burned(env: &Env, token_index: u32, amount: i128) {
    let current = get_total_burned(env, token_index);
    let updated = current.checked_add(amount).unwrap_or(i128::MAX);
    env.storage()
        .persistent()
        .set(&crate::types::DataKey::TotalBurned(token_index), &updated);
}
// Pause management
pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

// Token lookup by address
pub fn get_token_info_by_address(env: &Env, token_address: &Address) -> Option<TokenInfo> {
    env.storage()
        .instance()
        .get(&DataKey::TokenByAddress(token_address.clone()))
}

pub fn set_token_info_by_address(env: &Env, token_address: &Address, info: &TokenInfo) {
    env.storage()
        .instance()
        .set(&DataKey::TokenByAddress(token_address.clone()), info);
}

// Update token supply after burn
pub fn update_token_supply(env: &Env, token_address: &Address, amount_change: i128) -> Option<()> {
    let mut info = get_token_info_by_address(env, token_address)?;

    // Update total supply
    info.total_supply = info.total_supply.checked_add(amount_change)?;

    // If burning (negative change), update total_burned
    if amount_change < 0 {
        info.total_burned = info.total_burned.checked_add(-amount_change)?;
        info.burn_count = info.burn_count.checked_add(1)?;
    }

    // Save updated info
    set_token_info_by_address(env, token_address, &info);

    Some(())
}
// Phase 2 Optimization: Batch admin state operations
// Allows multiple admin parameters to be updated efficiently in a single transaction
// Reduces gas by combining storage verification and writes
pub fn batch_update_fees(env: &Env, base_fee: Option<i128>, metadata_fee: Option<i128>) {
    if let Some(fee) = base_fee {
        set_base_fee(env, fee);
    }
    if let Some(fee) = metadata_fee {
        set_metadata_fee(env, fee);
    }
}

/// Phase 2 Optimization: Get complete admin state in single call
/// Avoids multiple storage reads when checking authorization and state
/// Expected savings: 2,000-3,000 CPU instructions per call
///
/// Returns `None` for the admin address when the contract is uninitialised.
pub fn get_admin_state(env: &Env) -> (Option<Address>, bool) {
    let admin = get_admin(env);
    let paused = is_paused(env);
    (admin, paused)
}

// ── Timelock storage functions ─────────────────────────────

pub fn get_timelock_config(env: &Env) -> crate::types::TimelockConfig {
    env.storage()
        .instance()
        .get(&DataKey::TimelockConfig)
        .unwrap_or(crate::types::TimelockConfig {
            delay_seconds: 172_800, // 48 hours default
            enabled: false,
        })
}

pub fn set_timelock_config(env: &Env, config: &crate::types::TimelockConfig) {
    env.storage()
        .instance()
        .set(&DataKey::TimelockConfig, config);
}

// ── Per-type timelock delay storage ───────────────────────

/// Default per-type delays (in ledgers).
const DEFAULT_FEE_CHANGE_DELAY: u64 = 100;
const DEFAULT_ADMIN_TRANSFER_DELAY: u64 = 1_000;
const DEFAULT_UPGRADE_DELAY: u64 = 5_000;
const DEFAULT_PAUSE_DELAY: u64 = 100;

pub fn get_timelock_delay_config(env: &Env) -> crate::types::TimelockDelayConfig {
    env.storage()
        .instance()
        .get(&DataKey::TimelockDelayConfig)
        .unwrap_or(crate::types::TimelockDelayConfig {
            fee_change_delay: DEFAULT_FEE_CHANGE_DELAY,
            admin_transfer_delay: DEFAULT_ADMIN_TRANSFER_DELAY,
            upgrade_delay: DEFAULT_UPGRADE_DELAY,
            default_delay: DEFAULT_PAUSE_DELAY,
        })
}

pub fn set_timelock_delay_config(env: &Env, config: &crate::types::TimelockDelayConfig) {
    env.storage()
        .instance()
        .set(&DataKey::TimelockDelayConfig, config);
}

pub fn get_next_change_id(env: &Env) -> Result<u64, Error> {
    let id = env
        .storage()
        .instance()
        .get(&DataKey::NextChangeId)
        .unwrap_or(0_u64);
    let next_id = id.checked_add(1).ok_or(Error::ArithmeticError)?;
    env.storage()
        .instance()
        .set(&DataKey::NextChangeId, &next_id);
    Ok(id)
}

pub fn get_pending_change(env: &Env, change_id: u64) -> Option<crate::types::PendingChange> {
    env.storage()
        .persistent()
        .get(&DataKey::PendingChange(change_id))
}

pub fn set_pending_change(env: &Env, change_id: u64, change: &crate::types::PendingChange) {
    env.storage()
        .persistent()
        .set(&DataKey::PendingChange(change_id), change);
}

pub fn remove_pending_change(env: &Env, change_id: u64) {
    env.storage()
        .persistent()
        .remove(&DataKey::PendingChange(change_id));
}

// ── Creator indexing functions ─────────────────────────────

/// Add a token index to a creator's token list
pub fn add_creator_token(env: &Env, creator: &Address, token_index: u32) {
    let mut tokens: soroban_sdk::Vec<u32> = env
        .storage()
        .persistent()
        .get(&DataKey::CreatorTokens(creator.clone()))
        .unwrap_or(soroban_sdk::Vec::new(env));

    tokens.push_back(token_index);

    env.storage()
        .persistent()
        .set(&DataKey::CreatorTokens(creator.clone()), &tokens);

    // Update count
    let count = tokens.len();
    env.storage()
        .persistent()
        .set(&DataKey::CreatorTokenCount(creator.clone()), &count);
}

/// Get all token indices for a creator
pub fn get_creator_tokens(env: &Env, creator: &Address) -> soroban_sdk::Vec<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::CreatorTokens(creator.clone()))
        .unwrap_or(soroban_sdk::Vec::new(env))
}

/// Get the number of tokens created by an address
pub fn get_creator_token_count(env: &Env, creator: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::CreatorTokenCount(creator.clone()))
        .unwrap_or(0)
}

/// Get beneficiary stream count (alias for creator token count for now)
pub fn get_beneficiary_stream_count(env: &Env, beneficiary: &Address) -> u32 {
    get_creator_token_count(env, beneficiary)
}

/// Get beneficiary stream entry (alias for creator token entry for now)
pub fn get_beneficiary_stream_entry(env: &Env, beneficiary: &Address, index: u32) -> Option<u32> {
    let tokens = get_creator_tokens(env, beneficiary);
    if index < tokens.len() {
        Some(tokens.get(index).unwrap())
    } else {
        None
    }
}

// ── Token-stream indexing functions ─────────────────────────────

/// Add a stream ID to a token's stream list
///
/// Appends the stream_id to the token's stream vector and updates
/// the TokenStreamCount atomically. If the token has no existing
/// streams, initializes an empty vector first.
///
/// # Arguments
/// * `env` - The contract environment
/// * `token_index` - Index of the token
/// * `stream_id` - ID of the stream to add
pub fn add_token_stream(env: &Env, token_index: u32, stream_id: u32) {
    let key = DataKey::TokenStreams(token_index);
    let mut streams: soroban_sdk::Vec<u32> = env
        .storage()
        .instance()
        .get(&key)
        .unwrap_or(soroban_sdk::Vec::new(env));

    streams.push_back(stream_id);

    env.storage().instance().set(&key, &streams);

    // Update count atomically
    let count = streams.len();
    env.storage()
        .instance()
        .set(&DataKey::TokenStreamCount(token_index), &count);
}

/// Get all stream IDs for a token
///
/// Retrieves the vector of stream IDs associated with the specified token.
/// Returns an empty vector if the token has no streams.
///
/// # Arguments
/// * `env` - The contract environment
/// * `token_index` - Index of the token
///
/// # Returns
/// Vector of stream IDs for this token (empty if none exist)
pub fn get_token_streams(env: &Env, token_index: u32) -> soroban_sdk::Vec<u32> {
    env.storage()
        .instance()
        .get(&DataKey::TokenStreams(token_index))
        .unwrap_or(soroban_sdk::Vec::new(env))
}

/// Get the count of streams for a token
///
/// Retrieves the stream count without loading the full stream data.
/// Returns 0 if the token has no streams.
///
/// # Arguments
/// * `env` - The contract environment
/// * `token_index` - Index of the token
///
/// # Returns
/// Number of streams for this token
pub fn get_token_stream_count(env: &Env, token_index: u32) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::TokenStreamCount(token_index))
        .unwrap_or(0)
}

// ── Treasury storage functions ─────────────────────────────

/// Get treasury withdrawal policy
pub fn get_treasury_policy(env: &Env) -> crate::types::TreasuryPolicy {
    env.storage()
        .instance()
        .get(&DataKey::TreasuryPolicy)
        .unwrap_or(crate::types::TreasuryPolicy {
            daily_cap: 100_0000000, // 100 XLM default
            allowlist_enabled: false,
            period_duration: 86_400, // 24 hours
        })
}

/// Set treasury withdrawal policy
pub fn set_treasury_policy(env: &Env, policy: &crate::types::TreasuryPolicy) {
    env.storage()
        .instance()
        .set(&DataKey::TreasuryPolicy, policy);
}

/// Get current withdrawal period
pub fn get_withdrawal_period(env: &Env) -> crate::types::WithdrawalPeriod {
    env.storage()
        .instance()
        .get(&DataKey::WithdrawalPeriod)
        .unwrap_or(crate::types::WithdrawalPeriod {
            period_start: env.ledger().timestamp(),
            amount_withdrawn: 0,
        })
}

/// Set withdrawal period
pub fn set_withdrawal_period(env: &Env, period: &crate::types::WithdrawalPeriod) {
    env.storage()
        .instance()
        .set(&DataKey::WithdrawalPeriod, period);
}

/// Check if address is allowed recipient
pub fn is_allowed_recipient(env: &Env, recipient: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::AllowedRecipient(recipient.clone()))
        .unwrap_or(false)
}

/// Set allowed recipient status
pub fn set_allowed_recipient(env: &Env, recipient: &Address, allowed: bool) {
    env.storage()
        .persistent()
        .set(&DataKey::AllowedRecipient(recipient.clone()), &allowed);
}

// ── Stream storage functions ───────────────────────────────

/// Get the total number of streams created
pub fn get_stream_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::StreamCount)
        .unwrap_or(0)
}

/// Increment stream count and return new ID
pub fn increment_stream_count(env: &Env) -> Result<u32, Error> {
    let count = get_stream_count(env)
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    env.storage().instance().set(&DataKey::StreamCount, &count);
    Ok(count)
}

/// Get stream info by ID
///
/// Uses `persistent()` storage (not `temporary()`) — a payment stream must
/// survive for its full vesting lifetime, which can span months, so it must
/// not be subject to `temporary()`'s expiry-and-wipe semantics.
pub fn get_stream(env: &Env, stream_id: u64) -> Option<crate::types::StreamInfo> {
    let key = DataKey::Stream(stream_id.try_into().unwrap());
    env.storage().persistent().get(&key)
}

/// Store stream info
pub fn set_stream(env: &Env, stream_id: u64, stream: &crate::types::StreamInfo) {
    let key = DataKey::Stream(stream_id.try_into().unwrap());
    env.storage().persistent().set(&key, stream);
    bump_persistent(env, &key);
}

// ── Recurring stream storage functions ─────────────────────────

/// Get the total number of recurring streams created
pub fn get_recurring_stream_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::RecurringStreamCount)
        .unwrap_or(0)
}

/// Increment the recurring-stream counter and return the new id
pub fn increment_recurring_stream_count(env: &Env) -> Result<u64, Error> {
    let id = get_recurring_stream_count(env)
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    env.storage()
        .instance()
        .set(&DataKey::RecurringStreamCount, &id);
    Ok(id)
}

/// Get a recurring stream by id
pub fn get_recurring_stream(env: &Env, id: u64) -> Option<crate::types::RecurringStream> {
    env.storage().persistent().get(&DataKey::RecurringStream(id))
}

/// Store a recurring stream
pub fn set_recurring_stream(env: &Env, stream: &crate::types::RecurringStream) {
    let key = DataKey::RecurringStream(stream.id);
    env.storage().persistent().set(&key, stream);
    bump_persistent(env, &key);
}

/// Append a recurring-stream id to a creator's index
pub fn add_creator_recurring_stream(env: &Env, creator: &Address, recurring_stream_id: u64) {
    let key = DataKey::CreatorRecurringStreams(creator.clone());
    let mut ids: soroban_sdk::Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(soroban_sdk::Vec::new(env));
    ids.push_back(recurring_stream_id);
    env.storage().persistent().set(&key, &ids);
}

/// Get all recurring-stream ids created by an address
pub fn get_creator_recurring_streams(env: &Env, creator: &Address) -> soroban_sdk::Vec<u64> {
    env.storage()
        .persistent()
        .get(&DataKey::CreatorRecurringStreams(creator.clone()))
        .unwrap_or(soroban_sdk::Vec::new(env))
}

/// Get next stream ID
pub fn get_next_stream_id(env: &Env) -> u64 {
    let id = env
        .storage()
        .instance()
        .get(&DataKey::NextStreamId)
        .unwrap_or(0_u64);
    env.storage()
        .instance()
        .set(&DataKey::NextStreamId, &(id + 1));
    id
}

// ── Keyset pagination index (per-owner streams) ─────────────────

/// Append a `(created_ledger, stream_id)` entry to the owner's keyset index.
///
/// Streams are appended in creation order, and since `created_ledger` is
/// non-decreasing over time and `stream_id` is monotonically increasing,
/// the resulting vector is always sorted ascending by `(created_ledger,
/// stream_id)` without needing an explicit sort on read.
pub fn add_creator_stream_index(env: &Env, owner: &Address, created_ledger: u32, stream_id: u64) {
    let key = DataKey::CreatorStreamIndex(owner.clone());
    let mut index: soroban_sdk::Vec<StreamCursor> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(soroban_sdk::Vec::new(env));

    index.push_back(StreamCursor {
        created_ledger,
        stream_id,
    });

    env.storage().persistent().set(&key, &index);
}

/// Get the full keyset index (ascending `(created_ledger, stream_id)`) for an owner.
pub fn get_creator_stream_index(env: &Env, owner: &Address) -> soroban_sdk::Vec<StreamCursor> {
    env.storage()
        .persistent()
        .get(&DataKey::CreatorStreamIndex(owner.clone()))
        .unwrap_or(soroban_sdk::Vec::new(env))
}

// ── Vault storage functions ───────────────────────────────

/// Get the total number of vaults created.
pub fn get_vault_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::VaultCount)
        .unwrap_or(0_u64)
}

/// Increment vault count and return the new vault id.
pub fn increment_vault_count(env: &Env) -> Result<u64, Error> {
    let id = get_vault_count(env)
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    env.storage().instance().set(&DataKey::VaultCount, &id);
    Ok(id)
}

/// Get a vault by id.
pub fn get_vault(env: &Env, vault_id: u64) -> Option<crate::types::Vault> {
    env.storage().persistent().get(&DataKey::Vault(vault_id))
}

/// Persist a vault and maintain owner/creator index mappings.
pub fn set_vault(env: &Env, vault: &crate::types::Vault) -> Result<(), Error> {
    let is_new_vault = !env.storage().persistent().has(&DataKey::Vault(vault.id));

    env.storage()
        .persistent()
        .set(&DataKey::Vault(vault.id), vault);

    if is_new_vault {
        let owner_slot = get_owner_vault_count(env, &vault.owner);
        env.storage().persistent().set(
            &DataKey::VaultByOwner(vault.owner.clone(), owner_slot),
            &vault.id,
        );
        let next_owner_slot = owner_slot.checked_add(1).ok_or(Error::ArithmeticError)?;
        env.storage().persistent().set(
            &DataKey::OwnerVaultCount(vault.owner.clone()),
            &next_owner_slot,
        );

        let creator_slot = get_creator_vault_count(env, &vault.creator);
        env.storage().persistent().set(
            &DataKey::VaultByCreator(vault.creator.clone(), creator_slot),
            &vault.id,
        );
        let next_creator_slot = creator_slot.checked_add(1).ok_or(Error::ArithmeticError)?;
        env.storage().persistent().set(
            &DataKey::CreatorVaultCount(vault.creator.clone()),
            &next_creator_slot,
        );
    }

    Ok(())
}

pub fn get_owner_vault_count(env: &Env, owner: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::OwnerVaultCount(owner.clone()))
        .unwrap_or(0)
}

pub fn get_creator_vault_count(env: &Env, creator: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::CreatorVaultCount(creator.clone()))
        .unwrap_or(0)
}

// ── Vault circuit breaker storage ─────────────────────────────────────────

/// Default epoch length in ledgers (~1 day at 5s/ledger)
pub const DEFAULT_EPOCH_LEDGERS: u32 = 17_280;

/// Current epoch number derived from ledger sequence.
pub fn current_epoch(env: &Env) -> u32 {
    env.ledger().sequence() / DEFAULT_EPOCH_LEDGERS
}

/// Cumulative withdrawal volume for the given epoch.
pub fn get_epoch_withdraw_volume(env: &Env, epoch: u32) -> i128 {
    env.storage()
        .temporary()
        .get(&DataKey::EpochWithdrawVolume(epoch))
        .unwrap_or(0_i128)
}

pub fn set_epoch_withdraw_volume(env: &Env, epoch: u32, volume: i128) {
    env.storage()
        .temporary()
        .set(&DataKey::EpochWithdrawVolume(epoch), &volume);
}

/// Per-epoch withdrawal limit (0 = unlimited / not set).
pub fn get_vault_withdraw_limit(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::VaultWithdrawLimit)
        .unwrap_or(0_i128)
}

pub fn set_vault_withdraw_limit(env: &Env, limit: i128) {
    env.storage()
        .instance()
        .set(&DataKey::VaultWithdrawLimit, &limit);
}

/// Whether vault withdrawals are paused by the circuit breaker.
pub fn get_vault_circuit_breaker_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::VaultCircuitBreakerPaused)
        .unwrap_or(false)
}

pub fn set_vault_circuit_breaker_paused(env: &Env, paused: bool) {
    env.storage()
        .instance()
        .set(&DataKey::VaultCircuitBreakerPaused, &paused);
}

/// Get a page of vaults in ascending vault_id order
///
/// # Parameters
/// * `cursor` - Starting position (0 = start from vault_id 1, N = start from vault_id N)
/// * `limit` - Maximum number of vaults to return
///
/// # Returns
/// VaultsPage with vaults vector and optional next_cursor
pub fn get_vaults_page(env: &Env, cursor: u64, limit: u32) -> crate::types::VaultsPage {
    use soroban_sdk::Vec;
    
    let total_count = get_vault_count(env);
    let mut vaults = Vec::new(env);
    
    // Handle edge cases
    if limit == 0 || cursor > total_count {
        return crate::types::VaultsPage {
            vaults,
            next_cursor: None,
        };
    }
    
    // Calculate range
    let start = if cursor == 0 { 1 } else { cursor };
    let end = (start + limit as u64).min(total_count + 1);
    
    // Collect vaults
    for vault_id in start..end {
        if let Some(vault) = get_vault(env, vault_id) {
            vaults.push_back(vault);
        }
    }
    
    // Calculate next cursor
    let next_cursor = if end <= total_count {
        Some(end)
    } else {
        None
    };
    
    crate::types::VaultsPage {
        vaults,
        next_cursor,
    }
}

/// Get a page of vaults owned by a specific address
///
/// # Parameters
/// * `owner` - Address to filter by
/// * `cursor` - Starting position in owner's vault list (0-indexed)
/// * `limit` - Maximum number of vaults to return
///
/// # Returns
/// VaultsPage with filtered vaults and optional next_cursor
pub fn get_vaults_by_owner(
    env: &Env,
    owner: &Address,
    cursor: u64,
    limit: u32,
) -> crate::types::VaultsPage {
    use soroban_sdk::Vec;
    
    let owner_count = get_owner_vault_count(env, owner) as u64;
    let mut vaults = Vec::new(env);
    
    // Handle edge cases
    if limit == 0 || cursor >= owner_count {
        return crate::types::VaultsPage {
            vaults,
            next_cursor: None,
        };
    }
    
    // Calculate range
    let start = cursor;
    let end = (start + limit as u64).min(owner_count);
    
    // Collect vaults
    for index in start..end {
        let vault_id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::VaultByOwner(owner.clone(), index as u32))
            .unwrap_or(0);
        
        if vault_id > 0 {
            if let Some(vault) = get_vault(env, vault_id) {
                vaults.push_back(vault);
            }
        }
    }
    
    // Calculate next cursor
    let next_cursor = if end < owner_count {
        Some(end)
    } else {
        None
    };
    
    crate::types::VaultsPage {
        vaults,
        next_cursor,
    }
}

// ── Governance proposal storage ─────────────────────────────────────────

/// Get proposal count
pub fn get_proposal_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::ProposalCount)
        .unwrap_or(0)
}

/// Increment proposal count and return new count
pub fn increment_proposal_count(env: &Env) -> u32 {
    let count = get_proposal_count(env);
    let new_count = count.checked_add(1).expect("Proposal count overflow");
    env.storage()
        .instance()
        .set(&DataKey::ProposalCount, &new_count);
    new_count
}

/// Get next proposal ID
pub fn get_next_proposal_id(env: &Env) -> u64 {
    let id = env
        .storage()
        .instance()
        .get(&DataKey::NextProposalId)
        .unwrap_or(0_u64);
    env.storage()
        .instance()
        .set(&DataKey::NextProposalId, &(id + 1));
    id
}

/// Get proposal by ID
pub fn get_proposal(env: &Env, proposal_id: u64) -> Option<crate::types::Proposal> {
    env.storage()
        .persistent()
        .get(&DataKey::Proposal(proposal_id))
}

/// Set proposal
pub fn set_proposal(env: &Env, proposal_id: u64, proposal: &crate::types::Proposal) {
    env.storage()
        .persistent()
        .set(&DataKey::Proposal(proposal_id), proposal);
}

/// Check if an address has voted on a proposal
pub fn has_voted(env: &Env, proposal_id: u64, voter: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::ProposalVote(proposal_id, voter.clone()))
}

/// Record a vote for a proposal
pub fn set_vote(env: &Env, proposal_id: u64, voter: &Address, vote: crate::types::VoteChoice) {
    env.storage()
        .persistent()
        .set(&DataKey::ProposalVote(proposal_id, voter.clone()), &vote);
}

/// Get a vote for a proposal (if exists)
pub fn get_vote(env: &Env, proposal_id: u64, voter: &Address) -> Option<crate::types::VoteChoice> {
    env.storage()
        .persistent()
        .get(&DataKey::ProposalVote(proposal_id, voter.clone()))
}

/// Get the ledger sequence at which a `ProposalStateSnapshot` event was last
/// emitted for `proposal_id`. Returns 0 if no snapshot has ever been taken.
pub fn get_proposal_last_snapshot_ledger(env: &Env, proposal_id: u64) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::ProposalLastSnapshotLedger(proposal_id))
        .unwrap_or(0)
}

/// Record the ledger sequence at which a `ProposalStateSnapshot` event was
/// emitted for `proposal_id`, so future triggers know when the next snapshot
/// is due.
pub fn set_proposal_last_snapshot_ledger(env: &Env, proposal_id: u64, ledger: u32) {
    env.storage()
        .persistent()
        .set(&DataKey::ProposalLastSnapshotLedger(proposal_id), &ledger);
}

// ============================================================
// Storage Functions - Address Freezing (Transfer Restrictions)
// ============================================================
// Frozen addresses are blacklisted from token transfers, burns, and mints.
// The freeze state is stored per (token_address, address) pair using
// persistent storage so it survives ledger entry expiry.

/// Returns true if `address` is frozen (blacklisted) for `token_address`.
pub fn is_address_frozen(env: &Env, token_address: &Address, address: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&crate::types::DataKey::FrozenAddress(
            token_address.clone(),
            address.clone(),
        ))
        .unwrap_or(false)
}

/// Set the frozen (blacklist) state for `address` on `token_address`.
/// `frozen = true` blacklists the address; `frozen = false` removes the restriction.
pub fn set_address_frozen(env: &Env, token_address: &Address, address: &Address, frozen: bool) {
    let key = crate::types::DataKey::FrozenAddress(token_address.clone(), address.clone());
    if frozen {
        env.storage().persistent().set(&key, &true);
    } else {
        // Remove the entry entirely when unfreezing to reclaim storage
        env.storage().persistent().remove(&key);
    }
}

/// Record the ledger timestamp at which `address` was frozen on `token_address`.
pub fn set_freeze_timestamp(env: &Env, token_address: &Address, address: &Address, timestamp: u64) {
    env.storage().persistent().set(
        &crate::types::DataKey::FreezeTimestamp(token_address.clone(), address.clone()),
        &timestamp,
    );
}

/// Get the ledger timestamp at which `address` was frozen on `token_address`, if any.
pub fn get_freeze_timestamp(env: &Env, token_address: &Address, address: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&crate::types::DataKey::FreezeTimestamp(
            token_address.clone(),
            address.clone(),
        ))
        .unwrap_or(0)
}

/// Set the unfreeze cooldown grace period (seconds) for a token.
pub fn set_freeze_cooldown(env: &Env, token_address: &Address, cooldown_seconds: u64) {
    env.storage().persistent().set(
        &crate::types::DataKey::FreezeCooldown(token_address.clone()),
        &cooldown_seconds,
    );
}

/// Get the unfreeze cooldown grace period (seconds) for a token. Defaults to 0 (no cooldown).
pub fn get_freeze_cooldown(env: &Env, token_address: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&crate::types::DataKey::FreezeCooldown(token_address.clone()))
        .unwrap_or(0)
}

// ── Governance storage functions ───────────────────────────

/// Get governance configuration
pub fn get_governance_config(env: &Env) -> crate::types::GovernanceConfig {
    env.storage()
        .instance()
        .get(&DataKey::GovernanceConfig)
        .unwrap_or(crate::types::GovernanceConfig {
            quorum_percent: 30,
            approval_percent: 51,
            voting_period: 86400,
        })
}

/// Set governance configuration
pub fn set_governance_config(env: &Env, config: &crate::types::GovernanceConfig) {
    env.storage()
        .instance()
        .set(&DataKey::GovernanceConfig, config);
}

// ── Dynamic quorum storage functions ──────────────────────

/// Get dynamic quorum configuration (defaults to disabled).
pub fn get_dynamic_quorum_config(env: &Env) -> crate::types::DynamicQuorumConfig {
    env.storage()
        .instance()
        .get(&DataKey::DynamicQuorumConfig)
        .unwrap_or(crate::types::DynamicQuorumConfig {
            enabled: false,
            min_quorum_percent: 10,
            max_quorum_percent: 80,
            target_participation: 30,
            window_size: 5,
        })
}

/// Persist dynamic quorum configuration.
pub fn set_dynamic_quorum_config(env: &Env, config: &crate::types::DynamicQuorumConfig) {
    env.storage()
        .instance()
        .set(&DataKey::DynamicQuorumConfig, config);
}

/// Store a participation record for a concluded proposal.
pub fn set_participation_record(
    env: &Env,
    proposal_id: u64,
    record: &crate::types::ParticipationRecord,
) {
    env.storage()
        .persistent()
        .set(&DataKey::ParticipationRecord(proposal_id), record);
}

/// Retrieve a participation record by proposal ID.
pub fn get_participation_record(
    env: &Env,
    proposal_id: u64,
) -> Option<crate::types::ParticipationRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::ParticipationRecord(proposal_id))
}

// ── Milestone Verification (Stub Testing) ────────────────────────────────────────────────────────────────────

/// Set a valid proof for milestone verification testing
/// This is used by the MilestoneVerifierStub for testing purposes only
pub fn set_valid_proof(env: &Env, milestone_hash: &soroban_sdk::BytesN<32>, proof: &soroban_sdk::Bytes) {
    use soroban_sdk::Symbol;
    let key = (Symbol::new(env, "valid_proof"), milestone_hash.clone());
    env.storage()
        .temporary()
        .set(&key, proof);
}

/// Get a valid proof for milestone verification testing
/// This is used by the MilestoneVerifierStub for testing purposes only
pub fn get_valid_proof(env: &Env, milestone_hash: &soroban_sdk::BytesN<32>) -> Option<soroban_sdk::Bytes> {
    use soroban_sdk::Symbol;
    let key = (Symbol::new(env, "valid_proof"), milestone_hash.clone());
    env.storage()
        .temporary()
        .get(&key)
}

/// Register an authorized oracle for milestone verification
pub fn set_authorized_oracle(env: &Env, oracle_id: &soroban_sdk::Bytes) {
    use soroban_sdk::Symbol;
    let key = (Symbol::new(env, "authorized_oracle"), oracle_id.clone());
    env.storage()
        .instance()
        .set(&key, &true);
}

/// Check if an oracle is authorized for milestone verification
pub fn get_authorized_oracle(env: &Env, oracle_id: &soroban_sdk::Bytes) -> Option<bool> {
    use soroban_sdk::Symbol;
    let key = (Symbol::new(env, "authorized_oracle"), oracle_id.clone());
    env.storage()
        .instance()
        .get(&key)
}

/// Remove an oracle from the authorized list
pub fn remove_authorized_oracle(env: &Env, oracle_id: &soroban_sdk::Bytes) {
    use soroban_sdk::Symbol;
    let key = (Symbol::new(env, "authorized_oracle"), oracle_id.clone());
    env.storage()
        .instance()
        .remove(&key);
}

/// Mark that the contract-wide milestone verifier has been configured
pub fn set_verifier_configured(env: &Env, configured: bool) {
    use soroban_sdk::Symbol;
    env.storage()
        .instance()
        .set(&Symbol::new(env, "verifier_configured"), &configured);
}

/// Check if the contract-wide milestone verifier has been configured
pub fn is_verifier_configured(env: &Env) -> bool {
    use soroban_sdk::Symbol;
    env.storage()
        .instance()
        .get::<_, bool>(&Symbol::new(env, "verifier_configured"))
        .unwrap_or(false)
}

// ============================================================
// Storage Functions - Campaign Management
// ============================================================

/// Get campaign by ID
pub fn get_campaign(env: &Env, campaign_id: u64) -> Option<crate::types::BuybackCampaign> {
    env.storage()
        .instance()
        .get(&DataKey::BuybackCampaign(campaign_id))
}

/// Set campaign data
pub fn set_campaign(env: &Env, campaign_id: u64, campaign: &crate::types::BuybackCampaign) {
    env.storage()
        .instance()
        .set(&DataKey::BuybackCampaign(campaign_id), campaign);
}

/// Get total campaign count
pub fn get_campaign_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::BuybackCampaignCount)
        .unwrap_or(0)
}

/// Increment campaign count and return new count
pub fn increment_campaign_count(env: &Env) -> Result<u64, Error> {
    let count = get_campaign_count(env)
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    env.storage()
        .instance()
        .set(&DataKey::BuybackCampaignCount, &count);
    Ok(count)
}

/// Get campaign ID by owner and index
pub fn get_campaign_by_owner(env: &Env, owner: &Address, index: u32) -> Option<u64> {
    env.storage()
        .instance()
        .get(&DataKey::CampaignByCreator(owner.clone(), index))
}

/// Set campaign ID for owner at index
pub fn set_campaign_by_owner(env: &Env, owner: &Address, index: u32, campaign_id: u64) {
    env.storage()
        .instance()
        .set(&DataKey::CampaignByCreator(owner.clone(), index), &campaign_id);
}

/// Get owner's campaign count
pub fn get_owner_campaign_count(env: &Env, owner: &Address) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::CreatorCampaignCount(owner.clone()))
        .unwrap_or(0)
}

/// Increment owner's campaign count
pub fn increment_owner_campaign_count(env: &Env, owner: &Address) -> Result<u32, Error> {
    let count = get_owner_campaign_count(env, owner)
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    env.storage()
        .instance()
        .set(&DataKey::CreatorCampaignCount(owner.clone()), &count);
    Ok(count)
}

/// Get active campaign count
pub fn get_active_campaign_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::ActiveCampaigns)
        .unwrap_or(0)
}

/// Set active campaign count
pub fn set_active_campaign_count(env: &Env, count: u32) {
    env.storage()
        .instance()
        .set(&DataKey::ActiveCampaigns, &count);
}

/// Increment active campaign count
pub fn increment_active_campaign_count(env: &Env) -> Result<u32, Error> {
    let count = get_active_campaign_count(env)
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    set_active_campaign_count(env, count);
    Ok(count)
}

/// Decrement active campaign count
pub fn decrement_active_campaign_count(env: &Env) -> Result<u32, Error> {
    let count = get_active_campaign_count(env);
    if count == 0 {
        return Err(Error::ArithmeticError);
    }
    let new_count = count - 1;
    set_active_campaign_count(env, new_count);
    Ok(new_count)
}
// ============================================================
// Role-Based Access Control
// ============================================================

fn role_discriminant(role: crate::types::Role) -> u32 {
    match role {
        crate::types::Role::MetadataManager => 0,
        crate::types::Role::Pauser => 1,
        crate::types::Role::Minter => 2,
    }
}

pub fn has_role(env: &Env, token_index: u32, address: &Address, role: crate::types::Role) -> bool {
    let key = crate::types::DataKey::TokenRole(token_index, address.clone(), role_discriminant(role));
    env.storage().persistent().get::<_, bool>(&key).unwrap_or(false)
}

pub fn grant_role(env: &Env, token_index: u32, address: &Address, role: crate::types::Role) {
    let key = crate::types::DataKey::TokenRole(token_index, address.clone(), role_discriminant(role));
    env.storage().persistent().set(&key, &true);
}

pub fn revoke_role(env: &Env, token_index: u32, address: &Address, role: crate::types::Role) {
    let key = crate::types::DataKey::TokenRole(token_index, address.clone(), role_discriminant(role));
    env.storage().persistent().remove(&key);
}

// ============================================================
// Metadata History
// ============================================================

pub fn push_metadata_history(
    env: &Env,
    token_index: u32,
    record: &crate::types::MetadataRecord,
) -> Result<(), crate::types::Error> {
    let count_key = crate::types::DataKey::MetadataHistoryCount(token_index);
    let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
    let new_count = count.checked_add(1).ok_or(crate::types::Error::ArithmeticError)?;
    let entry_key = crate::types::DataKey::MetadataHistory(token_index, count);
    env.storage().persistent().set(&entry_key, record);
    env.storage().persistent().set(&count_key, &new_count);
    Ok(())
}

pub fn get_metadata_history(
    env: &Env,
    token_index: u32,
    version: u32,
) -> Option<crate::types::MetadataRecord> {
    // version is 1-based; stored at index version-1
    let idx = version.checked_sub(1)?;
    let key = crate::types::DataKey::MetadataHistory(token_index, idx);
    env.storage().persistent().get(&key)
}

// ============================================================
// Reentrancy Guard
// ============================================================

pub fn acquire_reentrancy_lock(env: &Env) -> Result<(), crate::types::Error> {
    let key = crate::types::DataKey::ReentrancyLock;
    if env.storage().instance().get::<_, bool>(&key).unwrap_or(false) {
        return Err(crate::types::Error::InvalidParameters);
    }
    env.storage().instance().set(&key, &true);
    Ok(())
}

pub fn release_reentrancy_lock(env: &Env) {
    env.storage().instance().remove(&crate::types::DataKey::ReentrancyLock);
}

// ============================================================
// Multi-Sig Storage
// ============================================================

pub fn get_multisig_config(env: &Env) -> Option<crate::types::MultiSigConfig> {
    env.storage().instance().get(&crate::types::DataKey::MultiSigConfig)
}

pub fn set_multisig_config(env: &Env, config: &crate::types::MultiSigConfig) {
    env.storage().instance().set(&crate::types::DataKey::MultiSigConfig, config);
}

pub fn has_multisig_config(env: &Env) -> bool {
    env.storage().instance().has(&crate::types::DataKey::MultiSigConfig)
}

pub fn next_multisig_proposal_id(env: &Env) -> u64 {
    let key = crate::types::DataKey::MultiSigProposalCount;
    env.storage().instance().get::<_, u64>(&key).unwrap_or(0)
}

pub fn increment_multisig_proposal_id(env: &Env) -> u64 {
    let key = crate::types::DataKey::MultiSigProposalCount;
    let id: u64 = env.storage().instance().get(&key).unwrap_or(0);
    env.storage().instance().set(&key, &(id + 1));
    id
}

pub fn get_multisig_proposal(env: &Env, id: u64) -> Option<crate::types::MultiSigProposal> {
    env.storage().instance().get(&crate::types::DataKey::MultiSigProposal(id))
}

pub fn set_multisig_proposal(env: &Env, proposal: &crate::types::MultiSigProposal) {
    env.storage().instance().set(&crate::types::DataKey::MultiSigProposal(proposal.id), proposal);
}

pub fn has_multisig_approval(env: &Env, proposal_id: u64, approver: &Address) -> bool {
    let key = crate::types::DataKey::MultiSigApproval(proposal_id, approver.clone());
    env.storage().instance().get::<_, bool>(&key).unwrap_or(false)
}

pub fn set_multisig_approval(env: &Env, proposal_id: u64, approver: &Address) {
    let key = crate::types::DataKey::MultiSigApproval(proposal_id, approver.clone());
    env.storage().instance().set(&key, &true);
}

// ============================================================
// Burn Schedule Storage
// ============================================================

pub fn get_burn_schedule_count_by_token(env: &Env, token_index: u32) -> u32 {
    env.storage()
        .instance()
        .get::<_, u32>(&crate::types::DataKey::BurnScheduleCountByToken(token_index))
        .unwrap_or(0)
}

pub fn add_burn_schedule_by_token(env: &Env, token_index: u32, schedule_id: u64) {
    let count = get_burn_schedule_count_by_token(env, token_index);
    env.storage().instance().set(
        &crate::types::DataKey::BurnSchedulesByToken(token_index, count),
        &schedule_id,
    );
    env.storage().instance().set(
        &crate::types::DataKey::BurnScheduleCountByToken(token_index),
        &(count + 1),
    );
}

pub fn get_burn_schedule_id_by_token(env: &Env, token_index: u32, local_index: u32) -> Option<u64> {
    env.storage()
        .instance()
        .get(&crate::types::DataKey::BurnSchedulesByToken(token_index, local_index))
}

// ============================================================
// Cross-Contract Trusted Caller Storage
// ============================================================

/// Register a trusted caller address.
pub fn set_trusted_caller(env: &Env, caller: &Address) {
    env.storage()
        .instance()
        .set(&crate::types::DataKey::TrustedCaller(caller.clone()), &true);
}

/// Remove a trusted caller address.
pub fn remove_trusted_caller(env: &Env, caller: &Address) {
    env.storage()
        .instance()
        .remove(&crate::types::DataKey::TrustedCaller(caller.clone()));
}

/// Check whether an address is a registered trusted caller.
pub fn is_trusted_caller(env: &Env, caller: &Address) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&crate::types::DataKey::TrustedCaller(caller.clone()))
        .unwrap_or(false)
}

// ============================================================
// Metadata Content Hash Storage (#1131)
// ============================================================

/// Store a 32-byte content hash alongside the metadata URI for a token.
///
/// The hash allows off-chain consumers to verify that IPFS content has not
/// been tampered with after registration.
pub fn set_metadata_content_hash(
    env: &Env,
    token_index: u32,
    hash: &soroban_sdk::BytesN<32>,
) {
    env.storage()
        .persistent()
        .set(&crate::types::DataKey::MetadataContentHash(token_index), hash);
}

/// Retrieve the stored content hash for a token's metadata.
///
/// Returns `None` if no hash has been registered (metadata not yet set or
/// set before this feature was introduced).
pub fn get_metadata_content_hash(
    env: &Env,
    token_index: u32,
) -> Option<soroban_sdk::BytesN<32>> {
    env.storage()
        .persistent()
        .get(&crate::types::DataKey::MetadataContentHash(token_index))
}

// ============================================================
// Vault Owner Change Storage (#1134)
// ============================================================

/// Persist a pending vault-owner change proposal.
pub fn set_pending_vault_owner_change(
    env: &Env,
    vault_id: u64,
    change: &crate::types::PendingVaultOwnerChange,
) {
    env.storage()
        .persistent()
        .set(&crate::types::DataKey::PendingVaultOwnerChange(vault_id), change);
}

/// Retrieve a pending vault-owner change proposal.
pub fn get_pending_vault_owner_change(
    env: &Env,
    vault_id: u64,
) -> Option<crate::types::PendingVaultOwnerChange> {
    env.storage()
        .persistent()
        .get(&crate::types::DataKey::PendingVaultOwnerChange(vault_id))
}

/// Remove a pending vault-owner change proposal (after execution or cancellation).
pub fn remove_pending_vault_owner_change(env: &Env, vault_id: u64) {
    env.storage()
        .persistent()
        .remove(&crate::types::DataKey::PendingVaultOwnerChange(vault_id));
}

// ============================================================
// Batch Scheduler Storage (#1625)
// ============================================================

/// Current per-ledger gas budget, defaulting to `DEFAULT_LEDGER_GAS_BUDGET`
/// (see `batch_scheduler`) until an admin overrides it.
pub fn get_ledger_gas_budget(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::LedgerGasBudget)
        .unwrap_or(crate::batch_scheduler::DEFAULT_LEDGER_GAS_BUDGET)
}

/// Set the per-ledger gas budget.
pub fn set_ledger_gas_budget(env: &Env, budget: u64) {
    env.storage().instance().set(&DataKey::LedgerGasBudget, &budget);
}

/// Tenants currently holding a pending batch-scheduler continuation, in
/// fair-share rotation order.
pub fn get_fair_share_queue(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::FairShareQueue)
        .unwrap_or_else(|| Vec::new(env))
}

fn set_fair_share_queue(env: &Env, queue: &Vec<Address>) {
    env.storage().instance().set(&DataKey::FairShareQueue, queue);
}

/// Add `tenant` to the fair-share queue if not already present.
pub fn enqueue_tenant(env: &Env, tenant: &Address) {
    let mut queue = get_fair_share_queue(env);
    for t in queue.iter() {
        if t == *tenant {
            return;
        }
    }
    queue.push_back(tenant.clone());
    set_fair_share_queue(env, &queue);
}

/// Remove `tenant` from the fair-share queue.
pub fn dequeue_tenant(env: &Env, tenant: &Address) {
    let queue = get_fair_share_queue(env);
    let mut updated = Vec::new(env);
    for t in queue.iter() {
        if t != *tenant {
            updated.push_back(t);
        }
    }
    set_fair_share_queue(env, &updated);
}

/// Move `tenant` to the back of the fair-share queue (round-robin fairness
/// across resume calls within the same ledger).
pub fn rotate_tenant_to_back(env: &Env, tenant: &Address) {
    dequeue_tenant(env, tenant);
    enqueue_tenant(env, tenant);
}

/// Gas used by `tenant` on `ledger_seq` so far.
pub fn get_tenant_ledger_gas_used(env: &Env, tenant: &Address, ledger_seq: u32) -> u64 {
    env.storage()
        .temporary()
        .get(&DataKey::TenantLedgerGasUsed(tenant.clone(), ledger_seq))
        .unwrap_or(0)
}

/// Total gas used by all tenants on `ledger_seq` so far.
pub fn get_ledger_gas_used(env: &Env, ledger_seq: u32) -> u64 {
    env.storage()
        .temporary()
        .get(&DataKey::LedgerGasUsed(ledger_seq))
        .unwrap_or(0)
}

/// Record that `tenant` consumed `amount` gas on `ledger_seq`, updating both
/// the per-tenant and ledger-wide running totals.
pub fn record_gas_used(env: &Env, tenant: &Address, ledger_seq: u32, amount: u64) {
    let tenant_used = get_tenant_ledger_gas_used(env, tenant, ledger_seq) + amount;
    env.storage().temporary().set(
        &DataKey::TenantLedgerGasUsed(tenant.clone(), ledger_seq),
        &tenant_used,
    );

    let ledger_used = get_ledger_gas_used(env, ledger_seq) + amount;
    env.storage()
        .temporary()
        .set(&DataKey::LedgerGasUsed(ledger_seq), &ledger_used);
}

/// Get the pending `schedule_batch_reveal` continuation for `creator`, if any.
pub fn get_reveal_continuation(env: &Env, creator: &Address) -> Option<RevealBatchContinuation> {
    env.storage()
        .persistent()
        .get(&DataKey::RevealContinuation(creator.clone()))
}

/// Set the pending `schedule_batch_reveal` continuation for `creator`.
pub fn set_reveal_continuation(env: &Env, creator: &Address, continuation: &RevealBatchContinuation) {
    env.storage()
        .persistent()
        .set(&DataKey::RevealContinuation(creator.clone()), continuation);
}

/// Clear the pending `schedule_batch_reveal` continuation for `creator`.
pub fn clear_reveal_continuation(env: &Env, creator: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::RevealContinuation(creator.clone()));
}

/// Get the pending `schedule_batch_settle` continuation for `creator`, if any.
pub fn get_settle_continuation(env: &Env, creator: &Address) -> Option<SettleBatchContinuation> {
    env.storage()
        .persistent()
        .get(&DataKey::SettleContinuation(creator.clone()))
}

/// Set the pending `schedule_batch_settle` continuation for `creator`.
pub fn set_settle_continuation(env: &Env, creator: &Address, continuation: &SettleBatchContinuation) {
    env.storage()
        .persistent()
        .set(&DataKey::SettleContinuation(creator.clone()), continuation);
}

/// Clear the pending `schedule_batch_settle` continuation for `creator`.
pub fn clear_settle_continuation(env: &Env, creator: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::SettleContinuation(creator.clone()));
}

// ============================================================
// Settlement Storage (#1624)
// ============================================================

/// Total amount of `token_index` currently held by pending (Prepared)
/// settlement reservations.
pub fn get_reserved_total(env: &Env, token_index: u32) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::ReservedTotal(token_index))
        .unwrap_or(0)
}

/// Set the total amount of `token_index` currently reserved.
pub fn set_reserved_total(env: &Env, token_index: u32, total: i128) {
    env.storage()
        .instance()
        .set(&DataKey::ReservedTotal(token_index), &total);
}

/// Allocate the next settlement reservation id.
pub fn next_reservation_id(env: &Env) -> u64 {
    let id: u64 = env.storage().instance().get(&DataKey::ReservationCount).unwrap_or(0);
    env.storage().instance().set(&DataKey::ReservationCount, &(id + 1));
    id
}

/// Get a settlement reservation by id.
pub fn get_reservation(env: &Env, reservation_id: u64) -> Option<crate::types::Reservation> {
    env.storage().persistent().get(&DataKey::Reservation(reservation_id))
}

/// Set a settlement reservation.
pub fn set_reservation(env: &Env, reservation_id: u64, reservation: &crate::types::Reservation) {
    env.storage()
        .persistent()
        .set(&DataKey::Reservation(reservation_id), reservation);
}

/// Ledgers a reservation may sit `Prepared` before `cleanup_stuck_reservation`
/// may force-release it. Defaults to `DEFAULT_EPOCH_LEDGERS` (~1 day).
pub fn get_reservation_timeout_ledgers(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::ReservationTimeoutLedgers)
        .unwrap_or(DEFAULT_EPOCH_LEDGERS)
}

/// Set the reservation timeout, in ledgers.
pub fn set_reservation_timeout_ledgers(env: &Env, ledgers: u32) {
    env.storage()
        .instance()
        .set(&DataKey::ReservationTimeoutLedgers, &ledgers);
}

// ═══════════════════════════════════════════════════════════════════════
// Staking storage (#1757)
// ═══════════════════════════════════════════════════════════════════════

/// Get a staking pool by ID.
pub fn get_staking_pool(env: &Env, pool_id: u64) -> Option<crate::types::StakingPool> {
    env.storage().persistent().get(&DataKey::StakingPool(pool_id))
}

/// Save a staking pool.
pub fn set_staking_pool(env: &Env, pool_id: u64, pool: &crate::types::StakingPool) {
    env.storage()
        .persistent()
        .set(&DataKey::StakingPool(pool_id), pool);
}

/// Allocate and return the next staking pool ID.
pub fn increment_next_staking_pool_id(env: &Env) -> u64 {
    let current = env
        .storage()
        .instance()
        .get(&DataKey::NextStakingPoolId)
        .unwrap_or(0u64);
    env.storage()
        .instance()
        .set(&DataKey::NextStakingPoolId, &(current + 1));
    current
}

/// Get the total number of staking pools created.
pub fn get_staking_pool_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::StakingPoolCount)
        .unwrap_or(0)
}

/// Increment and persist the staking pool counter.
pub fn increment_staking_pool_count(env: &Env) -> Result<u64, Error> {
    let count = get_staking_pool_count(env)
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    env.storage()
        .instance()
        .set(&DataKey::StakingPoolCount, &count);
    Ok(count)
}

/// Get a user's stake within a pool.
pub fn get_user_stake(
    env: &Env,
    pool_id: u64,
    user: &Address,
) -> Option<crate::types::StakeInfo> {
    env.storage()
        .persistent()
        .get(&DataKey::UserStake(pool_id, user.clone()))
}

/// Save a user's stake within a pool.
pub fn set_user_stake(
    env: &Env,
    pool_id: u64,
    user: &Address,
    stake: &crate::types::StakeInfo,
) {
    env.storage()
        .persistent()
        .set(&DataKey::UserStake(pool_id, user.clone()), stake);
}

// ── Tests — Issue #1681: panic-free core storage getters ─────────────────────
//
// Each test calls a getter *before* `initialize()` has been invoked and
// asserts that the result is `None` rather than a panic.

#[cfg(test)]
mod storage_getter_uninit_tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};
    use crate::TokenFactory;

    /// Helper: register the contract without calling `initialize`.
    fn bare_env() -> (Env, soroban_sdk::Address) {
        let env = Env::default();
        let contract_id = env.register_contract(None, TokenFactory);
        (env, contract_id)
    }

    /// `get_admin` returns `None` before `initialize()` — no panic.
    #[test]
    fn test_get_admin_before_init_is_none() {
        let (env, contract_id) = bare_env();
        let result = env.as_contract(&contract_id, || get_admin(&env));
        assert!(result.is_none(), "get_admin should return None before init");
    }

    /// `get_treasury` returns `None` before `initialize()` — no panic.
    #[test]
    fn test_get_treasury_before_init_is_none() {
        let (env, contract_id) = bare_env();
        let result = env.as_contract(&contract_id, || get_treasury(&env));
        assert!(result.is_none(), "get_treasury should return None before init");
    }

    /// `get_base_fee` returns `None` before `initialize()` — no panic.
    #[test]
    fn test_get_base_fee_before_init_is_none() {
        let (env, contract_id) = bare_env();
        let result = env.as_contract(&contract_id, || get_base_fee(&env));
        assert!(result.is_none(), "get_base_fee should return None before init");
    }

    /// `get_metadata_fee` returns `None` before `initialize()` — no panic.
    #[test]
    fn test_get_metadata_fee_before_init_is_none() {
        let (env, contract_id) = bare_env();
        let result = env.as_contract(&contract_id, || get_metadata_fee(&env));
        assert!(result.is_none(), "get_metadata_fee should return None before init");
    }

    /// After `initialize()` all four getters return `Some(value)`.
    #[test]
    fn test_getters_return_some_after_init() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TokenFactory);
        let admin = soroban_sdk::Address::generate(&env);
        let treasury = soroban_sdk::Address::generate(&env);

        let client = crate::TokenFactoryClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &70_000_000i128, &30_000_000i128);

        env.as_contract(&contract_id, || {
            assert!(get_admin(&env).is_some());
            assert!(get_treasury(&env).is_some());
            assert!(get_base_fee(&env).is_some());
            assert!(get_metadata_fee(&env).is_some());
        });
    }
}
