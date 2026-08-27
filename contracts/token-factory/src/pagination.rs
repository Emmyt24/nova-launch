use soroban_sdk::{Address, Env, Vec};

use crate::storage;
use crate::types::{
    Error, PaginatedStreamsResponse, PaginatedTokens, PaginationCursor, StreamCursor, TokenInfo,
};

const MAX_PAGE_SIZE: u32 = 100;
const DEFAULT_PAGE_SIZE: u32 = 20;
const NO_CURSOR: u32 = u32::MAX;

/// Maximum number of streams returned per page by `list_streams_paginated`.
const MAX_STREAM_PAGE_SIZE: u32 = 50;

pub fn get_tokens_by_creator(
    env: &Env,
    creator: &Address,
    cursor: PaginationCursor,
    limit: Option<u32>,
) -> Result<PaginatedTokens, Error> {
    let page_size = limit.unwrap_or(DEFAULT_PAGE_SIZE).min(MAX_PAGE_SIZE).max(1);

    let creator_tokens = storage::get_creator_tokens(env, creator);

    let start_pos = if cursor.next_index == NO_CURSOR {
        0
    } else {
        cursor.next_index
    };

    if start_pos >= creator_tokens.len() {
        return Ok(PaginatedTokens {
            tokens: Vec::new(env),
            has_more: false,
            cursor: PaginationCursor {
                next_index: NO_CURSOR,
            },
        });
    }

    let mut tokens = Vec::new(env);
    let mut count = 0_u32;
    let mut current_pos = start_pos;

    while count < page_size && current_pos < creator_tokens.len() {
        let token_index = creator_tokens.get(current_pos).unwrap();
        if let Some(token_info) = storage::get_token_info(env, token_index) {
            tokens.push_back(token_info);
            count += 1;
        }
        current_pos += 1;
    }

    let (has_more, next_cursor) = if current_pos < creator_tokens.len() {
        (
            true,
            PaginationCursor {
                next_index: current_pos,
            },
        )
    } else {
        (
            false,
            PaginationCursor {
                next_index: NO_CURSOR,
            },
        )
    };

    Ok(PaginatedTokens {
        tokens,
        has_more,
        cursor: next_cursor,
    })
}

pub fn get_creator_token_count(env: &Env, creator: &Address) -> u32 {
    storage::get_creator_token_count(env, creator)
}

/// Keyset (cursor-based) pagination over an owner's streams.
///
/// Unlike offset pagination — where inserting a new stream between two page
/// fetches shifts every subsequent index and can cause callers to skip or
/// duplicate rows — keyset pagination resumes strictly *after* the last
/// `(created_ledger, stream_id)` pair the caller has already seen. Because
/// streams are appended to the owner's index in creation order (and both
/// `created_ledger` and `stream_id` are monotonically non-decreasing), the
/// index is always sorted ascending and a linear scan from the cursor
/// position is sufficient — no re-sorting is needed on read.
///
/// # Arguments
/// * `env` - The contract environment
/// * `owner` - The stream creator whose streams should be listed
/// * `cursor` - `None` to start from the beginning; otherwise resume strictly
///   after this `(created_ledger, stream_id)` position
/// * `limit` - Maximum streams to return, clamped to `[1, 50]`
///
/// # Returns
/// A `PaginatedStreamsResponse` containing the page of streams ordered by
/// `(created_ledger, stream_id)` ascending, the cursor for the next page
/// (`None` if this is the last page), and a `has_more` flag.
pub fn list_streams_paginated(
    env: &Env,
    owner: &Address,
    cursor: Option<StreamCursor>,
    limit: u32,
) -> PaginatedStreamsResponse {
    let page_size = limit.clamp(1, MAX_STREAM_PAGE_SIZE);

    let index = storage::get_creator_stream_index(env, owner);

    // Find the first position strictly after the cursor. Since `index` is
    // sorted ascending, a linear scan suffices and keeps the logic simple;
    // owners with very large stream counts can later be optimized with a
    // binary search over the same invariant without changing the API.
    let start_pos: u32 = match cursor {
        None => 0,
        Some(after) => {
            let mut pos = index.len();
            for i in 0..index.len() {
                let entry = index.get(i).unwrap();
                if after.is_before(&entry) {
                    pos = i;
                    break;
                }
            }
            pos
        }
    };

    let mut streams = Vec::new(env);
    let mut pos = start_pos;
    let mut returned: u32 = 0;

    while pos < index.len() && returned < page_size {
        let entry = index.get(pos).unwrap();
        if let Some(stream_info) = storage::get_stream(env, entry.stream_id) {
            streams.push_back(stream_info);
            returned += 1;
        }
        pos += 1;
    }

    let has_more = pos < index.len();
    // Cursor is the last returned entry's position, i.e. `pos - 1`. Empty on
    // the last page -- see `PaginatedStreamsResponse::next_cursor`.
    let mut next_cursor = Vec::new(env);
    if has_more {
        next_cursor.push_back(index.get(pos - 1).unwrap());
    }

    PaginatedStreamsResponse {
        streams,
        next_cursor,
        has_more,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn install_contract(env: &Env) -> Address {
        let contract_id = Address::generate(env);
        env.register_contract(Some(&contract_id), crate::TokenFactory)
    }

    fn setup_with_tokens(token_count: u32) -> (Env, Address, Address) {
        let env = Env::default();
        let creator = Address::generate(&env);
        let contract_id = install_contract(&env);
        env.as_contract(&contract_id, || {
            for i in 0..token_count {
                let token_info = TokenInfo {
                    address: Address::generate(&env),
                    creator: creator.clone(),
                    name: soroban_sdk::String::from_str(&env, "Test Token"),
                    symbol: soroban_sdk::String::from_str(&env, "TST"),
                    decimals: 7,
                    total_supply: 1_000_000,
                    initial_supply: 1_000_000,
                    max_supply: None,
                    total_burned: 0,
                    burn_count: 0,
                    metadata_uri: None,
        metadata_version: 0,
                    created_at: env.ledger().timestamp(),
                    clawback_enabled: false,
                    is_paused: false,
                    freeze_enabled: false,
                };
                storage::set_token_info(&env, i, &token_info);
            }
        });
        (env, creator, contract_id)
    }

    fn no_cursor() -> PaginationCursor {
        PaginationCursor {
            next_index: NO_CURSOR,
        }
    }

    #[test]
    fn test_get_tokens_first_page() {
        let (env, creator, contract_id) = setup_with_tokens(50);
        let result = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, no_cursor(), Some(20)))
            .unwrap();
        assert_eq!(result.tokens.len(), 20);
        assert!(result.has_more);
    }

    #[test]
    fn test_get_tokens_pagination() {
        let (env, creator, contract_id) = setup_with_tokens(50);
        let page1 = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, no_cursor(), Some(20)))
            .unwrap();
        assert_eq!(page1.tokens.len(), 20);
        assert!(page1.has_more);
        let page2 = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, page1.cursor, Some(20)))
            .unwrap();
        assert_eq!(page2.tokens.len(), 20);
        assert!(page2.has_more);
        let page3 = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, page2.cursor, Some(20)))
            .unwrap();
        assert_eq!(page3.tokens.len(), 10);
        assert!(!page3.has_more);
    }

    #[test]
    fn test_get_tokens_empty_results() {
        let env = Env::default();
        let creator = Address::generate(&env);
        let contract_id = install_contract(&env);
        let result = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, no_cursor(), Some(20)))
            .unwrap();
        assert_eq!(result.tokens.len(), 0);
        assert!(!result.has_more);
    }

    #[test]
    fn test_get_tokens_single_token() {
        let (env, creator, contract_id) = setup_with_tokens(1);
        let result = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, no_cursor(), Some(20)))
            .unwrap();
        assert_eq!(result.tokens.len(), 1);
        assert!(!result.has_more);
    }

    #[test]
    fn test_get_tokens_exact_page_size() {
        let (env, creator, contract_id) = setup_with_tokens(20);
        let result = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, no_cursor(), Some(20)))
            .unwrap();
        assert_eq!(result.tokens.len(), 20);
        assert!(!result.has_more);
    }

    #[test]
    fn test_get_tokens_max_limit_enforced() {
        let (env, creator, contract_id) = setup_with_tokens(200);
        let result = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, no_cursor(), Some(150)))
            .unwrap();
        assert_eq!(result.tokens.len(), 100);
        assert!(result.has_more);
    }

    #[test]
    fn test_get_tokens_default_limit() {
        let (env, creator, contract_id) = setup_with_tokens(50);
        let result = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, no_cursor(), None))
            .unwrap();
        assert_eq!(result.tokens.len(), 20);
        assert!(result.has_more);
    }

    #[test]
    fn test_get_tokens_cursor_past_end() {
        let (env, creator, contract_id) = setup_with_tokens(10);
        let invalid_cursor = PaginationCursor { next_index: 100 };
        let result = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, invalid_cursor, Some(20)))
            .unwrap();
        assert_eq!(result.tokens.len(), 0);
        assert!(!result.has_more);
    }

    #[test]
    fn test_get_tokens_deterministic_ordering() {
        let (env, creator, contract_id) = setup_with_tokens(30);
        let result1 = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, no_cursor(), Some(10)))
            .unwrap();
        let result2 = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, no_cursor(), Some(10)))
            .unwrap();
        assert_eq!(result1.tokens.len(), result2.tokens.len());
        for i in 0..result1.tokens.len() {
            assert_eq!(
                result1.tokens.get(i).unwrap().address,
                result2.tokens.get(i).unwrap().address
            );
        }
    }

    #[test]
    fn test_get_creator_token_count() {
        let (env, creator, contract_id) = setup_with_tokens(42);
        assert_eq!(
            env.as_contract(&contract_id, || get_creator_token_count(&env, &creator)),
            42
        );
    }

    #[test]
    fn test_get_creator_token_count_zero() {
        let env = Env::default();
        let creator = Address::generate(&env);
        let contract_id = install_contract(&env);
        assert_eq!(
            env.as_contract(&contract_id, || get_creator_token_count(&env, &creator)),
            0
        );
    }

    #[test]
    fn test_pagination_boundary_conditions() {
        let (env, creator, contract_id) = setup_with_tokens(21);
        let page1 = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, no_cursor(), Some(20)))
            .unwrap();
        assert_eq!(page1.tokens.len(), 20);
        assert!(page1.has_more);
        let page2 = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator, page1.cursor, Some(20)))
            .unwrap();
        assert_eq!(page2.tokens.len(), 1);
        assert!(!page2.has_more);
    }

    #[test]
    fn test_multiple_creators_isolated() {
        let env = Env::default();
        let creator1 = Address::generate(&env);
        let creator2 = Address::generate(&env);
        let contract_id = install_contract(&env);
        env.as_contract(&contract_id, || {
            for i in 0..10 {
                let token_info = TokenInfo {
                    address: Address::generate(&env),
                    creator: creator1.clone(),
                    name: soroban_sdk::String::from_str(&env, "Token1"),
                    symbol: soroban_sdk::String::from_str(&env, "TK1"),
                    decimals: 7,
                    total_supply: 1_000_000,
                    initial_supply: 1_000_000,
                    max_supply: None,
                    total_burned: 0,
                    burn_count: 0,
                    metadata_uri: None,
        metadata_version: 0,
                    created_at: env.ledger().timestamp(),
                    clawback_enabled: false,
                    is_paused: false,
                    freeze_enabled: false,
                };
                storage::set_token_info(&env, i, &token_info);
            }
            for i in 10..15 {
                let token_info = TokenInfo {
                    address: Address::generate(&env),
                    creator: creator2.clone(),
                    name: soroban_sdk::String::from_str(&env, "Token2"),
                    symbol: soroban_sdk::String::from_str(&env, "TK2"),
                    decimals: 7,
                    total_supply: 2_000_000,
                    initial_supply: 2_000_000,
                    max_supply: None,
                    total_burned: 0,
                    burn_count: 0,
                    metadata_uri: None,
        metadata_version: 0,
                    created_at: env.ledger().timestamp(),
                    clawback_enabled: false,
                    is_paused: false,
                    freeze_enabled: false,
                };
                storage::set_token_info(&env, i, &token_info);
            }
        });
        let result1 = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator1, no_cursor(), Some(20)))
            .unwrap();
        assert_eq!(result1.tokens.len(), 10);
        let result2 = env
            .as_contract(&contract_id, || get_tokens_by_creator(&env, &creator2, no_cursor(), Some(20)))
            .unwrap();
        assert_eq!(result2.tokens.len(), 5);
    }
}
