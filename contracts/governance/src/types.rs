//! Governance Delegation System — Type Definitions
//!
//! Defines all on-chain data structures, storage keys, and error codes
//! used by the governance delegation contract.
//!
//! This module contains two sets of types:
//!  1. Delegation system types (vote-power transfer, snapshots)
//!  2. Proposal/voting types (on-chain governance proposals)

#![allow(dead_code)]

use soroban_sdk::{contracttype, contracterror, Address, String};

// ─── Storage keys ──────────────────────────────────────────────────────────

/// Discriminated union of every key written to contract storage.
///
/// Using a typed enum prevents key collisions and makes storage
/// access self-documenting.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    // ── Delegation system keys ──────────────────────────────────────────
    /// Contract admin address (instance storage)
    Admin,
    /// Whether the contract is paused (instance storage)
    Paused,
    /// Total token supply snapshot used for vote-power calculation (instance)
    TotalSupply,
    /// Holder's raw token balance: Balance(holder)
    Balance(Address),
    /// Who `delegator` has delegated their vote power to: Delegate(delegator)
    Delegate(Address),
    /// Accumulated vote power of `delegatee` (sum of all delegators + own balance)
    VotePower(Address),
    /// Nonce for replay-protection on delegation signatures: Nonce(address)
    Nonce(Address),
    /// Snapshot of vote power at a given ledger: Snapshot(address, ledger_seq)
    Snapshot(Address, u32),

    // ── Proposal/voting system keys ─────────────────────────────────────
    /// Address of the associated token contract
    TokenAddress,
    /// Total number of proposals created
    ProposalCount,
    /// Individual proposal by ID
    Proposal(u32),
    /// Vote cast by a specific voter on a specific proposal
    Vote(u32, Address),

    // ── Cross-contract settlement (#1624) ───────────────────────────────
    /// Address of the deployed token-factory contract this governance
    /// instance is authorized to disburse treasury payouts through.
    TokenFactory,
}

// ─── Delegation structs ────────────────────────────────────────────────────

/// A single delegation record stored on-chain.
///
/// Records who delegated to whom and when, enabling full audit trails.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DelegationRecord {
    /// The address that is delegating its vote power
    pub delegator: Address,
    /// The address receiving the delegated vote power
    pub delegatee: Address,
    /// Ledger sequence number when the delegation was created/updated
    pub since_ledger: u32,
}

/// A historical vote-power snapshot for a given address at a ledger.
///
/// Used to query vote power at a past point in time (e.g. for proposal
/// eligibility checks that must use a fixed snapshot).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VotePowerSnapshot {
    /// The address whose vote power is recorded
    pub address: Address,
    /// Ledger sequence at which this snapshot was taken
    pub ledger: u32,
    /// Vote power at that ledger
    pub power: i128,
}

// ─── Proposal/voting structs ───────────────────────────────────────────────

/// An on-chain governance proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GovernanceProposal {
    pub id: u32,
    pub creator: Address,
    pub description: String,
    pub voting_end: u64,
    pub quorum: i128,
    pub threshold_percent: u32,
    pub votes_for: i128,
    pub votes_against: i128,
    pub payload: soroban_sdk::Bytes,
    pub status: ProposalStatus,
    /// Treasury payout to disburse through token-factory on execution, if any.
    pub disbursement: Option<Disbursement>,
}

/// A treasury payout a passed proposal disburses through token-factory's
/// two-phase settlement protocol (`prepare_settlement` → `commit_settlement`)
/// when executed. See `settlement::execute_disbursement`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Disbursement {
    pub recipient: Address,
    pub token_index: u32,
    pub amount: i128,
}

/// Status of a governance proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Rejected,
    Failed,
    Executed,
}

/// A single vote cast on a proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalVote {
    pub voter: Address,
    pub proposal_id: u32,
    pub weight: i128,
    pub in_favor: bool,
}

// ─── Error codes ───────────────────────────────────────────────────────────

/// Errors for the delegation system.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    /// Contract has already been initialized
    AlreadyInitialized = 1,
    /// Caller is not authorized to perform this action
    Unauthorized = 2,
    /// One or more parameters are invalid (zero amount, self-delegation, etc.)
    InvalidParameters = 3,
    /// The requested address or record was not found
    NotFound = 4,
    /// Arithmetic overflow or underflow detected
    ArithmeticError = 5,
    /// Contract is paused; write operations are disabled
    ContractPaused = 6,
    /// Delegation chain would exceed the maximum allowed depth
    DelegationChainTooDeep = 7,
    /// Delegator has insufficient balance to delegate
    InsufficientBalance = 8,
    /// Circular delegation detected (A→B→A)
    CircularDelegation = 9,
    /// Snapshot not found for the requested ledger
    SnapshotNotFound = 10,
}

/// Errors for the proposal voting system.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VoteError {
    ProposalNotFound = 1,
    ProposalNotActive = 2,
    AlreadyVoted = 3,
    InsufficientBalance = 4,
    VotingPeriodEnded = 5,
    NotInitialized = 6,
    AlreadyInitialized = 7,
    Overflow = 8,
}

/// Errors for proposal finalization.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FinalizationError {
    ProposalNotFound = 1,
    VotingPeriodNotEnded = 2,
    AlreadyFinalized = 3,
    AlreadyExecuted = 4,
    ProposalNotPassed = 5,
    /// Checked arithmetic overflow during vote-total or threshold computation
    ArithmeticOverflow = 6,
    /// Proposal has a disbursement but no token-factory address is configured
    TokenFactoryNotConfigured = 7,
    /// token-factory rejected or failed to commit the settlement
    DisbursementFailed = 8,
}
