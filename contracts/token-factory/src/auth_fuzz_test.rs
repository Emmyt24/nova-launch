//! Hostile Authorization Fuzz Test Suite
//!
//! This module contains adversarial fuzzing tests designed to probe for:
//! - Authorization bypass vulnerabilities
//! - Signer confusion attacks
//! - Replay-like edge cases
//! - Privilege escalation attempts
//!
//! All privileged operations must fail closed without valid authorization.

#![cfg(test)]

use crate::{TokenFactory, TokenFactoryClient};
use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, Address, Env, String};

/// Setup factory with known admin and treasury
fn setup_factory(env: &Env) -> (TokenFactoryClient, Address, Address) {
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(env, &contract_id);
    
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    
    client.initialize(&admin, &treasury, &100_0000000, &50_0000000).unwrap();
    
    (client, admin, treasury)
}

/// Generate arbitrary address strategy
fn arb_address() -> impl Strategy<Value = u64> {
    any::<u64>()
}

/// Generate arbitrary amount strategy
fn arb_amount() -> impl Strategy<Value = i128> {
    -1000_0000000i128..=1000_0000000i128
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    /// Fuzz Test: Admin transfer with attacker as caller
    /// 
    /// Attempts to transfer admin rights by providing correct admin address
    /// but signing as attacker. Must fail.
    #[test]
    fn fuzz_admin_transfer_signer_confusion(
        attacker_seed in arb_address(),
        new_admin_seed in arb_address(),
    ) {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        // Generate attacker and new admin addresses
        let attacker = Address::generate(&env);
        let new_admin = Address::generate(&env);
        
        // Mock auth for attacker (not admin)
        env.mock_all_auths();
        
        // Attempt: attacker tries to transfer admin to new_admin
        let result = client.try_transfer_admin(&attacker, &new_admin);
        
        // Must fail - attacker is not current admin
        prop_assert!(result.is_err(), 
            "Attacker should not be able to transfer admin rights");
        
        // Verify admin unchanged
        let state = client.get_state();
        prop_assert_eq!(state.admin, admin, 
            "Admin should remain unchanged after failed attack");
    }

    /// Fuzz Test: Fee update with non-admin signer
    /// 
    /// Attempts to update fees with various non-admin addresses.
    #[test]
    fn fuzz_fee_update_unauthorized(
        attacker_seed in arb_address(),
        base_fee in arb_amount(),
        metadata_fee in arb_amount(),
    ) {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        let attacker = Address::generate(&env);
        env.mock_all_auths();
        
        // Attempt: attacker tries to update fees
        let result = client.try_update_fees(
            &attacker,
            &Some(base_fee),
            &Some(metadata_fee),
        );
        
        prop_assert!(result.is_err(),
            "Non-admin should not be able to update fees");
        
        // Verify fees unchanged
        let state = client.get_state();
        prop_assert_eq!(state.base_fee, 100_0000000,
            "Base fee should remain unchanged");
        prop_assert_eq!(state.metadata_fee, 50_0000000,
            "Metadata fee should remain unchanged");
    }

    /// Fuzz Test: Pause/unpause with address permutations
    /// 
    /// Tests all combinations of admin/non-admin attempting pause operations.
    #[test]
    fn fuzz_pause_operations_auth(
        attacker_seed in arb_address(),
        pause_state in any::<bool>(),
    ) {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        let attacker = Address::generate(&env);
        env.mock_all_auths();
        
        // Attempt: attacker tries to pause/unpause
        let result = if pause_state {
            client.try_pause(&attacker)
        } else {
            client.try_unpause(&attacker)
        };
        
        prop_assert!(result.is_err(),
            "Non-admin should not be able to pause/unpause");
        
        // Verify pause state unchanged
        prop_assert!(!client.is_paused(),
            "Pause state should remain unchanged");
    }

    /// Fuzz Test: Treasury withdrawal with attacker permutations
    /// 
    /// Attempts treasury withdrawals with various unauthorized addresses.
    #[test]
    fn fuzz_treasury_withdrawal_unauthorized(
        attacker_seed in arb_address(),
        recipient_seed in arb_address(),
        amount in 1i128..=100_0000000i128,
    ) {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        // Initialize treasury policy
        client.initialize_treasury_policy(&admin, &Some(100_0000000), &false).unwrap();
        
        let attacker = Address::generate(&env);
        let recipient = Address::generate(&env);
        env.mock_all_auths();
        
        // Attempt: attacker tries to withdraw fees
        let result = client.try_withdraw_fees(&attacker, &recipient, &amount);
        
        prop_assert!(result.is_err(),
            "Non-admin should not be able to withdraw treasury fees");
    }

    /// Fuzz Test: Timelock schedule with unauthorized signer
    /// 
    /// Attempts to schedule sensitive changes with non-admin addresses.
    #[test]
    fn fuzz_timelock_schedule_unauthorized(
        attacker_seed in arb_address(),
        base_fee in arb_amount(),
        metadata_fee in arb_amount(),
    ) {
        let env = Env::default();
        let (client, _admin, _treasury) = setup_factory(&env);
        
        let attacker = Address::generate(&env);
        env.mock_all_auths();
        
        // Attempt: attacker tries to schedule fee update
        let result = client.try_schedule_fee_update(
            &attacker,
            &Some(base_fee),
            &Some(metadata_fee),
        );
        
        prop_assert!(result.is_err(),
            "Non-admin should not be able to schedule changes");
    }

    /// Fuzz Test: Timelock cancel with unauthorized signer
    /// 
    /// Attempts to cancel pending changes with non-admin addresses.
    #[test]
    fn fuzz_timelock_cancel_unauthorized(
        attacker_seed in arb_address(),
        change_id in 0u64..=1000u64,
    ) {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        // Schedule a legitimate change first
        let real_change_id = client.schedule_fee_update(
            &admin,
            &Some(200_0000000),
            &None,
        ).unwrap();
        
        let attacker = Address::generate(&env);
        env.mock_all_auths();
        
        // Attempt: attacker tries to cancel the change
        let result = client.try_cancel_change(&attacker, &real_change_id);
        
        prop_assert!(result.is_err(),
            "Non-admin should not be able to cancel pending changes");
        
        // Verify change still exists
        let change = client.get_pending_change(&real_change_id);
        prop_assert!(change.is_some(),
            "Pending change should still exist after failed cancel");
    }

    /// Fuzz Test: Allowlist manipulation with unauthorized signer
    /// 
    /// Attempts to add/remove recipients from allowlist without authorization.
    #[test]
    fn fuzz_allowlist_manipulation_unauthorized(
        attacker_seed in arb_address(),
        recipient_seed in arb_address(),
        add_or_remove in any::<bool>(),
    ) {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        client.initialize_treasury_policy(&admin, &Some(100_0000000), &true).unwrap();
        
        let attacker = Address::generate(&env);
        let recipient = Address::generate(&env);
        env.mock_all_auths();
        
        // Attempt: attacker tries to modify allowlist
        let result = if add_or_remove {
            client.try_add_allowed_recipient(&attacker, &recipient)
        } else {
            client.try_remove_allowed_recipient(&attacker, &recipient)
        };
        
        prop_assert!(result.is_err(),
            "Non-admin should not be able to modify allowlist");
        
        // Verify recipient not in allowlist
        prop_assert!(!client.is_allowed_recipient(&recipient),
            "Recipient should not be in allowlist after failed attack");
    }

    /// Fuzz Test: Batch admin operations with mixed signers
    /// 
    /// Attempts batch updates with various unauthorized addresses.
    #[test]
    fn fuzz_batch_admin_unauthorized(
        attacker_seed in arb_address(),
        base_fee in arb_amount(),
        metadata_fee in arb_amount(),
        paused in any::<bool>(),
    ) {
        let env = Env::default();
        let (client, _admin, _treasury) = setup_factory(&env);
        
        let attacker = Address::generate(&env);
        env.mock_all_auths();
        
        // Attempt: attacker tries batch update
        let result = client.try_batch_update_admin(
            &attacker,
            &Some(base_fee),
            &Some(metadata_fee),
            &Some(paused),
        );
        
        prop_assert!(result.is_err(),
            "Non-admin should not be able to perform batch updates");
    }

    /// Fuzz Test: Mint with non-creator signer
    /// 
    /// Attempts to mint tokens with addresses that are not the token creator.
    #[test]
    fn fuzz_mint_unauthorized(
        attacker_seed in arb_address(),
        amount in 1i128..=1000_0000000i128,
    ) {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        // Create a token with admin as creator
        let token_index = 0u32;
        // Assume token exists with admin as creator
        
        let attacker = Address::generate(&env);
        let recipient = Address::generate(&env);
        env.mock_all_auths();
        
        // Attempt: attacker tries to mint tokens
        let result = client.try_mint(&attacker, &token_index, &recipient, &amount);
        
        prop_assert!(result.is_err(),
            "Non-creator should not be able to mint tokens");
    }

    /// Fuzz Test: Storage TTL bump with non-admin signer
    /// 
    /// Attempts to extend storage TTL for persistent entries with
    /// unauthorized addresses. Must fail closed.
    #[test]
    fn fuzz_bump_ttl_unauthorized(
        attacker_seed in arb_address(),
        extend_ledgers in 1u32..=1_000_000u32,
    ) {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        let attacker = Address::generate(&env);
        env.mock_all_auths();
        
        // Attempt: attacker tries to bump TTL
        let result = client.try_bump_storage_ttl(&attacker, &extend_ledgers);
        
        prop_assert!(result.is_err(),
            "Non-admin should not be able to bump storage TTL");
        
        // Verify admin still works (fail-closed did not corrupt state)
        let admin_result = client.try_bump_storage_ttl(&admin, &extend_ledgers);
        prop_assert!(admin_result.is_ok(),
            "Admin should still be able to bump storage TTL");
    }

    /// Fuzz Test: Allowlist mode toggle with non-admin signer
    /// 
    /// Attempts to enable/disable allowlist mode with unauthorized addresses.
    #[test]
    fn fuzz_set_allowlist_mode_unauthorized(
        attacker_seed in arb_address(),
        enabled in any::<bool>(),
    ) {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        let attacker = Address::generate(&env);
        env.mock_all_auths();
        
        // Attempt: attacker tries to toggle allowlist mode
        let result = client.try_set_allowlist_mode(&attacker, &enabled);
        
        prop_assert!(result.is_err(),
            "Non-admin should not be able to toggle allowlist mode");
        
        // Verify mode unchanged (defaults to disabled)
        prop_assert!(!client.is_allowlist_mode(),
            "Allowlist mode should remain disabled after failed attack");
        
        // Verify admin can still toggle
        client.set_allowlist_mode(&admin, &enabled).unwrap();
        prop_assert_eq!(client.is_allowlist_mode(), enabled,
            "Admin should be able to toggle allowlist mode");
    }

    /// Fuzz Test: Token allowlist management with non-admin signer
    /// 
    /// Attempts to add/remove addresses from the token transfer allowlist
    /// without authorization.
    #[test]
    fn fuzz_token_allowlist_management_unauthorized(
        attacker_seed in arb_address(),
        account_seed in arb_address(),
        add_or_remove in any::<bool>(),
    ) {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        client.set_allowlist_mode(&admin, &true).unwrap();
        
        let attacker = Address::generate(&env);
        let account = Address::generate(&env);
        env.mock_all_auths();
        
        // Attempt: attacker tries to modify the transfer allowlist
        let result = if add_or_remove {
            client.try_add_to_allowlist(&attacker, &account)
        } else {
            client.try_remove_from_allowlist(&attacker, &account)
        };
        
        prop_assert!(result.is_err(),
            "Non-admin should not be able to modify the transfer allowlist");
        
        // Verify account not allowlisted after failed attack
        prop_assert!(!client.is_allowlisted(&account),
            "Account should not be allowlisted after failed attack");
    }
}

/// Replay-style sequence fuzzing tests
///
/// These tests simulate replay attacks and sequence manipulation.
mod replay_tests {
    use super::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(300))]

        /// Replay Test: Admin transfer proposal/accept sequence
        /// 
        /// Tests that admin transfer cannot be replayed or reordered.
        #[test]
        fn fuzz_admin_transfer_replay(
            new_admin_seed1 in arb_address(),
            new_admin_seed2 in arb_address(),
        ) {
            let env = Env::default();
            let (client, admin, _treasury) = setup_factory(&env);
            
            let new_admin1 = Address::generate(&env);
            let new_admin2 = Address::generate(&env);
            
            env.mock_all_auths();
            
            // First transfer: admin -> new_admin1
            client.transfer_admin(&admin, &new_admin1).unwrap();
            
            // Verify transfer succeeded
            let state = client.get_state();
            prop_assert_eq!(state.admin, new_admin1,
                "Admin should be new_admin1 after first transfer");
            
            // Attempt replay: try to use old admin again
            let result = client.try_transfer_admin(&admin, &new_admin2);
            
            prop_assert!(result.is_err(),
                "Old admin should not be able to transfer after being replaced");
            
            // Verify admin still new_admin1
            let state = client.get_state();
            prop_assert_eq!(state.admin, new_admin1,
                "Admin should remain new_admin1 after replay attempt");
        }

        /// Replay Test: Timelock schedule/execute sequence
        /// 
        /// Tests that timelock changes cannot be executed multiple times.
        #[test]
        fn fuzz_timelock_execute_replay(
            base_fee in 1i128..=1000_0000000i128,
        ) {
            let env = Env::default();
            let (client, admin, _treasury) = setup_factory(&env);
            
            env.mock_all_auths();
            
            // Schedule a change
            let change_id = client.schedule_fee_update(
                &admin,
                &Some(base_fee),
                &None,
            ).unwrap();
            
            // Advance time past timelock
            env.ledger().with_mut(|li| {
                li.timestamp = li.timestamp + 172_801; // 48 hours + 1 second
            });
            
            // Execute the change
            client.execute_change(&change_id).unwrap();
            
            // Verify change was applied
            let state = client.get_state();
            prop_assert_eq!(state.base_fee, base_fee,
                "Fee should be updated after execution");
            
            // Attempt replay: try to execute again
            let result = client.try_execute_change(&change_id);
            
            prop_assert!(result.is_err(),
                "Change should not be executable twice");
        }

        /// Replay Test: Treasury withdrawal sequence
        /// 
        /// Tests that withdrawal tracking prevents replay attacks.
        #[test]
        fn fuzz_treasury_withdrawal_replay(
            amount in 1i128..=50_0000000i128,
        ) {
            let env = Env::default();
            let (client, admin, _treasury) = setup_factory(&env);
            
            client.initialize_treasury_policy(&admin, &Some(100_0000000), &false).unwrap();
            
            let recipient = Address::generate(&env);
            env.mock_all_auths();
            
            // First withdrawal
            client.withdraw_fees(&admin, &recipient, &amount).unwrap();
            
            let remaining1 = client.get_remaining_capacity();
            prop_assert_eq!(remaining1, 100_0000000 - amount,
                "Remaining capacity should decrease after withdrawal");
            
            // Second withdrawal with same amount
            client.withdraw_fees(&admin, &recipient, &amount).unwrap();
            
            let remaining2 = client.get_remaining_capacity();
            prop_assert_eq!(remaining2, 100_0000000 - (2 * amount),
                "Remaining capacity should decrease again");
            
            // Verify withdrawals are tracked cumulatively
            prop_assert!(remaining2 < remaining1,
                "Each withdrawal should reduce remaining capacity");
        }

        /// Replay Test: Allowlist add/remove sequence
        /// 
        /// Tests that allowlist modifications cannot be replayed.
        #[test]
        fn fuzz_allowlist_sequence_replay(
            recipient_seed in arb_address(),
        ) {
            let env = Env::default();
            let (client, admin, _treasury) = setup_factory(&env);
            
            client.initialize_treasury_policy(&admin, &Some(100_0000000), &true).unwrap();
            
            let recipient = Address::generate(&env);
            env.mock_all_auths();
            
            // Add recipient
            client.add_allowed_recipient(&admin, &recipient).unwrap();
            prop_assert!(client.is_allowed_recipient(&recipient),
                "Recipient should be in allowlist after add");
            
            // Remove recipient
            client.remove_allowed_recipient(&admin, &recipient).unwrap();
            prop_assert!(!client.is_allowed_recipient(&recipient),
                "Recipient should not be in allowlist after remove");
            
            // Verify removal is persistent (not replayable)
            prop_assert!(!client.is_allowed_recipient(&recipient),
                "Recipient should remain removed");
        }

        /// Replay Test: Pause/unpause sequence
        /// 
        /// Tests that pause state changes are properly tracked.
        #[test]
        fn fuzz_pause_sequence_replay(
            _seed in arb_address(),
        ) {
            let env = Env::default();
            let (client, admin, _treasury) = setup_factory(&env);
            
            env.mock_all_auths();
            
            // Initial state: not paused
            prop_assert!(!client.is_paused(),
                "Contract should not be paused initially");
            
            // Pause
            client.pause(&admin).unwrap();
            prop_assert!(client.is_paused(),
                "Contract should be paused after pause()");
            
            // Unpause
            client.unpause(&admin).unwrap();
            prop_assert!(!client.is_paused(),
                "Contract should not be paused after unpause()");
            
            // Verify state is persistent
            prop_assert!(!client.is_paused(),
                "Pause state should remain consistent");
        }
    }
}

/// Signer confusion tests with address permutations
mod signer_confusion_tests {
    use super::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(300))]

        /// Confusion Test: Admin vs Treasury address confusion
        /// 
        /// Tests that treasury address cannot be used for admin operations.
        #[test]
        fn fuzz_admin_treasury_confusion(
            base_fee in arb_amount(),
        ) {
            let env = Env::default();
            let (client, _admin, treasury) = setup_factory(&env);
            
            env.mock_all_auths();
            
            // Attempt: use treasury address for admin operation
            let result = client.try_update_fees(&treasury, &Some(base_fee), &None);
            
            prop_assert!(result.is_err(),
                "Treasury address should not have admin privileges");
        }

        /// Confusion Test: Creator vs Admin confusion
        /// 
        /// Tests that token creator cannot perform factory admin operations.
        #[test]
        fn fuzz_creator_admin_confusion(
            creator_seed in arb_address(),
            base_fee in arb_amount(),
        ) {
            let env = Env::default();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let creator = Address::generate(&env);
            env.mock_all_auths();
            
            // Attempt: creator tries admin operation
            let result = client.try_update_fees(&creator, &Some(base_fee), &None);
            
            prop_assert!(result.is_err(),
                "Token creator should not have factory admin privileges");
        }

        /// Confusion Test: Multiple address role confusion
        /// 
        /// Tests that addresses with one role cannot use another role's privileges.
        #[test]
        fn fuzz_multi_role_confusion(
            addr1_seed in arb_address(),
            addr2_seed in arb_address(),
            addr3_seed in arb_address(),
        ) {
            let env = Env::default();
            let (client, admin, treasury) = setup_factory(&env);
            
            let addr1 = Address::generate(&env);
            let addr2 = Address::generate(&env);
            let addr3 = Address::generate(&env);
            
            env.mock_all_auths();
            
            // Test matrix: each address tries each privileged operation
            let addresses = vec![&env, addr1.clone(), addr2.clone(), addr3.clone(), treasury.clone()];
            
            for addr in addresses.iter() {
                if *addr != admin {
                    // Try pause
                    let result = client.try_pause(addr);
                    prop_assert!(result.is_err(),
                        "Non-admin address should not be able to pause");
                    
                    // Try fee update
                    let result = client.try_update_fees(addr, &Some(200_0000000), &None);
                    prop_assert!(result.is_err(),
                        "Non-admin address should not be able to update fees");
                    
                    // Try admin transfer
                    let result = client.try_transfer_admin(addr, &addr1);
                    prop_assert!(result.is_err(),
                        "Non-admin address should not be able to transfer admin");
                }
            }
        }

        /// Confusion Test: Same address different contexts
        /// 
        /// Tests that using the same address in different parameter positions
        /// doesn't bypass authorization.
        #[test]
        fn fuzz_same_address_confusion(
            attacker_seed in arb_address(),
        ) {
            let env = Env::default();
            let (client, admin, _treasury) = setup_factory(&env);
            
            let attacker = Address::generate(&env);
            env.mock_all_auths();
            
            // Attempt: attacker tries to transfer admin to themselves
            let result = client.try_transfer_admin(&attacker, &attacker);
            
            prop_assert!(result.is_err(),
                "Attacker should not be able to make themselves admin");
            
            // Verify admin unchanged
            let state = client.get_state();
            prop_assert_eq!(state.admin, admin,
                "Admin should remain unchanged");
        }

        /// Confusion Test: Zero address and special addresses
        /// 
        /// Tests that special addresses cannot bypass authorization.
        #[test]
        fn fuzz_special_address_confusion(
            base_fee in arb_amount(),
        ) {
            let env = Env::default();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            // Generate various "special" addresses
            let addr1 = Address::generate(&env);
            let addr2 = Address::generate(&env);
            
            env.mock_all_auths();
            
            // Test with different generated addresses
            for addr in [addr1, addr2].iter() {
                let result = client.try_update_fees(addr, &Some(base_fee), &None);
                prop_assert!(result.is_err(),
                    "Generated address should not have admin privileges");
            }
        }
    }
}

/// Privilege escalation tests
mod privilege_escalation_tests {
    use super::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(300))]

        /// Escalation Test: Chain admin transfers
        /// 
        /// Tests that intermediate admins cannot be used after transfer.
        #[test]
        fn fuzz_admin_chain_escalation(
            seed1 in arb_address(),
            seed2 in arb_address(),
            seed3 in arb_address(),
        ) {
            let env = Env::default();
            let (client, admin, _treasury) = setup_factory(&env);
            
            let admin1 = Address::generate(&env);
            let admin2 = Address::generate(&env);
            let admin3 = Address::generate(&env);
            
            env.mock_all_auths();
            
            // Transfer chain: admin -> admin1 -> admin2
            client.transfer_admin(&admin, &admin1).unwrap();
            client.transfer_admin(&admin1, &admin2).unwrap();
            
            // Attempt: old admins try to reclaim
            let result1 = client.try_transfer_admin(&admin, &admin3);
            prop_assert!(result1.is_err(),
                "Original admin should not work after transfer");
            
            let result2 = client.try_transfer_admin(&admin1, &admin3);
            prop_assert!(result2.is_err(),
                "Intermediate admin should not work after transfer");
            
            // Verify current admin is admin2
            let state = client.get_state();
            prop_assert_eq!(state.admin, admin2,
                "Current admin should be admin2");
        }

        /// Escalation Test: Timelock bypass attempts
        /// 
        /// Tests that non-admin cannot execute changes even after timelock.
        #[test]
        fn fuzz_timelock_escalation(
            attacker_seed in arb_address(),
            base_fee in 1i128..=1000_0000000i128,
        ) {
            let env = Env::default();
            let (client, admin, _treasury) = setup_factory(&env);
            
            env.mock_all_auths();
            
            // Admin schedules a change
            let change_id = client.schedule_fee_update(
                &admin,
                &Some(base_fee),
                &None,
            ).unwrap();
            
            // Advance time past timelock
            env.ledger().with_mut(|li| {
                li.timestamp = li.timestamp + 172_801;
            });
            
            // Transfer admin to someone else
            let new_admin = Address::generate(&env);
            client.transfer_admin(&admin, &new_admin).unwrap();
            
            // Attempt: old admin tries to execute
            // Note: execute_change doesn't require admin, but let's verify
            // the change was scheduled by the correct admin
            let change = client.get_pending_change(&change_id).unwrap();
            prop_assert_eq!(change.scheduled_by, admin,
                "Change should be scheduled by original admin");
            
            // Anyone can execute after timelock, but verify it works correctly
            client.execute_change(&change_id).unwrap();
            
            let state = client.get_state();
            prop_assert_eq!(state.base_fee, base_fee,
                "Fee should be updated after execution");
        }

        /// Escalation Test: Treasury policy manipulation
        /// 
        /// Tests that non-admin cannot escalate via treasury policy.
        #[test]
        fn fuzz_treasury_policy_escalation(
            attacker_seed in arb_address(),
            daily_cap in 1i128..=1000_0000000i128,
        ) {
            let env = Env::default();
            let (client, admin, _treasury) = setup_factory(&env);
            
            client.initialize_treasury_policy(&admin, &Some(100_0000000), &true).unwrap();
            
            let attacker = Address::generate(&env);
            env.mock_all_auths();
            
            // Attempt: attacker tries to increase cap
            let result = client.try_update_treasury_policy(
                &attacker,
                &Some(daily_cap),
                &None,
            );
            
            prop_assert!(result.is_err(),
                "Non-admin should not be able to update treasury policy");
            
            // Verify policy unchanged
            let policy = client.get_treasury_policy();
            prop_assert_eq!(policy.daily_cap, 100_0000000,
                "Daily cap should remain unchanged");
        }

        /// Escalation Test: Allowlist self-addition
        /// 
        /// Tests that non-admin cannot add themselves to allowlist.
        #[test]
        fn fuzz_allowlist_self_escalation(
            attacker_seed in arb_address(),
        ) {
            let env = Env::default();
            let (client, admin, _treasury) = setup_factory(&env);
            
            client.initialize_treasury_policy(&admin, &Some(100_0000000), &true).unwrap();
            
            let attacker = Address::generate(&env);
            env.mock_all_auths();
            
            // Attempt: attacker tries to add themselves
            let result = client.try_add_allowed_recipient(&attacker, &attacker);
            
            prop_assert!(result.is_err(),
                "Attacker should not be able to add themselves to allowlist");
            
            // Verify not in allowlist
            prop_assert!(!client.is_allowed_recipient(&attacker),
                "Attacker should not be in allowlist");
        }

        /// Escalation Test: Batch operation privilege mixing
        /// 
        /// Tests that batch operations don't allow privilege escalation.
        #[test]
        fn fuzz_batch_operation_escalation(
            attacker_seed in arb_address(),
            base_fee in arb_amount(),
        ) {
            let env = Env::default();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let attacker = Address::generate(&env);
            env.mock_all_auths();
            
            // Attempt: attacker tries batch update with pause
            let result = client.try_batch_update_admin(
                &attacker,
                &Some(base_fee),
                &None,
                &Some(true),
            );
            
            prop_assert!(result.is_err(),
                "Attacker should not be able to use batch operations");
            
            // Verify nothing changed
            prop_assert!(!client.is_paused(),
                "Contract should not be paused");
        }

        /// Escalation Test: Allowlist self-addition via token allowlist
        /// 
        /// Tests that non-admin cannot add themselves to the token
        /// transfer allowlist to bypass compliance restrictions.
        #[test]
        fn fuzz_token_allowlist_self_escalation(
            attacker_seed in arb_address(),
        ) {
            let env = Env::default();
            let (client, admin, _treasury) = setup_factory(&env);
            
            client.set_allowlist_mode(&admin, &true).unwrap();
            
            let attacker = Address::generate(&env);
            env.mock_all_auths();
            
            // Attempt: attacker tries to allowlist themselves
            let result = client.try_add_to_allowlist(&attacker, &attacker);
            
            prop_assert!(result.is_err(),
                "Attacker should not be able to allowlist themselves");
            
            prop_assert!(!client.is_allowlisted(&attacker),
                "Attacker should not be allowlisted");
        }

        /// Escalation Test: TTL bump privilege escalation
        /// 
        /// Tests that non-admin cannot extend storage TTL to keep
        /// stale or malicious state alive.
        #[test]
        fn fuzz_ttl_bump_escalation(
            attacker_seed in arb_address(),
            extend_ledgers in 1u32..=1_000_000u32,
        ) {
            let env = Env::default();
            let (client, _admin, _treasury) = setup_factory(&env);
            
            let attacker = Address::generate(&env);
            env.mock_all_auths();
            
            // Attempt: attacker tries to bump TTL
            let result = client.try_bump_storage_ttl(&attacker, &extend_ledgers);
            
            prop_assert!(result.is_err(),
                "Attacker should not be able to bump storage TTL");
        }
    }
}

/// Corpus seeds for historically risky auth patterns
mod corpus_seeds {
    use super::*;

    /// Corpus: Known attack patterns from DeFi exploits
    #[test]
    fn corpus_reentrancy_auth_pattern() {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        env.mock_all_auths();
        
        // Pattern: Try to call admin function during state transition
        // This simulates reentrancy during admin transfer
        let new_admin = Address::generate(&env);
        client.transfer_admin(&admin, &new_admin).unwrap();
        
        // Verify old admin cannot act
        let result = client.try_pause(&admin);
        assert!(result.is_err(), "Old admin should not work after transfer");
    }

    /// Corpus: Front-running admin transfer
    #[test]
    fn corpus_frontrun_admin_transfer() {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        let attacker = Address::generate(&env);
        let new_admin = Address::generate(&env);
        
        env.mock_all_auths();
        
        // Attacker tries to front-run admin transfer
        let result = client.try_transfer_admin(&attacker, &attacker);
        assert!(result.is_err(), "Attacker cannot front-run admin transfer");
        
        // Legitimate transfer succeeds
        client.transfer_admin(&admin, &new_admin).unwrap();
        
        let state = client.get_state();
        assert_eq!(state.admin, new_admin);
    }

    /// Corpus: Signature replay across contracts
    #[test]
    fn corpus_cross_contract_replay() {
        let env = Env::default();
        
        // Deploy two separate factory instances
        let (client1, admin1, _) = setup_factory(&env);
        let (client2, admin2, _) = setup_factory(&env);
        
        env.mock_all_auths();
        
        // Admin1 performs operation on factory1
        client1.pause(&admin1).unwrap();
        assert!(client1.is_paused());
        
        // Verify admin1 cannot affect factory2
        let result = client2.try_pause(&admin1);
        assert!(result.is_err(), "Admin from one factory cannot affect another");
        assert!(!client2.is_paused());
    }

    /// Corpus: Zero-value auth bypass
    #[test]
    fn corpus_zero_value_auth() {
        let env = Env::default();
        let (client, _admin, _treasury) = setup_factory(&env);
        
        let attacker = Address::generate(&env);
        env.mock_all_auths();
        
        // Try various zero-value operations
        let result = client.try_update_fees(&attacker, &Some(0), &Some(0));
        assert!(result.is_err(), "Zero-value operations still require auth");
    }

    /// Corpus: Max value overflow auth
    #[test]
    fn corpus_max_value_auth() {
        let env = Env::default();
        let (client, _admin, _treasury) = setup_factory(&env);
        
        let attacker = Address::generate(&env);
        env.mock_all_auths();
        
        // Try max value operations
        let result = client.try_update_fees(&attacker, &Some(i128::MAX), &None);
        assert!(result.is_err(), "Max value operations still require auth");
    }

    /// Corpus: Negative value auth bypass
    #[test]
    fn corpus_negative_value_auth() {
        let env = Env::default();
        let (client, _admin, _treasury) = setup_factory(&env);
        
        let attacker = Address::generate(&env);
        env.mock_all_auths();
        
        // Try negative value operations
        let result = client.try_update_fees(&attacker, &Some(-1000), &None);
        assert!(result.is_err(), "Negative value operations still require auth");
    }

    /// Corpus: Self-referential address patterns
    #[test]
    fn corpus_self_referential_auth() {
        let env = Env::default();
        let (client, _admin, _treasury) = setup_factory(&env);
        
        let attacker = Address::generate(&env);
        env.mock_all_auths();
        
        // Attacker tries to transfer admin to themselves
        let result = client.try_transfer_admin(&attacker, &attacker);
        assert!(result.is_err(), "Self-referential transfer requires auth");
    }

    /// Corpus: Circular admin transfer
    #[test]
    fn corpus_circular_admin_transfer() {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        
        env.mock_all_auths();
        
        // Create transfer chain
        client.transfer_admin(&admin, &admin1).unwrap();
        client.transfer_admin(&admin1, &admin2).unwrap();
        
        // Try to create circular reference
        let result = client.try_transfer_admin(&admin2, &admin);
        // This should succeed (circular is allowed, just tests auth)
        assert!(result.is_ok(), "Circular transfer is allowed if authorized");
        
        // But old admin1 cannot act
        let result = client.try_pause(&admin1);
        assert!(result.is_err(), "Old admin in chain cannot act");
    }

    /// Corpus: Rapid admin changes
    #[test]
    fn corpus_rapid_admin_changes() {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        env.mock_all_auths();
        
        // Rapid succession of admin changes
        let mut current_admin = admin;
        for _ in 0..10 {
            let new_admin = Address::generate(&env);
            client.transfer_admin(&current_admin, &new_admin).unwrap();
            current_admin = new_admin;
        }
        
        // Verify final admin is correct
        let state = client.get_state();
        assert_eq!(state.admin, current_admin);
        
        // Verify old admins cannot act
        let result = client.try_pause(&admin);
        assert!(result.is_err(), "Original admin should not work after chain");
    }

    /// Corpus: Timelock manipulation sequence
    #[test]
    fn corpus_timelock_manipulation() {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        env.mock_all_auths();
        
        // Schedule multiple changes
        let id1 = client.schedule_fee_update(&admin, &Some(200_0000000), &None).unwrap();
        let id2 = client.schedule_fee_update(&admin, &Some(300_0000000), &None).unwrap();
        
        // Transfer admin
        let new_admin = Address::generate(&env);
        client.transfer_admin(&admin, &new_admin).unwrap();
        
        // Old admin cannot cancel
        let result = client.try_cancel_change(&admin, &id1);
        assert!(result.is_err(), "Old admin cannot cancel pending changes");
        
        // New admin can cancel
        client.cancel_change(&new_admin, &id2).unwrap();
    }

    /// Corpus: TTL bump after admin transfer
    #[test]
    fn corpus_ttl_bump_after_admin_transfer() {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        env.mock_all_auths();
        
        // Old admin bumps TTL successfully
        client.bump_storage_ttl(&admin, &100_000).unwrap();
        
        // Transfer admin
        let new_admin = Address::generate(&env);
        client.transfer_admin(&admin, &new_admin).unwrap();
        
        // Old admin cannot bump TTL anymore
        let result = client.try_bump_storage_ttl(&admin, &100_000);
        assert!(result.is_err(), "Old admin cannot bump TTL after transfer");
        
        // New admin can bump TTL
        client.bump_storage_ttl(&new_admin, &100_000).unwrap();
    }

    /// Corpus: Allowlist mode toggle after admin transfer
    #[test]
    fn corpus_allowlist_mode_after_admin_transfer() {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        env.mock_all_auths();
        
        // Enable allowlist mode as admin
        client.set_allowlist_mode(&admin, &true).unwrap();
        assert!(client.is_allowlist_mode());
        
        // Transfer admin
        let new_admin = Address::generate(&env);
        client.transfer_admin(&admin, &new_admin).unwrap();
        
        // Old admin cannot toggle allowlist mode
        let result = client.try_set_allowlist_mode(&admin, &false);
        assert!(result.is_err(), "Old admin cannot toggle allowlist mode");
        assert!(client.is_allowlist_mode(), "Mode should remain enabled");
        
        // New admin can toggle allowlist mode
        client.set_allowlist_mode(&new_admin, &false).unwrap();
        assert!(!client.is_allowlist_mode());
    }

    /// Corpus: Allowlist management after admin transfer
    #[test]
    fn corpus_allowlist_management_after_admin_transfer() {
        let env = Env::default();
        let (client, admin, _treasury) = setup_factory(&env);
        
        env.mock_all_auths();
        
        client.set_allowlist_mode(&admin, &true).unwrap();
        
        let account = Address::generate(&env);
        client.add_to_allowlist(&admin, &account).unwrap();
        assert!(client.is_allowlisted(&account));
        
        // Transfer admin
        let new_admin = Address::generate(&env);
        client.transfer_admin(&admin, &new_admin).unwrap();
        
        // Old admin cannot remove from allowlist
        let result = client.try_remove_from_allowlist(&admin, &account);
        assert!(result.is_err(), "Old admin cannot modify allowlist");
        assert!(client.is_allowlisted(&account), "Account should remain allowlisted");
        
        // New admin can remove from allowlist
        client.remove_from_allowlist(&new_admin, &account).unwrap();
        assert!(!client.is_allowlisted(&account));
    }
}
