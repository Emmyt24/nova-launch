#![cfg(test)]

extern crate std;

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::string::String;
use std::vec::Vec;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CampaignStatus {
    Active,
    Paused,
    Completed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActionKind {
    Create,
    Pause,
    Resume,
    Execute,
    Finalize,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FuzzAction {
    kind: ActionKind,
    spend_hint: i128,
    bought_hint: i128,
    burned_hint: i128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CampaignModel {
    exists: bool,
    budget: i128,
    spent: i128,
    bought: i128,
    burned: i128,
    executions: u32,
    status: Option<CampaignStatus>,
}

impl CampaignModel {
    fn new() -> Self {
        Self {
            exists: false,
            budget: 0,
            spent: 0,
            bought: 0,
            burned: 0,
            executions: 0,
            status: None,
        }
    }

    fn is_terminal(&self) -> bool {
        matches!(self.status, Some(CampaignStatus::Completed | CampaignStatus::Cancelled))
    }

    fn apply_action(&mut self, action: FuzzAction) -> Result<(), String> {
        match action.kind {
            ActionKind::Create => {
                if self.exists {
                    return Err(String::from("campaign already created"));
                }
                let budget = action.spend_hint.max(1);
                self.exists = true;
                self.budget = budget;
                self.spent = 0;
                self.bought = 0;
                self.burned = 0;
                self.executions = 0;
                self.status = Some(CampaignStatus::Active);
                Ok(())
            }
            ActionKind::Pause => match self.status {
                Some(CampaignStatus::Active) => {
                    self.status = Some(CampaignStatus::Paused);
                    Ok(())
                }
                _ => Err(String::from("pause requires active status")),
            },
            ActionKind::Resume => match self.status {
                Some(CampaignStatus::Paused) => {
                    self.status = Some(CampaignStatus::Active);
                    Ok(())
                }
                _ => Err(String::from("resume requires paused status")),
            },
            ActionKind::Execute => match self.status {
                Some(CampaignStatus::Active) => {
                    if self.spent >= self.budget {
                        return Err(String::from("cannot execute after budget exhaustion"));
                    }

                    let remaining = self.budget - self.spent;
                    let spend = action.spend_hint.clamp(1, remaining);
                    let bought = action.bought_hint.max(0).max(spend);
                    let burned = action.burned_hint.max(0).min(bought);

                    self.spent += spend;
                    self.bought += bought;
                    self.burned += burned;
                    self.executions = self.executions.saturating_add(1);
                    Ok(())
                }
                _ => Err(String::from("execute requires active status")),
            },
            ActionKind::Finalize => match self.status {
                Some(CampaignStatus::Active) | Some(CampaignStatus::Paused) => {
                    self.status = Some(CampaignStatus::Completed);
                    Ok(())
                }
                _ => Err(String::from("finalize requires active or paused status")),
            },
            ActionKind::Cancel => match self.status {
                Some(CampaignStatus::Active) | Some(CampaignStatus::Paused) => {
                    self.status = Some(CampaignStatus::Cancelled);
                    Ok(())
                }
                _ => Err(String::from("cancel requires active or paused status")),
            },
        }
    }
}

#[derive(Clone, Debug)]
struct LcgRng {
    state: u64,
}

impl LcgRng {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self
            .state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.state
    }

    fn next_range(&mut self, max: u64) -> u64 {
        if max == 0 {
            return 0;
        }
        self.next_u64() % max
    }
}

fn parse_u64_seed(value: &str) -> Result<u64, String> {
    if let Some(hex) = value.strip_prefix("0x") {
        return u64::from_str_radix(hex, 16).map_err(|e| format!("invalid hex seed: {e}"));
    }
    value
        .parse::<u64>()
        .map_err(|e| format!("invalid decimal seed: {e}"))
}

fn generate_action(rng: &mut LcgRng) -> FuzzAction {
    let kind = match rng.next_range(6) {
        0 => ActionKind::Create,
        1 => ActionKind::Pause,
        2 => ActionKind::Resume,
        3 => ActionKind::Execute,
        4 => ActionKind::Finalize,
        _ => ActionKind::Cancel,
    };

    let spend_hint = (rng.next_range(1_000_000) as i128) + 1;
    let bought_hint = (rng.next_range(2_000_000) as i128) + 1;
    let burned_hint = rng.next_range(2_000_000) as i128;
    FuzzAction {
        kind,
        spend_hint,
        bought_hint,
        burned_hint,
    }
}

fn valid_transition(from: Option<CampaignStatus>, to: Option<CampaignStatus>) -> bool {
    match (from, to) {
        (None, None) => true,
        (None, Some(CampaignStatus::Active)) => true,
        (Some(CampaignStatus::Active), Some(CampaignStatus::Active)) => true,
        (Some(CampaignStatus::Active), Some(CampaignStatus::Paused)) => true,
        (Some(CampaignStatus::Active), Some(CampaignStatus::Completed)) => true,
        (Some(CampaignStatus::Active), Some(CampaignStatus::Cancelled)) => true,
        (Some(CampaignStatus::Paused), Some(CampaignStatus::Paused)) => true,
        (Some(CampaignStatus::Paused), Some(CampaignStatus::Active)) => true,
        (Some(CampaignStatus::Paused), Some(CampaignStatus::Completed)) => true,
        (Some(CampaignStatus::Paused), Some(CampaignStatus::Cancelled)) => true,
        (Some(CampaignStatus::Completed), Some(CampaignStatus::Completed)) => true,
        (Some(CampaignStatus::Cancelled), Some(CampaignStatus::Cancelled)) => true,
        _ => false,
    }
}

fn check_invariants(previous: &CampaignModel, current: &CampaignModel) -> Result<(), String> {
    if !valid_transition(previous.status, current.status) {
        return Err(format!(
            "invalid status transition: {:?} -> {:?}",
            previous.status, current.status
        ));
    }

    if current.budget < 0 || current.spent < 0 || current.bought < 0 || current.burned < 0 {
        return Err(String::from("budget/counters must be non-negative"));
    }

    if current.spent > current.budget {
        return Err(format!(
            "spent exceeds budget: spent={} budget={}",
            current.spent, current.budget
        ));
    }

    if current.burned > current.bought {
        return Err(format!(
            "burned exceeds bought: burned={} bought={}",
            current.burned, current.bought
        ));
    }

    if current.spent < previous.spent
        || current.bought < previous.bought
        || current.burned < previous.burned
        || current.executions < previous.executions
    {
        return Err(String::from("monotonic counters regressed"));
    }

    if previous.is_terminal() && current.status != previous.status {
        return Err(String::from("terminal status changed"));
    }

    Ok(())
}

fn failure_artifact_path(seed: u64) -> PathBuf {
    let base = env::var("CAMPAIGN_FUZZ_ARTIFACT_DIR")
        .unwrap_or_else(|_| String::from("test-artifacts/campaign-fuzz"));
    let mut path = PathBuf::from(base);
    path.push(format!("failure-seed-{seed}.txt"));
    path
}

fn persist_failure(seed: u64, depth: usize, step: usize, message: &str, trace: &[String]) {
    let path = failure_artifact_path(seed);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let mut contents = String::new();
    let _ = writeln!(contents, "seed={seed}");
    let _ = writeln!(contents, "depth={depth}");
    let _ = writeln!(contents, "failed_step={step}");
    let _ = writeln!(contents, "error={message}");
    let _ = writeln!(
        contents,
        "replay_command=CAMPAIGN_FUZZ_REPLAY_SEED={seed} CAMPAIGN_FUZZ_DEPTH={depth} cargo test --lib campaign_stateful_fuzz_test::replay_seed_from_env -- --ignored --nocapture"
    );
    let _ = writeln!(contents, "trace:");
    for (i, action) in trace.iter().enumerate() {
        let _ = writeln!(contents, "  {i:04}: {action}");
    }

    let _ = fs::write(path, contents);
}

fn run_seed(seed: u64, depth: usize) -> Result<(), String> {
    let mut rng = LcgRng::new(seed);
    let mut model = CampaignModel::new();
    let mut trace: Vec<String> = Vec::with_capacity(depth);

    for step in 0..depth {
        let action = generate_action(&mut rng);
        let before = model.clone();
        let action_repr = format!("{:?}", action);
        let result = model.apply_action(action);

        // Failed actions must not mutate state (replay safety).
        if result.is_err() && model != before {
            let msg = String::from("failed action mutated campaign state");
            trace.push(action_repr);
            persist_failure(seed, depth, step, &msg, &trace);
            return Err(msg);
        }

        if let Err(e) = check_invariants(&before, &model) {
            trace.push(action_repr);
            persist_failure(seed, depth, step, &e, &trace);
            return Err(e);
        }

        trace.push(action_repr);
    }

    Ok(())
}

fn read_u64_env(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default)
}

#[test]
fn stateful_campaign_fuzz() {
    let base_seed = read_u64_env("CAMPAIGN_FUZZ_BASE_SEED", 0xC0FFEE_1234_5678);
    let cases = read_u64_env("CAMPAIGN_FUZZ_CASES", 64);
    let depth = read_u64_env("CAMPAIGN_FUZZ_DEPTH", 150) as usize;

    for i in 0..cases {
        let seed = base_seed ^ i.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        if let Err(error) = run_seed(seed, depth) {
            panic!(
                "campaign stateful fuzz failed\nseed={seed}\ndepth={depth}\nerror={error}\nartifact={}",
                failure_artifact_path(seed).display()
            );
        }
    }
}

#[test]
#[ignore]
fn replay_seed_from_env() {
    let seed_raw = env::var("CAMPAIGN_FUZZ_REPLAY_SEED")
        .expect("Set CAMPAIGN_FUZZ_REPLAY_SEED to replay a failing seed");
    let seed = parse_u64_seed(&seed_raw).expect("Invalid CAMPAIGN_FUZZ_REPLAY_SEED");
    let depth = read_u64_env("CAMPAIGN_FUZZ_DEPTH", 150) as usize;
    run_seed(seed, depth).unwrap_or_else(|err| {
        panic!("replay failed for seed={seed} depth={depth}: {err}");
    });
}
