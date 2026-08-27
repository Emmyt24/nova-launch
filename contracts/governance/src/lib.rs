//! Governance contract — public entry points.
//!
//! This crate provides an on-chain governance system for the Nova Launch
//! platform. It supports:
//!
//! - **Vote-power delegation** (`delegate`, `undelegate`)
//! - **Proposal lifecycle** (`create_proposal`, `cast_vote`, `finalize_proposal`,
//!   `execute_proposal`)
//! - **Vote-power snapshots** (`take_snapshot`, `get_snapshot_power`)
//! - **Admin controls** (`initialize`, `set_balance`, `transfer_admin`,
//!   `pause`, `unpause`)
#![no_std]
#![warn(missing_docs)]

mod delegation;
mod events;
mod settlement;
mod storage;
mod types;

use soroban_sdk::{contract, contractimpl, Address, Env, String};
use types::{
    DelegationRecord, Disbursement, Error,
    GovernanceProposal, ProposalStatus, ProposalVote,
    VoteError, FinalizationError,
};

#[contract]
/// The governance contract struct.
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initialize the governance contract.
    ///
    /// Must be called exactly once before any other operation. Sets the
    /// contract admin and the total token supply used for vote-power
    /// calculations.
    ///
    /// # Arguments
    /// * `admin`        – Address that will have admin privileges.
    /// * `total_supply` – Total token supply (must be positive).
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::AlreadyInitialized`] – Contract has already been initialized.
    /// * [`Error::InvalidParameters`] – `total_supply` is zero or negative.
    pub fn initialize(env: Env, admin: Address, total_supply: i128) -> Result<(), Error> {
        if storage::has_admin(&env) {
            return Err(Error::AlreadyInitialized);
        }
        if total_supply <= 0 {
            return Err(Error::InvalidParameters);
        }
        storage::set_admin(&env, &admin);
        storage::set_total_supply(&env, total_supply);
        storage::set_proposal_count(&env, 0);
        Ok(())
    }

    /// Delegate vote power from `delegator` to `delegatee`.
    ///
    /// The delegator's current balance is transferred to the delegatee's
    /// vote-power tally. A delegator may only delegate to one address at a
    /// time; calling this again replaces the previous delegation.
    ///
    /// # Arguments
    /// * `delegator` – Address delegating its vote power (must authorize).
    /// * `delegatee` – Address receiving the delegated vote power.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::InvalidParameters`] – `delegator == delegatee` (self-delegation).
    /// * [`Error::CircularDelegation`] – Delegation would create a cycle.
    /// * [`Error::DelegationChainTooDeep`] – Chain length would exceed the limit.
    /// * [`Error::ContractPaused`] – Contract is paused.
    pub fn delegate(env: Env, delegator: Address, delegatee: Address) -> Result<(), Error> {
        delegation::delegate(&env, delegator, delegatee)
    }

    /// Remove the active delegation for `delegator`.
    ///
    /// Returns the delegator's vote power back to itself. Has no effect if
    /// no active delegation exists.
    ///
    /// # Arguments
    /// * `delegator` – Address revoking its delegation (must authorize).
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::ContractPaused`] – Contract is paused.
    pub fn undelegate(env: Env, delegator: Address) -> Result<(), Error> {
        delegation::undelegate(&env, delegator)
    }

    /// Get the current voting power of an address.
    ///
    /// Returns the address's own balance plus any vote power delegated to it
    /// by other holders.
    ///
    /// # Arguments
    /// * `address` – The address to query.
    ///
    /// # Returns
    /// Voting power as a non-negative `i128`. Returns `0` if the address
    /// is unknown.
    pub fn get_vote_power(env: Env, address: Address) -> i128 {
        delegation::get_vote_power(&env, &address)
    }

    /// Retrieve the active delegation record for `delegator`, if any.
    ///
    /// # Arguments
    /// * `delegator` – The address to query.
    ///
    /// # Returns
    /// `Some(DelegationRecord)` if the address has an active delegation,
    /// `None` otherwise.
    pub fn get_delegation(env: Env, delegator: Address) -> Option<DelegationRecord> {
        delegation::get_delegation(&env, &delegator)
    }

    /// Get the raw token balance of a holder.
    ///
    /// This is the holder's own token balance, independent of any delegated
    /// vote power.
    ///
    /// # Arguments
    /// * `holder` – The address to query.
    ///
    /// # Returns
    /// Balance as a non-negative `i128`. Returns `0` if the address is unknown.
    pub fn get_balance(env: Env, holder: Address) -> i128 {
        storage::get_balance(&env, &holder)
    }

    /// Return the total token supply recorded at [`initialize`].
    ///
    /// This value is set once during initialization and is **not**
    /// recalculated from live balances — it reflects the canonical supply
    /// figure provided by the deployer.  Unlike `get_balance` / `get_vote_power`,
    /// no on-chain arithmetic depends on this figure; it exists so off-chain
    /// observers can verify the supply cap without reading constructor call-data.
    ///
    /// - No authorization required.
    /// - Works while the contract is paused.
    /// - Returns `0` if called before `initialize` (storage default).
    pub fn get_total_supply(env: Env) -> i128 {
        storage::get_total_supply(&env)
    }

    /// Record a vote-power snapshot for `address` at the current ledger.
    ///
    /// Snapshots are used to determine an address's vote power at a fixed
    /// point in time, preventing manipulation by moving tokens between the
    /// proposal creation and the vote.
    ///
    /// # Arguments
    /// * `address` – The address to snapshot (must authorize).
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::ContractPaused`] – Contract is paused.
    pub fn take_snapshot(env: Env, address: Address) -> Result<(), Error> {
        delegation::take_snapshot(&env, &address)
    }

    /// Query the vote power of `address` at a past ledger sequence number.
    ///
    /// # Arguments
    /// * `address` – The address to query.
    /// * `ledger`  – The ledger sequence number of the desired snapshot.
    ///
    /// # Returns
    /// `Ok(i128)` — vote power at the given ledger.
    ///
    /// # Errors
    /// * [`Error::SnapshotNotFound`] – No snapshot exists for the given
    ///   address/ledger combination.
    pub fn get_snapshot_power(env: Env, address: Address, ledger: u32) -> Result<i128, Error> {
        delegation::get_snapshot_power(&env, &address, ledger)
    }

    /// Set the token balance of a holder (admin only).
    ///
    /// Updates `holder`'s balance and propagates the delta to the vote-power
    /// tally of the holder (or their delegatee, if a delegation is active).
    ///
    /// # Arguments
    /// * `admin`       – Contract admin address (must authorize).
    /// * `holder`      – Address whose balance is being updated.
    /// * `new_balance` – New balance value (must be ≥ 0).
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::ContractPaused`] – Contract is paused.
    /// * [`Error::Unauthorized`]   – Caller is not the stored admin.
    /// * [`Error::InvalidParameters`] – `new_balance` is negative.
    /// * [`Error::ArithmeticError`]   – Overflow computing the vote-power delta.
    pub fn set_balance(
        env: Env,
        admin: Address,
        holder: Address,
        new_balance: i128,
    ) -> Result<(), Error> {
        if storage::is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        if new_balance < 0 {
            return Err(Error::InvalidParameters);
        }
        let old_balance = storage::get_balance(&env, &holder);
        let delta = new_balance
            .checked_sub(old_balance)
            .ok_or_else(|| {
                events::emit_error_detail(&env, Error::ArithmeticError as u32, old_balance);
                Error::ArithmeticError
            })?;
        storage::set_balance(&env, &holder, new_balance);
        if let Some(ref record) = storage::get_delegation(&env, &holder) {
            let delegatee = record.delegatee.clone();
            let current_power = storage::get_vote_power(&env, &delegatee);
            let new_power = current_power
                .checked_add(delta)
                .ok_or_else(|| {
                    events::emit_error_detail(&env, Error::ArithmeticError as u32, current_power);
                    Error::ArithmeticError
                })?;
            storage::set_vote_power(&env, &delegatee, new_power.max(0));
        } else {
            let current_power = storage::get_vote_power(&env, &holder);
            let new_power = current_power
                .checked_add(delta)
                .ok_or_else(|| {
                    events::emit_error_detail(&env, Error::ArithmeticError as u32, current_power);
                    Error::ArithmeticError
                })?;
            storage::set_vote_power(&env, &holder, new_power.max(0));
        }
        Ok(())
    }

    /// Transfer admin privileges to a new address.
    ///
    /// The current admin must authorize this call. The new admin address must
    /// differ from the current admin.
    ///
    /// # Arguments
    /// * `current_admin` – The existing admin (must authorize).
    /// * `new_admin`     – The address to grant admin privileges to.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`]      – Caller is not the stored admin.
    /// * [`Error::InvalidParameters`] – `new_admin == current_admin`.
    pub fn transfer_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), Error> {
        current_admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if current_admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        if new_admin == current_admin {
            return Err(Error::InvalidParameters);
        }
        storage::set_admin(&env, &new_admin);
        events::emit_admin_transfer(&env, &current_admin, &new_admin);
        Ok(())
    }

    /// Pause the contract, disabling all write operations.
    ///
    /// While paused, any function that would modify state returns
    /// [`Error::ContractPaused`]. Read-only queries continue to work.
    ///
    /// # Arguments
    /// * `admin` – Contract admin (must authorize).
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] – Caller is not the stored admin.
    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        storage::set_paused(&env, true);
        events::emit_pause_changed(&env, &admin, true);
        Ok(())
    }

    /// Resume a paused contract, re-enabling write operations.
    ///
    /// # Arguments
    /// * `admin` – Contract admin (must authorize).
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] – Caller is not the stored admin.
    /// Configure the deployed token-factory contract this governance
    /// instance is authorized to disburse treasury payouts through.
    ///
    /// Must be set before executing any proposal with a `disbursement`.
    ///
    /// # Arguments
    /// * `admin`         – Contract admin (must authorize).
    /// * `token_factory` – Address of the deployed token-factory contract.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`Error::Unauthorized`] – Caller is not the stored admin.
    pub fn set_token_factory(env: Env, admin: Address, token_factory: Address) -> Result<(), Error> {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        storage::set_token_factory(&env, &token_factory);
        Ok(())
    }

    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        storage::set_paused(&env, false);
        events::emit_pause_changed(&env, &admin, false);
        Ok(())
    }

    /// Return whether the contract is currently paused.
    ///
    /// # Returns
    /// `true` if paused, `false` otherwise.
    pub fn is_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    // ── Proposals ───────────────────────────────────────────────────────────

    /// Create a new governance proposal.
    ///
    /// Opens a new proposal in [`ProposalStatus::Active`] state. Voting begins
    /// immediately and closes at `env.ledger().timestamp() + voting_period`.
    ///
    /// # Arguments
    /// * `creator`           – Address creating the proposal (must authorize).
    /// * `description`       – Human-readable description of the proposal.
    /// * `payload`           – Arbitrary bytes to be executed if the proposal passes.
    /// * `voting_period`     – Duration in seconds from now until voting closes.
    /// * `quorum`            – Minimum total votes (for + against) required for
    ///                         the result to be valid.
    /// * `threshold_percent` – Percentage of *total* votes that must be *for*
    ///                         the proposal for it to pass (0–100).
    ///
    /// # Returns
    /// The newly created proposal's numeric ID.
    pub fn create_proposal(
        env: Env,
        creator: Address,
        description: String,
        payload: soroban_sdk::Bytes,
        voting_period: u64,
        quorum: i128,
        threshold_percent: u32,
    ) -> Result<u32, Error> {
        creator.require_auth();

        // Bounds validation — reject malformed proposals before any storage write
        if threshold_percent > 100 {
            return Err(Error::InvalidParameters);
        }
        if quorum <= 0 {
            return Err(Error::InvalidParameters);
        }
        if voting_period == 0 {
            return Err(Error::InvalidParameters);
        }

        let proposal_id = storage::get_proposal_count(&env);
        let voting_end = env.ledger().timestamp() + voting_period;
        let proposal = GovernanceProposal {
            id: proposal_id,
            creator: creator.clone(),
            description,
            voting_end,
            quorum,
            threshold_percent,
            votes_for: 0,
            votes_against: 0,
            payload,
            status: ProposalStatus::Active,
            disbursement: None,
        };
        storage::set_proposal(&env, proposal_id, &proposal);
        storage::set_proposal_count(&env, proposal_id + 1);
        Ok(proposal_id)
    }

    /// Execute a passed proposal atomically with the status change.
    ///
    /// Marks the proposal as [`ProposalStatus::Executed`] and emits an
    /// `exec_prop` event. Actual side-effects encoded in `payload` are
    /// expected to be dispatched by the caller after this function succeeds.
    ///
    /// # Arguments
    /// * `proposal_id` – The ID of the proposal to execute.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`FinalizationError::ProposalNotFound`]  – No proposal with this ID.
    /// * [`FinalizationError::AlreadyExecuted`]   – Proposal was already executed.
    /// * [`FinalizationError::ProposalNotPassed`] – Proposal has not reached
    ///   [`ProposalStatus::Passed`] status yet.
    pub fn execute_proposal(env: Env, proposal_id: u32) -> Result<(), FinalizationError> {
        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(FinalizationError::ProposalNotFound)?;

        if proposal.status == ProposalStatus::Executed {
            return Err(FinalizationError::AlreadyExecuted);
        }

        if proposal.status != ProposalStatus::Passed {
            return Err(FinalizationError::ProposalNotPassed);
        }

        if let Some(disbursement) = proposal.disbursement.clone() {
            let token_factory = storage::get_token_factory(&env)
                .ok_or(FinalizationError::TokenFactoryNotConfigured)?;
            settlement::execute_disbursement(&env, &token_factory, proposal_id, &disbursement)?;
        }

        // Only set once settlement (if any) is confirmed committed.
        proposal.status = ProposalStatus::Executed;
        storage::set_proposal(&env, proposal_id, &proposal);

        // Emit execution event (actual side effects would be triggered here or by caller)
        events::emit_proposal_executed(&env, proposal_id, &proposal.description);

        Ok(())
    }

    /// Cast a vote on an active proposal.
    ///
    /// Each address may vote at most once per proposal. The vote weight equals
    /// the voter's current vote power (delegated + own), falling back to their
    /// raw balance if no vote power is recorded.
    ///
    /// # Arguments
    /// * `voter`       – Address casting the vote (must authorize).
    /// * `proposal_id` – ID of the proposal to vote on.
    /// * `in_favor`    – `true` to vote for the proposal, `false` to vote against.
    ///
    /// # Returns
    /// `Ok(())` on success.
    ///
    /// # Errors
    /// * [`VoteError::ProposalNotFound`]    – No proposal with this ID.
    /// * [`VoteError::ProposalNotActive`]   – Proposal is not in Active state.
    /// * [`VoteError::VotingPeriodEnded`]   – The voting deadline has passed.
    /// * [`VoteError::AlreadyVoted`]        – This address has already voted.
    /// * [`VoteError::InsufficientBalance`] – Voter has zero vote power and
    ///   zero balance.
    /// * [`VoteError::Overflow`]            – Arithmetic overflow accumulating votes.
    pub fn cast_vote(
        env: Env,
        voter: Address,
        proposal_id: u32,
        in_favor: bool,
    ) -> Result<(), VoteError> {
        voter.require_auth();
        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(VoteError::ProposalNotFound)?;
        if proposal.status != ProposalStatus::Active {
            return Err(VoteError::ProposalNotActive);
        }
        if env.ledger().timestamp() > proposal.voting_end {
            return Err(VoteError::VotingPeriodEnded);
        }
        if storage::has_voted(&env, proposal_id, &voter) {
            return Err(VoteError::AlreadyVoted);
        }
        let weight = {
            let vp = storage::get_vote_power(&env, &voter);
            if vp > 0 {
                vp
            } else {
                let bal = storage::get_balance(&env, &voter);
                if bal <= 0 {
                    return Err(VoteError::InsufficientBalance);
                }
                bal
            }
        };
        let vote = ProposalVote {
            voter: voter.clone(),
            proposal_id,
            weight,
            in_favor,
        };
        storage::set_vote(&env, proposal_id, &voter, &vote);
        if in_favor {
            proposal.votes_for = proposal.votes_for
                .checked_add(weight)
                .ok_or(VoteError::Overflow)?;
        } else {
            proposal.votes_against = proposal.votes_against
                .checked_add(weight)
                .ok_or(VoteError::Overflow)?;
        }
        storage::set_proposal(&env, proposal_id, &proposal);
        Ok(())
    }

    /// Check whether an address has already voted on a proposal.
    ///
    /// # Arguments
    /// * `proposal_id` – ID of the proposal.
    /// * `voter`       – Address to check.
    ///
    /// # Returns
    /// `true` if the address has cast a vote, `false` otherwise.
    pub fn has_voted(env: Env, proposal_id: u32, voter: Address) -> bool {
        storage::has_voted(&env, proposal_id, &voter)
    }

    /// Finalize the outcome of a proposal after its voting period ends.
    ///
    /// Transitions the proposal from [`ProposalStatus::Active`] to one of:
    /// * [`ProposalStatus::Failed`]   – Total votes did not meet quorum.
    /// * [`ProposalStatus::Rejected`] – Quorum met but `votes_for` did not
    ///   exceed `threshold_percent` of total votes.
    /// * [`ProposalStatus::Passed`]   – Quorum met and threshold was reached.
    ///
    /// # Arguments
    /// * `proposal_id` – ID of the proposal to finalize.
    ///
    /// # Returns
    /// `Ok(ProposalStatus)` – The final status of the proposal.
    ///
    /// # Errors
    /// * [`FinalizationError::ProposalNotFound`]     – No proposal with this ID.
    /// * [`FinalizationError::AlreadyFinalized`]     – Proposal is not Active.
    /// * [`FinalizationError::VotingPeriodNotEnded`] – Voting deadline has not
    ///   passed yet.
    pub fn finalize_proposal(
        env: Env,
        proposal_id: u32,
    ) -> Result<ProposalStatus, FinalizationError> {
        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(FinalizationError::ProposalNotFound)?;
        if proposal.status != ProposalStatus::Active {
            return Err(FinalizationError::AlreadyFinalized);
        }
        if env.ledger().timestamp() <= proposal.voting_end {
            return Err(FinalizationError::VotingPeriodNotEnded);
        }
        let total_votes = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .ok_or(FinalizationError::ArithmeticOverflow)?;
        let final_status = if total_votes < proposal.quorum {
            ProposalStatus::Failed
        } else {
            let threshold_votes = total_votes
                .checked_mul(proposal.threshold_percent as i128)
                .ok_or(FinalizationError::ArithmeticOverflow)?
                / 100;
            if proposal.votes_for > threshold_votes {
                ProposalStatus::Passed
            } else {
                ProposalStatus::Rejected
            }
        };
        proposal.status = final_status.clone();
        storage::set_proposal(&env, proposal_id, &proposal);
        Ok(final_status)
    }

    /// Retrieve a proposal by ID.
    ///
    /// # Arguments
    /// * `proposal_id` – The proposal's numeric ID.
    ///
    /// # Returns
    /// `Some(GovernanceProposal)` if the proposal exists, `None` otherwise.
    pub fn get_proposal(env: Env, proposal_id: u32) -> Option<GovernanceProposal> {
        storage::get_proposal(&env, proposal_id)
    }

    /// Retrieve the vote cast by a specific address on a proposal.
    ///
    /// # Arguments
    /// * `proposal_id` – The proposal's numeric ID.
    /// * `voter`       – The address whose vote to retrieve.
    ///
    /// # Returns
    /// `Some(ProposalVote)` if the address has voted, `None` otherwise.
    pub fn get_proposal_vote(env: Env, proposal_id: u32, voter: Address) -> Option<ProposalVote> {
        storage::get_vote(&env, proposal_id, &voter)
    }
}

#[cfg(test)]
mod governance_test;

#[cfg(test)]
mod governance_property_test;

#[cfg(test)]
mod governance_bounds_test;
