#![no_std]

mod delegation;
mod events;
mod storage;
mod types;

use soroban_sdk::{contract, contractimpl, Address, Env, String};
use types::{
    DelegationRecord, Error,
    GovernanceProposal, ProposalStatus, ProposalVote,
    VoteError, FinalizationError,
};

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
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

    pub fn delegate(env: Env, delegator: Address, delegatee: Address) -> Result<(), Error> {
        delegation::delegate(&env, delegator, delegatee)
    }

    pub fn undelegate(env: Env, delegator: Address) -> Result<(), Error> {
        delegation::undelegate(&env, delegator)
    }

    pub fn get_vote_power(env: Env, address: Address) -> i128 {
        delegation::get_vote_power(&env, &address)
    }

    pub fn get_delegation(env: Env, delegator: Address) -> Option<DelegationRecord> {
        delegation::get_delegation(&env, &delegator)
    }

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

    pub fn take_snapshot(env: Env, address: Address) -> Result<(), Error> {
        delegation::take_snapshot(&env, &address)
    }

    pub fn get_snapshot_power(env: Env, address: Address, ledger: u32) -> Result<i128, Error> {
        delegation::get_snapshot_power(&env, &address, ledger)
    }

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

    pub fn is_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    // Proposals

    pub fn create_proposal(
        env: Env,
        creator: Address,
        description: String,
        payload: soroban_sdk::Bytes,
        voting_period: u64,
        quorum: i128,
        threshold_percent: u32,
    ) -> u32 {
        creator.require_auth();
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
        };
        storage::set_proposal(&env, proposal_id, &proposal);
        storage::set_proposal_count(&env, proposal_id + 1);
        proposal_id
    }

    /// Execute a passed proposal (atomically with state change)
    pub fn execute_proposal(env: Env, proposal_id: u32) -> Result<(), FinalizationError> {
        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(FinalizationError::ProposalNotFound)?;

        if proposal.status == ProposalStatus::Executed {
            return Err(FinalizationError::AlreadyExecuted);
        }

        if proposal.status != ProposalStatus::Passed {
            return Err(FinalizationError::ProposalNotPassed);
        }

        // Atomically mark as executed
        proposal.status = ProposalStatus::Executed;
        storage::set_proposal(&env, proposal_id, &proposal);

        // Emit execution event (actual side effects would be triggered here or by caller)
        events::emit_proposal_executed(&env, proposal_id, &proposal.description);

        Ok(())
    }

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

    pub fn has_voted(env: Env, proposal_id: u32, voter: Address) -> bool {
        storage::has_voted(&env, proposal_id, &voter)
    }

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
        let total_votes = proposal.votes_for + proposal.votes_against;
        let final_status = if total_votes < proposal.quorum {
            ProposalStatus::Failed
        } else {
            let threshold_votes =
                (total_votes * proposal.threshold_percent as i128) / 100;
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

    pub fn get_proposal(env: Env, proposal_id: u32) -> Option<GovernanceProposal> {
        storage::get_proposal(&env, proposal_id)
    }

    pub fn get_proposal_vote(env: Env, proposal_id: u32, voter: Address) -> Option<ProposalVote> {
        storage::get_vote(&env, proposal_id, &voter)
    }
}

#[cfg(test)]
mod governance_test;

#[cfg(test)]
mod governance_property_test;
