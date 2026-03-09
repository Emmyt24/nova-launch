#![cfg(test)]

use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup_test() -> (Env, TokenFactoryClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    (env, client, admin, treasury)
}

#[test]
fn test_get_campaign() {
    let (env, client, admin, _treasury) = setup_test();

    let campaign_id = client.create_buyback_campaign(&admin, &0, &10_000_0000000, &1_000_0000000);

    let campaign = client.get_campaign(&campaign_id);
    assert_eq!(campaign.token_index, 0);
    assert_eq!(campaign.total_budget, 10_000_0000000);
    assert_eq!(campaign.max_spend_per_step, 1_000_0000000);
    assert!(campaign.active);
}

#[test]
fn test_get_campaign_not_found() {
    let (_env, client, _admin, _treasury) = setup_test();

    let result = client.try_get_campaign(&999);
    assert!(result.is_err());
}

#[test]
fn test_get_campaign_count() {
    let (_env, client, admin, _treasury) = setup_test();

    assert_eq!(client.get_campaign_count(), 0);

    client.create_buyback_campaign(&admin, &0, &10_000_0000000, &1_000_0000000);
    assert_eq!(client.get_campaign_count(), 1);

    client.create_buyback_campaign(&admin, &1, &5_000_0000000, &500_0000000);
    assert_eq!(client.get_campaign_count(), 2);
}

#[test]
fn test_get_campaigns_page_empty() {
    let (_env, client, _admin, _treasury) = setup_test();

    let campaigns = client.get_campaigns_page(&0, &10);
    assert_eq!(campaigns.len(), 0);
}

#[test]
fn test_get_campaigns_page_single() {
    let (_env, client, admin, _treasury) = setup_test();

    client.create_buyback_campaign(&admin, &0, &10_000_0000000, &1_000_0000000);

    let campaigns = client.get_campaigns_page(&0, &10);
    assert_eq!(campaigns.len(), 1);
    assert_eq!(campaigns.get(0).unwrap().token_index, 0);
}

#[test]
fn test_get_campaigns_page_multiple() {
    let (_env, client, admin, _treasury) = setup_test();

    // Create 5 campaigns
    for i in 0..5 {
        client.create_buyback_campaign(&admin, &i, &10_000_0000000, &1_000_0000000);
    }

    let campaigns = client.get_campaigns_page(&0, &10);
    assert_eq!(campaigns.len(), 5);

    // Verify deterministic ordering (by campaign ID)
    for i in 0..5 {
        assert_eq!(campaigns.get(i).unwrap().token_index, i);
    }
}

#[test]
fn test_get_campaigns_page_pagination() {
    let (_env, client, admin, _treasury) = setup_test();

    // Create 10 campaigns
    for i in 0..10 {
        client.create_buyback_campaign(&admin, &i, &10_000_0000000, &1_000_0000000);
    }

    // First page
    let page1 = client.get_campaigns_page(&0, &3);
    assert_eq!(page1.len(), 3);
    assert_eq!(page1.get(0).unwrap().token_index, 0);
    assert_eq!(page1.get(2).unwrap().token_index, 2);

    // Second page
    let page2 = client.get_campaigns_page(&3, &3);
    assert_eq!(page2.len(), 3);
    assert_eq!(page2.get(0).unwrap().token_index, 3);
    assert_eq!(page2.get(2).unwrap().token_index, 5);

    // Last partial page
    let page3 = client.get_campaigns_page(&9, &3);
    assert_eq!(page3.len(), 1);
    assert_eq!(page3.get(0).unwrap().token_index, 9);
}

#[test]
fn test_get_campaigns_page_max_limit() {
    let (_env, client, admin, _treasury) = setup_test();

    // Create 60 campaigns
    for i in 0..60 {
        client.create_buyback_campaign(&admin, &i, &10_000_0000000, &1_000_0000000);
    }

    // Request 100 but should get max 50
    let campaigns = client.get_campaigns_page(&0, &100);
    assert_eq!(campaigns.len(), 50);
}

#[test]
fn test_get_campaigns_page_cursor_beyond_end() {
    let (_env, client, admin, _treasury) = setup_test();

    client.create_buyback_campaign(&admin, &0, &10_000_0000000, &1_000_0000000);

    let campaigns = client.get_campaigns_page(&10, &10);
    assert_eq!(campaigns.len(), 0);
}

#[test]
fn test_get_campaigns_by_status_all_active() {
    let (_env, client, admin, _treasury) = setup_test();

    // Create 3 active campaigns
    for i in 0..3 {
        client.create_buyback_campaign(&admin, &i, &10_000_0000000, &1_000_0000000);
    }

    let active = client.get_campaigns_by_status(&true, &0, &10);
    assert_eq!(active.len(), 3);

    let inactive = client.get_campaigns_by_status(&false, &0, &10);
    assert_eq!(inactive.len(), 0);
}

#[test]
fn test_get_campaigns_by_status_mixed() {
    let (env, client, admin, _treasury) = setup_test();

    // Create campaigns
    let id1 = client.create_buyback_campaign(&admin, &0, &10_000_0000000, &1_000_0000000);
    let id2 = client.create_buyback_campaign(&admin, &1, &5_000_0000000, &500_0000000);
    let id3 = client.create_buyback_campaign(&admin, &2, &8_000_0000000, &800_0000000);

    // Deactivate campaign 1 by exhausting budget
    let executor = Address::generate(&env);
    let dex = Address::generate(&env);
    client.execute_buyback_step(&id1, &executor, &10_000_0000000, &90_000_0000000, &dex);

    let active = client.get_campaigns_by_status(&true, &0, &10);
    assert_eq!(active.len(), 2);
    assert_eq!(active.get(0).unwrap().token_index, 1);
    assert_eq!(active.get(1).unwrap().token_index, 2);

    let inactive = client.get_campaigns_by_status(&false, &0, &10);
    assert_eq!(inactive.len(), 1);
    assert_eq!(inactive.get(0).unwrap().token_index, 0);
}

#[test]
fn test_get_campaigns_by_status_pagination() {
    let (_env, client, admin, _treasury) = setup_test();

    // Create 5 campaigns
    for i in 0..5 {
        client.create_buyback_campaign(&admin, &i, &10_000_0000000, &1_000_0000000);
    }

    // First page
    let page1 = client.get_campaigns_by_status(&true, &0, &2);
    assert_eq!(page1.len(), 2);

    // Second page
    let page2 = client.get_campaigns_by_status(&true, &2, &2);
    assert_eq!(page2.len(), 2);

    // Last page
    let page3 = client.get_campaigns_by_status(&true, &4, &2);
    assert_eq!(page3.len(), 1);
}
