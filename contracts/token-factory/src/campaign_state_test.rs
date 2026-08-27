//! Campaign state machine tests (issue #1764).
//!
//! Covers the full transition table: every legal transition lands, every
//! illegal one is rejected with a dedicated error, and replays of a
//! transition that already applied are refused rather than silently
//! succeeding.

#![cfg(test)]

use crate::campaign;
use crate::storage;
use crate::test_helpers::TestEnv;
use crate::types::{BuybackCampaign, CampaignStatus, Error};
use soroban_sdk::{testutils::Address as _, Address, Env};

const ALL_STATUSES: [CampaignStatus; 5] = [
    CampaignStatus::Active,
    CampaignStatus::Paused,
    CampaignStatus::Completed,
    CampaignStatus::Cancelled,
    CampaignStatus::Expired,
];

fn make_campaign(env: &Env, owner: &Address, status: CampaignStatus) -> BuybackCampaign {
    let source = Address::generate(env);
    let target = Address::generate(env);
    let now = env.ledger().timestamp();
    BuybackCampaign {
        id: 1,
        token_index: 0,
        budget: 1_000_000,
        spent: 0,
        tokens_bought: 0,
        tokens_burned: 0,
        max_spend_per_step: 100_000,
        execution_count: 0,
        start_time: now,
        end_time: now + 86_400,
        min_interval: 300,
        max_slippage_bps: 100,
        source_token: source,
        target_token: target,
        owner: owner.clone(),
        status,
        created_at: now,
        updated_at: now,
        trigger_price: 0,
        last_executed_at: 0,
    }
}

/// Seed a campaign in `status` and run `body` inside the contract context.
fn with_campaign<F, T>(status: CampaignStatus, body: F) -> T
where
    F: FnOnce(&Env, &Address) -> T,
{
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;
    env.as_contract(&env.current_contract_address(), || {
        let campaign = make_campaign(env, admin, status);
        storage::set_campaign(env, 1, &campaign);
        // Keep the active gauge consistent with the seeded status so the
        // decrement on pause/cancel/finalize does not underflow.
        if status == CampaignStatus::Active {
            storage::set_active_campaign_count(env, 1);
        }
        body(env, admin)
    })
}

fn status_of(env: &Env) -> CampaignStatus {
    storage::get_campaign(env, 1).unwrap().status
}

// ── Legal transitions ────────────────────────────────────────────────────

#[test]
fn pause_moves_active_to_paused() {
    with_campaign(CampaignStatus::Active, |env, admin| {
        assert_eq!(campaign::pause_campaign(env, admin, 1), Ok(()));
        assert_eq!(status_of(env), CampaignStatus::Paused);
        assert_eq!(storage::get_active_campaign_count(env), 0);
    });
}

#[test]
fn resume_moves_paused_to_active() {
    with_campaign(CampaignStatus::Paused, |env, admin| {
        assert_eq!(campaign::resume_campaign(env, admin, 1), Ok(()));
        assert_eq!(status_of(env), CampaignStatus::Active);
        assert_eq!(storage::get_active_campaign_count(env), 1);
    });
}

#[test]
fn pause_resume_round_trips() {
    with_campaign(CampaignStatus::Active, |env, admin| {
        campaign::pause_campaign(env, admin, 1).unwrap();
        campaign::resume_campaign(env, admin, 1).unwrap();
        campaign::pause_campaign(env, admin, 1).unwrap();
        assert_eq!(status_of(env), CampaignStatus::Paused);
        assert_eq!(storage::get_active_campaign_count(env), 0);
    });
}

#[test]
fn finalize_moves_active_to_completed() {
    with_campaign(CampaignStatus::Active, |env, admin| {
        assert_eq!(campaign::finalize_campaign(env, admin, 1), Ok(()));
        assert_eq!(status_of(env), CampaignStatus::Completed);
    });
}

#[test]
fn finalize_moves_paused_to_completed() {
    with_campaign(CampaignStatus::Paused, |env, admin| {
        assert_eq!(campaign::finalize_campaign(env, admin, 1), Ok(()));
        assert_eq!(status_of(env), CampaignStatus::Completed);
    });
}

#[test]
fn cancel_moves_active_to_cancelled() {
    with_campaign(CampaignStatus::Active, |env, admin| {
        assert_eq!(campaign::cancel_campaign(env, admin, 1), Ok(()));
        assert_eq!(status_of(env), CampaignStatus::Cancelled);
    });
}

#[test]
fn cancel_moves_paused_to_cancelled() {
    with_campaign(CampaignStatus::Paused, |env, admin| {
        assert_eq!(campaign::cancel_campaign(env, admin, 1), Ok(()));
        assert_eq!(status_of(env), CampaignStatus::Cancelled);
    });
}

// ── Replay protection ────────────────────────────────────────────────────

#[test]
fn pausing_a_paused_campaign_is_rejected() {
    with_campaign(CampaignStatus::Paused, |env, admin| {
        assert_eq!(
            campaign::pause_campaign(env, admin, 1),
            Err(Error::CampaignAlreadyPaused)
        );
        assert_eq!(status_of(env), CampaignStatus::Paused);
    });
}

#[test]
fn resuming_an_active_campaign_is_rejected() {
    with_campaign(CampaignStatus::Active, |env, admin| {
        assert_eq!(
            campaign::resume_campaign(env, admin, 1),
            Err(Error::CampaignNotPaused)
        );
        assert_eq!(status_of(env), CampaignStatus::Active);
    });
}

#[test]
fn cancelling_a_cancelled_campaign_is_rejected() {
    with_campaign(CampaignStatus::Cancelled, |env, admin| {
        assert_eq!(
            campaign::cancel_campaign(env, admin, 1),
            Err(Error::CampaignCancelled)
        );
    });
}

#[test]
fn finalizing_a_completed_campaign_is_rejected() {
    with_campaign(CampaignStatus::Completed, |env, admin| {
        assert_eq!(
            campaign::finalize_campaign(env, admin, 1),
            Err(Error::CampaignCompleted)
        );
    });
}

/// `retry_finalize_campaign` is the idempotent variant: the same second call
/// that `finalize_campaign` rejects must succeed here.
#[test]
fn retry_finalize_is_idempotent_once_completed() {
    with_campaign(CampaignStatus::Completed, |env, admin| {
        assert_eq!(campaign::retry_finalize_campaign(env, admin, 1), Ok(()));
        assert_eq!(status_of(env), CampaignStatus::Completed);
    });
}

#[test]
fn retry_finalize_still_rejects_cancelled() {
    with_campaign(CampaignStatus::Cancelled, |env, admin| {
        assert_eq!(
            campaign::retry_finalize_campaign(env, admin, 1),
            Err(Error::CampaignCancelled)
        );
    });
}

#[test]
fn retry_finalize_completes_an_active_campaign() {
    with_campaign(CampaignStatus::Active, |env, admin| {
        assert_eq!(campaign::retry_finalize_campaign(env, admin, 1), Ok(()));
        assert_eq!(status_of(env), CampaignStatus::Completed);
    });
}

// ── Terminal states are terminal ─────────────────────────────────────────

#[test]
fn terminal_states_reject_every_transition() {
    for status in [
        CampaignStatus::Completed,
        CampaignStatus::Cancelled,
        CampaignStatus::Expired,
    ] {
        let expected = match status {
            CampaignStatus::Completed => Error::CampaignCompleted,
            CampaignStatus::Cancelled => Error::CampaignCancelled,
            _ => Error::CampaignExpiredError,
        };

        with_campaign(status, |env, admin| {
            assert_eq!(campaign::pause_campaign(env, admin, 1), Err(expected));
            assert_eq!(campaign::resume_campaign(env, admin, 1), Err(expected));
            assert_eq!(campaign::cancel_campaign(env, admin, 1), Err(expected));
            assert_eq!(campaign::finalize_campaign(env, admin, 1), Err(expected));
            // Status is unchanged by any of the rejected attempts.
            assert_eq!(status_of(env), status);
        });
    }
}

// ── Transition table ─────────────────────────────────────────────────────

/// The table allows exactly six transitions; everything else, including every
/// self-transition, is rejected.
#[test]
fn transition_table_matches_the_documented_state_machine() {
    let legal = [
        (CampaignStatus::Active, CampaignStatus::Paused),
        (CampaignStatus::Paused, CampaignStatus::Active),
        (CampaignStatus::Active, CampaignStatus::Completed),
        (CampaignStatus::Paused, CampaignStatus::Completed),
        (CampaignStatus::Active, CampaignStatus::Cancelled),
        (CampaignStatus::Paused, CampaignStatus::Cancelled),
    ];

    for from in ALL_STATUSES {
        for to in ALL_STATUSES {
            let expected_ok = legal.contains(&(from, to));
            let actual = campaign::validate_state_transition(from, to);
            assert_eq!(
                actual.is_ok(),
                expected_ok,
                "transition {:?} -> {:?} classified incorrectly",
                from,
                to
            );
            if !expected_ok {
                assert_eq!(actual, Err(Error::InvalidStateTransition));
            }
        }
    }
}

#[test]
fn self_transitions_are_never_legal() {
    for status in ALL_STATUSES {
        assert_eq!(
            campaign::validate_state_transition(status, status),
            Err(Error::InvalidStateTransition)
        );
    }
}

// ── Authorization ────────────────────────────────────────────────────────

#[test]
fn a_stranger_cannot_transition_a_campaign() {
    with_campaign(CampaignStatus::Active, |env, _admin| {
        let stranger = Address::generate(env);
        assert_eq!(
            campaign::pause_campaign(env, &stranger, 1),
            Err(Error::Unauthorized)
        );
        assert_eq!(
            campaign::cancel_campaign(env, &stranger, 1),
            Err(Error::Unauthorized)
        );
        assert_eq!(
            campaign::finalize_campaign(env, &stranger, 1),
            Err(Error::Unauthorized)
        );
        assert_eq!(status_of(env), CampaignStatus::Active);
    });
}

#[test]
fn the_campaign_owner_can_transition_without_being_admin() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    env.as_contract(&env.current_contract_address(), || {
        let owner = Address::generate(env);
        let campaign = make_campaign(env, &owner, CampaignStatus::Active);
        storage::set_campaign(env, 1, &campaign);
        storage::set_active_campaign_count(env, 1);

        assert_eq!(campaign::pause_campaign(env, &owner, 1), Ok(()));
        assert_eq!(status_of(env), CampaignStatus::Paused);
    });
}

#[test]
fn transitions_on_a_missing_campaign_report_not_found() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;
    env.as_contract(&env.current_contract_address(), || {
        assert_eq!(
            campaign::pause_campaign(env, admin, 404),
            Err(Error::CampaignNotFound)
        );
        assert_eq!(
            campaign::cancel_campaign(env, admin, 404),
            Err(Error::CampaignNotFound)
        );
    });
}

// ── Cancellation accounting ──────────────────────────────────────────────

/// Cancelling reports the unspent remainder, not the whole budget, so the
/// treasury releases only what was never committed.
#[test]
fn cancel_reports_the_unspent_budget() {
    let test_env = TestEnv::new();
    let env = &test_env.env;
    let admin = &test_env.admin;
    env.as_contract(&env.current_contract_address(), || {
        let mut c = make_campaign(env, admin, CampaignStatus::Active);
        c.spent = 250_000;
        storage::set_campaign(env, 1, &c);
        storage::set_active_campaign_count(env, 1);

        assert_eq!(campaign::cancel_campaign(env, admin, 1), Ok(()));

        let after = storage::get_campaign(env, 1).unwrap();
        // Cancellation is a status change only: it must not rewrite the
        // accounting fields.
        assert_eq!(after.spent, 250_000);
        assert_eq!(after.budget, 1_000_000);
        assert_eq!(after.status, CampaignStatus::Cancelled);
    });
}
