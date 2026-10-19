#![cfg(test)]

use crate::{types::MintRecipient, TokenFactory, TokenFactoryClient};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    vec, Address, Env, IntoVal, Symbol, Vec,
};

fn create_test_env() -> (Env, TokenFactoryClient, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_address = Address::generate(&env);

    // Initialize factory
    client.initialize(&admin, &treasury, &1_000_000, &500_000);

    (env, client, admin, treasury, token_address)
}

fn setup_token(
    env: &Env,
    client: &TokenFactoryClient,
    token_address: &Address,
    creator: &Address,
) {
    use crate::types::{DataKey, TokenInfo};
    use soroban_sdk::String;

    let token_info = TokenInfo {
        address: token_address.clone(),
        creator: creator.clone(),
        name: String::from_str(env, "Test Token"),
        symbol: String::from_str(env, "TEST"),
        decimals: 7,
        total_supply: 1_000_000_0000000, // 1M tokens
        metadata_uri: None,
        metadata_version: 0,
        created_at: env.ledger().timestamp(),
        total_burned: 0,
        burn_count: 0,
        clawback_enabled: false,
            freeze_enabled: false,
            is_paused: false,
            allowlist_enabled: false,
        
        };

    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::TokenByAddress(token_address.clone()), &token_info);
    });
}

#[test]
fn test_batch_mint_success() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);
    let recipient3 = Address::generate(&env);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient1.clone(),
            amount: 1000_0000000, // 1000 tokens
        },
        MintRecipient {
            recipient: recipient2.clone(),
            amount: 2000_0000000, // 2000 tokens
        },
        MintRecipient {
            recipient: recipient3.clone(),
            amount: 3000_0000000, // 3000 tokens
        },
    ];

    let result = client.batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_ok());

    // Verify event was emitted
    let events = env.events().all();
    let event = events.last().unwrap();

    assert_eq!(
        event.topics,
        (Symbol::new(&env, "btch_mnt"), token_address.clone()).into_val(&env)
    );
}

#[test]
fn test_batch_mint_unauthorized() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    let unauthorized = Address::generate(&env);
    let recipient = Address::generate(&env);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient.clone(),
            amount: 1000_0000000,
        },
    ];

    let result = client.try_batch_mint_tokens(&token_address, &unauthorized, &mints);
    assert!(result.is_err());
}

#[test]
fn test_batch_mint_empty_vector() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    let mints: Vec<MintRecipient> = vec![&env];

    let result = client.try_batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_err());
}

#[test]
fn test_batch_mint_invalid_amount_zero() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    let recipient = Address::generate(&env);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient.clone(),
            amount: 0,
        },
    ];

    let result = client.try_batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_err());
}

#[test]
fn test_batch_mint_invalid_amount_negative() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    let recipient = Address::generate(&env);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient.clone(),
            amount: -1000,
        },
    ];

    let result = client.try_batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_err());
}

#[test]
fn test_batch_mint_supply_overflow() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    let recipient = Address::generate(&env);

    // Try to mint i128::MAX which will overflow when added to existing supply
    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient.clone(),
            amount: i128::MAX,
        },
    ];

    let result = client.try_batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_err());
}

#[test]
fn test_batch_mint_aggregate_overflow() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    // Two amounts that individually are valid but together overflow
    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient1.clone(),
            amount: i128::MAX / 2 + 1,
        },
        MintRecipient {
            recipient: recipient2.clone(),
            amount: i128::MAX / 2 + 1,
        },
    ];

    let result = client.try_batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_err());
}

#[test]
fn test_batch_mint_token_not_found() {
    let (env, client, admin, _treasury, _token_address) = create_test_env();

    let nonexistent_token = Address::generate(&env);
    let recipient = Address::generate(&env);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient.clone(),
            amount: 1000_0000000,
        },
    ];

    let result = client.try_batch_mint_tokens(&nonexistent_token, &admin, &mints);
    assert!(result.is_err());
}

#[test]
fn test_batch_mint_when_paused() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    // Pause the contract
    client.pause(&admin);

    let recipient = Address::generate(&env);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient.clone(),
            amount: 1000_0000000,
        },
    ];

    let result = client.try_batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_err());
}

#[test]
fn test_batch_mint_single_recipient() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    let recipient = Address::generate(&env);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient.clone(),
            amount: 5000_0000000,
        },
    ];

    let result = client.batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_ok());
}

#[test]
fn test_batch_mint_many_recipients() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    let mut mints: Vec<MintRecipient> = vec![&env];

    // Create 10 recipients
    for _ in 0..10 {
        let recipient = Address::generate(&env);
        mints.push_back(MintRecipient {
            recipient,
            amount: 100_0000000, // 100 tokens each
        });
    }

    let result = client.batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_ok());

    // Verify event contains correct count
    let events = env.events().all();
    let event = events.last().unwrap();
    let data: (Address, i128, u32, u64) = event.data.try_into().unwrap();
    assert_eq!(data.2, 10); // recipient_count should be 10
}

#[test]
fn test_batch_mint_preserves_invariants() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    use crate::types::{DataKey, TokenInfo};

    // Get initial supply
    let initial_info: TokenInfo = env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .get(&DataKey::TokenByAddress(token_address.clone()))
            .unwrap()
    });
    let initial_supply = initial_info.total_supply;

    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let amount1 = 1000_0000000;
    let amount2 = 2000_0000000;

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient1.clone(),
            amount: amount1,
        },
        MintRecipient {
            recipient: recipient2.clone(),
            amount: amount2,
        },
    ];

    client.batch_mint_tokens(&token_address, &admin, &mints);

    // Verify supply increased by exact amount
    let final_info: TokenInfo = env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .get(&DataKey::TokenByAddress(token_address.clone()))
            .unwrap()
    });

    assert_eq!(
        final_info.total_supply,
        initial_supply + amount1 + amount2
    );
}

fn enable_allowlist(env: &Env, client: &TokenFactoryClient, token_address: &Address) {
    use crate::types::{DataKey, TokenInfo};

    let mut token_info: TokenInfo = env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .get(&DataKey::TokenByAddress(token_address.clone()))
            .unwrap()
    });
    token_info.allowlist_enabled = true;

    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::TokenByAddress(token_address.clone()), &token_info);
    });
}

#[test]
fn test_batch_mint_allowlist_all_allowed() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);
    enable_allowlist(&env, &client, &token_address);

    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    client.add_to_allowlist(&token_address, &admin, &recipient1);
    client.add_to_allowlist(&token_address, &admin, &recipient2);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient1.clone(),
            amount: 1000_0000000,
        },
        MintRecipient {
            recipient: recipient2.clone(),
            amount: 2000_0000000,
        },
    ];

    let result = client.try_batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_ok());
}

#[test]
fn test_batch_mint_allowlist_rejects_unlisted_recipient() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);
    enable_allowlist(&env, &client, &token_address);

    let allowed = Address::generate(&env);
    let not_allowed = Address::generate(&env);

    client.add_to_allowlist(&token_address, &admin, &allowed);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: allowed.clone(),
            amount: 1000_0000000,
        },
        MintRecipient {
            recipient: not_allowed.clone(),
            amount: 2000_0000000,
        },
    ];

    let result = client.try_batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_err());
}

#[test]
fn test_batch_mint_allowlist_rejects_all_unlisted() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);
    enable_allowlist(&env, &client, &token_address);

    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient1.clone(),
            amount: 1000_0000000,
        },
        MintRecipient {
            recipient: recipient2.clone(),
            amount: 2000_0000000,
        },
    ];

    let result = client.try_batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_err());
}

#[test]
fn test_batch_mint_allowlist_after_removal() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);
    enable_allowlist(&env, &client, &token_address);

    let recipient = Address::generate(&env);
    client.add_to_allowlist(&token_address, &admin, &recipient);
    client.remove_from_allowlist(&token_address, &admin, &recipient);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient.clone(),
            amount: 1000_0000000,
        },
    ];

    let result = client.try_batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_err());
}

#[test]
fn test_batch_mint_allowlist_disabled_allows_any_recipient() {
    let (env, client, admin, _treasury, token_address) = create_test_env();
    setup_token(&env, &client, &token_address, &admin);

    // Allowlist mode is off; unlisted recipients should still be mintable
    let recipient = Address::generate(&env);

    let mints: Vec<MintRecipient> = vec![
        &env,
        MintRecipient {
            recipient: recipient.clone(),
            amount: 1000_0000000,
        },
    ];

    let result = client.try_batch_mint_tokens(&token_address, &admin, &mints);
    assert!(result.is_ok());
}
