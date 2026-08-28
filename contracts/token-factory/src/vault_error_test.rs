//! Vault Error Diagnostic Context Tests (#1384)
//!
//! Verifies that:
//! 1. Vault-related `Error` variants expose a stable, named string
//!    representation via `Error::name()` (so off-chain indexers such as
//!    `vaultEventParser.ts` never have to hardcode a numeric-to-name map).
//! 2. Every vault entry point that rejects an operation emits a structured
//!    `OperationFailed` event (topic `vlt_fail`) carrying the numeric error
//!    code, the stable error name, the affected amount, and a machine
//!    readable "condition" describing exactly why the operation failed.
//! 3. The diagnostic context (vault id, amount, condition) reported in the
//!    event matches the actual failure being tested.
//!
//! ## A note on how these failures are observed
//!
//! Soroban rolls back *all* state changes and events from a contract
//! invocation that returns an `Err` at the top-level entry point — this is
//! fundamental to how failed transactions work on-chain, and the test
//! harness's `env.events().all()` faithfully mirrors it by filtering out
//! events tagged as belonging to a failed call. That means an event emitted
//! immediately before an entry point returns `Err` is never observable via
//! a committed ledger event stream; it is, however, fully visible during
//! *simulation* (`simulateTransaction`), which is exactly the moment
//! off-chain tooling (wallets, indexers doing pre-flight checks) needs rich
//! diagnostic context most. To exercise and assert on that event payload in
//! these tests we invoke the entry points as direct Rust function calls
//! (`TokenFactory::create_vault(env.clone(), ...)`) inside `env.as_contract`
//! rather than through the generated cross-contract `Client`, which avoids
//! the call-boundary rollback while still running the exact same production
//! code path.

#![cfg(test)]

use crate::types::Error;
use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::testutils::{Address as _, Events, Ledger, LedgerInfo};
use soroban_sdk::xdr::{ScVal, VecM};
use soroban_sdk::{Address, BytesN, Env, String};

const BASE_FEE: i128 = 70_000_000;
const METADATA_FEE: i128 = 30_000_000;

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &BASE_FEE, &METADATA_FEE);

    let creator = Address::generate(&env);
    let token = client.create_token(
        &creator,
        &String::from_str(&env, "Vault Token"),
        &String::from_str(&env, "VLT"),
        &7,
        &1_000_000_000,
        &None,
        &BASE_FEE,
    );

    (env, contract_id, creator, token)
}

fn sc_symbol_string(val: &ScVal) -> String_ {
    match val {
        ScVal::Symbol(sym) => sym
            .0
            .to_utf8_string()
            .expect("symbol bytes must be valid utf-8"),
        other => panic!("expected ScVal::Symbol, got {other:?}"),
    }
}

fn sc_u64(val: &ScVal) -> u64 {
    match val {
        ScVal::U64(v) => *v,
        other => panic!("expected ScVal::U64, got {other:?}"),
    }
}

fn sc_u32(val: &ScVal) -> u32 {
    match val {
        ScVal::U32(v) => *v,
        other => panic!("expected ScVal::U32, got {other:?}"),
    }
}

fn sc_i128(val: &ScVal) -> i128 {
    match val {
        ScVal::I128(parts) => ((parts.hi as i128) << 64) | (parts.lo as i128),
        other => panic!("expected ScVal::I128, got {other:?}"),
    }
}

fn sc_vec(val: &ScVal) -> &VecM<ScVal> {
    match val {
        ScVal::Vec(Some(v)) => v,
        other => panic!("expected ScVal::Vec, got {other:?}"),
    }
}

type String_ = std::string::String;

/// Decodes the most recently emitted event into (vault_id, error_code,
/// error_name, amount, condition), asserting it is a `vlt_fail`
/// (OperationFailed) event.
fn last_operation_failed(env: &Env) -> (u64, u32, String_, i128, String_) {
    let events = env.events().all();
    let raw = events.events();
    let last = raw.last().expect("expected at least one event");

    let body = match &last.body {
        soroban_sdk::xdr::ContractEventBody::V0(v0) => v0,
    };

    let name_topic = sc_symbol_string(&body.topics[0]);
    assert_eq!(
        name_topic, "vlt_fail",
        "expected the last event to be an OperationFailed (vlt_fail) event"
    );
    let vault_id = sc_u64(&body.topics[1]);

    let payload = sc_vec(&body.data);
    let error_code = sc_u32(&payload[0]);
    let error_name = sc_symbol_string(&payload[1]);
    let amount = sc_i128(&payload[2]);
    let condition = sc_symbol_string(&payload[3]);

    (vault_id, error_code, error_name, amount, condition)
}

// ── Error::name() stability ───────────────────────────────────────────────

#[test]
fn test_vault_error_names_are_stable() {
    // These names are part of the off-chain indexer contract (vaultEventParser.ts).
    // Renaming or removing any of these is a breaking change.
    assert_eq!(Error::TokenNotFound.name(), "TokenNotFound");
    assert_eq!(Error::Unauthorized.name(), "Unauthorized");
    assert_eq!(Error::InvalidParameters.name(), "InvalidParameters");
    assert_eq!(Error::InvalidAmount.name(), "InvalidAmount");
    assert_eq!(Error::ContractPaused.name(), "ContractPaused");
    assert_eq!(Error::ArithmeticError.name(), "ArithmeticError");
    assert_eq!(Error::NothingToClaim.name(), "NothingToClaim");
    assert_eq!(Error::CliffNotReached.name(), "CliffNotReached");
    assert_eq!(Error::MilestoneUnauthorized.name(), "MilestoneUnauthorized");
    assert_eq!(
        Error::MilestoneAlreadyVerified.name(),
        "MilestoneAlreadyVerified"
    );
    assert_eq!(
        Error::VaultOwnerChangePending.name(),
        "VaultOwnerChangePending"
    );
    assert_eq!(
        Error::VaultOwnerChangeNotFound.name(),
        "VaultOwnerChangeNotFound"
    );
    assert_eq!(
        Error::VaultOwnerChangeAlreadyApproved.name(),
        "VaultOwnerChangeAlreadyApproved"
    );
}

#[test]
fn test_unknown_error_code_maps_to_unknown_error_name() {
    // Codes with no registered variant must not panic; they map to a
    // documented sentinel so indexers can detect drift instead of crashing.
    assert_eq!(Error(255).name(), "UnknownError");
}

// ── create_vault failure diagnostics ──────────────────────────────────────

#[test]
fn test_create_vault_invalid_amount_emits_operation_failed() {
    let (env, contract_id, creator, token) = setup();
    let owner = Address::generate(&env);
    let no_milestone = BytesN::from_array(&env, &[0u8; 32]);

    let result = env.as_contract(&contract_id, || {
        TokenFactory::create_vault(
            env.clone(),
            creator.clone(),
            token.clone(),
            owner.clone(),
            0, // invalid: amount must be positive
            1_750_000_000,
            no_milestone.clone(),
            None,
        )
    });
    assert_eq!(result, Err(Error::InvalidAmount));

    let (vault_id, code, name, amount, condition) = last_operation_failed(&env);
    assert_eq!(vault_id, u64::MAX, "no vault id is allocated yet");
    assert_eq!(code, Error::InvalidAmount.0);
    assert_eq!(name, "InvalidAmount");
    assert_eq!(amount, 0);
    assert_eq!(condition, "amount_not_positive");
}

#[test]
fn test_create_vault_missing_unlock_condition_emits_operation_failed() {
    let (env, contract_id, creator, token) = setup();
    let owner = Address::generate(&env);
    let no_milestone = BytesN::from_array(&env, &[0u8; 32]);

    let result = env.as_contract(&contract_id, || {
        TokenFactory::create_vault(
            env.clone(),
            creator.clone(),
            token.clone(),
            owner.clone(),
            500_000,
            0,                    // no time unlock
            no_milestone.clone(), // no milestone unlock either
            None,
        )
    });
    assert_eq!(result, Err(Error::InvalidParameters));

    let (_, code, name, amount, condition) = last_operation_failed(&env);
    assert_eq!(code, Error::InvalidParameters.0);
    assert_eq!(name, "InvalidParameters");
    assert_eq!(amount, 500_000);
    assert_eq!(condition, "missing_unlock_condition");
}

#[test]
fn test_create_vault_milestone_without_verifier_emits_operation_failed() {
    let (env, contract_id, creator, token) = setup();
    let owner = Address::generate(&env);
    let milestone_hash = BytesN::from_array(&env, &[7u8; 32]);

    let result = env.as_contract(&contract_id, || {
        TokenFactory::create_vault(
            env.clone(),
            creator.clone(),
            token.clone(),
            owner.clone(),
            500_000,
            0,
            milestone_hash.clone(),
            None, // missing required verifier
        )
    });
    assert_eq!(result, Err(Error::InvalidParameters));

    let (_, _, _, _, condition) = last_operation_failed(&env);
    assert_eq!(condition, "milestone_without_verifier");
}

#[test]
fn test_create_vault_unknown_token_emits_operation_failed() {
    let (env, contract_id, creator, _token) = setup();
    let owner = Address::generate(&env);
    let unregistered_token = Address::generate(&env);
    let no_milestone = BytesN::from_array(&env, &[0u8; 32]);

    let result = env.as_contract(&contract_id, || {
        TokenFactory::create_vault(
            env.clone(),
            creator.clone(),
            unregistered_token.clone(),
            owner.clone(),
            500_000,
            1_750_000_000,
            no_milestone.clone(),
            None,
        )
    });
    assert_eq!(result, Err(Error::TokenNotFound));

    let (_, code, name, _, condition) = last_operation_failed(&env);
    assert_eq!(code, Error::TokenNotFound.0);
    assert_eq!(name, "TokenNotFound");
    assert_eq!(condition, "token_not_registered");
}

// ── claim_vault failure diagnostics ────────────────────────────────────────

fn create_test_vault(
    env: &Env,
    contract_id: &Address,
    creator: &Address,
    token: &Address,
    owner: &Address,
    amount: i128,
    unlock_time: u64,
) -> u64 {
    let no_milestone = BytesN::from_array(env, &[0u8; 32]);
    env.as_contract(contract_id, || {
        TokenFactory::create_vault(
            env.clone(),
            creator.clone(),
            token.clone(),
            owner.clone(),
            amount,
            unlock_time,
            no_milestone,
            None,
        )
    })
    .unwrap()
}

#[test]
fn test_claim_vault_nonexistent_emits_operation_failed_with_vault_id() {
    let (env, contract_id, _creator, _token) = setup();
    let owner = Address::generate(&env);

    let missing_vault_id = 999u64;
    let result = env.as_contract(&contract_id, || {
        TokenFactory::claim_vault(env.clone(), owner.clone(), missing_vault_id, None)
    });
    assert_eq!(result, Err(Error::TokenNotFound));

    let (vault_id, code, name, amount, condition) = last_operation_failed(&env);
    assert_eq!(vault_id, missing_vault_id);
    assert_eq!(code, Error::TokenNotFound.0);
    assert_eq!(name, "TokenNotFound");
    assert_eq!(amount, 0);
    assert_eq!(condition, "vault_not_found");
}

#[test]
fn test_claim_vault_unauthorized_emits_operation_failed_with_amount() {
    let (env, contract_id, creator, token) = setup();
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    let vault_id = create_test_vault(&env, &contract_id, &creator, &token, &owner, 500_000, 1);

    let result = env.as_contract(&contract_id, || {
        TokenFactory::claim_vault(env.clone(), attacker.clone(), vault_id, None)
    });
    assert_eq!(result, Err(Error::Unauthorized));

    let (evt_vault_id, code, name, amount, condition) = last_operation_failed(&env);
    assert_eq!(evt_vault_id, vault_id);
    assert_eq!(code, Error::Unauthorized.0);
    assert_eq!(name, "Unauthorized");
    assert_eq!(
        amount, 500_000,
        "diagnostic context should carry the vault total"
    );
    assert_eq!(condition, "not_vault_owner");
}

#[test]
fn test_claim_vault_before_unlock_emits_operation_failed() {
    let (env, contract_id, creator, token) = setup();
    let owner = Address::generate(&env);

    let vault_id = create_test_vault(&env, &contract_id, &creator, &token, &owner, 500_000, 5_000);

    env.ledger().with_mut(|li| li.timestamp = 1_000);

    let result = env.as_contract(&contract_id, || {
        TokenFactory::claim_vault(env.clone(), owner.clone(), vault_id, None)
    });
    assert_eq!(result, Err(Error::InvalidParameters));

    let (_, _, _, amount, condition) = last_operation_failed(&env);
    assert_eq!(amount, 500_000);
    assert_eq!(condition, "cliff_not_reached");
}

#[test]
fn test_claim_vault_nothing_to_claim_emits_operation_failed() {
    let (env, contract_id, creator, token) = setup();
    let owner = Address::generate(&env);

    let vault_id = create_test_vault(&env, &contract_id, &creator, &token, &owner, 500_000, 1);

    // Advance past the unlock time so the first claim below can succeed.
    env.ledger().with_mut(|li| li.timestamp = 1);

    // First claim succeeds and drains the vault. This goes through the
    // generated client (a real cross-contract call) rather than
    // `env.as_contract`, because a successful claim performs a nested
    // token `transfer` call, which is rejected as re-entrancy when invoked
    // directly inside an `env.as_contract` context.
    let client = TokenFactoryClient::new(&env, &contract_id);
    client.claim_vault(&owner, &vault_id, &None);

    // Second claim has nothing left (vault is now `Claimed`, not `Active`).
    let result = env.as_contract(&contract_id, || {
        TokenFactory::claim_vault(env.clone(), owner.clone(), vault_id, None)
    });
    assert_eq!(result, Err(Error::InvalidParameters));

    let (_, code, name, _, condition) = last_operation_failed(&env);
    assert_eq!(code, Error::InvalidParameters.0);
    assert_eq!(name, "InvalidParameters");
    assert_eq!(condition, "vault_not_active");
}

// ── cancel_vault failure diagnostics ───────────────────────────────────────

#[test]
fn test_cancel_vault_unauthorized_emits_operation_failed() {
    let (env, contract_id, creator, token) = setup();
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    let vault_id = create_test_vault(
        &env,
        &contract_id,
        &creator,
        &token,
        &owner,
        500_000,
        1_750_000_000,
    );

    let result = env.as_contract(&contract_id, || {
        TokenFactory::cancel_vault(env.clone(), vault_id, attacker.clone())
    });
    assert_eq!(result, Err(Error::Unauthorized));

    let (evt_vault_id, code, name, amount, condition) = last_operation_failed(&env);
    assert_eq!(evt_vault_id, vault_id);
    assert_eq!(code, Error::Unauthorized.0);
    assert_eq!(name, "Unauthorized");
    assert_eq!(amount, 500_000);
    assert_eq!(condition, "not_creator_or_admin");
}

// ── verify_milestone failure diagnostics ───────────────────────────────────

#[test]
fn test_verify_milestone_wrong_verifier_emits_operation_failed() {
    let (env, contract_id, creator, token) = setup();
    let owner = Address::generate(&env);
    let verifier = Address::generate(&env);
    let attacker = Address::generate(&env);
    let milestone_hash = BytesN::from_array(&env, &[3u8; 32]);

    let vault_id = env
        .as_contract(&contract_id, || {
            TokenFactory::create_vault(
                env.clone(),
                creator.clone(),
                token.clone(),
                owner.clone(),
                500_000,
                0,
                milestone_hash.clone(),
                Some(verifier.clone()),
            )
        })
        .unwrap();

    let result = env.as_contract(&contract_id, || {
        TokenFactory::verify_milestone(env.clone(), attacker.clone(), vault_id)
    });
    assert_eq!(result, Err(Error::MilestoneUnauthorized));

    let (evt_vault_id, code, name, _, condition) = last_operation_failed(&env);
    assert_eq!(evt_vault_id, vault_id);
    assert_eq!(code, Error::MilestoneUnauthorized.0);
    assert_eq!(name, "MilestoneUnauthorized");
    assert_eq!(condition, "not_designated_verifier");
}

#[test]
fn test_verify_milestone_already_verified_emits_operation_failed() {
    let (env, contract_id, creator, token) = setup();
    let owner = Address::generate(&env);
    let verifier = Address::generate(&env);
    let milestone_hash = BytesN::from_array(&env, &[3u8; 32]);

    let vault_id = env
        .as_contract(&contract_id, || {
            TokenFactory::create_vault(
                env.clone(),
                creator.clone(),
                token.clone(),
                owner.clone(),
                500_000,
                0,
                milestone_hash.clone(),
                Some(verifier.clone()),
            )
        })
        .unwrap();

    env.as_contract(&contract_id, || {
        TokenFactory::verify_milestone(env.clone(), verifier.clone(), vault_id)
    })
    .unwrap();

    let result = env.as_contract(&contract_id, || {
        TokenFactory::verify_milestone(env.clone(), verifier.clone(), vault_id)
    });
    assert_eq!(result, Err(Error::MilestoneAlreadyVerified));

    let (_, code, name, _, condition) = last_operation_failed(&env);
    assert_eq!(code, Error::MilestoneAlreadyVerified.0);
    assert_eq!(name, "MilestoneAlreadyVerified");
    assert_eq!(condition, "milestone_already_verified");
}

// ── propose/approve vault owner change failure diagnostics ────────────────

#[test]
fn test_propose_vault_owner_change_unauthorized_emits_operation_failed() {
    let (env, contract_id, creator, token) = setup();
    let owner = Address::generate(&env);
    let attacker = Address::generate(&env);
    let new_owner = Address::generate(&env);

    let vault_id = create_test_vault(
        &env,
        &contract_id,
        &creator,
        &token,
        &owner,
        500_000,
        1_750_000_000,
    );

    let result = env.as_contract(&contract_id, || {
        TokenFactory::propose_vault_owner_change(
            env.clone(),
            attacker.clone(),
            vault_id,
            new_owner.clone(),
        )
    });
    assert_eq!(result, Err(Error::Unauthorized));

    let (_, code, name, _, condition) = last_operation_failed(&env);
    assert_eq!(code, Error::Unauthorized.0);
    assert_eq!(name, "Unauthorized");
    assert_eq!(condition, "not_owner_or_creator");
}

#[test]
fn test_approve_vault_owner_change_not_found_emits_operation_failed() {
    let (env, contract_id, creator, token) = setup();
    let owner = Address::generate(&env);

    let vault_id = create_test_vault(
        &env,
        &contract_id,
        &creator,
        &token,
        &owner,
        500_000,
        1_750_000_000,
    );

    // No proposal has been created yet.
    let result = env.as_contract(&contract_id, || {
        TokenFactory::approve_vault_owner_change(env.clone(), owner.clone(), vault_id)
    });
    assert_eq!(result, Err(Error::VaultOwnerChangeNotFound));

    let (evt_vault_id, code, name, _, condition) = last_operation_failed(&env);
    assert_eq!(evt_vault_id, vault_id);
    assert_eq!(code, Error::VaultOwnerChangeNotFound.0);
    assert_eq!(name, "VaultOwnerChangeNotFound");
    assert_eq!(condition, "no_pending_owner_change");
}
