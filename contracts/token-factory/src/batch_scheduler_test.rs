#![cfg(test)]

use crate::types::TokenCreationParams;
use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env, String, Vec};

const BASE_FEE: i128 = 100;
const LEDGER_GAS_BUDGET: u64 = 12_000_000;
const REVEAL_ITEM_GAS: u64 = 6_000_000;

fn setup() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &BASE_FEE, &50);
    client.set_batch_gas_budget(&admin, &LEDGER_GAS_BUDGET);

    (env, contract_id)
}

fn token_batch(env: &Env, names: [&str; 4], symbols: [&str; 4]) -> Vec<TokenCreationParams> {
    let mut tokens = Vec::new(env);
    for (name, symbol) in names.iter().zip(symbols.iter()) {
        tokens.push_back(TokenCreationParams {
            name: String::from_str(env, name),
            symbol: String::from_str(env, symbol),
            decimals: 7,
            initial_supply: 1_000,
            max_supply: None,
            metadata_uri: None,
            clawback_enabled: false,
            freeze_enabled: false,
        });
    }
    tokens
}

fn assert_both_tenants_pending(pending: &Vec<Address>, tenant_a: &Address, tenant_b: &Address) {
    let mut has_tenant_a = false;
    let mut has_tenant_b = false;
    for tenant in pending.iter() {
        has_tenant_a |= tenant == *tenant_a;
        has_tenant_b |= tenant == *tenant_b;
    }
    assert!(has_tenant_a, "tenant A continuation should remain queued");
    assert!(has_tenant_b, "tenant B continuation should remain queued");
}

#[test]
fn scheduled_reveals_share_a_ledger_budget_across_pending_tenants() {
    let (env, contract_id) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);
    let tenant_a = Address::generate(&env);
    let tenant_b = Address::generate(&env);
    let tokens_a = token_batch(
        &env,
        ["Alpha One", "Alpha Two", "Alpha Three", "Alpha Four"],
        ["A01", "A02", "A03", "A04"],
    );
    let tokens_b = token_batch(
        &env,
        ["Beta One", "Beta Two", "Beta Three", "Beta Four"],
        ["B01", "B02", "B03", "B04"],
    );

    let first_schedule = client.schedule_batch_reveal(
        &tenant_a,
        &tokens_a,
        &(BASE_FEE * tokens_a.len() as i128),
    );
    assert!(first_schedule.continuation_pending);

    let second_schedule = client.schedule_batch_reveal(
        &tenant_b,
        &tokens_b,
        &(BASE_FEE * tokens_b.len() as i128),
    );
    assert!(second_schedule.continuation_pending);
    assert_both_tenants_pending(
        &client.get_pending_batch_tenants(),
        &tenant_a,
        &tenant_b,
    );

    env.ledger().with_mut(|ledger| ledger.sequence += 1);
    let resume_a = client.resume_batch_reveal(&tenant_a);
    let resume_b = client.resume_batch_reveal(&tenant_b);

    assert_eq!(resume_a.executed_count, 1);
    assert_eq!(resume_b.executed_count, 1);
    assert!(resume_a.executed_count as u64 * REVEAL_ITEM_GAS <= LEDGER_GAS_BUDGET / 2);
    assert!(resume_b.executed_count as u64 * REVEAL_ITEM_GAS <= LEDGER_GAS_BUDGET / 2);
    assert!(resume_a.continuation_pending);
    assert!(resume_b.continuation_pending);
    assert_both_tenants_pending(
        &client.get_pending_batch_tenants(),
        &tenant_a,
        &tenant_b,
    );
}