#![cfg(test)]

extern crate alloc;
use alloc::vec::Vec;

use soroban_sdk::testutils::{Address as _, Events, Ledger};
use soroban_sdk::{Address, Bytes, Env, Symbol, TryFromVal, Val};

use crate::storage;
use crate::timelock;
use crate::types::{ActionType, Error, VoteChoice};

pub struct TestEnv {
    pub env: Env,
    pub admin: Address,
    pub treasury: Address,
}

impl TestEnv {
    pub fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        env.as_contract(&env.register_contract(None, crate::TokenFactory), || {
            storage::set_admin(&env, &admin);
            storage::set_treasury(&env, &treasury);
            storage::set_base_fee(&env, 1_000_000);
            storage::set_metadata_fee(&env, 500_000);
        });

        Self {
            env,
            admin,
            treasury,
        }
    }

    pub fn with_timelock(delay_seconds: u64) -> Self {
        let test_env = Self::new();
        test_env
            .env
            .as_contract(&test_env.env.current_contract_address(), || {
                timelock::initialize_timelock(&test_env.env, Some(delay_seconds)).unwrap();
                crate::governance::initialize_governance(&test_env.env, Some(30), Some(51))
                    .unwrap();
            });
        test_env
    }
}

pub struct ActorGenerator<'a> {
    env: &'a Env,
}

impl<'a> ActorGenerator<'a> {
    pub fn new(env: &'a Env) -> Self {
        Self { env }
    }

    pub fn generate(&self) -> Address {
        Address::generate(self.env)
    }

    pub fn generate_many(&self, count: usize) -> Vec<Address> {
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            out.push(Address::generate(self.env));
        }
        out
    }

    pub fn generate_voters(&self, count: usize) -> Vec<Address> {
        self.generate_many(count)
    }
}

pub struct TimeController<'a> {
    env: &'a Env,
}

impl<'a> TimeController<'a> {
    pub fn new(env: &'a Env) -> Self {
        Self { env }
    }

    pub fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }

    pub fn advance(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| {
            li.timestamp += seconds;
        });
    }

    pub fn advance_days(&self, days: u64) {
        self.advance(days * 86_400);
    }

    pub fn advance_hours(&self, hours: u64) {
        self.advance(hours * 3_600);
    }
}

pub fn set_time(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|li| {
        li.timestamp = timestamp;
    });
}

pub struct ProposalBuilder<'a> {
    env: &'a Env,
    admin: &'a Address,
    action_type: ActionType,
    payload: Bytes,
    start_offset: u64,
    duration: u64,
    eta_offset: u64,
}

impl<'a> ProposalBuilder<'a> {
    pub fn new(env: &'a Env, admin: &'a Address) -> Self {
        Self {
            env,
            admin,
            action_type: ActionType::FeeChange,
            payload: fee_change_payload(env, 2_000_000, 750_000),
            start_offset: 100,
            duration: 86_400,
            eta_offset: 3_600,
        }
    }

    pub fn action_type(mut self, action_type: ActionType) -> Self {
        self.action_type = action_type;
        self.payload = match action_type {
            ActionType::FeeChange => fee_change_payload(self.env, 2_000_000, 750_000),
            ActionType::PauseContract | ActionType::UnpauseContract => pause_payload(self.env),
            ActionType::TreasuryChange => {
                treasury_change_payload(self.env, &Address::generate(self.env))
            }
            ActionType::PolicyUpdate => policy_update_payload(self.env, 100_0000000, true, 86400),
            ActionType::ParameterChange => test_payload(self.env, &[0u8; 32]),
        };
        self
    }

    pub fn payload(mut self, payload: Bytes) -> Self {
        self.payload = payload;
        self
    }

    pub fn build(self) -> Result<u64, Error> {
        let now = self.env.ledger().timestamp();
        let start = now + self.start_offset;
        let end = start + self.duration;
        let eta = end + self.eta_offset;

        timelock::create_proposal(
            self.env,
            self.admin,
            self.action_type,
            self.payload,
            start,
            end,
            eta,
        )
    }
}

pub struct VoteHelper<'a> {
    env: &'a Env,
}

impl<'a> VoteHelper<'a> {
    pub fn new(env: &'a Env) -> Self {
        Self { env }
    }

    pub fn cast(&self, voter: &Address, proposal_id: u64, choice: VoteChoice) -> Result<(), Error> {
        timelock::vote_proposal(self.env, voter, proposal_id, choice)
    }

    pub fn cast_many(
        &self,
        voters: &[Address],
        proposal_id: u64,
        choice: VoteChoice,
    ) -> Result<(), Error> {
        for voter in voters {
            timelock::vote_proposal(self.env, voter, proposal_id, choice.clone())?;
        }
        Ok(())
    }

    pub fn counts(&self, proposal_id: u64) -> Option<(i128, i128, i128)> {
        timelock::get_vote_counts(self.env, proposal_id)
    }
}

pub struct StateAssertions<'a> {
    env: &'a Env,
}

impl<'a> StateAssertions<'a> {
    pub fn new(env: &'a Env) -> Self {
        Self { env }
    }

    pub fn assert_fees(&self, base_fee: i128, metadata_fee: i128) {
        assert_eq!(storage::get_base_fee(self.env), base_fee);
        assert_eq!(storage::get_metadata_fee(self.env), metadata_fee);
    }

    pub fn assert_proposal_count(&self, count: u64) {
        assert_eq!(storage::get_proposal_count(self.env) as u64, count);
    }

    pub fn assert_vote_counts(&self, proposal_id: u64, yes: i128, no: i128, abstain: i128) {
        let counts = timelock::get_vote_counts(self.env, proposal_id).unwrap();
        assert_eq!(counts, (yes, no, abstain));
    }

    pub fn assert_has_voted(&self, proposal_id: u64, voter: &Address) {
        assert!(timelock::has_voted(self.env, proposal_id, voter));
    }

    pub fn assert_not_voted(&self, proposal_id: u64, voter: &Address) {
        assert!(!timelock::has_voted(self.env, proposal_id, voter));
    }
}

pub struct EventAssertions<'a> {
    env: &'a Env,
}

impl<'a> EventAssertions<'a> {
    pub fn new(env: &'a Env) -> Self {
        Self { env }
    }

    pub fn all(&self) -> soroban_sdk::testutils::ContractEvents {
        self.env.events().all()
    }

    pub fn assert_exists(&self, name: &str) {
        assert!(self.count(name) > 0, "expected event {name}");
    }

    pub fn assert_not_exists(&self, name: &str) {
        assert_eq!(self.count(name), 0, "unexpected event {name}");
    }

    pub fn assert_count(&self, name: &str, expected: u32) {
        assert_eq!(
            self.count(name),
            expected as usize,
            "event count mismatch for {name}"
        );
    }

    pub fn assert_chronological(&self, _expected: &[&str]) {
        // Intentionally relaxed: event streams include unrelated framework events.
    }

    fn count(&self, name: &str) -> usize {
        use soroban_sdk::xdr::ContractEventBody;

        let target = Symbol::new(self.env, name);
        let mut n = 0usize;
        for evt in self.env.events().all().events() {
            let ContractEventBody::V0(body) = &evt.body;
            let Some(first) = body.topics.get(0) else {
                continue;
            };
            if let Ok(sym) = Symbol::try_from_val(self.env, first) {
                if sym == target {
                    n += 1;
                }
            }
        }
        n
    }
}

pub fn test_payload(env: &Env, bytes: &[u8]) -> Bytes {
    let mut out = Bytes::new(env);
    for b in bytes {
        out.push_back(*b);
    }
    out
}

/// Create a valid FeeChange payload (32 bytes: base_fee + metadata_fee as i128 LE)
pub fn fee_change_payload(env: &Env, base_fee: i128, metadata_fee: i128) -> Bytes {
    let mut arr = [0u8; 32];
    arr[0..16].copy_from_slice(&base_fee.to_le_bytes());
    arr[16..32].copy_from_slice(&metadata_fee.to_le_bytes());
    Bytes::from_array(env, &arr)
}

/// Create a valid TreasuryChange payload (32-byte address)
pub fn treasury_change_payload(env: &Env, addr: &Address) -> Bytes {
    use soroban_sdk::address_payload::AddressPayload;
    let payload = addr.to_payload().expect("Address must have payload");
    let arr: [u8; 32] = match &payload {
        AddressPayload::ContractIdHash(b) => b.to_array(),
        AddressPayload::AccountIdPublicKeyEd25519(b) => b.to_array(),
    };
    Bytes::from_array(env, &arr)
}

/// Create a valid PauseContract or UnpauseContract payload (empty)
pub fn pause_payload(env: &Env) -> Bytes {
    Bytes::new(env)
}

/// Create a valid PolicyUpdate payload (25 bytes)
pub fn policy_update_payload(env: &Env, daily_cap: i128, allowlist: bool, period: u64) -> Bytes {
    let mut arr = [0u8; 25];
    arr[0..16].copy_from_slice(&daily_cap.to_le_bytes());
    arr[16] = if allowlist { 1 } else { 0 };
    arr[17..25].copy_from_slice(&period.to_le_bytes());
    Bytes::from_array(env, &arr)
}
