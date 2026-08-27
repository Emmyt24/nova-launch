//! Commit-Reveal Randomness Scheme for Front-Running-Resistant Auction
//! Tie-Breaking
//!
//! Bidders submit a hashed commitment during a bidding window, then reveal
//! the pre-image during a separate reveal window. The final tie-break seed
//! is derived from the hash-chain of all valid reveals, applied in
//! deterministic submission order (commitment index, not reveal-arrival
//! order), so no single participant can unilaterally determine the outcome.
//!
//! ```text
//! 0 ──── commit_start ──── commit_end / reveal_start ──── reveal_end
//!          [commit window]                [reveal window]
//! ```
//!
//! This module is deliberately narrow in scope: it is the tie-breaking
//! randomness primitive, not an auction implementation. `auction_id` is an
//! opaque `u64` supplied by the caller for the consuming auction module to
//! correlate a session with its own state; this module does not look up or
//! validate against any auction record.
//!
//! ## Forfeiture rule
//! A bidder who commits but never reveals forfeits their slot: they are
//! silently excluded from tie-break resolution when the session is
//! finalised. No refund advantage is granted to non-revealers — this module
//! only tracks randomness contribution, not funds.
//!
//! ## Tie-break randomness derivation
//! ```text
//! state_0 = 32 zero bytes
//! state_i = SHA256(state_{i-1} || pre_image_i)   for each revealed pre_image_i,
//!                                                 taken in ascending commitment index
//! seed    = state_n
//! ```
//! Bidders who never revealed contribute nothing and do not advance the
//! chain — the ordering is fixed by commitment index (submission order), not
//! by the order in which reveals happen to arrive, which is what prevents a
//! late revealer from choosing their position to bias the outcome.

use crate::{events, storage, types::Error};
use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env};

/// Minimum commit window duration (seconds). Floors out griefing via an
/// artificially short commit window that bidders have no realistic chance
/// to participate in.
pub const MIN_COMMIT_WINDOW: u64 = 60;
/// Maximum commit window duration (seconds).
pub const MAX_COMMIT_WINDOW: u64 = 7 * 24 * 3_600; // 7 days
/// Minimum reveal window duration (seconds).
pub const MIN_REVEAL_WINDOW: u64 = 60;
/// Maximum reveal window duration (seconds).
pub const MAX_REVEAL_WINDOW: u64 = 7 * 24 * 3_600; // 7 days
/// Maximum number of bidders a single session accepts commitments from.
pub const MAX_BIDDERS: u32 = 200;

/// Lifecycle status of a commit-reveal session.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitRevealStatus {
    /// Commit window is open (or has not started yet).
    Committing = 0,
    /// Reveal window is open.
    Revealing = 1,
    /// The tie-break seed has been derived; the session is terminal.
    Finalised = 2,
}

/// A single bidder's commitment record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitRecord {
    /// Bidder address.
    pub bidder: Address,
    /// SHA-256 commitment: `H(pre_image)`, submitted during the commit window.
    pub commitment: BytesN<32>,
    /// Ledger timestamp the commitment was submitted.
    pub committed_at: u64,
    /// Whether the pre-image was successfully revealed.
    pub revealed: bool,
    /// The revealed pre-image. `None` until `revealed == true`.
    pub pre_image: Option<BytesN<32>>,
    /// Ledger timestamp of the reveal (`0` if not yet revealed).
    pub revealed_at: u64,
    /// Sequential index within the session (0-based, assigned at commit
    /// time). This — not reveal-arrival order — is the order the hash-chain
    /// is applied in.
    pub index: u32,
}

/// A commit-reveal session.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitRevealSession {
    /// Unique session ID.
    pub id: u64,
    /// Opaque identifier of the auction (or other mechanism) this session
    /// resolves a tie-break for. Not validated by this module.
    pub auction_id: u64,
    /// Timestamp when bidders may start committing.
    pub commit_start: u64,
    /// Timestamp when the commit window closes.
    pub commit_end: u64,
    /// Timestamp when the reveal window opens (always equal to `commit_end`).
    pub reveal_start: u64,
    /// Timestamp when the reveal window closes.
    pub reveal_end: u64,
    /// Current session status.
    pub status: CommitRevealStatus,
    /// Number of commitments submitted so far.
    pub commit_count: u32,
    /// Number of valid reveals so far.
    pub reveal_count: u32,
    /// Final tie-break seed. `None` until finalisation.
    pub final_seed: Option<BytesN<32>>,
    /// Address that created the session (must match the factory admin).
    pub creator: Address,
    /// Ledger timestamp the session was created.
    pub created_at: u64,
}

/// Create a new commit-reveal session (admin only).
///
/// `reveal_start` is always set to `commit_end` — reveals may not begin
/// before commits stop being accepted.
///
/// # Errors
/// * `Error::Unauthorized` — `admin` does not match the stored factory admin.
/// * `Error::MissingAdmin` — no admin configured on the factory.
/// * `Error::ContractPaused` — the factory is paused.
/// * `Error::InvalidTimeWindow` — window ordering/duration is invalid (see
///   `validate_windows`).
pub fn create_commit_reveal_session(
    env: &Env,
    admin: &Address,
    auction_id: u64,
    commit_start: u64,
    commit_end: u64,
    reveal_end: u64,
) -> Result<u64, Error> {
    admin.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let stored_admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    validate_windows(commit_start, commit_end, reveal_end)?;

    let session_id = storage::get_next_commit_reveal_session_id(env)?;
    let now = env.ledger().timestamp();

    let session = CommitRevealSession {
        id: session_id,
        auction_id,
        commit_start,
        commit_end,
        reveal_start: commit_end,
        reveal_end,
        status: CommitRevealStatus::Committing,
        commit_count: 0,
        reveal_count: 0,
        final_seed: None,
        creator: admin.clone(),
        created_at: now,
    };
    storage::set_commit_reveal_session(env, &session);

    events::emit_commit_reveal_session_created(
        env,
        session_id,
        admin,
        auction_id,
        commit_start,
        commit_end,
        reveal_end,
    );

    Ok(session_id)
}

/// Submit a hashed commitment during the commit window.
///
/// `commitment` must equal `SHA256(pre_image)`; the contract stores only the
/// hash and never sees the pre-image until `reveal_pre_image`. Each bidder
/// may commit at most once per session; the assigned `index` is the position
/// used for hash-chain ordering at finalisation.
///
/// # Errors
/// * `Error::CommitRevealSessionNotFound` — no such session.
/// * `Error::CommitWindowClosed` — outside `[commit_start, commit_end)`.
/// * `Error::AlreadyCommitted` — `bidder` already has a commitment in this session.
/// * `Error::TooManyBidders` — the session is at capacity (`MAX_BIDDERS`).
pub fn submit_commitment(
    env: &Env,
    session_id: u64,
    bidder: &Address,
    commitment: BytesN<32>,
) -> Result<u32, Error> {
    bidder.require_auth();

    let mut session = load_session(env, session_id)?;
    let now = env.ledger().timestamp();

    if now < session.commit_start || now >= session.commit_end {
        return Err(Error::CommitWindowClosed);
    }

    if storage::has_commit_reveal_bidder(env, session_id, bidder) {
        return Err(Error::AlreadyCommitted);
    }

    if session.commit_count >= MAX_BIDDERS {
        return Err(Error::TooManyBidders);
    }

    let index = session.commit_count;
    let record = CommitRecord {
        bidder: bidder.clone(),
        commitment,
        committed_at: now,
        revealed: false,
        pre_image: None,
        revealed_at: 0,
        index,
    };
    storage::set_commit_record(env, session_id, index, &record);
    storage::set_commit_reveal_bidder_index(env, session_id, bidder, index);

    session.commit_count += 1;
    storage::set_commit_reveal_session(env, &session);

    events::emit_commitment_submitted(env, session_id, bidder, index);

    Ok(index)
}

/// Reveal the pre-image committed to earlier, during the reveal window.
///
/// Verifies `SHA256(pre_image) == commitment` before accepting the reveal.
/// On the first reveal in a session, the session status lazily transitions
/// `Committing -> Revealing`.
///
/// # Errors
/// * `Error::CommitRevealSessionNotFound` — no such session.
/// * `Error::RevealWindowClosed` — outside `[reveal_start, reveal_end)`.
/// * `Error::NoBidderCommitment` — `bidder` never committed in this session.
/// * `Error::AlreadyRevealed` — `bidder` already revealed.
/// * `Error::CommitmentMismatch` — `SHA256(pre_image)` does not match the
///   stored commitment.
pub fn reveal_pre_image(
    env: &Env,
    session_id: u64,
    bidder: &Address,
    pre_image: BytesN<32>,
) -> Result<(), Error> {
    bidder.require_auth();

    let mut session = load_session(env, session_id)?;
    let now = env.ledger().timestamp();

    if now < session.reveal_start || now >= session.reveal_end {
        return Err(Error::RevealWindowClosed);
    }

    let index = storage::get_commit_reveal_bidder_index(env, session_id, bidder)
        .ok_or(Error::NoBidderCommitment)?;
    let mut record =
        storage::get_commit_record(env, session_id, index).ok_or(Error::NoBidderCommitment)?;

    if record.revealed {
        return Err(Error::AlreadyRevealed);
    }

    let pre_image_bytes: Bytes = pre_image.clone().into();
    let digest: BytesN<32> = env.crypto().sha256(&pre_image_bytes).into();
    if digest != record.commitment {
        return Err(Error::CommitmentMismatch);
    }

    record.revealed = true;
    record.pre_image = Some(pre_image);
    record.revealed_at = now;
    storage::set_commit_record(env, session_id, index, &record);

    if session.status == CommitRevealStatus::Committing {
        session.status = CommitRevealStatus::Revealing;
    }
    session.reveal_count += 1;
    storage::set_commit_reveal_session(env, &session);

    events::emit_pre_image_revealed(env, session_id, bidder, index);

    Ok(())
}

/// Finalise the session and derive the combined tie-break seed.
///
/// Callable by anyone once the reveal window has closed. Walks every
/// commitment in ascending index (submission) order and hash-chains only
/// the revealed pre-images; bidders who never revealed are silently skipped
/// (forfeited) and do not influence the seed or its position in the chain.
///
/// # Errors
/// * `Error::CommitRevealSessionNotFound` — no such session.
/// * `Error::RevealWindowOpen` — the reveal window has not closed yet.
/// * `Error::AlreadyFinalised` — the session was already finalised.
/// * `Error::NoValidReveals` — every bidder forfeited; no seed can be derived.
pub fn finalise_session(env: &Env, session_id: u64) -> Result<BytesN<32>, Error> {
    let mut session = load_session(env, session_id)?;
    let now = env.ledger().timestamp();

    if now < session.reveal_end {
        return Err(Error::RevealWindowOpen);
    }
    if session.status == CommitRevealStatus::Finalised {
        return Err(Error::AlreadyFinalised);
    }

    let seed = derive_seed(env, &session)?;

    session.status = CommitRevealStatus::Finalised;
    session.final_seed = Some(seed.clone());
    storage::set_commit_reveal_session(env, &session);

    events::emit_commit_reveal_finalised(
        env,
        session_id,
        session.auction_id,
        &seed,
        session.reveal_count,
    );

    Ok(seed)
}

/// Look up a commit-reveal session by ID.
pub fn get_session(env: &Env, session_id: u64) -> Option<CommitRevealSession> {
    storage::get_commit_reveal_session(env, session_id)
}

/// Look up a bidder's commitment record within a session.
pub fn get_commitment(env: &Env, session_id: u64, bidder: &Address) -> Option<CommitRecord> {
    let index = storage::get_commit_reveal_bidder_index(env, session_id, bidder)?;
    storage::get_commit_record(env, session_id, index)
}

fn load_session(env: &Env, session_id: u64) -> Result<CommitRevealSession, Error> {
    storage::get_commit_reveal_session(env, session_id).ok_or(Error::CommitRevealSessionNotFound)
}

/// Validate commit/reveal window ordering and minimum/maximum durations.
///
/// `MIN_COMMIT_WINDOW` / `MIN_REVEAL_WINDOW` exist specifically to stop an
/// admin (malicious or careless) from griefing bidders with a window too
/// short to realistically act within.
fn validate_windows(commit_start: u64, commit_end: u64, reveal_end: u64) -> Result<(), Error> {
    if commit_end <= commit_start {
        return Err(Error::InvalidTimeWindow);
    }
    let commit_dur = commit_end - commit_start;
    if !(MIN_COMMIT_WINDOW..=MAX_COMMIT_WINDOW).contains(&commit_dur) {
        return Err(Error::InvalidTimeWindow);
    }

    if reveal_end <= commit_end {
        return Err(Error::InvalidTimeWindow);
    }
    let reveal_dur = reveal_end - commit_end;
    if !(MIN_REVEAL_WINDOW..=MAX_REVEAL_WINDOW).contains(&reveal_dur) {
        return Err(Error::InvalidTimeWindow);
    }

    Ok(())
}

/// Derive the final seed by hash-chaining all revealed pre-images in
/// ascending commitment-index order:
///
/// ```text
/// state_0 = [0u8; 32]
/// state_i = SHA256(state_{i-1} || pre_image_i)   for each revealed pre_image_i
/// seed    = state_n
/// ```
///
/// Non-revealed commitments are skipped without breaking the chain — the
/// order is fixed by commitment index, never by reveal-arrival order, which
/// is what stops a bidder from timing their reveal to manipulate the seed.
fn derive_seed(env: &Env, session: &CommitRevealSession) -> Result<BytesN<32>, Error> {
    let mut state = Bytes::from_array(env, &[0u8; 32]);
    let mut any_revealed = false;

    for index in 0..session.commit_count {
        let record = storage::get_commit_record(env, session.id, index)
            .ok_or(Error::CommitRevealSessionNotFound)?;

        if !record.revealed {
            continue;
        }
        let pre_image = record.pre_image.ok_or(Error::CommitRevealSessionNotFound)?;

        let pre_image_bytes: Bytes = pre_image.into();
        let mut input = state.clone();
        input.append(&pre_image_bytes);
        state = env.crypto().sha256(&input).into();
        any_revealed = true;
    }

    if !any_revealed {
        return Err(Error::NoValidReveals);
    }

    // `state` is always exactly 32 bytes: seeded at 32 zero bytes and every
    // update replaces it with a SHA-256 digest, so this conversion cannot fail.
    Ok(state
        .try_into()
        .expect("hash-chain state is always 32 bytes"))
}
