//! Payment streaming module (Issue #1765).
//!
//! Creates vesting-aware payment streams from a creator to a recipient,
//! optionally gated by milestones on top of the linear-vesting schedule
//! computed by [`crate::vesting`]. Distinct from the pre-existing Vaults
//! feature (`vault.rs`) — see the module-level docs there for the naming
//! history. Storage/events for streams (`DataKey::Stream`, `StreamInfo`,
//! `emit_stream_*`) predate this module as scaffolding; this module is what
//! actually wires create/claim/cancel/metadata-update logic on top of them.

use soroban_sdk::{Address, Env, String, Vec};

use crate::stream_types::{MAX_BATCH_SIZE, MAX_MILESTONES_PER_STREAM};
use crate::types::{Error, Milestone, StreamInfo, StreamParams};
use crate::{events, storage, vesting};

fn validate_params(env: &Env, params: &StreamParams, milestones_len: u32) -> Result<(), Error> {
    if params.total_amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    vesting::validate_schedule(params.start_time, params.end_time, params.cliff_time)?;
    if storage::get_token_info(env, params.token_index).is_none() {
        return Err(Error::TokenNotFound);
    }
    if milestones_len > MAX_MILESTONES_PER_STREAM {
        return Err(Error::InvalidParameters);
    }
    Ok(())
}

/// Write a new `StreamInfo` and its indices/event, unconditionally.
///
/// Callers must have already validated `params`/`milestones` and authorized
/// `creator` as appropriate — this is the single place that actually mints a
/// stream id and commits storage, shared by [`create_stream`],
/// [`batch_create_streams`], and `recurring_stream`'s per-period child-stream
/// creation (which intentionally does *not* re-require the creator's live
/// signature on every period — see `recurring_stream::trigger_recurring_period`).
pub(crate) fn mint_stream(
    env: &Env,
    creator: &Address,
    params: &StreamParams,
    metadata: Option<String>,
    milestones: Vec<Milestone>,
) -> u64 {
    let stream_id_u32 = storage::increment_stream_count(env)
        .unwrap_or_else(|e| panic!("mint_stream: counter overflow after validation: {:?}", e));
    let stream_id = stream_id_u32 as u64;

    let stream = StreamInfo {
        id: stream_id,
        creator: creator.clone(),
        recipient: params.recipient.clone(),
        token_index: params.token_index,
        total_amount: params.total_amount,
        claimed_amount: 0,
        start_time: params.start_time,
        end_time: params.end_time,
        cliff_time: params.cliff_time,
        metadata: metadata.clone(),
        cancelled: false,
        paused: false,
        disputed: false,
        milestones,
    };

    storage::set_stream(env, stream_id, &stream);
    storage::add_token_stream(env, params.token_index, stream_id_u32);
    storage::add_creator_stream_index(env, creator, env.ledger().sequence(), stream_id);

    events::emit_stream_created(
        env,
        stream_id_u32,
        creator,
        &params.recipient,
        params.total_amount,
        metadata.is_some(),
    );

    stream_id
}

/// Create a single payment stream.
///
/// # Errors
/// * `Error::ContractPaused` - Factory is paused
/// * `Error::InvalidAmount` - `total_amount <= 0`
/// * `Error::InvalidStreamSchedule` - Bad `start`/`end`/`cliff` ordering
/// * `Error::TokenNotFound` - `token_index` is not a registered token
/// * `Error::InvalidParameters` - Too many milestones, or a milestone has a non-positive `unlock_amount`
pub fn create_stream(
    env: &Env,
    creator: &Address,
    params: &StreamParams,
    metadata: Option<String>,
    milestones: Vec<Milestone>,
) -> Result<u64, Error> {
    creator.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    validate_params(env, params, milestones.len())?;
    for milestone in milestones.iter() {
        if milestone.unlock_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
    }

    Ok(mint_stream(env, creator, params, metadata, milestones))
}

/// Batch-create up to [`MAX_BATCH_SIZE`] streams in one atomic call.
///
/// Follows the same stage-then-commit atomicity model as
/// `batch_operations::batch_reveal`: every item is validated in phase 1
/// (nothing written), then every stream is written in phase 2 (infallible,
/// since everything committed there already passed phase 1).
///
/// # Errors
/// * `Error::ContractPaused` - Factory is paused
/// * `Error::InvalidParameters` - Empty batch
/// * `Error::BatchTooLarge` - `items.len() > MAX_BATCH_SIZE`
/// * Any [`create_stream`] validation error, for the first invalid item found
pub fn batch_create_streams(
    env: &Env,
    creator: &Address,
    items: Vec<StreamParams>,
) -> Result<Vec<u64>, Error> {
    creator.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let batch_len = items.len();
    if batch_len == 0 {
        return Err(Error::InvalidParameters);
    }
    if batch_len > MAX_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }

    // Phase 1 (stage): validate every item. Nothing written to storage here.
    for item in items.iter() {
        validate_params(env, &item, 0)?;
    }

    // Phase 2 (commit): every item already passed validation, so this loop
    // cannot fail on a validation error.
    let mut ids = Vec::new(env);
    for item in items.iter() {
        let stream_id = mint_stream(env, creator, &item, None, Vec::new(env));
        ids.push_back(stream_id);
    }

    events::emit_batch_streams_created(env, creator, batch_len);

    Ok(ids)
}

/// Sum of a stream's linearly-vested amount plus any verified-milestone bonus.
fn total_unlocked(stream: &StreamInfo, now: u64) -> Result<i128, Error> {
    let vested = vesting::linear_vested_amount(
        stream.total_amount,
        stream.start_time,
        stream.end_time,
        stream.cliff_time,
        now,
    )?;

    let mut milestone_unlocked: i128 = 0;
    for milestone in stream.milestones.iter() {
        if milestone.verified {
            milestone_unlocked = milestone_unlocked
                .checked_add(milestone.unlock_amount)
                .ok_or(Error::ArithmeticError)?;
        }
    }

    vested
        .checked_add(milestone_unlocked)
        .ok_or(Error::ArithmeticError)
}

/// Claim the currently-vested (and unclaimed) balance of a stream.
///
/// Commits the updated `claimed_amount` to storage and returns the claimable
/// amount, but does **not** perform the token transfer itself — the caller
/// (the `claim_stream` contract entry point) does that after this returns,
/// so state is committed before the external call (CEI pattern), matching
/// `claim_vault_inner`.
///
/// # Errors
/// * `Error::ContractPaused` - Factory is paused
/// * `Error::StreamNotFound` - No stream with this id
/// * `Error::Unauthorized` - Caller is not the stream's recipient
/// * `Error::StreamCancelled` - Stream was cancelled
/// * `Error::NothingToClaim` - Nothing vested beyond what's already claimed
/// * `Error::ArithmeticError` - Overflow computing the claimable amount
pub fn claim_stream(env: &Env, recipient: &Address, stream_id: u64) -> Result<i128, Error> {
    recipient.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let mut stream = storage::get_stream(env, stream_id).ok_or(Error::StreamNotFound)?;

    if stream.recipient != *recipient {
        return Err(Error::Unauthorized);
    }
    if stream.cancelled {
        return Err(Error::StreamCancelled);
    }

    let now = env.ledger().timestamp();
    let ceiling = total_unlocked(&stream, now)?;
    let claimable = ceiling
        .checked_sub(stream.claimed_amount)
        .ok_or(Error::ArithmeticError)?;

    if claimable <= 0 {
        return Err(Error::NothingToClaim);
    }

    stream.claimed_amount = stream
        .claimed_amount
        .checked_add(claimable)
        .ok_or(Error::ArithmeticError)?;
    storage::set_stream(env, stream_id, &stream);

    events::emit_stream_claimed(env, stream_id as u32, recipient, claimable);

    Ok(claimable)
}

/// Cancel an active stream, computing (and committing to storage) the
/// vested-but-unclaimed amount owed to the recipient and the unvested
/// remainder owed back to the creator.
///
/// Like [`claim_stream`], this does not itself transfer tokens — it commits
/// state first and returns `(vested_unclaimed, unvested_to_creator)` for the
/// `cancel_stream` contract entry point to disburse, preserving the CEI
/// ordering.
///
/// # Errors
/// * `Error::ContractPaused` - Factory is paused
/// * `Error::StreamNotFound` - No stream with this id
/// * `Error::Unauthorized` - Caller is neither the stream creator nor the contract admin
/// * `Error::StreamCancelled` - Stream was already cancelled
pub fn cancel_stream(env: &Env, actor: &Address, stream_id: u64) -> Result<(i128, i128), Error> {
    actor.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let mut stream = storage::get_stream(env, stream_id).ok_or(Error::StreamNotFound)?;

    let admin = storage::get_admin(env).ok_or(Error::MissingAdmin)?;
    if *actor != stream.creator && *actor != admin {
        return Err(Error::Unauthorized);
    }
    if stream.cancelled {
        return Err(Error::StreamCancelled);
    }

    let now = env.ledger().timestamp();
    let ceiling = total_unlocked(&stream, now)?;
    let vested_unclaimed = ceiling
        .checked_sub(stream.claimed_amount)
        .ok_or(Error::ArithmeticError)?
        .max(0);
    let capped_ceiling = ceiling.min(stream.total_amount);
    let unvested_to_creator = stream
        .total_amount
        .checked_sub(capped_ceiling)
        .ok_or(Error::ArithmeticError)?
        .max(0);

    stream.cancelled = true;
    stream.claimed_amount = stream
        .claimed_amount
        .checked_add(vested_unclaimed)
        .ok_or(Error::ArithmeticError)?;
    storage::set_stream(env, stream_id, &stream);

    events::emit_stream_cancelled_with_settlement(
        env,
        stream_id as u32,
        actor,
        vested_unclaimed,
        unvested_to_creator,
    );

    Ok((vested_unclaimed, unvested_to_creator))
}

/// Update a stream's metadata.
///
/// Metadata is immutable once the recipient has claimed anything — this
/// prevents a creator from retroactively rewriting the description of a
/// stream after value has already moved against it.
///
/// # Errors
/// * `Error::ContractPaused` - Factory is paused
/// * `Error::StreamNotFound` - No stream with this id
/// * `Error::Unauthorized` - Caller is not the stream creator
/// * `Error::StreamCancelled` - Stream was cancelled
/// * `Error::StreamMetadataLocked` - Stream has already had a claim
pub fn update_stream_metadata(
    env: &Env,
    actor: &Address,
    stream_id: u64,
    metadata: Option<String>,
) -> Result<(), Error> {
    actor.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let mut stream = storage::get_stream(env, stream_id).ok_or(Error::StreamNotFound)?;

    if stream.creator != *actor {
        return Err(Error::Unauthorized);
    }
    if stream.cancelled {
        return Err(Error::StreamCancelled);
    }
    if stream.claimed_amount > 0 {
        return Err(Error::StreamMetadataLocked);
    }

    stream.metadata = metadata.clone();
    storage::set_stream(env, stream_id, &stream);

    events::emit_stream_metadata_updated(env, stream_id as u32, actor, metadata.is_some());

    Ok(())
}

/// Verify a milestone, unlocking its `unlock_amount` on top of the linear
/// vesting schedule. Only the milestone's designated `oracle_address` may
/// call this.
///
/// # Errors
/// * `Error::ContractPaused` - Factory is paused
/// * `Error::StreamNotFound` - No stream with this id
/// * `Error::StreamCancelled` - Stream was cancelled
/// * `Error::MilestoneNotFound` - `milestone_index` out of range
/// * `Error::UnauthorizedMilestoneOracle` - Caller is not this milestone's oracle
/// * `Error::MilestoneAlreadyVerified` - Milestone was already verified
pub fn verify_stream_milestone(
    env: &Env,
    oracle: &Address,
    stream_id: u64,
    milestone_index: u32,
) -> Result<(), Error> {
    oracle.require_auth();

    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    let mut stream = storage::get_stream(env, stream_id).ok_or(Error::StreamNotFound)?;
    if stream.cancelled {
        return Err(Error::StreamCancelled);
    }

    let mut milestone = stream
        .milestones
        .get(milestone_index)
        .ok_or(Error::MilestoneNotFound)?;

    if milestone.oracle_address != *oracle {
        return Err(Error::UnauthorizedMilestoneOracle);
    }
    if milestone.verified {
        return Err(Error::MilestoneAlreadyVerified);
    }

    milestone.verified = true;
    stream.milestones.set(milestone_index, milestone);
    storage::set_stream(env, stream_id, &stream);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    fn setup(env: &Env) -> (Address, u32) {
        let admin = Address::generate(env);
        storage::set_admin(env, &admin);
        let token = crate::types::TokenInfo {
            address: Address::generate(env),
            creator: admin.clone(),
            name: String::from_str(env, "Test"),
            symbol: String::from_str(env, "TST"),
            decimals: 7,
            total_supply: 1_000_000_000,
            initial_supply: 1_000_000_000,
            max_supply: None,
            total_burned: 0,
            burn_count: 0,
            metadata_uri: None,
            metadata_version: 0,
            created_at: 0,
            is_paused: false,
            clawback_enabled: false,
            freeze_enabled: false,
        };
        storage::set_token_info(env, 0, &token);
        (admin, 0)
    }

    fn params(_env: &Env, recipient: &Address, token_index: u32) -> StreamParams {
        StreamParams {
            recipient: recipient.clone(),
            token_index,
            total_amount: 1_000,
            start_time: 0,
            end_time: 1_000,
            cliff_time: 0,
        }
    }

    #[test]
    #[should_panic]
    fn create_stream_requires_auth() {
        let env = Env::default();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = params(&env, &recipient, token_index);
            let _ = create_stream(&env, &creator, &p, None, Vec::new(&env));
        });
    }

    #[test]
    fn create_stream_rejects_zero_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let mut p = params(&env, &recipient, token_index);
            p.total_amount = 0;
            let result = create_stream(&env, &creator, &p, None, Vec::new(&env));
            assert_eq!(result, Err(Error::InvalidAmount));
        });
    }

    #[test]
    fn create_stream_rejects_bad_schedule() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let mut p = params(&env, &recipient, token_index);
            p.end_time = 0;
            p.start_time = 100;
            let result = create_stream(&env, &creator, &p, None, Vec::new(&env));
            assert_eq!(result, Err(Error::InvalidStreamSchedule));
        });
    }

    #[test]
    fn create_stream_rejects_unregistered_token() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = params(&env, &recipient, 999);
            let result = create_stream(&env, &creator, &p, None, Vec::new(&env));
            assert_eq!(result, Err(Error::TokenNotFound));
        });
    }

    #[test]
    fn create_stream_success_assigns_incrementing_ids() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        // Each auth-requiring call gets its own `as_contract` frame — calling
        // `require_auth()` twice for the same address within a single frame
        // (even under `mock_all_auths`) trips this soroban-sdk version's
        // "frame is already authorized" guard.
        let (creator, recipient, token_index) = env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            (
                Address::generate(&env),
                Address::generate(&env),
                token_index,
            )
        });
        let p = params(&env, &recipient, token_index);
        let id1 = env.as_contract(&contract_id, || {
            create_stream(&env, &creator, &p, None, Vec::new(&env)).unwrap()
        });
        let id2 = env.as_contract(&contract_id, || {
            create_stream(&env, &creator, &p, None, Vec::new(&env)).unwrap()
        });
        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
    }

    #[test]
    fn batch_create_streams_rejects_empty_batch() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            setup(&env);
            let creator = Address::generate(&env);
            let result = batch_create_streams(&env, &creator, Vec::new(&env));
            assert_eq!(result, Err(Error::InvalidParameters));
        });
    }

    #[test]
    fn batch_create_streams_rejects_over_max_batch_size() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let mut items = Vec::new(&env);
            for _ in 0..(MAX_BATCH_SIZE + 1) {
                items.push_back(params(&env, &recipient, token_index));
            }
            let result = batch_create_streams(&env, &creator, items);
            assert_eq!(result, Err(Error::BatchTooLarge));
        });
    }

    #[test]
    fn batch_create_streams_atomic_on_invalid_item() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let mut items = Vec::new(&env);
            items.push_back(params(&env, &recipient, token_index));
            let mut bad = params(&env, &recipient, token_index);
            bad.total_amount = 0;
            items.push_back(bad);

            let result = batch_create_streams(&env, &creator, items);
            assert_eq!(result, Err(Error::InvalidAmount));
            // No stream should have been written despite the first item being valid.
            assert!(storage::get_stream(&env, 1).is_none());
        });
    }

    #[test]
    fn batch_create_streams_success_returns_all_ids() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let mut items = Vec::new(&env);
            for _ in 0..5 {
                items.push_back(params(&env, &recipient, token_index));
            }
            let ids = batch_create_streams(&env, &creator, items).unwrap();
            assert_eq!(ids.len(), 5);
        });
    }

    #[test]
    fn claim_stream_before_cliff_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let mut p = params(&env, &recipient, token_index);
            p.cliff_time = 500;
            let id = create_stream(&env, &creator, &p, None, Vec::new(&env)).unwrap();

            env.ledger().with_mut(|li| li.timestamp = 100);
            let result = claim_stream(&env, &recipient, id);
            assert_eq!(result, Err(Error::NothingToClaim));
        });
    }

    #[test]
    fn claim_stream_unauthorized_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let attacker = Address::generate(&env);
            let p = params(&env, &recipient, token_index);
            let id = create_stream(&env, &creator, &p, None, Vec::new(&env)).unwrap();

            env.ledger().with_mut(|li| li.timestamp = 1_000);
            let result = claim_stream(&env, &attacker, id);
            assert_eq!(result, Err(Error::Unauthorized));
        });
    }

    #[test]
    fn claim_stream_nonexistent_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            setup(&env);
            let recipient = Address::generate(&env);
            let result = claim_stream(&env, &recipient, 999);
            assert_eq!(result, Err(Error::StreamNotFound));
        });
    }

    #[test]
    fn cancel_stream_requires_creator_or_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let attacker = Address::generate(&env);
            let p = params(&env, &recipient, token_index);
            let id = create_stream(&env, &creator, &p, None, Vec::new(&env)).unwrap();

            let result = cancel_stream(&env, &attacker, id);
            assert_eq!(result, Err(Error::Unauthorized));
        });
    }

    #[test]
    fn cancel_stream_twice_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        let (creator, id) = env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = params(&env, &recipient, token_index);
            let id = create_stream(&env, &creator, &p, None, Vec::new(&env)).unwrap();
            (creator, id)
        });

        env.as_contract(&contract_id, || cancel_stream(&env, &creator, id).unwrap());
        let result = env.as_contract(&contract_id, || cancel_stream(&env, &creator, id));
        assert_eq!(result, Err(Error::StreamCancelled));
    }

    #[test]
    fn update_metadata_before_claim_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        let (creator, id) = env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = params(&env, &recipient, token_index);
            let id = create_stream(&env, &creator, &p, None, Vec::new(&env)).unwrap();
            (creator, id)
        });

        let new_meta = Some(String::from_str(&env, "updated"));
        env.as_contract(&contract_id, || {
            update_stream_metadata(&env, &creator, id, new_meta.clone()).unwrap()
        });
        let stream = env.as_contract(&contract_id, || storage::get_stream(&env, id).unwrap());
        assert_eq!(stream.metadata, new_meta);
    }

    #[test]
    fn update_metadata_locked_after_claim() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        let (creator, recipient, id) = env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = params(&env, &recipient, token_index);
            let id = create_stream(&env, &creator, &p, None, Vec::new(&env)).unwrap();
            (creator, recipient, id)
        });

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        env.as_contract(&contract_id, || claim_stream(&env, &recipient, id).unwrap());

        let result = env.as_contract(&contract_id, || {
            update_stream_metadata(&env, &creator, id, None)
        });
        assert_eq!(result, Err(Error::StreamMetadataLocked));
    }

    #[test]
    fn update_metadata_non_creator_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = params(&env, &recipient, token_index);
            let id = create_stream(&env, &creator, &p, None, Vec::new(&env)).unwrap();

            let result = update_stream_metadata(&env, &recipient, id, None);
            assert_eq!(result, Err(Error::Unauthorized));
        });
    }

    #[test]
    fn verify_milestone_wrong_oracle_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let oracle = Address::generate(&env);
            let attacker = Address::generate(&env);
            let p = params(&env, &recipient, token_index);
            let mut milestones = Vec::new(&env);
            milestones.push_back(Milestone {
                description: String::from_str(&env, "milestone 1"),
                oracle_address: oracle.clone(),
                unlock_amount: 100,
                verified: false,
            });
            let id = create_stream(&env, &creator, &p, None, milestones).unwrap();

            let result = verify_stream_milestone(&env, &attacker, id, 0);
            assert_eq!(result, Err(Error::UnauthorizedMilestoneOracle));
        });
    }

    #[test]
    fn verify_milestone_twice_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        let (oracle, id) = env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let oracle = Address::generate(&env);
            let p = params(&env, &recipient, token_index);
            let mut milestones = Vec::new(&env);
            milestones.push_back(Milestone {
                description: String::from_str(&env, "milestone 1"),
                oracle_address: oracle.clone(),
                unlock_amount: 100,
                verified: false,
            });
            let id = create_stream(&env, &creator, &p, None, milestones).unwrap();
            (oracle, id)
        });

        env.as_contract(&contract_id, || {
            verify_stream_milestone(&env, &oracle, id, 0).unwrap()
        });
        let result = env.as_contract(&contract_id, || {
            verify_stream_milestone(&env, &oracle, id, 0)
        });
        assert_eq!(result, Err(Error::MilestoneAlreadyVerified));
    }

    #[test]
    fn verify_milestone_out_of_range_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, crate::TokenFactory);
        env.as_contract(&contract_id, || {
            let (_, token_index) = setup(&env);
            let creator = Address::generate(&env);
            let recipient = Address::generate(&env);
            let p = params(&env, &recipient, token_index);
            let id = create_stream(&env, &creator, &p, None, Vec::new(&env)).unwrap();

            let oracle = Address::generate(&env);
            let result = verify_stream_milestone(&env, &oracle, id, 0);
            assert_eq!(result, Err(Error::MilestoneNotFound));
        });
    }
}
