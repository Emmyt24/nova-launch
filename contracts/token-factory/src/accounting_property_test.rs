#![cfg(test)]

extern crate std;

use proptest::prelude::*;

#[derive(Clone, Copy, Debug)]
enum CampaignStatus {
    Active,
    Paused,
    Completed,
    Cancelled,
}

#[derive(Clone, Copy, Debug)]
enum CampaignAction {
    Pause,
    Resume,
    Execute {
        spent_delta: i128,
        bought_delta: i128,
        burned_delta: i128,
    },
    Finalize,
    Cancel,
}

#[derive(Clone, Debug)]
struct CampaignConfig {
    budget: i128,
    spent: i128,
    bought: i128,
    burned: i128,
    status: CampaignStatus,
}

#[derive(Clone, Debug)]
struct CampaignTotals {
    budget: i128,
    spent: i128,
    bought: i128,
    burned: i128,
}

fn near_invalid_i128(max_abs: i128) -> impl Strategy<Value = i128> {
    prop_oneof![
        (-3i128..=3i128),
        (0i128..=max_abs),
        (-max_abs..=-1i128),
    ]
}

fn config_strategy() -> impl Strategy<Value = CampaignConfig> {
    (
        near_invalid_i128(2_000_000),
        near_invalid_i128(2_000_000),
        near_invalid_i128(2_000_000),
        near_invalid_i128(2_000_000),
        prop_oneof![
            Just(CampaignStatus::Active),
            Just(CampaignStatus::Paused),
            Just(CampaignStatus::Completed),
            Just(CampaignStatus::Cancelled),
        ],
    )
        .prop_map(|(budget, spent, bought, burned, status)| CampaignConfig {
            budget,
            spent,
            bought,
            burned,
            status,
        })
}

fn action_strategy() -> impl Strategy<Value = CampaignAction> {
    prop_oneof![
        Just(CampaignAction::Pause),
        Just(CampaignAction::Resume),
        (near_invalid_i128(500_000), near_invalid_i128(500_000), near_invalid_i128(500_000))
            .prop_map(|(spent_delta, bought_delta, burned_delta)| CampaignAction::Execute {
                spent_delta,
                bought_delta,
                burned_delta,
            }),
        Just(CampaignAction::Finalize),
        Just(CampaignAction::Cancel),
    ]
}

fn sanitize_config(cfg: &CampaignConfig) -> CampaignTotals {
    let budget = cfg.budget.max(0);
    let spent = cfg.spent.max(0).min(budget);
    let bought = cfg.bought.max(0).max(spent);
    let burned = cfg.burned.max(0).min(bought);

    CampaignTotals {
        budget,
        spent,
        bought,
        burned,
    }
}

fn apply_action(state: &mut CampaignTotals, status: &mut CampaignStatus, action: CampaignAction) {
    match action {
        CampaignAction::Pause => {
            if matches!(status, CampaignStatus::Active) {
                *status = CampaignStatus::Paused;
            }
        }
        CampaignAction::Resume => {
            if matches!(status, CampaignStatus::Paused) {
                *status = CampaignStatus::Active;
            }
        }
        CampaignAction::Execute {
            spent_delta,
            bought_delta,
            burned_delta,
        } => {
            if !matches!(status, CampaignStatus::Active) {
                return;
            }

            let allowed_spend = (state.budget - state.spent).max(0);
            let spend = spent_delta.max(0).min(allowed_spend);
            let buy = bought_delta.max(0).max(spend);
            let burn = burned_delta.max(0).min(buy);

            state.spent += spend;
            state.bought += buy;
            state.burned += burn;
        }
        CampaignAction::Finalize => {
            if matches!(status, CampaignStatus::Active | CampaignStatus::Paused) {
                *status = CampaignStatus::Completed;
            }
        }
        CampaignAction::Cancel => {
            if matches!(status, CampaignStatus::Active | CampaignStatus::Paused) {
                *status = CampaignStatus::Cancelled;
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(150))]

    #[test]
    fn prop_accounting_conservation(
        cfg in config_strategy(),
        actions in prop::collection::vec(action_strategy(), 1..80),
    ) {
        let mut status = cfg.status;
        let mut current = sanitize_config(&cfg);

        let mut prev_spent = current.spent;
        let mut prev_bought = current.bought;
        let mut prev_burned = current.burned;

        for (step, action) in actions.iter().enumerate() {
            apply_action(&mut current, &mut status, *action);

            prop_assert!(
                current.spent <= current.budget,
                "counterexample(spent<=budget): step={step} status={status:?} cfg={cfg:?} action={action:?} state={current:?}",
            );
            prop_assert!(
                current.burned <= current.bought,
                "counterexample(burned<=bought): step={step} status={status:?} cfg={cfg:?} action={action:?} state={current:?}",
            );
            prop_assert!(
                current.spent >= prev_spent && current.bought >= prev_bought && current.burned >= prev_burned,
                "counterexample(monotonic totals): step={step} status={status:?} cfg={cfg:?} action={action:?} prev=({}, {}, {}) curr=({}, {}, {})",
                prev_spent,
                prev_bought,
                prev_burned,
                current.spent,
                current.bought,
                current.burned,
            );

            prev_spent = current.spent;
            prev_bought = current.bought;
            prev_burned = current.burned;
        }
    }
}
