#![no_std]

//! Event Emitter – structured events for all Nova state transitions.
//!
//! Convention: topics = (contract_name: Symbol, event_type: Symbol)
//!             data   = a plain struct / tuple with relevant fields.
//!
//! All Symbol keys use `symbol_short!` to stay within the 32-byte limit.

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Env, Symbol,
};

// ---------------------------------------------------------------------------
// Data structs emitted as event payloads
// (No sensitive data – only public on-chain state)
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct MintData {
    pub to: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct BurnData {
    pub from: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct TransferData {
    pub from: Address,
    pub to: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct ApproveData {
    pub owner: Address,
    pub spender: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct DepositData {
    pub depositor: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct WithdrawData {
    pub recipient: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct ClaimData {
    pub claimant: Address,
    pub amount: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct StakeData {
    pub staker: Address,
    pub amount: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct UnstakeData {
    pub staker: Address,
    pub amount: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct AdminProposedData {
    pub proposed_by: Address,
    pub new_admin: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct AdminTransferredData {
    pub old_admin: Address,
    pub new_admin: Address,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------
#[contract]
pub struct EventEmitter;

#[contractimpl]
impl EventEmitter {
    // -----------------------------------------------------------------------
    // NovaToken events
    // -----------------------------------------------------------------------
    pub fn emit_mint(env: Env, to: Address, amount: i128) {
        env.events().publish(
            (symbol_short!("nova_tok"), symbol_short!("mint")),
            MintData { to, amount },
        );
    }

    pub fn emit_burn(env: Env, from: Address, amount: i128) {
        env.events().publish(
            (symbol_short!("nova_tok"), symbol_short!("burn")),
            BurnData { from, amount },
        );
    }

    pub fn emit_transfer(env: Env, from: Address, to: Address, amount: i128) {
        env.events().publish(
            (symbol_short!("nova_tok"), symbol_short!("transfer")),
            TransferData { from, to, amount },
        );
    }

    pub fn emit_approve(env: Env, owner: Address, spender: Address, amount: i128) {
        env.events().publish(
            (symbol_short!("nova_tok"), symbol_short!("approve")),
            ApproveData { owner, spender, amount },
        );
    }

    // -----------------------------------------------------------------------
    // RewardPool events
    // -----------------------------------------------------------------------
    pub fn emit_deposited(env: Env, depositor: Address, amount: i128) {
        env.events().publish(
            (symbol_short!("rwd_pool"), symbol_short!("deposited")),
            DepositData { depositor, amount },
        );
    }

    pub fn emit_withdrawn(env: Env, recipient: Address, amount: i128) {
        env.events().publish(
            (symbol_short!("rwd_pool"), symbol_short!("withdrawn")),
            WithdrawData { recipient, amount },
        );
    }

    // -----------------------------------------------------------------------
    // ClaimDistribution events
    // -----------------------------------------------------------------------
    pub fn emit_claimed(env: Env, claimant: Address, amount: i128) {
        let timestamp = env.ledger().timestamp();
        env.events().publish(
            (symbol_short!("claim_dst"), symbol_short!("claimed")),
            ClaimData { claimant, amount, timestamp },
        );
    }

    // -----------------------------------------------------------------------
    // Staking events
    // -----------------------------------------------------------------------
    pub fn emit_staked(env: Env, staker: Address, amount: i128) {
        let timestamp = env.ledger().timestamp();
        env.events().publish(
            (symbol_short!("staking"), symbol_short!("staked")),
            StakeData { staker, amount, timestamp },
        );
    }

    pub fn emit_unstaked(env: Env, staker: Address, amount: i128) {
        let timestamp = env.ledger().timestamp();
        env.events().publish(
            (symbol_short!("staking"), symbol_short!("unstaked")),
            UnstakeData { staker, amount, timestamp },
        );
    }

    // -----------------------------------------------------------------------
    // AdminRoles events
    // -----------------------------------------------------------------------
    pub fn emit_admin_proposed(env: Env, proposed_by: Address, new_admin: Address) {
        env.events().publish(
            (symbol_short!("adm_role"), symbol_short!("adm_prop")),
            AdminProposedData { proposed_by, new_admin },
        );
    }

    pub fn emit_admin_transferred(env: Env, old_admin: Address, new_admin: Address) {
        env.events().publish(
            (symbol_short!("adm_role"), symbol_short!("adm_xfer")),
            AdminTransferredData { old_admin, new_admin },
        );
    }
}

// Re-export a helper so other contracts can call these emit functions inline.
pub fn topics(contract: Symbol, event: Symbol) -> (Symbol, Symbol) {
    (contract, event)
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests;
