#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, symbol_short,
    Address, Env, Vec,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------
#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Signers,
    Threshold,
    Paused,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    NotInitialized   = 1,
    AlreadyInit      = 2,
    Unauthorized     = 3,
    NoPendingAdmin   = 4,
    InvalidThreshold = 5,
    ContractPaused   = 6,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------
#[contract]
pub struct AdminRoles;

#[contractimpl]
impl AdminRoles {
    // -----------------------------------------------------------------------
    // Initialise
    // -----------------------------------------------------------------------
    /// Set up the contract with a single admin and an optional multisig list.
    /// `threshold` must be ≥ 1 and ≤ len(signers).
    pub fn initialize(
        env: Env,
        admin: Address,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInit);
        }
        if threshold == 0 || threshold as usize > signers.len() as usize {
            return Err(Error::InvalidThreshold);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Two-step admin transfer
    // -----------------------------------------------------------------------
    /// Step 1 – current admin proposes a new admin.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        env.events().publish(
            (symbol_short!("adm_prop"), symbol_short!("admin")),
            new_admin,
        );
        Ok(())
    }

    /// Step 2 – pending admin accepts and becomes the new admin.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(Error::NoPendingAdmin)?;
        pending.require_auth();
        let old_admin = Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events().publish(
            (symbol_short!("adm_xfer"), symbol_short!("admin")),
            (old_admin, pending),
        );
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Multisig helpers
    // -----------------------------------------------------------------------
    /// Update the signers list and approval threshold (admin only).
    pub fn update_signers(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        if threshold == 0 || threshold as usize > signers.len() as usize {
            return Err(Error::InvalidThreshold);
        }
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Privileged operations (gated behind admin auth)
    // -----------------------------------------------------------------------
    /// caller must be the stored admin.
    pub fn mint(env: Env, caller: Address, _amount: i128) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        let admin = Self::require_admin(&env)?;
        if caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        Ok(())
    }

    pub fn withdraw(env: Env, caller: Address, _amount: i128) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        let admin = Self::require_admin(&env)?;
        if caller != admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        Ok(())
    }

    pub fn update_rate(env: Env, _rate: u32) -> Result<(), Error> {
        Self::require_not_paused(&env)?;
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        Ok(())
    }

    pub fn pause(env: Env) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        let admin = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Read-only
    // -----------------------------------------------------------------------
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        Self::require_admin(&env)
    }

    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    pub fn get_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(1)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------
    fn require_admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    fn require_not_paused(env: &Env) -> Result<(), Error> {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            Err(Error::ContractPaused)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests;
