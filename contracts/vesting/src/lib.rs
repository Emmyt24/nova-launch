#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, symbol_short,
    Address, Env,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Composite storage key: (beneficiary, schedule_id)
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Schedule(Address, u32),
    ScheduleCount(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub beneficiary: Address,
    pub total_amount: i128,
    pub start_time: u64,
    pub cliff_duration: u64,
    pub total_duration: u64,
    pub released: i128,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    NotInitialized    = 1,
    Unauthorized      = 2,
    InvalidParameters = 3,
    ScheduleNotFound  = 4,
    NothingToRelease  = 5,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------
#[contract]
pub struct Vesting;

#[contractimpl]
impl Vesting {
    // -----------------------------------------------------------------------
    // Admin setup
    // -----------------------------------------------------------------------
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Create a vesting schedule (admin only)
    // -----------------------------------------------------------------------
    pub fn create_schedule(
        env: Env,
        beneficiary: Address,
        total_amount: i128,
        start_time: u64,
        cliff_duration: u64,
        total_duration: u64,
    ) -> Result<u32, Error> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        if total_amount <= 0 || total_duration == 0 || cliff_duration > total_duration {
            return Err(Error::InvalidParameters);
        }

        let schedule_id = Self::next_schedule_id(&env, &beneficiary);

        let schedule = VestingSchedule {
            beneficiary: beneficiary.clone(),
            total_amount,
            start_time,
            cliff_duration,
            total_duration,
            released: 0,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Schedule(beneficiary.clone(), schedule_id), &schedule);

        env.storage()
            .persistent()
            .set(&DataKey::ScheduleCount(beneficiary), &(schedule_id + 1));

        Ok(schedule_id)
    }

    // -----------------------------------------------------------------------
    // Release vested tokens for a specific schedule
    // -----------------------------------------------------------------------
    pub fn release(env: Env, beneficiary: Address, schedule_id: u32) -> Result<i128, Error> {
        let key = DataKey::Schedule(beneficiary.clone(), schedule_id);
        let mut schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ScheduleNotFound)?;

        let now = env.ledger().timestamp();
        let releasable = Self::compute_releasable(&schedule, now);

        if releasable == 0 {
            return Err(Error::NothingToRelease);
        }

        schedule.released += releasable;
        env.storage().persistent().set(&key, &schedule);

        // Emit tokens_released event
        env.events().publish(
            (symbol_short!("vesting"), symbol_short!("released")),
            (beneficiary, releasable, now),
        );

        Ok(releasable)
    }

    // -----------------------------------------------------------------------
    // Read-only
    // -----------------------------------------------------------------------
    pub fn get_schedule(
        env: Env,
        beneficiary: Address,
        schedule_id: u32,
    ) -> Result<VestingSchedule, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Schedule(beneficiary, schedule_id))
            .ok_or(Error::ScheduleNotFound)
    }

    pub fn vested_amount(env: Env, beneficiary: Address, schedule_id: u32) -> Result<i128, Error> {
        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(beneficiary, schedule_id))
            .ok_or(Error::ScheduleNotFound)?;
        let now = env.ledger().timestamp();
        Ok(Self::compute_vested(&schedule, now))
    }

    pub fn releasable_amount(
        env: Env,
        beneficiary: Address,
        schedule_id: u32,
    ) -> Result<i128, Error> {
        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(beneficiary, schedule_id))
            .ok_or(Error::ScheduleNotFound)?;
        let now = env.ledger().timestamp();
        Ok(Self::compute_releasable(&schedule, now))
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------
    fn get_admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    fn next_schedule_id(env: &Env, beneficiary: &Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::ScheduleCount(beneficiary.clone()))
            .unwrap_or(0u32)
    }

    /// Linear vesting: vested = total × (now - start) / total_duration
    /// Returns 0 before cliff.
    fn compute_vested(schedule: &VestingSchedule, now: u64) -> i128 {
        if now < schedule.start_time + schedule.cliff_duration {
            return 0;
        }
        let elapsed = now.saturating_sub(schedule.start_time) as i128;
        let duration = schedule.total_duration as i128;
        let vested = schedule.total_amount * elapsed / duration;
        vested.min(schedule.total_amount)
    }

    fn compute_releasable(schedule: &VestingSchedule, now: u64) -> i128 {
        let vested = Self::compute_vested(schedule, now);
        (vested - schedule.released).max(0)
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests;
