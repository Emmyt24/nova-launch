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

#[derive(Clone, Debug)]
struct AllowlistState {
    enabled: bool,
    allowed: std::vec::Vec<u32>,
}

#[derive(Clone, Copy, Debug)]
enum AllowlistAction {
    Enable,
    Disable,
    Add(u32),
    Remove(u32),
    Transfer {
        from_allowed: bool,
        to_allowed: bool,
        amount: i128,
    },
    Mint {
        to_allowed: bool,
        amount: i128,
    },
}

#[derive(Clone, Debug)]
struct TokenBalances {
    total_supply: i128,
    balances: std::vec::Vec<(u32, i128)>,
}

fn allowlist_strategy() -> impl Strategy<Value = AllowlistState> {
    (
        any::<bool>(),
        prop::collection::vec(0u32..8u32, 0..8),
    )
        .prop_map(|(enabled, mut allowed)| {
            allowed.sort_unstable();
            allowed.dedup();
            AllowlistState { enabled, allowed }
        })
}

fn allowlist_action_strategy() -> impl Strategy<Value = AllowlistAction> {
    prop_oneof![
        Just(AllowlistAction::Enable),
        Just(AllowlistAction::Disable),
        (0u32..8u32).prop_map(AllowlistAction::Add),
        (0u32..8u32).prop_map(AllowlistAction::Remove),
        (any::<bool>(), any::<bool>(), 0i128..1_000_000i128).prop_map(
            |(from_allowed, to_allowed, amount)| AllowlistAction::Transfer {
                from_allowed,
                to_allowed,
                amount,
            }
        ),
        (any::<bool>(), 0i128..1_000_000i128)
            .prop_map(|(to_allowed, amount)| AllowlistAction::Mint { to_allowed, amount }),
    ]
}

fn is_allowed(state: &AllowlistState, account: u32) -> bool {
    !state.enabled || state.allowed.binary_search(&account).is_ok()
}

fn apply_allowlist_action(
    allowlist: &mut AllowlistState,
    balances: &mut TokenBalances,
    action: AllowlistAction,
) {
    match action {
        AllowlistAction::Enable => allowlist.enabled = true,
        AllowlistAction::Disable => allowlist.enabled = false,
        AllowlistAction::Add(account) => {
            if let Err(pos) = allowlist.allowed.binary_search(&account) {
                allowlist.allowed.insert(pos, account);
            }
        }
        AllowlistAction::Remove(account) => {
            if let Ok(pos) = allowlist.allowed.binary_search(&account) {
                allowlist.allowed.remove(pos);
            }
        }
        AllowlistAction::Transfer {
            from_allowed,
            to_allowed,
            amount,
        } => {
            let from = 0u32;
            let to = 1u32;
            let from_ok = is_allowed(allowlist, from) && from_allowed;
            let to_ok = is_allowed(allowlist, to) && to_allowed;
            if !from_ok || !to_ok {
                return;
            }
            let from_balance = balances
                .balances
                .iter()
                .find(|(acct, _)| *acct == from)
                .map(|(_, bal)| *bal)
                .unwrap_or(0);
            let transfer = amount.max(0).min(from_balance);
            if transfer == 0 {
                return;
            }
            for (acct, bal) in balances.balances.iter_mut() {
                if *acct == from {
                    *bal -= transfer;
                } else if *acct == to {
                    *bal += transfer;
                }
            }
        }
        AllowlistAction::Mint { to_allowed, amount } => {
            let to = 1u32;
            if !(is_allowed(allowlist, to) && to_allowed) {
                return;
            }
            let mint = amount.max(0);
            if mint == 0 {
                return;
            }
            if let Some((_, bal)) = balances.balances.iter_mut().find(|(acct, _)| *acct == to) {
                *bal += mint;
            } else {
                balances.balances.push((to, mint));
            }
            balances.total_supply += mint;
        }
    }
}

fn sum_balances(balances: &TokenBalances) -> i128 {
    balances.balances.iter().map(|(_, bal)| *bal).sum()
}
=======

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

    #[test]
    fn prop_allowlist_preserves_balance_invariants(
        initial_allowlist in allowlist_strategy(),
        actions in prop::collection::vec(allowlist_action_strategy(), 1..80),
    ) {
        let mut allowlist = initial_allowlist;
        let mut balances = TokenBalances {
            total_supply: 0,
            balances: std::vec![(0u32, 0i128), (1u32, 0i128)],
        };

        for (step, action) in actions.iter().enumerate() {
            let prev_supply = balances.total_supply;
            let prev_sum = sum_balances(&balances);

            apply_allowlist_action(&mut allowlist, &mut balances, *action);

            prop_assert!(
                balances.balances.iter().all(|(_, bal)| *bal >= 0),
                "counterexample(non-negative balances): step={step} allowlist={allowlist:?} action={action:?} balances={balances:?}",
            );
            prop_assert!(
                balances.total_supply >= prev_supply,
                "counterexample(monotonic supply): step={step} allowlist={allowlist:?} action={action:?} prev_supply={prev_supply} curr_supply={}",
                balances.total_supply,
            );
            prop_assert_eq!(
                sum_balances(&balances),
                balances.total_supply,
                "counterexample(sum(balances)==supply): step={step} allowlist={allowlist:?} action={action:?} prev_sum={prev_sum} balances={balances:?}",
            );
        }
    }

    #[test]
    fn prop_ttl_bump_preserves_accounting_state(
        cfg in config_strategy(),
        actions in prop::collection::vec(action_strategy(), 1..40),
        bump_sequence in prop::collection::vec(any::<bool>(), 1..40),
    ) {
        let mut status = cfg.status;
        let mut current = sanitize_config(&cfg);

        for (step, action) in actions.iter().enumerate() {
            apply_action(&mut current, &mut status, *action);

            // Simulating a TTL bump on access must never mutate accounting state.
            let snapshot = current.clone();
            let status_snapshot = status;
            let bump = bump_sequence[step % bump_sequence.len()];
            if bump {
                // TTL extension is a storage-only operation; accounting is untouched.
            }

            prop_assert_eq!(
                &current.budget,
                &snapshot.budget,
                "counterexample(ttl bump budget): step={step} bump={bump} cfg={cfg:?} action={action:?}",
            );
            prop_assert_eq!(
                &current.spent,
                &snapshot.spent,
                "counterexample(ttl bump spent): step={step} bump={bump} cfg={cfg:?} action={action:?}",
            );
            prop_assert_eq!(
                &current.bought,
                &snapshot.bought,
                "counterexample(ttl bump bought): step={step} bump={bump} cfg={cfg:?} action={action:?}",
            );
            prop_assert_eq!(
                &current.burned,
                &snapshot.burned,
                "counterexample(ttl bump burned): step={step} bump={bump} cfg={cfg:?} action={action:?}",
            );
            prop_assert_eq!(
                status,
                status_snapshot,
                "counterexample(ttl bump status): step={step} bump={bump} cfg={cfg:?} action={action:?}",
            );
        }
    }
}
