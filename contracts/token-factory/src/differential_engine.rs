use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct DifferentialVestingSchedule {
    pub total_amount: i128,
    pub start_time: u64,
    pub cliff_duration: u64,
    pub vesting_duration: u64,
    pub claimed_amount: i128,
}

impl DifferentialVestingSchedule {
    pub fn calculate_vested(&self, current_time: u64) -> Result<i128, String> {
        if current_time < self.start_time { return Ok(0); }
        let elapsed = current_time.saturating_sub(self.start_time);
        if elapsed < self.cliff_duration { return Ok(0); }
        if elapsed >= self.vesting_duration { return Ok(self.total_amount); }
        (self.total_amount as u128).checked_mul(elapsed as u128)
            .and_then(|v| v.checked_div(self.vesting_duration as u128))
            .and_then(|v| i128::try_from(v).ok())
            .ok_or_else(|| "Overflow".to_string())
    }

    pub fn calculate_claimable(&self, current_time: u64) -> Result<i128, String> {
        self.calculate_vested(current_time)?.checked_sub(self.claimed_amount).ok_or_else(|| "Underflow".to_string())
    }
}

#[derive(Debug, Clone)]
pub struct DifferentialEngine {
    pub schedules: HashMap<u32, DifferentialVestingSchedule>,
}

impl DifferentialEngine {
    pub fn new() -> Self { Self { schedules: HashMap::new() } }

    pub fn add_schedule(&mut self, id: u32, total_amount: i128, start_time: u64, cliff_duration: u64, vesting_duration: u64) {
        self.schedules.insert(id, DifferentialVestingSchedule { total_amount, start_time, cliff_duration, vesting_duration, claimed_amount: 0 });
    }

    pub fn get_vested(&self, id: u32, current_time: u64) -> Result<i128, String> {
        self.schedules.get(&id).ok_or("Not found".to_string())?.calculate_vested(current_time)
    }

    pub fn get_claimable(&self, id: u32, current_time: u64) -> Result<i128, String> {
        self.schedules.get(&id).ok_or("Not found".to_string())?.calculate_claimable(current_time)
    }

    pub fn claim(&mut self, id: u32, current_time: u64) -> Result<i128, String> {
        let schedule = self.schedules.get_mut(&id).ok_or("Not found".to_string())?;
        let claimable = schedule.calculate_claimable(current_time)?;
        if claimable == 0 { return Err("Nothing to claim".to_string()); }
        schedule.claimed_amount = schedule.claimed_amount.checked_add(claimable).ok_or("Overflow".to_string())?;
        Ok(claimable)
    }
}

#[derive(Debug, Clone)]
pub struct SupplyTracker {
    pub total_supply: i128,
    pub total_minted: i128,
    pub total_burned: i128,
    pub balances: HashMap<String, i128>,
}

impl SupplyTracker {
    pub fn new(initial: i128) -> Self {
        Self { total_supply: initial, total_minted: initial, total_burned: 0, balances: HashMap::new() }
    }

    pub fn mint(&mut self, to: &str, amount: i128) -> Result<(), String> {
        self.total_supply = self.total_supply.checked_add(amount).ok_or("Overflow")?;
        self.total_minted = self.total_minted.checked_add(amount).ok_or("Overflow")?;
        *self.balances.entry(to.to_string()).or_insert(0) = self.balances.get(to).unwrap_or(&0).checked_add(amount).ok_or("Overflow")?;
        Ok(())
    }

    pub fn burn(&mut self, from: &str, amount: i128) -> Result<(), String> {
        let balance = *self.balances.get(from).unwrap_or(&0);
        if balance < amount { return Err("Insufficient".to_string()); }
        self.balances.insert(from.to_string(), balance.checked_sub(amount).ok_or("Underflow")?);
        self.total_supply = self.total_supply.checked_sub(amount).ok_or("Underflow")?;
        self.total_burned = self.total_burned.checked_add(amount).ok_or("Overflow")?;
        Ok(())
    }

    pub fn verify(&self) -> Result<(), String> {
        let calc = self.total_minted.checked_sub(self.total_burned).ok_or("Underflow")?;
        if calc != self.total_supply { return Err(format!("Supply mismatch: {} != {}", calc, self.total_supply)); }
        let sum: i128 = self.balances.values().sum();
        if sum != self.total_supply { return Err(format!("Balance sum mismatch: {} != {}", sum, self.total_supply)); }
        Ok(())
    }
}
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct DifferentialVestingSchedule {
    pub total_amount: i128,
    pub start_time: u64,
    pub cliff_duration: u64,
    pub vesting_duration: u64,
    pub claimed_amount: i128,
}

impl DifferentialVestingSchedule {
    pub fn calculate_vested(&self, current_time: u64) -> Result<i128, String> {
        if current_time < self.start_time { return Ok(0); }
        let elapsed = current_time.saturating_sub(self.start_time);
        if elapsed < self.cliff_duration { return Ok(0); }
        if elapsed >= self.vesting_duration { return Ok(self.total_amount); }
        (self.total_amount as u128).checked_mul(elapsed as u128)
            .and_then(|v| v.checked_div(self.vesting_duration as u128))
            .and_then(|v| i128::try_from(v).ok())
            .ok_or_else(|| "Overflow".to_string())
    }

    pub fn calculate_claimable(&self, current_time: u64) -> Result<i128, String> {
        self.calculate_vested(current_time)?.checked_sub(self.claimed_amount).ok_or_else(|| "Underflow".to_string())
    }
}

#[derive(Debug, Clone)]
pub struct DifferentialEngine {
    pub schedules: HashMap<u32, DifferentialVestingSchedule>,
}

impl DifferentialEngine {
    pub fn new() -> Self { Self { schedules: HashMap::new() } }

    pub fn add_schedule(&mut self, id: u32, total_amount: i128, start_time: u64, cliff_duration: u64, vesting_duration: u64) {
        self.schedules.insert(id, DifferentialVestingSchedule { total_amount, start_time, cliff_duration, vesting_duration, claimed_amount: 0 });
    }

    pub fn get_vested(&self, id: u32, current_time: u64) -> Result<i128, String> {
        self.schedules.get(&id).ok_or("Not found".to_string())?.calculate_vested(current_time)
    }

    pub fn get_claimable(&self, id: u32, current_time: u64) -> Result<i128, String> {
        self.schedules.get(&id).ok_or("Not found".to_string())?.calculate_claimable(current_time)
    }

    pub fn claim(&mut self, id: u32, current_time: u64) -> Result<i128, String> {
        let schedule = self.schedules.get_mut(&id).ok_or("Not found".to_string())?;
        let claimable = schedule.calculate_claimable(current_time)?;
        if claimable == 0 { return Err("Nothing to claim".to_string()); }
        schedule.claimed_amount = schedule.claimed_amount.checked_add(claimable).ok_or("Overflow".to_string())?;
        Ok(claimable)
    }
}

#[derive(Debug, Clone)]
pub struct SupplyTracker {
    pub total_supply: i128,
    pub total_minted: i128,
    pub total_burned: i128,
    pub balances: HashMap<String, i128>,
}

impl SupplyTracker {
    pub fn new(initial: i128) -> Self {
        Self { total_supply: initial, total_minted: initial, total_burned: 0, balances: HashMap::new() }
    }

    pub fn mint(&mut self, to: &str, amount: i128) -> Result<(), String> {
        self.total_supply = self.total_supply.checked_add(amount).ok_or("Overflow")?;
        self.total_minted = self.total_minted.checked_add(amount).ok_or("Overflow")?;
        *self.balances.entry(to.to_string()).or_insert(0) = self.balances.get(to).unwrap_or(&0).checked_add(amount).ok_or("Overflow")?;
        Ok(())
    }

    pub fn burn(&mut self, from: &str, amount: i128) -> Result<(), String> {
        let balance = *self.balances.get(from).unwrap_or(&0);
        if balance < amount { return Err("Insufficient".to_string()); }
        self.balances.insert(from.to_string(), balance.checked_sub(amount).ok_or("Underflow")?);
        self.total_supply = self.total_supply.checked_sub(amount).ok_or("Underflow")?;
        self.total_burned = self.total_burned.checked_add(amount).ok_or("Overflow")?;
        Ok(())
    }

    pub fn verify(&self) -> Result<(), String> {
        let calc = self.total_minted.checked_sub(self.total_burned).ok_or("Underflow")?;
        if calc != self.total_supply { return Err(format!("Supply mismatch: {} != {}", calc, self.total_supply)); }
        let sum: i128 = self.balances.values().sum();
        if sum != self.total_supply { return Err(format!("Balance sum mismatch: {} != {}", sum, self.total_supply)); }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct SupplyTracker {
    pub total_supply: i128,
    pub total_minted: i128,
    pub total_burned: i128,
    pub balances: HashMap<String, i128>,
}

impl SupplyTracker {
    pub fn new(initial: i128) -> Self {
        Self { total_supply: initial, total_minted: initial, total_burned: 0, balances: HashMap::new() }
    }

    pub fn mint(&mut self, to: &str, amount: i128) -> Result<(), String> {
        self.total_supply = self.total_supply.checked_add(amount).ok_or("Overflow")?;
        self.total_minted = self.total_minted.checked_add(amount).ok_or("Overflow")?;
        *self.balances.entry(to.to_string()).or_insert(0) = self.balances.get(to).unwrap_or(&0).checked_add(amount).ok_or("Overflow")?;
        Ok(())
    }

    pub fn burn(&mut self, from: &str, amount: i128) -> Result<(), String> {
        let balance = *self.balances.get(from).unwrap_or(&0);
        if balance < amount { return Err("Insufficient".to_string()); }
        self.balances.insert(from.to_string(), balance.checked_sub(amount).ok_or("Underflow")?);
        self.total_supply = self.total_supply.checked_sub(amount).ok_or("Underflow")?;
        self.total_burned = self.total_burned.checked_add(amount).ok_or("Overflow")?;
        Ok(())
    }

    pub fn verify(&self) -> Result<(), String> {
        let calc = self.total_minted.checked_sub(self.total_burned).ok_or("Underflow")?;
        if calc != self.total_supply { return Err(format!("Supply mismatch: {} != {}", calc, self.total_supply)); }
        let sum: i128 = self.balances.values().sum();
        if sum != self.total_supply { return Err(format!("Balance sum mismatch: {} != {}", sum, self.total_supply)); }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct SupplyTracker {
    pub total_supply: i128,
    pub total_minted: i128,
    pub total_burned: i128,
    pub balances: HashMap<String, i128>,
}

impl SupplyTracker {
    pub fn new(initial: i128) -> Self {
        Self { total_supply: initial, total_minted: initial, total_burned: 0, balances: HashMap::new() }
    }

    pub fn mint(&mut self, to: &str, amount: i128) -> Result<(), String> {
        self.total_supply = self.total_supply.checked_add(amount).ok_or("Overflow")?;
        self.total_minted = self.total_minted.checked_add(amount).ok_or("Overflow")?;
        *self.balances.entry(to.to_string()).or_insert(0) = self.balances.get(to).unwrap_or(&0).checked_add(amount).ok_or("Overflow")?;
        Ok(())
    }

    pub fn burn(&mut self, from: &str, amount: i128) -> Result<(), String> {
        let balance = *self.balances.get(from).unwrap_or(&0);
        if balance < amount { return Err("Insufficient".to_string()); }
        self.balances.insert(from.to_string(), balance.checked_sub(amount).ok_or("Underflow")?);
        self.total_supply = self.total_supply.checked_sub(amount).ok_or("Underflow")?;
        self.total_burned = self.total_burned.checked_add(amount).ok_or("Overflow")?;
        Ok(())
    }

    pub fn verify(&self) -> Result<(), String> {
        let calc = self.total_minted.checked_sub(self.total_burned).ok_or("Underflow")?;
        if calc != self.total_supply { return Err(format!("Supply: {} != {}", calc, self.total_supply)); }
        let sum: i128 = self.balances.values().sum();
        if sum != self.total_supply { return Err(format!("Balance: {} != {}", sum, self.total_supply)); }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct SupplyTracker {
    pub total_supply: i128,
    pub total_minted: i128,
    pub total_burned: i128,
    pub balances: HashMap<String, i128>,
}

impl SupplyTracker {
    pub fn new(initial: i128) -> Self {
        Self { total_supply: initial, total_minted: initial, total_burned: 0, balances: HashMap::new() }
    }

    pub fn mint(&mut self, to: &str, amount: i128) -> Result<(), String> {
        self.total_supply = self.total_supply.checked_add(amount).ok_or("Overflow")?;
        self.total_minted = self.total_minted.checked_add(amount).ok_or("Overflow")?;
        *self.balances.entry(to.to_string()).or_insert(0) = self.balances.get(to).unwrap_or(&0).checked_add(amount).ok_or("Overflow")?;
        Ok(())
    }

    pub fn burn(&mut self, from: &str, amount: i128) -> Result<(), String> {
        let balance = *self.balances.get(from).unwrap_or(&0);
        if balance < amount { return Err("Insufficient".to_string()); }
        self.balances.insert(from.to_string(), balance.checked_sub(amount).ok_or("Underflow")?);
        self.total_supply = self.total_supply.checked_sub(amount).ok_or("Underflow")?;
        self.total_burned = self.total_burned.checked_add(amount).ok_or("Overflow")?;
        Ok(())
    }

    pub fn verify(&self) -> Result<(), String> {
        let calc = self.total_minted.checked_sub(self.total_burned).ok_or("Underflow")?;
        if calc != self.total_supply { return Err(format!("Supply: {} != {}", calc, self.total_supply)); }
        let sum: i128 = self.balances.values().sum();
        if sum != self.total_supply { return Err(format!("Balance: {} != {}", sum, self.total_supply)); }
        Ok(())
    }
}
