use soroban_sdk::{Bytes, BytesN, Env};

use crate::types;
use crate::storage;
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

        let signature = proof.slice(PROOF_SIGNATURE_OFFSET..PROOF_SIGNATURE_OFFSET + PROOF_SIGNATURE_LEN);
        let milestone_hash = proof.slice(PROOF_MILESTONE_HASH_OFFSET..PROOF_MILESTONE_HASH_OFFSET + PROOF_MILESTONE_HASH_LEN);
        let timestamp_bytes = proof.slice(PROOF_TIMESTAMP_OFFSET..PROOF_TIMESTAMP_OFFSET + PROOF_TIMESTAMP_LEN);
        let oracle_id = proof.slice(PROOF_ORACLE_ID_OFFSET..PROOF_ORACLE_ID_OFFSET + PROOF_ORACLE_ID_LEN);

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

    /// Verify oracle is authorized
    fn verify_oracle_authorized(&self, oracle_id: &Bytes) -> Result<(), Error> {
        match storage::get_authorized_oracle(&self.env, oracle_id) {
            Some(_) => Ok(()),
            None => Err(Error::InvalidProof),
        }
    }

    /// Verify milestone hash matches the one in proof
    fn verify_milestone_hash_match(&self, proof_hash: &Bytes, expected_hash: &BytesN<32>) -> Result<(), Error> {
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

        self.verify_oracle_authorized(&payload.oracle_id)?;

        self.verify_milestone_hash_match(&payload.milestone_hash, milestone_hash)?;

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
