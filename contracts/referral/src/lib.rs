#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, symbol_short,
    Address, Env,
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// referred -> referrer
    Referral(Address),
    /// referrer -> total referral count
    ReferralCount(Address),
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    NotInitialized    = 1,
    Unauthorized      = 2,
    AlreadyReferred   = 3,
    ReferralNotFound  = 4,
    InvalidParameters = 5,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------
#[contract]
pub struct Referral;

#[contractimpl]
impl Referral {
    // -----------------------------------------------------------------------
    // Initialise
    // -----------------------------------------------------------------------
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Register a referral (each wallet can only be referred once)
    // -----------------------------------------------------------------------
    pub fn register_referral(
        env: Env,
        referrer: Address,
        referred: Address,
    ) -> Result<(), Error> {
        if referrer == referred {
            return Err(Error::InvalidParameters);
        }

        let key = DataKey::Referral(referred.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyReferred);
        }

        // Store referred -> referrer mapping
        env.storage().persistent().set(&key, &referrer);

        // Increment referrer's counter
        let count_key = DataKey::ReferralCount(referrer.clone());
        let count: u64 = env
            .storage()
            .persistent()
            .get(&count_key)
            .unwrap_or(0u64);
        env.storage().persistent().set(&count_key, &(count + 1));

        // Emit referral_registered event
        env.events().publish(
            (symbol_short!("referral"), symbol_short!("reg")),
            (referrer, referred),
        );

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Look up the referrer for a given referred address
    // -----------------------------------------------------------------------
    pub fn get_referrer(env: Env, referred: Address) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Referral(referred))
    }

    // -----------------------------------------------------------------------
    // Credit the referrer with Nova tokens (admin only)
    // -----------------------------------------------------------------------
    pub fn credit_referrer(
        env: Env,
        referred: Address,
        reward_amount: i128,
    ) -> Result<Address, Error> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        if reward_amount <= 0 {
            return Err(Error::InvalidParameters);
        }

        let referrer: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Referral(referred.clone()))
            .ok_or(Error::ReferralNotFound)?;

        // In a full implementation this would call the Nova token contract's
        // transfer function. Here we emit the event to record the credit.
        env.events().publish(
            (symbol_short!("referral"), symbol_short!("credit")),
            (referrer.clone(), reward_amount),
        );

        Ok(referrer)
    }

    // -----------------------------------------------------------------------
    // Leaderboard: total referrals per referrer
    // -----------------------------------------------------------------------
    pub fn get_referral_count(env: Env, referrer: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::ReferralCount(referrer))
            .unwrap_or(0)
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------
    fn get_admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests;
