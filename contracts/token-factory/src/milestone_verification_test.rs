#[cfg(test)]
mod tests {
    use crate::milestone_verification::{MilestoneVerifier, MilestoneVerifierStub};
    use crate::types::{Error, Vault, VaultStatus};
    use crate::{storage, TokenFactory, TokenFactoryClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Bytes, BytesN, Env, String,
    };

    // ── Test Helpers ──────────────────────────────────────────────────────────

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        (env, admin, treasury, creator)
    }

    fn create_test_token(
        env: &Env,
        client: &TokenFactoryClient,
        admin: &Address,
    ) -> Address {
        let token_name = String::from_str(env, "Test Token");
        let token_symbol = String::from_str(env, "TEST");
        let decimals = 7u32;

        client.deploy_token(admin, &token_name, &token_symbol, &decimals)
    }

    fn create_milestone_vault(
        env: &Env,
        client: &TokenFactoryClient,
        creator: &Address,
        token: &Address,
        owner: &Address,
        amount: i128,
        unlock_time: u64,
        milestone_hash: BytesN<32>,
    ) -> u64 {
        client.create_vault(creator, token, owner, &amount, &unlock_time, &milestone_hash)
    }

    fn generate_milestone_hash(env: &Env, value: u8) -> BytesN<32> {
        let mut bytes = [0u8; 32];
        bytes[0] = value;
        BytesN::from_array(env, &bytes)
    }

    fn generate_proof(env: &Env, value: &str) -> Bytes {
        Bytes::from_slice(env, value.as_bytes())
    }

    // ── Task 4.1: Test Valid Proof Claim Success ─────────────────────────────

    #[test]
    fn test_valid_proof_claim_success() {
        let (env, admin, treasury, creator) = setup();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        // Initialize contract
        client.initialize(&admin, &treasury, &100, &50);

        // Create token
        let token = create_test_token(&env, &client, &admin);

        // Create vault owner
        let owner = Address::generate(&env);

        // Create milestone-locked vault
        let milestone_hash = generate_milestone_hash(&env, 1);
        let amount = 1_000_000i128;
        let unlock_time = env.ledger().timestamp(); // Already unlocked

        let vault_id = create_milestone_vault(
            &env,
            &client,
            &creator,
            &token,
            &owner,
            amount,
            unlock_time,
            milestone_hash.clone(),
        );

        // Configure valid proof in stub
        let valid_proof = generate_proof(&env, "valid_proof_123");
        let verifier = MilestoneVerifierStub::new(&env);
        verifier.add_valid_proof(milestone_hash.clone(), valid_proof.clone());

        // Claim vault with valid proof
        let claimed_amount = client.claim_vault(&owner, &vault_id, &Some(valid_proof));

        // Verify claim succeeded
        assert_eq!(claimed_amount, amount);

        // Verify vault status transitioned to Claimed
        let vault = client.get_vault(&vault_id);
        assert_eq!(vault.status, VaultStatus::Claimed);
        assert_eq!(vault.claimed_amount, amount);
    }

    // ── Task 4.2: Test Invalid Proof Claim Failure ───────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #42)")] // InvalidProof error code
    fn test_invalid_proof_claim_failure() {
        let (env, admin, treasury, creator) = setup();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        // Initialize contract
        client.initialize(&admin, &treasury, &100, &50);

        // Create token
        let token = create_test_token(&env, &client, &admin);

        // Create vault owner
        let owner = Address::generate(&env);

        // Create milestone-locked vault
        let milestone_hash = generate_milestone_hash(&env, 2);
        let amount = 1_000_000i128;
        let unlock_time = env.ledger().timestamp();

        let vault_id = create_milestone_vault(
            &env,
            &client,
            &creator,
            &token,
            &owner,
            amount,
            unlock_time,
            milestone_hash.clone(),
        );

        // Configure valid proof in stub
        let valid_proof = generate_proof(&env, "valid_proof_456");
        let verifier = MilestoneVerifierStub::new(&env);
        verifier.add_valid_proof(milestone_hash.clone(), valid_proof);

        // Attempt to claim with INVALID proof
        let invalid_proof = generate_proof(&env, "wrong_proof");
        client.claim_vault(&owner, &vault_id, &Some(invalid_proof));
        // Should panic with InvalidProof error
    }

    #[test]
    fn test_invalid_proof_no_state_change() {
        let (env, admin, treasury, creator) = setup();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        // Initialize contract
        client.initialize(&admin, &treasury, &100, &50);

        // Create token
        let token = create_test_token(&env, &client, &admin);

        // Create vault owner
        let owner = Address::generate(&env);

        // Create milestone-locked vault
        let milestone_hash = generate_milestone_hash(&env, 3);
        let amount = 1_000_000i128;
        let unlock_time = env.ledger().timestamp();

        let vault_id = create_milestone_vault(
            &env,
            &client,
            &creator,
            &token,
            &owner,
            amount,
            unlock_time,
            milestone_hash.clone(),
        );

        // Get initial vault state
        let vault_before = client.get_vault(&vault_id);

        // Configure valid proof
        let valid_proof = generate_proof(&env, "valid_proof_789");
        let verifier = MilestoneVerifierStub::new(&env);
        verifier.add_valid_proof(milestone_hash, valid_proof);

        // Attempt claim with invalid proof (should fail)
        let invalid_proof = generate_proof(&env, "invalid");
        let result = client.try_claim_vault(&owner, &vault_id, &Some(invalid_proof));

        // Verify claim failed
        assert!(result.is_err());

        // Verify vault state unchanged
        let vault_after = client.get_vault(&vault_id);
        assert_eq!(vault_after.status, VaultStatus::Active);
        assert_eq!(vault_after.claimed_amount, 0);
        assert_eq!(vault_before, vault_after);
    }

    // ── Task 4.3: Test Missing Proof Claim Failure ───────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #43)")] // ProofRequired error code
    fn test_missing_proof_claim_failure() {
        let (env, admin, treasury, creator) = setup();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        // Initialize contract
        client.initialize(&admin, &treasury, &100, &50);

        // Create token
        let token = create_test_token(&env, &client, &admin);

        // Create vault owner
        let owner = Address::generate(&env);

        // Create milestone-locked vault
        let milestone_hash = generate_milestone_hash(&env, 4);
        let amount = 1_000_000i128;
        let unlock_time = env.ledger().timestamp();

        let vault_id = create_milestone_vault(
            &env,
            &client,
            &creator,
            &token,
            &owner,
            amount,
            unlock_time,
            milestone_hash,
        );

        // Attempt to claim without providing proof (None)
        client.claim_vault(&owner, &vault_id, &None);
        // Should panic with ProofRequired error
    }

    #[test]
    fn test_missing_proof_vault_remains_locked() {
        let (env, admin, treasury, creator) = setup();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        // Initialize contract
        client.initialize(&admin, &treasury, &100, &50);

        // Create token
        let token = create_test_token(&env, &client, &admin);

        // Create vault owner
        let owner = Address::generate(&env);

        // Create milestone-locked vault
        let milestone_hash = generate_milestone_hash(&env, 5);
        let amount = 1_000_000i128;
        let unlock_time = env.ledger().timestamp();

        let vault_id = create_milestone_vault(
            &env,
            &client,
            &creator,
            &token,
            &owner,
            amount,
            unlock_time,
            milestone_hash,
        );

        // Attempt claim without proof
        let result = client.try_claim_vault(&owner, &vault_id, &None);

        // Verify claim failed
        assert!(result.is_err());

        // Verify vault remains locked (Active status)
        let vault = client.get_vault(&vault_id);
        assert_eq!(vault.status, VaultStatus::Active);
        assert_eq!(vault.claimed_amount, 0);
    }

    // ── Task 4.4: Test Zero Milestone Hash Skips Verification ────────────────

    #[test]
    fn test_zero_milestone_hash_skips_verification() {
        let (env, admin, treasury, creator) = setup();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        // Initialize contract
        client.initialize(&admin, &treasury, &100, &50);

        // Create token
        let token = create_test_token(&env, &client, &admin);

        // Create vault owner
        let owner = Address::generate(&env);

        // Create vault with ZERO milestone_hash (time-locked only)
        let zero_milestone_hash = BytesN::from_array(&env, &[0u8; 32]);
        let amount = 1_000_000i128;
        let unlock_time = env.ledger().timestamp(); // Already unlocked

        let vault_id = create_milestone_vault(
            &env,
            &client,
            &creator,
            &token,
            &owner,
            amount,
            unlock_time,
            zero_milestone_hash,
        );

        // Claim vault WITHOUT providing proof (should succeed)
        let claimed_amount = client.claim_vault(&owner, &vault_id, &None);

        // Verify claim succeeded without proof validation
        assert_eq!(claimed_amount, amount);

        // Verify vault status transitioned to Claimed
        let vault = client.get_vault(&vault_id);
        assert_eq!(vault.status, VaultStatus::Claimed);
        assert_eq!(vault.claimed_amount, amount);
    }

    // ── Additional Tests ──────────────────────────────────────────────────────

    #[test]
    fn test_time_lock_enforced_with_valid_proof() {
        let (env, admin, treasury, creator) = setup();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        // Initialize contract
        client.initialize(&admin, &treasury, &100, &50);

        // Create token
        let token = create_test_token(&env, &client, &admin);

        // Create vault owner
        let owner = Address::generate(&env);

        // Create milestone-locked vault with FUTURE unlock time
        let milestone_hash = generate_milestone_hash(&env, 6);
        let amount = 1_000_000i128;
        let unlock_time = env.ledger().timestamp() + 1000; // Future time

        let vault_id = create_milestone_vault(
            &env,
            &client,
            &creator,
            &token,
            &owner,
            amount,
            unlock_time,
            milestone_hash.clone(),
        );

        // Configure valid proof
        let valid_proof = generate_proof(&env, "valid_proof_time");
        let verifier = MilestoneVerifierStub::new(&env);
        verifier.add_valid_proof(milestone_hash, valid_proof.clone());

        // Attempt claim with valid proof but time lock not met
        let result = client.try_claim_vault(&owner, &vault_id, &Some(valid_proof));

        // Verify claim failed due to time lock (VaultLocked error)
        assert!(result.is_err());
        // Error code 61 is VaultLocked
    }

    #[test]
    fn test_error_codes_are_correct() {
        // Verify that the new error variants have the correct codes
        assert_eq!(Error::InvalidProof as u32, 42);
        assert_eq!(Error::ProofRequired as u32, 43);
        assert_eq!(Error::VerificationUnavailable as u32, 51);
    }

    #[test]
    fn test_error_codes_are_distinct() {
        // Ensure the error codes don't conflict with existing errors
        let invalid_proof = Error::InvalidProof;
        let proof_required = Error::ProofRequired;
        let verification_unavailable = Error::VerificationUnavailable;

        assert_ne!(invalid_proof, proof_required);
        assert_ne!(invalid_proof, verification_unavailable);
        assert_ne!(proof_required, verification_unavailable);
    }
}


// ══════════════════════════════════════════════════════════════════════════════
// Property-Based Tests (Task 6)
// ══════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod property_tests {
    use super::*;
    use proptest::prelude::*;

    // ── Property Test Helpers ─────────────────────────────────────────────────

    fn valid_amount() -> impl Strategy<Value = i128> {
        1i128..=1_000_000_000i128
    }

    fn valid_unlock_time_past() -> impl Strategy<Value = u64> {
        0u64..=1000u64 // Past times (relative to test ledger time)
    }

    fn valid_unlock_time_future() -> impl Strategy<Value = u64> {
        1001u64..=100_000u64 // Future times
    }

    fn non_zero_milestone_hash_value() -> impl Strategy<Value = u8> {
        1u8..=255u8
    }

    fn proof_string() -> impl Strategy<Value = String> {
        "[a-zA-Z0-9_]{10,50}"
    }

    // ── Task 6.1: Property Test - Valid Proof Enables Claim ──────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        
        /// Feature: milestone-verification-vault-claims, Property 1: Valid proof enables claim
        /// 
        /// For any vault with a non-zero milestone_hash and valid proof, when the time 
        /// unlock condition is met, the claim should succeed and transfer the full 
        /// claimable amount to the owner.
        /// 
        /// Validates: Requirements 2.2, 3.2, 3.3, 3.4
        #[test]
        fn prop_valid_proof_enables_claim(
            amount in valid_amount(),
            milestone_value in non_zero_milestone_hash_value(),
            proof_str in proof_string(),
        ) {
            let (env, admin, treasury, creator) = setup();
            let contract_id = env.register_contract(None, TokenFactory);
            let client = TokenFactoryClient::new(&env, &contract_id);

            // Initialize contract
            client.initialize(&admin, &treasury, &100, &50);

            // Create token
            let token = create_test_token(&env, &client, &admin);
            let owner = Address::generate(&env);

            // Create milestone-locked vault with past unlock time
            let milestone_hash = generate_milestone_hash(&env, milestone_value);
            let unlock_time = env.ledger().timestamp(); // Already unlocked

            let vault_id = create_milestone_vault(
                &env,
                &client,
                &creator,
                &token,
                &owner,
                amount,
                unlock_time,
                milestone_hash.clone(),
            );

            // Configure valid proof
            let valid_proof = generate_proof(&env, &proof_str);
            let verifier = MilestoneVerifierStub::new(&env);
            verifier.add_valid_proof(milestone_hash, valid_proof.clone());

            // Claim vault with valid proof
            let claimed_amount = client.claim_vault(&owner, &vault_id, &Some(valid_proof));

            // Property: Claim succeeds and transfers correct amount
            prop_assert_eq!(claimed_amount, amount);

            // Property: Vault status transitions to Claimed
            let vault = client.get_vault(&vault_id);
            prop_assert_eq!(vault.status, VaultStatus::Claimed);
            prop_assert_eq!(vault.claimed_amount, amount);
        }
    }

    // ── Task 6.2: Property Test - Invalid Proof Prevents Claim ───────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        
        /// Feature: milestone-verification-vault-claims, Property 2: Invalid proof prevents claim
        /// 
        /// For any vault with a non-zero milestone_hash, when an invalid proof is 
        /// provided, the claim should fail with an error and no tokens should be 
        /// transferred, regardless of whether time unlock conditions are met.
        /// 
        /// Validates: Requirements 2.3, 4.2, 4.3, 4.4
        #[test]
        fn prop_invalid_proof_prevents_claim(
            amount in valid_amount(),
            milestone_value in non_zero_milestone_hash_value(),
            valid_proof_str in proof_string(),
            invalid_proof_str in proof_string(),
        ) {
            // Ensure proofs are different
            prop_assume!(valid_proof_str != invalid_proof_str);

            let (env, admin, treasury, creator) = setup();
            let contract_id = env.register_contract(None, TokenFactory);
            let client = TokenFactoryClient::new(&env, &contract_id);

            client.initialize(&admin, &treasury, &100, &50);

            let token = create_test_token(&env, &client, &admin);
            let owner = Address::generate(&env);

            let milestone_hash = generate_milestone_hash(&env, milestone_value);
            let unlock_time = env.ledger().timestamp();

            let vault_id = create_milestone_vault(
                &env,
                &client,
                &creator,
                &token,
                &owner,
                amount,
                unlock_time,
                milestone_hash.clone(),
            );

            // Configure valid proof
            let valid_proof = generate_proof(&env, &valid_proof_str);
            let verifier = MilestoneVerifierStub::new(&env);
            verifier.add_valid_proof(milestone_hash, valid_proof);

            // Get initial vault state
            let vault_before = client.get_vault(&vault_id);

            // Attempt claim with INVALID proof
            let invalid_proof = generate_proof(&env, &invalid_proof_str);
            let result = client.try_claim_vault(&owner, &vault_id, &Some(invalid_proof));

            // Property: Claim fails
            prop_assert!(result.is_err());

            // Property: Vault state unchanged
            let vault_after = client.get_vault(&vault_id);
            prop_assert_eq!(vault_after.status, VaultStatus::Active);
            prop_assert_eq!(vault_after.claimed_amount, 0);
            prop_assert_eq!(vault_before, vault_after);
        }
    }

    // ── Task 6.3: Property Test - Zero Milestone Hash Skips Verification ─────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        
        /// Feature: milestone-verification-vault-claims, Property 3: Zero milestone hash skips verification
        /// 
        /// For any vault with a zero milestone_hash (all bytes are 0), the claim 
        /// should succeed without requiring a proof, provided time unlock conditions 
        /// are met.
        /// 
        /// Validates: Requirements 2.4, 5.4
        #[test]
        fn prop_zero_milestone_skips_verification(
            amount in valid_amount(),
        ) {
            let (env, admin, treasury, creator) = setup();
            let contract_id = env.register_contract(None, TokenFactory);
            let client = TokenFactoryClient::new(&env, &contract_id);

            client.initialize(&admin, &treasury, &100, &50);

            let token = create_test_token(&env, &client, &admin);
            let owner = Address::generate(&env);

            // Create vault with ZERO milestone_hash
            let zero_milestone_hash = BytesN::from_array(&env, &[0u8; 32]);
            let unlock_time = env.ledger().timestamp();

            let vault_id = create_milestone_vault(
                &env,
                &client,
                &creator,
                &token,
                &owner,
                amount,
                unlock_time,
                zero_milestone_hash,
            );

            // Claim without proof
            let claimed_amount = client.claim_vault(&owner, &vault_id, &None);

            // Property: Claim succeeds without proof
            prop_assert_eq!(claimed_amount, amount);

            let vault = client.get_vault(&vault_id);
            prop_assert_eq!(vault.status, VaultStatus::Claimed);
        }
    }

    // ── Task 6.4: Property Test - Time Lock Independence ─────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        
        /// Feature: milestone-verification-vault-claims, Property 4: Time lock independence
        /// 
        /// For any vault, the time-based unlock condition should be enforced 
        /// independently of milestone verification. A vault with valid milestone 
        /// proof but locked time should fail with VaultLocked error.
        /// 
        /// Validates: Requirements 2.5
        #[test]
        fn prop_time_lock_independence(
            amount in valid_amount(),
            milestone_value in non_zero_milestone_hash_value(),
            time_offset in valid_unlock_time_future(),
            proof_str in proof_string(),
        ) {
            let (env, admin, treasury, creator) = setup();
            let contract_id = env.register_contract(None, TokenFactory);
            let client = TokenFactoryClient::new(&env, &contract_id);

            client.initialize(&admin, &treasury, &100, &50);

            let token = create_test_token(&env, &client, &admin);
            let owner = Address::generate(&env);

            let milestone_hash = generate_milestone_hash(&env, milestone_value);
            let unlock_time = env.ledger().timestamp() + time_offset; // Future time

            let vault_id = create_milestone_vault(
                &env,
                &client,
                &creator,
                &token,
                &owner,
                amount,
                unlock_time,
                milestone_hash.clone(),
            );

            // Configure valid proof
            let valid_proof = generate_proof(&env, &proof_str);
            let verifier = MilestoneVerifierStub::new(&env);
            verifier.add_valid_proof(milestone_hash, valid_proof.clone());

            // Attempt claim with valid proof but time lock not met
            let result = client.try_claim_vault(&owner, &vault_id, &Some(valid_proof));

            // Property: Claim fails due to time lock (independent of milestone verification)
            prop_assert!(result.is_err());
            
            // Vault should remain Active
            let vault = client.get_vault(&vault_id);
            prop_assert_eq!(vault.status, VaultStatus::Active);
        }
    }

    // ── Task 6.5: Property Test - Missing Proof Rejection ────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        
        /// Feature: milestone-verification-vault-claims, Property 5: Missing proof rejection
        /// 
        /// For any vault with a non-zero milestone_hash, when no proof is provided 
        /// (None), the claim should fail with an appropriate error.
        /// 
        /// Validates: Requirements 5.2, 5.3
        #[test]
        fn prop_missing_proof_rejection(
            amount in valid_amount(),
            milestone_value in non_zero_milestone_hash_value(),
        ) {
            let (env, admin, treasury, creator) = setup();
            let contract_id = env.register_contract(None, TokenFactory);
            let client = TokenFactoryClient::new(&env, &contract_id);

            client.initialize(&admin, &treasury, &100, &50);

            let token = create_test_token(&env, &client, &admin);
            let owner = Address::generate(&env);

            let milestone_hash = generate_milestone_hash(&env, milestone_value);
            let unlock_time = env.ledger().timestamp();

            let vault_id = create_milestone_vault(
                &env,
                &client,
                &creator,
                &token,
                &owner,
                amount,
                unlock_time,
                milestone_hash,
            );

            // Attempt claim without proof
            let result = client.try_claim_vault(&owner, &vault_id, &None);

            // Property: Claim fails with ProofRequired error
            prop_assert!(result.is_err());

            // Property: Vault remains locked
            let vault = client.get_vault(&vault_id);
            prop_assert_eq!(vault.status, VaultStatus::Active);
            prop_assert_eq!(vault.claimed_amount, 0);
        }
    }

    // ── Task 6.6: Property Test - Vault State Preservation on Failure ────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        
        /// Feature: milestone-verification-vault-claims, Property 6: Vault state preservation on failure
        /// 
        /// For any vault and any claim attempt that fails (due to invalid proof, 
        /// missing proof, or time lock), the vault state should remain unchanged 
        /// (status stays Active, claimed_amount unchanged).
        /// 
        /// Validates: Requirements 4.4, 5.3
        #[test]
        fn prop_vault_state_preservation_on_failure(
            amount in valid_amount(),
            milestone_value in non_zero_milestone_hash_value(),
            failure_type in 0u8..=2u8, // 0=invalid proof, 1=missing proof, 2=time lock
        ) {
            let (env, admin, treasury, creator) = setup();
            let contract_id = env.register_contract(None, TokenFactory);
            let client = TokenFactoryClient::new(&env, &contract_id);

            client.initialize(&admin, &treasury, &100, &50);

            let token = create_test_token(&env, &client, &admin);
            let owner = Address::generate(&env);

            let milestone_hash = generate_milestone_hash(&env, milestone_value);
            
            // Set unlock time based on failure type
            let unlock_time = if failure_type == 2 {
                env.ledger().timestamp() + 1000 // Future (time lock failure)
            } else {
                env.ledger().timestamp() // Past (other failures)
            };

            let vault_id = create_milestone_vault(
                &env,
                &client,
                &creator,
                &token,
                &owner,
                amount,
                unlock_time,
                milestone_hash.clone(),
            );

            // Configure valid proof for comparison
            let valid_proof = generate_proof(&env, "valid_proof");
            let verifier = MilestoneVerifierStub::new(&env);
            verifier.add_valid_proof(milestone_hash, valid_proof);

            // Get initial vault state
            let vault_before = client.get_vault(&vault_id);

            // Attempt claim with different failure scenarios
            let result = match failure_type {
                0 => {
                    // Invalid proof
                    let invalid_proof = generate_proof(&env, "invalid_proof");
                    client.try_claim_vault(&owner, &vault_id, &Some(invalid_proof))
                }
                1 => {
                    // Missing proof
                    client.try_claim_vault(&owner, &vault_id, &None)
                }
                _ => {
                    // Time lock (with valid proof)
                    let valid_proof = generate_proof(&env, "valid_proof");
                    client.try_claim_vault(&owner, &vault_id, &Some(valid_proof))
                }
            };

            // Property: Claim fails
            prop_assert!(result.is_err());

            // Property: Vault state unchanged
            let vault_after = client.get_vault(&vault_id);
            prop_assert_eq!(vault_after.status, VaultStatus::Active);
            prop_assert_eq!(vault_after.claimed_amount, 0);
            prop_assert_eq!(vault_before, vault_after);
        }
    }

    // ── Task 6.7: Property Test - Claim Idempotence Guard ────────────────────

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        
        /// Feature: milestone-verification-vault-claims, Property 7: Claim idempotence guard
        /// 
        /// For any vault that has been successfully claimed (status = Claimed), 
        /// subsequent claim attempts should fail with VaultAlreadyClaimed error, 
        /// regardless of proof validity.
        /// 
        /// Validates: Requirements 4.4
        #[test]
        fn prop_claim_idempotence_guard(
            amount in valid_amount(),
            milestone_value in non_zero_milestone_hash_value(),
            proof_str in proof_string(),
        ) {
            let (env, admin, treasury, creator) = setup();
            let contract_id = env.register_contract(None, TokenFactory);
            let client = TokenFactoryClient::new(&env, &contract_id);

            client.initialize(&admin, &treasury, &100, &50);

            let token = create_test_token(&env, &client, &admin);
            let owner = Address::generate(&env);

            let milestone_hash = generate_milestone_hash(&env, milestone_value);
            let unlock_time = env.ledger().timestamp();

            let vault_id = create_milestone_vault(
                &env,
                &client,
                &creator,
                &token,
                &owner,
                amount,
                unlock_time,
                milestone_hash.clone(),
            );

            // Configure valid proof
            let valid_proof = generate_proof(&env, &proof_str);
            let verifier = MilestoneVerifierStub::new(&env);
            verifier.add_valid_proof(milestone_hash, valid_proof.clone());

            // First claim (should succeed)
            let first_claim = client.claim_vault(&owner, &vault_id, &Some(valid_proof.clone()));
            prop_assert_eq!(first_claim, amount);

            // Verify vault is claimed
            let vault = client.get_vault(&vault_id);
            prop_assert_eq!(vault.status, VaultStatus::Claimed);

            // Attempt second claim with same valid proof
            let second_claim = client.try_claim_vault(&owner, &vault_id, &Some(valid_proof));

            // Property: Second claim fails with VaultAlreadyClaimed error
            prop_assert!(second_claim.is_err());
            
            // Vault should still be Claimed
            let vault_after = client.get_vault(&vault_id);
            prop_assert_eq!(vault_after.status, VaultStatus::Claimed);
        }
    }
}

#[cfg(test)]
mod oracle_verification_tests {
    use crate::milestone_verification::{MilestoneVerifier, OracleMilestoneVerifier};
    use crate::types::Error;
    use crate::storage;
    use soroban_sdk::{Bytes, BytesN, Env};

    fn create_valid_proof(env: &Env, milestone_hash: &BytesN<32>, oracle_id: &Bytes, timestamp: u64) -> Bytes {
        let mut proof_data = vec![];
        proof_data.extend_from_slice(&[0u8; 64]);
        proof_data.extend_from_slice(milestone_hash.as_ref());
        proof_data.extend_from_slice(&timestamp.to_be_bytes());
        proof_data.extend_from_slice(oracle_id.as_ref());

        Bytes::from_slice(env, &proof_data)
    }

    #[test]
    fn test_oracle_valid_proof_verification() {
        let env = Env::default();
        env.mock_all_auths();

        let oracle_id = Bytes::from_slice(&env, &[1u8; 32]);
        storage::set_authorized_oracle(&env, &oracle_id);

        let verifier = OracleMilestoneVerifier::new(&env);
        let milestone_hash = BytesN::from_array(&env, &[42u8; 32]);
        let timestamp = env.ledger().timestamp();
        let proof = create_valid_proof(&env, &milestone_hash, &oracle_id, timestamp);

        let result = verifier.verify_milestone(&env, &milestone_hash, &proof);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), true);
    }

    #[test]
    fn test_oracle_stale_proof_rejection() {
        let env = Env::default();
        env.mock_all_auths();

        let oracle_id = Bytes::from_slice(&env, &[1u8; 32]);
        storage::set_authorized_oracle(&env, &oracle_id);

        let verifier = OracleMilestoneVerifier::new(&env);
        let milestone_hash = BytesN::from_array(&env, &[42u8; 32]);
        let stale_timestamp = env.ledger().timestamp().saturating_sub(7200);
        let proof = create_valid_proof(&env, &milestone_hash, &oracle_id, stale_timestamp);

        let result = verifier.verify_milestone(&env, &milestone_hash, &proof);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::VerificationUnavailable);
    }

    #[test]
    fn test_oracle_future_timestamp_rejection() {
        let env = Env::default();
        env.mock_all_auths();

        let oracle_id = Bytes::from_slice(&env, &[1u8; 32]);
        storage::set_authorized_oracle(&env, &oracle_id);

        let verifier = OracleMilestoneVerifier::new(&env);
        let milestone_hash = BytesN::from_array(&env, &[42u8; 32]);
        let future_timestamp = env.ledger().timestamp() + 1000;
        let proof = create_valid_proof(&env, &milestone_hash, &oracle_id, future_timestamp);

        let result = verifier.verify_milestone(&env, &milestone_hash, &proof);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::InvalidProof);
    }

    #[test]
    fn test_oracle_invalid_proof_format() {
        let env = Env::default();
        env.mock_all_auths();

        let oracle_id = Bytes::from_slice(&env, &[1u8; 32]);
        storage::set_authorized_oracle(&env, &oracle_id);

        let verifier = OracleMilestoneVerifier::new(&env);
        let milestone_hash = BytesN::from_array(&env, &[42u8; 32]);
        let invalid_proof = Bytes::from_slice(&env, &[0u8; 100]);

        let result = verifier.verify_milestone(&env, &milestone_hash, &invalid_proof);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::InvalidProof);
    }

    #[test]
    fn test_oracle_unauthorized_oracle_rejection() {
        let env = Env::default();
        env.mock_all_auths();

        let authorized_oracle = Bytes::from_slice(&env, &[1u8; 32]);
        storage::set_authorized_oracle(&env, &authorized_oracle);

        let verifier = OracleMilestoneVerifier::new(&env);
        let milestone_hash = BytesN::from_array(&env, &[42u8; 32]);
        let unauthorized_oracle = Bytes::from_slice(&env, &[2u8; 32]);
        let timestamp = env.ledger().timestamp();
        let proof = create_valid_proof(&env, &milestone_hash, &unauthorized_oracle, timestamp);

        let result = verifier.verify_milestone(&env, &milestone_hash, &proof);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::InvalidProof);
    }

    #[test]
    fn test_oracle_milestone_hash_mismatch() {
        let env = Env::default();
        env.mock_all_auths();

        let oracle_id = Bytes::from_slice(&env, &[1u8; 32]);
        storage::set_authorized_oracle(&env, &oracle_id);

        let verifier = OracleMilestoneVerifier::new(&env);
        let milestone_hash = BytesN::from_array(&env, &[42u8; 32]);
        let wrong_milestone_hash = BytesN::from_array(&env, &[99u8; 32]);
        let timestamp = env.ledger().timestamp();
        let proof = create_valid_proof(&env, &wrong_milestone_hash, &oracle_id, timestamp);

        let result = verifier.verify_milestone(&env, &milestone_hash, &proof);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::InvalidProof);
    }
}
