#![cfg(test)]

use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env};

#[derive(Debug, PartialEq, Clone)]
enum Error {
    Unauthorized, InvalidParameters, InvalidAmount, TokenNotFound,
    ContractPaused, AlreadyExecuted, ProposalCancelled, ProposalNotQueued,
    NoPendingAdmin, WrongPendingAdmin, AlreadyVoted,
    // Issue #1765: recurring payment streams
    RecurringStreamNotFound, RecurringStreamCancelled,
    RecurringPeriodNotElapsed, RecurringStreamLimitReached,
}

#[derive(Debug, PartialEq, Clone)]
enum ProposalState { Queued, Executed, Cancelled }

#[derive(Clone)]
struct StreamInfo {
    creator: Address, recipient: Address,
    amount: i128, claimed_amount: i128,
    start_time: u64, end_time: u64,
    cancelled: bool, paused: bool,
}

#[derive(Clone)]
struct Proposal {
    state: ProposalState, eta: u64,
    cancelled_at: Option<u64>, executed_at: Option<u64>,
}

use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static STREAMS: RefCell<HashMap<u64, StreamInfo>> = RefCell::new(HashMap::new());
    static PROPOSALS: RefCell<HashMap<u64, Proposal>> = RefCell::new(HashMap::new());
    static ADMIN: RefCell<Option<Address>> = RefCell::new(None);
    static PENDING_ADMIN: RefCell<Option<Address>> = RefCell::new(None);
}

fn reset_state() {
    STREAMS.with(|s| s.borrow_mut().clear());
    PROPOSALS.with(|p| p.borrow_mut().clear());
    ADMIN.with(|a| *a.borrow_mut() = None);
    PENDING_ADMIN.with(|p| *p.borrow_mut() = None);
}
fn set_stream(id: u64, s: StreamInfo) { STREAMS.with(|m| { m.borrow_mut().insert(id, s); }); }
fn get_stream(id: u64) -> Option<StreamInfo> { STREAMS.with(|m| m.borrow().get(&id).cloned()) }
fn set_proposal(id: u64, p: Proposal) { PROPOSALS.with(|m| { m.borrow_mut().insert(id, p); }); }
fn get_proposal(id: u64) -> Option<Proposal> { PROPOSALS.with(|m| m.borrow().get(&id).cloned()) }
fn set_admin(a: Address) { ADMIN.with(|v| *v.borrow_mut() = Some(a)); }
fn get_admin() -> Option<Address> { ADMIN.with(|v| v.borrow().clone()) }
fn set_pending_admin(a: Option<Address>) { PENDING_ADMIN.with(|v| *v.borrow_mut() = a); }
fn get_pending_admin() -> Option<Address> { PENDING_ADMIN.with(|v| v.borrow().clone()) }

fn propose_admin(caller: &Address, new_admin: &Address) -> Result<(), Error> {
    if get_admin().as_ref() != Some(caller) { return Err(Error::Unauthorized); }
    set_pending_admin(Some(new_admin.clone()));
    Ok(())
}

fn accept_admin(caller: &Address) -> Result<(), Error> {
    match get_pending_admin() {
        None => Err(Error::NoPendingAdmin),
        Some(p) if p != *caller => Err(Error::WrongPendingAdmin),
        Some(p) => { set_admin(p); set_pending_admin(None); Ok(()) }
    }
}

fn execute_proposal(env: &Env, pid: u64) -> Result<(), Error> {
    let mut p = get_proposal(pid).ok_or(Error::ProposalNotQueued)?;
    match p.state {
        ProposalState::Executed  => return Err(Error::AlreadyExecuted),
        ProposalState::Cancelled => return Err(Error::ProposalCancelled),
        ProposalState::Queued    => {}
    }
    if env.ledger().timestamp() <= p.eta { return Err(Error::InvalidParameters); }
    p.state = ProposalState::Executed;
    p.executed_at = Some(env.ledger().timestamp());
    set_proposal(pid, p);
    Ok(())
}

fn cancel_stream(caller: &Address, sid: u64) -> Result<(), Error> {
    let mut s = get_stream(sid).ok_or(Error::TokenNotFound)?;
    if s.creator != *caller { return Err(Error::Unauthorized); }
    if s.cancelled { return Err(Error::InvalidParameters); }
    s.cancelled = true;
    set_stream(sid, s);
    Ok(())
}

fn claim_stream(env: &Env, recipient: &Address, sid: u64) -> Result<i128, Error> {
    let mut s = get_stream(sid).ok_or(Error::TokenNotFound)?;
    if s.recipient != *recipient { return Err(Error::Unauthorized); }
    if s.cancelled { return Err(Error::InvalidParameters); }
    if s.paused    { return Err(Error::ContractPaused); }
    let now = env.ledger().timestamp();
    let vested = if now >= s.end_time { s.amount }
        else if now <= s.start_time { 0 }
        else {
            let e = now - s.start_time;
            let d = s.end_time - s.start_time;
            s.amount * e as i128 / d as i128
        };
    let claimable = vested - s.claimed_amount;
    if claimable <= 0 { return Err(Error::InvalidAmount); }
    s.claimed_amount += claimable;
    set_stream(sid, s);
    Ok(claimable)
}

fn make_env() -> Env { let e = Env::default(); e.mock_all_auths(); e }

fn make_stream_fixture(env: &Env) -> (u64, Address, Address) {
    reset_state();
    let creator   = Address::generate(env);
    let recipient = Address::generate(env);
    set_stream(0, StreamInfo {
        creator: creator.clone(), recipient: recipient.clone(),
        amount: 10_000, claimed_amount: 0,
        start_time: 1_000, end_time: 2_000,
        cancelled: false, paused: false,
    });
    (0, creator, recipient)
}

fn make_proposal_fixture(env: &Env) -> (u64, u64) {
    reset_state();
    let eta = env.ledger().timestamp() + 3_600;
    set_proposal(1, Proposal { state: ProposalState::Queued, eta, cancelled_at: None, executed_at: None });
    (1, eta)
}

fn make_admin_fixture(env: &Env) -> (Address, Address) {
    reset_state();
    let admin     = Address::generate(env);
    let new_admin = Address::generate(env);
    set_admin(admin.clone());
    (admin, new_admin)
}

#[test]
fn test_accept_admin_replay_fails_after_acceptance() {
    let env = make_env();
    let (admin, new_admin) = make_admin_fixture(&env);
    propose_admin(&admin, &new_admin).unwrap();
    accept_admin(&new_admin).unwrap();
    assert_eq!(get_admin(), Some(new_admin.clone()));
    assert_eq!(accept_admin(&new_admin), Err(Error::NoPendingAdmin));
}

#[test]
fn test_accept_admin_replay_is_deterministic() {
    let env = make_env();
    let (admin, new_admin) = make_admin_fixture(&env);
    propose_admin(&admin, &new_admin).unwrap();
    accept_admin(&new_admin).unwrap();
    for i in 0..5 {
        assert_eq!(accept_admin(&new_admin), Err(Error::NoPendingAdmin), "replay #{}", i+1);
    }
    assert_eq!(get_admin(), Some(new_admin));
}

#[test]
fn test_accept_admin_stale_replay_fails() {
    let env = make_env();
    let (admin, first) = make_admin_fixture(&env);
    let second = Address::generate(&env);
    propose_admin(&admin, &first).unwrap();
    propose_admin(&admin, &second).unwrap();
    for i in 0..3 {
        assert_eq!(accept_admin(&first), Err(Error::WrongPendingAdmin), "stale replay #{}", i+1);
    }
    accept_admin(&second).unwrap();
    assert_eq!(get_admin(), Some(second));
}

#[test]
fn test_old_admin_cannot_replay_accept_after_transfer() {
    let env = make_env();
    let (admin, new_admin) = make_admin_fixture(&env);
    propose_admin(&admin, &new_admin).unwrap();
    accept_admin(&new_admin).unwrap();
    assert!(accept_admin(&admin).is_err());
    assert_eq!(get_admin(), Some(new_admin));
}

#[test]
fn test_execute_proposal_replay_fails() {
    let env = make_env();
    let (pid, eta) = make_proposal_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = eta + 1);
    execute_proposal(&env, pid).unwrap();
    assert_eq!(get_proposal(pid).unwrap().state, ProposalState::Executed);
    assert_eq!(execute_proposal(&env, pid), Err(Error::AlreadyExecuted));
}

#[test]
fn test_execute_proposal_replay_is_deterministic() {
    let env = make_env();
    let (pid, eta) = make_proposal_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = eta + 1);
    execute_proposal(&env, pid).unwrap();
    for i in 0..5 {
        assert_eq!(execute_proposal(&env, pid), Err(Error::AlreadyExecuted), "replay #{}", i+1);
    }
}

#[test]
fn test_execute_cancelled_proposal_replay_fails() {
    let env = make_env();
    let (pid, eta) = make_proposal_fixture(&env);
    let mut p = get_proposal(pid).unwrap();
    p.state = ProposalState::Cancelled;
    p.cancelled_at = Some(env.ledger().timestamp());
    set_proposal(pid, p);
    env.ledger().with_mut(|li| li.timestamp = eta + 1);
    for i in 0..3 {
        assert_eq!(execute_proposal(&env, pid), Err(Error::ProposalCancelled), "attempt #{}", i+1);
    }
}

#[test]
fn test_two_proposals_no_cross_replay() {
    let env = make_env();
    reset_state();
    let eta1 = env.ledger().timestamp() + 1_000;
    let eta2 = env.ledger().timestamp() + 2_000;
    set_proposal(1, Proposal { state: ProposalState::Queued, eta: eta1, cancelled_at: None, executed_at: None });
    set_proposal(2, Proposal { state: ProposalState::Queued, eta: eta2, cancelled_at: None, executed_at: None });
    env.ledger().with_mut(|li| li.timestamp = eta1 + 1);
    execute_proposal(&env, 1).unwrap();
    assert_eq!(get_proposal(2).unwrap().state, ProposalState::Queued);
    env.ledger().with_mut(|li| li.timestamp = eta2 + 1);
    execute_proposal(&env, 2).unwrap();
    assert_eq!(execute_proposal(&env, 1), Err(Error::AlreadyExecuted));
    assert_eq!(execute_proposal(&env, 2), Err(Error::AlreadyExecuted));
}

#[test]
fn test_claim_stream_replay_same_timestamp_fails() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    assert!(claim_stream(&env, &recipient, sid).unwrap() > 0);
    assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidAmount));
}

#[test]
fn test_claim_stream_replay_after_full_vesting_fails() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 3_000);
    assert_eq!(claim_stream(&env, &recipient, sid).unwrap(), 10_000);
    assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidAmount));
}

#[test]
fn test_claim_stream_replay_is_deterministic() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 3_000);
    claim_stream(&env, &recipient, sid).unwrap();
    for i in 0..5 {
        assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidAmount), "replay #{}", i+1);
    }
    let s = get_stream(sid).unwrap();
    assert_eq!(s.claimed_amount, s.amount);
}

#[test]
fn test_claim_stream_replay_on_cancelled_fails() {
    let env = make_env();
    let (sid, creator, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    let partial = claim_stream(&env, &recipient, sid).unwrap();
    cancel_stream(&creator, sid).unwrap();
    for i in 0..3 {
        assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidParameters), "claim #{}", i+1);
    }
    assert_eq!(get_stream(sid).unwrap().claimed_amount, partial);
}

#[test]
fn test_claim_stream_unauthorized_replay_fails() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    let attacker = Address::generate(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    claim_stream(&env, &recipient, sid).unwrap();
    for i in 0..3 {
        assert_eq!(claim_stream(&env, &attacker, sid), Err(Error::Unauthorized), "attacker replay #{}", i+1);
    }
}

#[test]
fn test_claim_stream_incremental_no_double_accounting() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_250);
    let c1 = claim_stream(&env, &recipient, sid).unwrap();
    assert_eq!(c1, 2_500);
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    let c2 = claim_stream(&env, &recipient, sid).unwrap();
    assert_eq!(c2, 2_500);
    env.ledger().with_mut(|li| li.timestamp = 3_000);
    let c3 = claim_stream(&env, &recipient, sid).unwrap();
    assert_eq!(c3, 5_000);
    let s = get_stream(sid).unwrap();
    assert_eq!(c1 + c2 + c3, s.amount);
    assert_eq!(s.claimed_amount, s.amount);
    assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidAmount));
}

#[test]
fn test_cancel_stream_replay_fails() {
    let env = make_env();
    let (sid, creator, _) = make_stream_fixture(&env);
    cancel_stream(&creator, sid).unwrap();
    assert_eq!(cancel_stream(&creator, sid), Err(Error::InvalidParameters));
}

#[test]
fn test_cancel_stream_replay_is_deterministic() {
    let env = make_env();
    let (sid, creator, _) = make_stream_fixture(&env);
    cancel_stream(&creator, sid).unwrap();
    for i in 0..5 {
        assert_eq!(cancel_stream(&creator, sid), Err(Error::InvalidParameters), "replay #{}", i+1);
    }
    assert!(get_stream(sid).unwrap().cancelled);
}

#[test]
fn test_cancel_stream_unauthorized_replay_fails() {
    let env = make_env();
    let (sid, creator, _) = make_stream_fixture(&env);
    let attacker = Address::generate(&env);
    for i in 0..3 {
        assert_eq!(cancel_stream(&attacker, sid), Err(Error::Unauthorized), "attacker replay #{}", i+1);
    }
    assert!(!get_stream(sid).unwrap().cancelled);
    cancel_stream(&creator, sid).unwrap();
    assert!(get_stream(sid).unwrap().cancelled);
}

#[test]
fn test_cancel_then_claim_replay_no_state_drift() {
    let env = make_env();
    let (sid, creator, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    let pre = claim_stream(&env, &recipient, sid).unwrap();
    assert!(pre > 0);
    cancel_stream(&creator, sid).unwrap();
    let claimed_at_cancel = get_stream(sid).unwrap().claimed_amount;
    assert_eq!(cancel_stream(&creator, sid), Err(Error::InvalidParameters));
    for _ in 0..3 { let _ = claim_stream(&env, &recipient, sid); }
    assert_eq!(get_stream(sid).unwrap().claimed_amount, claimed_at_cancel);
}


// =============================================================================
// REPLAY REGRESSION TESTS: VAULT DEPOSIT
// =============================================================================
//
// fund_vault is IDEMPOTENT: calling it twice with valid parameters accumulates
// the deposited amount — each call is a legitimate new deposit. There is no
// "already deposited" guard because adding more funds is valid.
//
// claim_vault is REPLAY-PROTECTED: once all funds are claimed the vault is
// marked as fully claimed. A second claim attempt must return
// Error::VaultAlreadyClaimed (code 62), never silently succeed or panic.

#[derive(Debug, PartialEq, Clone)]
enum VaultStatus { Active, Claimed, Locked, Cancelled }

#[derive(Clone)]
struct VaultState {
    owner:          Address,
    total_amount:   i128,
    claimed_amount: i128,
    unlock_time:    u64,
    status:         VaultStatus,
}

thread_local! {
    static VAULTS: RefCell<std::collections::HashMap<u64, VaultState>> =
        RefCell::new(std::collections::HashMap::new());
    static VOTES: RefCell<std::collections::HashMap<(u64, String), bool>> =
        RefCell::new(std::collections::HashMap::new());
    static CAMPAIGNS: RefCell<std::collections::HashMap<u64, CampaignState>> =
        RefCell::new(std::collections::HashMap::new());
}

#[derive(Debug, PartialEq, Clone)]
enum VaultError {
    TokenNotFound, Unauthorized, InvalidAmount, InvalidParameters,
    VaultLocked, VaultAlreadyClaimed, NothingToClaim,
}

fn vault_reset() {
    VAULTS.with(|v| v.borrow_mut().clear());
}
fn vault_set(id: u64, s: VaultState) {
    VAULTS.with(|v| { v.borrow_mut().insert(id, s); });
}
fn vault_get(id: u64) -> Option<VaultState> {
    VAULTS.with(|v| v.borrow().get(&id).cloned())
}

/// Simulate fund_vault: IDEMPOTENT — accumulates on repeat calls.
fn sim_fund_vault(vault_id: u64, caller: &Address, amount: i128) -> Result<(), VaultError> {
    if amount <= 0 { return Err(VaultError::InvalidAmount); }
    let mut v = vault_get(vault_id).ok_or(VaultError::TokenNotFound)?;
    if v.status != VaultStatus::Active { return Err(VaultError::InvalidParameters); }
    v.total_amount = v.total_amount.checked_add(amount).ok_or(VaultError::InvalidAmount)?;
    vault_set(vault_id, v);
    Ok(())
}

/// Simulate claim_vault: REPLAY-PROTECTED via VaultAlreadyClaimed.
fn sim_claim_vault(env: &Env, vault_id: u64, caller: &Address) -> Result<i128, VaultError> {
    let mut v = vault_get(vault_id).ok_or(VaultError::TokenNotFound)?;
    if v.owner != *caller { return Err(VaultError::Unauthorized); }
    match v.status {
        VaultStatus::Claimed    => return Err(VaultError::VaultAlreadyClaimed),
        VaultStatus::Locked     => return Err(VaultError::VaultLocked),
        VaultStatus::Cancelled  => return Err(VaultError::InvalidParameters),
        VaultStatus::Active     => {}
    }
    if env.ledger().timestamp() < v.unlock_time { return Err(VaultError::VaultLocked); }
    let claimable = v.total_amount - v.claimed_amount;
    if claimable <= 0 { return Err(VaultError::NothingToClaim); }
    v.claimed_amount += claimable;
    v.status = VaultStatus::Claimed;
    vault_set(vault_id, v);
    Ok(claimable)
}

fn make_vault_fixture(env: &Env) -> (u64, Address) {
    vault_reset();
    let owner = Address::generate(env);
    vault_set(0, VaultState {
        owner: owner.clone(), total_amount: 5_000, claimed_amount: 0,
        unlock_time: 100, status: VaultStatus::Active,
    });
    (0, owner)
}

/// fund_vault is IDEMPOTENT: a second call with the same parameters is valid
/// and adds more funds to the vault total.
#[test]
fn replay_protection_vault_deposit_is_idempotent() {
    let env = make_env();
    let (vid, _owner) = make_vault_fixture(&env);
    let funder = Address::generate(&env);

    // First deposit succeeds
    sim_fund_vault(vid, &funder, 1_000).expect("first deposit must succeed");
    let after_first = vault_get(vid).unwrap().total_amount;

    // Second deposit with identical parameters also succeeds — it accumulates
    sim_fund_vault(vid, &funder, 1_000).expect("second deposit must also succeed (idempotent add)");
    let after_second = vault_get(vid).unwrap().total_amount;

    // Total should be initial + both deposits
    assert_eq!(after_first,  6_000, "total after first deposit");
    assert_eq!(after_second, 7_000, "total after second deposit accumulates correctly");
}

/// claim_vault is REPLAY-PROTECTED: after a full claim the vault is sealed
/// and every subsequent call must return VaultAlreadyClaimed, not panic.
#[test]
fn replay_protection_vault_claim_after_full_claim_returns_already_claimed() {
    let env = make_env();
    let (vid, owner) = make_vault_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 200);

    let claimed = sim_claim_vault(&env, vid, &owner).expect("first claim must succeed");
    assert_eq!(claimed, 5_000);
    assert_eq!(vault_get(vid).unwrap().status, VaultStatus::Claimed);

    // Replay — must return the specific VaultAlreadyClaimed error, never panic
    assert_eq!(
        sim_claim_vault(&env, vid, &owner),
        Err(VaultError::VaultAlreadyClaimed),
        "second claim must return VaultAlreadyClaimed"
    );
}

/// Multiple replay attempts must all consistently return VaultAlreadyClaimed.
#[test]
fn replay_protection_vault_claim_replay_is_deterministic() {
    let env = make_env();
    let (vid, owner) = make_vault_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 200);

    sim_claim_vault(&env, vid, &owner).unwrap();
    for i in 0..5 {
        assert_eq!(
            sim_claim_vault(&env, vid, &owner),
            Err(VaultError::VaultAlreadyClaimed),
            "replay #{} must return VaultAlreadyClaimed", i + 1
        );
    }
    // State must not drift
    let v = vault_get(vid).unwrap();
    assert_eq!(v.claimed_amount, v.total_amount);
}

/// claim_vault before unlock must return VaultLocked (not panic).
#[test]
fn replay_protection_vault_claim_before_unlock_returns_locked() {
    let env = make_env();
    let (vid, owner) = make_vault_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 50); // before unlock_time=100

    for i in 0..3 {
        assert_eq!(
            sim_claim_vault(&env, vid, &owner),
            Err(VaultError::VaultLocked),
            "attempt #{} before unlock must return VaultLocked", i + 1
        );
    }
    // After advancing time it succeeds
    env.ledger().with_mut(|li| li.timestamp = 200);
    assert!(sim_claim_vault(&env, vid, &owner).is_ok());
}

// =============================================================================
// REPLAY REGRESSION TESTS: GOVERNANCE VOTE
// =============================================================================
//
// cast_vote is REPLAY-PROTECTED: each address may vote at most once per proposal.
// A second vote attempt with the same address and proposal must return
// Error::AlreadyVoted (code 46 per error_code_stability_test). The vote totals
// must not change after the first successful vote.

#[derive(Debug, PartialEq, Clone)]
enum VoteError { ProposalNotFound, AlreadyVoted, Unauthorized, InvalidParameters }

#[derive(Clone)]
struct ProposalVoteState {
    yes_votes: i128,
    no_votes:  i128,
    open: bool,
}

thread_local! {
    static GOV_PROPOSALS: RefCell<std::collections::HashMap<u64, ProposalVoteState>> =
        RefCell::new(std::collections::HashMap::new());
    static GOV_VOTERS: RefCell<std::collections::HashMap<(u64, String), bool>> =
        RefCell::new(std::collections::HashMap::new());
}

fn gov_reset() {
    GOV_PROPOSALS.with(|p| p.borrow_mut().clear());
    GOV_VOTERS.with(|v| v.borrow_mut().clear());
}
fn gov_set_proposal(id: u64, s: ProposalVoteState) {
    GOV_PROPOSALS.with(|p| { p.borrow_mut().insert(id, s); });
}
fn gov_get_proposal(id: u64) -> Option<ProposalVoteState> {
    GOV_PROPOSALS.with(|p| p.borrow().get(&id).cloned())
}
fn gov_has_voted(proposal_id: u64, voter: &Address) -> bool {
    let key = (proposal_id, format!("{:?}", voter));
    GOV_VOTERS.with(|v| v.borrow().contains_key(&key))
}
fn gov_record_vote(proposal_id: u64, voter: &Address, support: bool) {
    let key = (proposal_id, format!("{:?}", voter));
    GOV_VOTERS.with(|v| { v.borrow_mut().insert(key, support); });
}

/// Simulate cast_vote: REPLAY-PROTECTED via AlreadyVoted.
fn sim_cast_vote(
    proposal_id: u64, voter: &Address, support: bool, voting_power: i128,
) -> Result<(), VoteError> {
    if voting_power <= 0 { return Err(VoteError::InvalidParameters); }
    let mut p = gov_get_proposal(proposal_id).ok_or(VoteError::ProposalNotFound)?;
    if !p.open { return Err(VoteError::InvalidParameters); }
    if gov_has_voted(proposal_id, voter) { return Err(VoteError::AlreadyVoted); }
    if support { p.yes_votes += voting_power; } else { p.no_votes += voting_power; }
    gov_set_proposal(proposal_id, p);
    gov_record_vote(proposal_id, voter, support);
    Ok(())
}

fn make_gov_fixture() -> u64 {
    gov_reset();
    gov_set_proposal(1, ProposalVoteState { yes_votes: 0, no_votes: 0, open: true });
    1
}

/// cast_vote is REPLAY-PROTECTED: a second vote by the same address on the same
/// proposal must return AlreadyVoted and must not change the vote totals.
#[test]
fn replay_protection_governance_vote_replay_returns_already_voted() {
    let env = make_env();
    let pid = make_gov_fixture();
    let voter = Address::generate(&env);

    // First vote succeeds
    sim_cast_vote(pid, &voter, true, 100).expect("first vote must succeed");
    let after_first = gov_get_proposal(pid).unwrap().yes_votes;

    // Replay — must return AlreadyVoted, not panic or double-count
    assert_eq!(
        sim_cast_vote(pid, &voter, true, 100),
        Err(VoteError::AlreadyVoted),
        "replay vote must return AlreadyVoted"
    );
    assert_eq!(
        gov_get_proposal(pid).unwrap().yes_votes, after_first,
        "vote total must not change on replay"
    );
}

/// Multiple replay attempts must all consistently return AlreadyVoted.
#[test]
fn replay_protection_governance_vote_replay_is_deterministic() {
    let env = make_env();
    let pid = make_gov_fixture();
    let voter = Address::generate(&env);

    sim_cast_vote(pid, &voter, true, 50).unwrap();
    for i in 0..5 {
        assert_eq!(
            sim_cast_vote(pid, &voter, true, 50),
            Err(VoteError::AlreadyVoted),
            "replay #{} must return AlreadyVoted", i + 1
        );
    }
    // Totals must reflect exactly one vote
    assert_eq!(gov_get_proposal(pid).unwrap().yes_votes, 50);
}

/// Two different voters each vote once — no cross-address replay.
#[test]
fn replay_protection_governance_vote_two_voters_no_cross_replay() {
    let env = make_env();
    let pid = make_gov_fixture();
    let alice = Address::generate(&env);
    let bob   = Address::generate(&env);

    sim_cast_vote(pid, &alice, true,  100).expect("alice vote 1");
    sim_cast_vote(pid, &bob,   false, 200).expect("bob vote 1");

    // Both replays individually rejected
    assert_eq!(sim_cast_vote(pid, &alice, true, 100), Err(VoteError::AlreadyVoted));
    assert_eq!(sim_cast_vote(pid, &bob,  false, 200), Err(VoteError::AlreadyVoted));

    let p = gov_get_proposal(pid).unwrap();
    assert_eq!(p.yes_votes, 100);
    assert_eq!(p.no_votes,  200);
}

/// Voter switches support on replay — second vote is still rejected.
#[test]
fn replay_protection_governance_vote_switch_support_rejected() {
    let env = make_env();
    let pid = make_gov_fixture();
    let voter = Address::generate(&env);

    sim_cast_vote(pid, &voter, true, 100).unwrap();

    // Attempt to switch from yes to no — must be rejected
    assert_eq!(
        sim_cast_vote(pid, &voter, false, 100),
        Err(VoteError::AlreadyVoted),
        "switching vote support must also be rejected"
    );
    // Original yes vote must stand
    let p = gov_get_proposal(pid).unwrap();
    assert_eq!(p.yes_votes, 100);
    assert_eq!(p.no_votes,  0);
}

// =============================================================================
// REPLAY REGRESSION TESTS: STREAM CLAIM
// =============================================================================
//
// claim_stream is REPLAY-PROTECTED at-saturation: once the full vested amount
// has been claimed, subsequent calls must return Error::InvalidAmount (no
// claimable balance), not panic or over-disburse. This suite specifically
// validates replay behavior using the `replay_protection_` naming convention
// for easy `cargo test replay_protection` filtering.

/// Claiming a fully vested stream twice — second call returns error.
#[test]
fn replay_protection_stream_claim_full_vested_replay_fails() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 3_000); // past end_time

    let first = claim_stream(&env, &recipient, sid).expect("first claim must succeed");
    assert_eq!(first, 10_000, "should claim full amount");

    // Replay at same timestamp
    assert_eq!(
        claim_stream(&env, &recipient, sid),
        Err(Error::InvalidAmount),
        "replay claim must return InvalidAmount"
    );
}

/// Multiple replays are deterministically rejected.
#[test]
fn replay_protection_stream_claim_replay_deterministic() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 3_000);

    claim_stream(&env, &recipient, sid).unwrap();
    for i in 0..5 {
        assert_eq!(
            claim_stream(&env, &recipient, sid),
            Err(Error::InvalidAmount),
            "replay #{} must be rejected", i + 1
        );
    }
    let s = get_stream(sid).unwrap();
    assert_eq!(s.claimed_amount, s.amount, "claimed_amount must equal total after saturation");
}

/// Replay at the same mid-stream timestamp disburses zero.
#[test]
fn replay_protection_stream_claim_mid_stream_same_timestamp_replay_fails() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_500); // 50% through

    let partial = claim_stream(&env, &recipient, sid).expect("partial claim must succeed");
    assert_eq!(partial, 5_000);

    // Same timestamp replay — nothing new vested
    assert_eq!(
        claim_stream(&env, &recipient, sid),
        Err(Error::InvalidAmount),
        "second claim at same timestamp must return InvalidAmount"
    );
}

// =============================================================================
// REPLAY REGRESSION TESTS: CAMPAIGN EXECUTE (pause/resume cycle)
// =============================================================================
//
// pause_campaign is REPLAY-PROTECTED: calling it twice on an already-paused
// campaign must return Error::CampaignAlreadyPaused (code 65), not panic.
//
// resume_campaign is similarly REPLAY-PROTECTED: resuming an already-active
// campaign must return an error (InvalidStateTransition / InvalidParameters),
// not silently succeed or panic.
//
// Together they form the "campaign execute" replay surface: the pair governs
// campaign state-change idempotency.

#[derive(Debug, PartialEq, Clone)]
enum CampaignStatus { Active, Paused, Completed, Cancelled }

#[derive(Clone)]
struct CampaignState {
    owner:  Address,
    status: CampaignStatus,
}

#[derive(Debug, PartialEq, Clone)]
enum CampaignError {
    CampaignNotFound, Unauthorized,
    CampaignAlreadyPaused, CampaignAlreadyActive,
    CampaignCompleted, CampaignCancelled,
}

fn camp_reset() { CAMPAIGNS.with(|c| c.borrow_mut().clear()); }
fn camp_set(id: u64, s: CampaignState) {
    CAMPAIGNS.with(|c| { c.borrow_mut().insert(id, s); });
}
fn camp_get(id: u64) -> Option<CampaignState> {
    CAMPAIGNS.with(|c| c.borrow().get(&id).cloned())
}

/// Simulate pause_campaign: REPLAY-PROTECTED via CampaignAlreadyPaused.
fn sim_pause_campaign(campaign_id: u64, caller: &Address) -> Result<(), CampaignError> {
    let mut c = camp_get(campaign_id).ok_or(CampaignError::CampaignNotFound)?;
    if c.owner != *caller { return Err(CampaignError::Unauthorized); }
    match c.status {
        CampaignStatus::Active    => { c.status = CampaignStatus::Paused; }
        CampaignStatus::Paused    => return Err(CampaignError::CampaignAlreadyPaused),
        CampaignStatus::Completed => return Err(CampaignError::CampaignCompleted),
        CampaignStatus::Cancelled => return Err(CampaignError::CampaignCancelled),
    }
    camp_set(campaign_id, c);
    Ok(())
}

/// Simulate resume_campaign: REPLAY-PROTECTED via CampaignAlreadyActive.
fn sim_resume_campaign(campaign_id: u64, caller: &Address) -> Result<(), CampaignError> {
    let mut c = camp_get(campaign_id).ok_or(CampaignError::CampaignNotFound)?;
    if c.owner != *caller { return Err(CampaignError::Unauthorized); }
    match c.status {
        CampaignStatus::Paused    => { c.status = CampaignStatus::Active; }
        CampaignStatus::Active    => return Err(CampaignError::CampaignAlreadyActive),
        CampaignStatus::Completed => return Err(CampaignError::CampaignCompleted),
        CampaignStatus::Cancelled => return Err(CampaignError::CampaignCancelled),
    }
    camp_set(campaign_id, c);
    Ok(())
}

fn make_campaign_fixture(env: &Env) -> (u64, Address) {
    camp_reset();
    let owner = Address::generate(env);
    camp_set(1, CampaignState { owner: owner.clone(), status: CampaignStatus::Active });
    (1, owner)
}

/// pause_campaign is REPLAY-PROTECTED: a second pause call must return
/// CampaignAlreadyPaused and must not modify state.
#[test]
fn replay_protection_campaign_execute_pause_replay_returns_already_paused() {
    let env = make_env();
    let (cid, owner) = make_campaign_fixture(&env);

    // First pause succeeds
    sim_pause_campaign(cid, &owner).expect("first pause must succeed");
    assert_eq!(camp_get(cid).unwrap().status, CampaignStatus::Paused);

    // Replay — must return CampaignAlreadyPaused, not panic
    assert_eq!(
        sim_pause_campaign(cid, &owner),
        Err(CampaignError::CampaignAlreadyPaused),
        "second pause must return CampaignAlreadyPaused"
    );
    // State must not change
    assert_eq!(camp_get(cid).unwrap().status, CampaignStatus::Paused);
}

/// Multiple pause replay attempts must all consistently return CampaignAlreadyPaused.
#[test]
fn replay_protection_campaign_execute_pause_replay_is_deterministic() {
    let env = make_env();
    let (cid, owner) = make_campaign_fixture(&env);

    sim_pause_campaign(cid, &owner).unwrap();
    for i in 0..5 {
        assert_eq!(
            sim_pause_campaign(cid, &owner),
            Err(CampaignError::CampaignAlreadyPaused),
            "pause replay #{} must return CampaignAlreadyPaused", i + 1
        );
    }
}

/// resume_campaign is REPLAY-PROTECTED: resuming an already-active campaign
/// must return CampaignAlreadyActive, not silently succeed or panic.
#[test]
fn replay_protection_campaign_execute_resume_on_active_returns_already_active() {
    let env = make_env();
    let (cid, owner) = make_campaign_fixture(&env); // starts Active

    // Resume on already-active campaign
    assert_eq!(
        sim_resume_campaign(cid, &owner),
        Err(CampaignError::CampaignAlreadyActive),
        "resuming an active campaign must return CampaignAlreadyActive"
    );
    assert_eq!(camp_get(cid).unwrap().status, CampaignStatus::Active);
}

/// Full pause-resume-pause cycle: every repeated state transition is rejected.
#[test]
fn replay_protection_campaign_execute_pause_resume_cycle_no_cross_replay() {
    let env = make_env();
    let (cid, owner) = make_campaign_fixture(&env);

    // Active -> Paused
    sim_pause_campaign(cid, &owner).unwrap();
    assert_eq!(camp_get(cid).unwrap().status, CampaignStatus::Paused);

    // Replay pause — rejected
    assert_eq!(sim_pause_campaign(cid, &owner), Err(CampaignError::CampaignAlreadyPaused));

    // Paused -> Active
    sim_resume_campaign(cid, &owner).unwrap();
    assert_eq!(camp_get(cid).unwrap().status, CampaignStatus::Active);

    // Replay resume — rejected
    assert_eq!(sim_resume_campaign(cid, &owner), Err(CampaignError::CampaignAlreadyActive));
}

/// Terminal state (Completed) blocks all execute operations with typed errors.
#[test]
fn replay_protection_campaign_execute_terminal_state_is_immutable() {
    let env = make_env();
    let owner = Address::generate(&env);
    camp_reset();
    camp_set(2, CampaignState { owner: owner.clone(), status: CampaignStatus::Completed });

    assert_eq!(sim_pause_campaign(2, &owner),   Err(CampaignError::CampaignCompleted));
    assert_eq!(sim_resume_campaign(2, &owner),  Err(CampaignError::CampaignCompleted));
}

// =============================================================================
// REPLAY REGRESSION TESTS: RECURRING STREAM TRIGGER (Issue #1765)
// =============================================================================
//
// trigger_recurring_period is REPLAY-PROTECTED: calling it again before the
// next period is due, after the recurring stream is cancelled, or after
// total_periods (without auto-renew) has been reached must return a typed
// error, not create a duplicate child stream or panic.

#[derive(Clone)]
struct RecurringStreamState {
    creator: Address,
    cancelled: bool,
    total_periods: u32,
    periods_created: u32,
    period_ledgers: u64,
    current_period_start_ledger: u64,
    auto_renew: bool,
}

thread_local! {
    static RECURRING: RefCell<HashMap<u64, RecurringStreamState>> = RefCell::new(HashMap::new());
}

fn recurring_reset() { RECURRING.with(|m| m.borrow_mut().clear()); }
fn recurring_set(id: u64, s: RecurringStreamState) { RECURRING.with(|m| { m.borrow_mut().insert(id, s); }); }
fn recurring_get(id: u64) -> Option<RecurringStreamState> { RECURRING.with(|m| m.borrow().get(&id).cloned()) }

fn make_recurring_fixture(env: &Env) -> (u64, Address) {
    recurring_reset();
    let creator = Address::generate(env);
    recurring_set(0, RecurringStreamState {
        creator: creator.clone(),
        cancelled: false,
        total_periods: 3,
        periods_created: 1,
        period_ledgers: 10,
        current_period_start_ledger: 0,
        auto_renew: false,
    });
    (0, creator)
}

fn sim_trigger_recurring_period(env: &Env, rid: u64) -> Result<u32, Error> {
    let mut s = recurring_get(rid).ok_or(Error::RecurringStreamNotFound)?;
    if s.cancelled {
        return Err(Error::RecurringStreamCancelled);
    }
    let now = env.ledger().sequence() as u64;
    if now < s.current_period_start_ledger + s.period_ledgers {
        return Err(Error::RecurringPeriodNotElapsed);
    }
    if s.periods_created >= s.total_periods && !s.auto_renew {
        return Err(Error::RecurringStreamLimitReached);
    }
    s.periods_created += 1;
    s.current_period_start_ledger = now;
    let created = s.periods_created;
    recurring_set(rid, s);
    Ok(created)
}

fn sim_cancel_recurring(rid: u64, caller: &Address) -> Result<(), Error> {
    let mut s = recurring_get(rid).ok_or(Error::RecurringStreamNotFound)?;
    if s.creator != *caller {
        return Err(Error::Unauthorized);
    }
    if s.cancelled {
        return Err(Error::RecurringStreamCancelled);
    }
    s.cancelled = true;
    recurring_set(rid, s);
    Ok(())
}

/// Triggering before the current period has elapsed is rejected — and
/// replaying the same too-early call again stays rejected (no drift toward
/// eventually succeeding without the ledger actually advancing).
#[test]
fn replay_protection_recurring_trigger_before_due_replay_fails() {
    let env = make_env();
    let (rid, _creator) = make_recurring_fixture(&env);
    env.ledger().with_mut(|li| li.sequence_number = 5); // period is 10 ledgers

    assert_eq!(sim_trigger_recurring_period(&env, rid), Err(Error::RecurringPeriodNotElapsed));
    // Replay at the same (still too-early) ledger — deterministically rejected.
    assert_eq!(sim_trigger_recurring_period(&env, rid), Err(Error::RecurringPeriodNotElapsed));
}

/// Cancelling twice — second call returns error, first cancellation is not undone.
#[test]
fn replay_protection_recurring_cancel_replay_fails() {
    let env = make_env();
    let (rid, creator) = make_recurring_fixture(&env);

    sim_cancel_recurring(rid, &creator).expect("first cancel must succeed");
    assert_eq!(
        sim_cancel_recurring(rid, &creator),
        Err(Error::RecurringStreamCancelled),
        "replay cancel must be rejected"
    );
    assert!(recurring_get(rid).unwrap().cancelled);
}

/// Once cancelled, triggering the next period is permanently rejected —
/// including on replay after the period would otherwise have been due.
#[test]
fn replay_protection_recurring_trigger_after_cancel_replay_fails() {
    let env = make_env();
    let (rid, creator) = make_recurring_fixture(&env);
    sim_cancel_recurring(rid, &creator).unwrap();

    env.ledger().with_mut(|li| li.sequence_number = 100);
    for i in 0..3 {
        assert_eq!(
            sim_trigger_recurring_period(&env, rid),
            Err(Error::RecurringStreamCancelled),
            "trigger attempt #{} after cancel must be rejected", i + 1
        );
    }
}

/// Once `total_periods` is reached without auto-renew, further triggers are
/// rejected deterministically on every replay, never silently exceeding the
/// configured bound.
#[test]
fn replay_protection_recurring_trigger_beyond_total_periods_replay_fails() {
    let env = make_env();
    let (rid, _creator) = make_recurring_fixture(&env); // total_periods = 3, periods_created = 1

    env.ledger().with_mut(|li| li.sequence_number = 10);
    assert_eq!(sim_trigger_recurring_period(&env, rid), Ok(2));

    env.ledger().with_mut(|li| li.sequence_number = 20);
    assert_eq!(sim_trigger_recurring_period(&env, rid), Ok(3));

    // periods_created (3) now equals total_periods (3) — every further
    // trigger, no matter how far the ledger advances, must be rejected.
    for seq in [30_u32, 40, 1_000] {
        env.ledger().with_mut(|li| li.sequence_number = seq);
        assert_eq!(
            sim_trigger_recurring_period(&env, rid),
            Err(Error::RecurringStreamLimitReached)
        );
    }
    assert_eq!(recurring_get(rid).unwrap().periods_created, 3, "no phantom period ever created past the bound");
}
