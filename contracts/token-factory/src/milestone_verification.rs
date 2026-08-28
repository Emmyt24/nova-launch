use soroban_sdk::{Bytes, BytesN, Env};

use crate::storage;
use crate::types;
use types::Error;

const PROOF_SIGNATURE_OFFSET: u32 = 0;
const PROOF_SIGNATURE_LEN: u32 = 64;
const PROOF_MILESTONE_HASH_OFFSET: u32 = 64;
const PROOF_MILESTONE_HASH_LEN: u32 = 32;
const PROOF_TIMESTAMP_OFFSET: u32 = 96;
const PROOF_TIMESTAMP_LEN: u32 = 8;
const PROOF_ORACLE_ID_OFFSET: u32 = 104;
const PROOF_ORACLE_ID_LEN: u32 = 32;
const TOTAL_PROOF_LEN: u32 = 136;

const STALENESS_THRESHOLD_SECONDS: u64 = 3600;

/// Trait for milestone proof verification
///
/// This interface is designed to be implemented by external oracle services
/// or proof providers.
pub trait MilestoneVerifier {
    /// Verify that a milestone has been completed
    ///
    /// # Parameters
    /// - `env`: Contract environment
    /// - `milestone_hash`: 32-byte hash identifying the milestone
    /// - `proof`: Cryptographic proof of milestone completion (136 bytes)
    ///
    /// # Returns
    /// - `Ok(true)` if proof is valid
    /// - `Ok(false)` if proof is invalid
    /// - `Err(Error)` if verification cannot be performed (stale proof, invalid format)
    ///
    /// # Proof Format
    /// ```text
    /// Proof Structure (136 bytes total):
    /// ┌─────────────────────────────────────┐
    /// │ Signature (64 bytes)                │  Oracle signature
    /// ├─────────────────────────────────────┤
    /// │ Milestone Hash (32 bytes)           │  Hash being verified
    /// ├─────────────────────────────────────┤
    /// │ Timestamp (8 bytes)                 │  Proof generation time (u64)
    /// ├─────────────────────────────────────┤
    /// │ Oracle ID (32 bytes)                │  Proof provider identifier
    /// └─────────────────────────────────────┘
    /// ```
    fn verify_milestone(
        &self,
        env: &Env,
        milestone_hash: &BytesN<32>,
        proof: &Bytes,
    ) -> Result<bool, Error>;
}

/// Oracle-based milestone verifier with real cryptographic validation
///
/// This implementation validates proofs by checking:
/// 1. Proof structure (136 bytes total)
/// 2. Proof timestamp is recent (within staleness threshold)
/// 3. Milestone hash matches the one in the proof payload
/// 4. Oracle ID is from an authorized provider
pub struct OracleMilestoneVerifier {
    env: Env,
}

impl OracleMilestoneVerifier {
    /// Create a new oracle verifier instance
    pub fn new(env: &Env) -> Self {
        Self { env: env.clone() }
    }

    /// Extract and validate proof structure
    fn parse_proof(&self, proof: &Bytes) -> Result<ProofPayload, Error> {
        if proof.len() != TOTAL_PROOF_LEN {
            return Err(Error::InvalidProof);
        }

        let signature =
            proof.slice(PROOF_SIGNATURE_OFFSET..PROOF_SIGNATURE_OFFSET + PROOF_SIGNATURE_LEN);
        let milestone_hash = proof.slice(
            PROOF_MILESTONE_HASH_OFFSET..PROOF_MILESTONE_HASH_OFFSET + PROOF_MILESTONE_HASH_LEN,
        );
        let timestamp_bytes =
            proof.slice(PROOF_TIMESTAMP_OFFSET..PROOF_TIMESTAMP_OFFSET + PROOF_TIMESTAMP_LEN);
        let oracle_id =
            proof.slice(PROOF_ORACLE_ID_OFFSET..PROOF_ORACLE_ID_OFFSET + PROOF_ORACLE_ID_LEN);

        let mut ts_array = [0u8; 8];
        for i in 0..8 {
            ts_array[i] = timestamp_bytes.get(i as u32).ok_or(Error::InvalidProof)?;
        }
        let timestamp = u64::from_be_bytes(ts_array);

        Ok(ProofPayload {
            signature,
            milestone_hash,
            timestamp,
            oracle_id,
        })
    }

    /// Verify proof timestamp is not stale
    fn verify_timestamp(&self, proof_timestamp: u64, current_timestamp: u64) -> Result<(), Error> {
        if proof_timestamp > current_timestamp {
            return Err(Error::InvalidProof);
        }

        let age = current_timestamp - proof_timestamp;
        if age > STALENESS_THRESHOLD_SECONDS {
            return Err(Error::VerificationUnavailable);
        }

        Ok(())
    }

    /// Verify oracle is authorized, returning its registered ed25519 public key.
    fn verify_oracle_authorized(&self, oracle_id: &Bytes) -> Result<BytesN<32>, Error> {
        storage::get_authorized_oracle(&self.env, oracle_id).ok_or(Error::InvalidProof)
    }

    /// Verify milestone hash matches the one in proof
    fn verify_milestone_hash_match(
        &self,
        proof_hash: &Bytes,
        expected_hash: &BytesN<32>,
    ) -> Result<(), Error> {
        if proof_hash.len() != 32 {
            return Err(Error::InvalidProof);
        }

        for i in 0..32 {
            let proof_byte = proof_hash.get(i as u32).ok_or(Error::InvalidProof)?;
            if proof_byte != expected_hash.get(i as u32).ok_or(Error::InvalidProof)? {
                return Err(Error::InvalidProof);
            }
        }

        Ok(())
    }

    /// Cryptographically verify that `signature` is a valid ed25519 signature
    /// by `public_key` over `message`.
    ///
    /// # Panics
    /// Panics (via `env.crypto().ed25519_verify`) if the signature is invalid
    /// for the given public key and message — this aborts the whole
    /// invocation rather than returning gracefully, which is the standard
    /// Soroban pattern for cryptographic verification failures.
    fn verify_signature(
        &self,
        signature: &Bytes,
        message: &Bytes,
        public_key: &BytesN<32>,
    ) -> Result<(), Error> {
        if signature.len() != PROOF_SIGNATURE_LEN {
            return Err(Error::InvalidProof);
        }

        let mut sig_array = [0u8; PROOF_SIGNATURE_LEN as usize];
        for i in 0..PROOF_SIGNATURE_LEN {
            sig_array[i as usize] = signature.get(i).ok_or(Error::InvalidProof)?;
        }
        let signature_bytes = BytesN::from_array(&self.env, &sig_array);

        self.env
            .crypto()
            .ed25519_verify(public_key, message, &signature_bytes);

        Ok(())
    }
}

/// Parsed proof payload for validation
struct ProofPayload {
    signature: Bytes,
    milestone_hash: Bytes,
    timestamp: u64,
    oracle_id: Bytes,
}

/// Test-only verifier stub for development and testing
pub struct MilestoneVerifierStub {
    env: Env,
}

impl MilestoneVerifierStub {
    /// Create a new verification stub instance
    pub fn new(env: &Env) -> Self {
        Self { env: env.clone() }
    }

    /// Configure a valid proof for testing purposes
    pub fn add_valid_proof(&self, milestone_hash: BytesN<32>, proof: Bytes) {
        storage::set_valid_proof(&self.env, &milestone_hash, &proof);
    }
}

impl MilestoneVerifier for OracleMilestoneVerifier {
    fn verify_milestone(
        &self,
        env: &Env,
        milestone_hash: &BytesN<32>,
        proof: &Bytes,
    ) -> Result<bool, Error> {
        let payload = self.parse_proof(proof)?;

        let current_timestamp = env.ledger().timestamp();
        self.verify_timestamp(payload.timestamp, current_timestamp)?;

        let public_key = self.verify_oracle_authorized(&payload.oracle_id)?;

        self.verify_milestone_hash_match(&payload.milestone_hash, milestone_hash)?;

        // Verify the oracle's signature over everything in the proof besides
        // the signature itself (milestone_hash || timestamp || oracle_id),
        // proving the named oracle actually produced this proof.
        let signed_message = proof.slice(PROOF_MILESTONE_HASH_OFFSET..TOTAL_PROOF_LEN);
        self.verify_signature(&payload.signature, &signed_message, &public_key)?;

        Ok(true)
    }
}

impl MilestoneVerifier for MilestoneVerifierStub {
    fn verify_milestone(
        &self,
        _env: &Env,
        milestone_hash: &BytesN<32>,
        proof: &Bytes,
    ) -> Result<bool, Error> {
        match storage::get_valid_proof(&self.env, milestone_hash) {
            Some(expected_proof) => Ok(expected_proof == *proof),
            None => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::{testutils::Address as _, Address};
    use std::vec::Vec as StdVec;

    fn oracle_id_bytes(env: &Env) -> Bytes {
        Bytes::from_slice(env, &[1u8; 32])
    }

    /// Builds the canonical signed message (milestone_hash || timestamp ||
    /// oracle_id) and a 136-byte proof around a given 64-byte signature.
    fn build_proof(
        env: &Env,
        milestone_hash: &BytesN<32>,
        timestamp: u64,
        oracle_id: &Bytes,
        signature: &[u8; 64],
    ) -> Bytes {
        let mut bytes = StdVec::with_capacity(TOTAL_PROOF_LEN as usize);
        bytes.extend_from_slice(signature);
        bytes.extend_from_slice(&milestone_hash.to_array());
        bytes.extend_from_slice(&timestamp.to_be_bytes());
        for i in 0..32 {
            bytes.push(oracle_id.get(i).unwrap());
        }
        Bytes::from_slice(env, &bytes)
    }

    fn signed_message(milestone_hash: &BytesN<32>, timestamp: u64, oracle_id: &Bytes) -> StdVec<u8> {
        let mut message = StdVec::with_capacity(72);
        message.extend_from_slice(&milestone_hash.to_array());
        message.extend_from_slice(&timestamp.to_be_bytes());
        for i in 0..32 {
            message.push(oracle_id.get(i).unwrap());
        }
        message
    }

    fn deploy(env: &Env) -> Address {
        env.register_contract(None, crate::TokenFactory)
    }

    #[test]
    fn valid_signature_from_registered_oracle_is_accepted() {
        let env = Env::default();
        let contract_id = deploy(&env);
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let public_key = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let oracle_id = oracle_id_bytes(&env);
        let milestone_hash = BytesN::from_array(&env, &[42u8; 32]);
        let timestamp = env.ledger().timestamp();
        let message = signed_message(&milestone_hash, timestamp, &oracle_id);
        let signature = signing_key.sign(&message).to_bytes();
        let proof = build_proof(&env, &milestone_hash, timestamp, &oracle_id, &signature);

        env.as_contract(&contract_id, || {
            storage::set_authorized_oracle(&env, &oracle_id, &public_key);

            let verifier = OracleMilestoneVerifier::new(&env);
            let result = verifier.verify_milestone(&env, &milestone_hash, &proof);
            assert_eq!(result, Ok(true));
        });
    }

    #[test]
    #[should_panic]
    fn forged_signature_with_otherwise_valid_fields_is_rejected() {
        let env = Env::default();
        let contract_id = deploy(&env);
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let public_key = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let oracle_id = oracle_id_bytes(&env);
        let milestone_hash = BytesN::from_array(&env, &[42u8; 32]);
        let timestamp = env.ledger().timestamp();

        // Correct hash/timestamp/oracle_id, but a garbage (all-zero) signature
        // that was never produced by the registered oracle's private key.
        let forged_signature = [0u8; 64];
        let proof = build_proof(&env, &milestone_hash, timestamp, &oracle_id, &forged_signature);

        env.as_contract(&contract_id, || {
            storage::set_authorized_oracle(&env, &oracle_id, &public_key);

            let verifier = OracleMilestoneVerifier::new(&env);
            // Must not be accepted — panics via ed25519_verify rather than
            // returning Ok(true), so this whole invocation would abort on-chain.
            let _ = verifier.verify_milestone(&env, &milestone_hash, &proof);
        });
    }

    #[test]
    #[should_panic]
    fn signature_from_a_different_keypair_is_rejected() {
        let env = Env::default();
        let contract_id = deploy(&env);
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let attacker_key = SigningKey::from_bytes(&[9u8; 32]);
        let public_key = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());

        let oracle_id = oracle_id_bytes(&env);
        let milestone_hash = BytesN::from_array(&env, &[42u8; 32]);
        let timestamp = env.ledger().timestamp();
        let message = signed_message(&milestone_hash, timestamp, &oracle_id);

        // Valid signature, but produced by a different (unauthorized) key.
        let signature = attacker_key.sign(&message).to_bytes();
        let proof = build_proof(&env, &milestone_hash, timestamp, &oracle_id, &signature);

        env.as_contract(&contract_id, || {
            storage::set_authorized_oracle(&env, &oracle_id, &public_key);

            let verifier = OracleMilestoneVerifier::new(&env);
            let _ = verifier.verify_milestone(&env, &milestone_hash, &proof);
        });
    }

    #[test]
    fn unauthorized_oracle_id_is_still_rejected_before_signature_check() {
        let env = Env::default();
        let contract_id = deploy(&env);
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        // Note: no storage::set_authorized_oracle call — oracle_id below is unregistered.
        let oracle_id = oracle_id_bytes(&env);

        let milestone_hash = BytesN::from_array(&env, &[42u8; 32]);
        let timestamp = env.ledger().timestamp();
        let message = signed_message(&milestone_hash, timestamp, &oracle_id);
        let signature = signing_key.sign(&message).to_bytes();
        let proof = build_proof(&env, &milestone_hash, timestamp, &oracle_id, &signature);

        env.as_contract(&contract_id, || {
            let verifier = OracleMilestoneVerifier::new(&env);
            let result = verifier.verify_milestone(&env, &milestone_hash, &proof);
            assert_eq!(result, Err(Error::InvalidProof));
        });
    }
}
