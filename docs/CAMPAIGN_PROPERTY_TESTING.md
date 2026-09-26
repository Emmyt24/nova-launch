# Campaign Property and Fuzz Tests

The accounting property suite uses `proptest` to check budget, burn, and
monotonic-counter invariants across generated campaign configurations and
actions. The stateful fuzz suite explores seeded lifecycle interleavings and
writes a seed plus action trace to `CAMPAIGN_FUZZ_ARTIFACT_DIR` when a failure
occurs.

Run the suites from `contracts/token-factory`:

```sh
PROPTEST_CASES=150 PROPTEST_MAX_SHRINK_ITERS=2000 \
PROPTEST_RNG_ALGORITHM=chacha PROPTEST_RNG_SEED=18364758544493064720 \
cargo test --lib accounting_property_test -- --nocapture

CAMPAIGN_FUZZ_BASE_SEED=12648430 CAMPAIGN_FUZZ_CASES=64 \
CAMPAIGN_FUZZ_DEPTH=150 CAMPAIGN_FUZZ_ARTIFACT_DIR=test-artifacts/campaign-fuzz \
cargo test --lib campaign_stateful_fuzz_test::stateful_campaign_fuzz -- --nocapture
```

For a failing fuzz artifact, replay the recorded seed and depth with:

```sh
CAMPAIGN_FUZZ_REPLAY_SEED=<seed> CAMPAIGN_FUZZ_DEPTH=<depth> \
cargo test --lib campaign_stateful_fuzz_test::replay_seed_from_env -- --ignored --nocapture
```

The `Campaign Invariant Tests` workflow uses the same fixed seeds on pull
requests and raises case count and fuzz depth on its nightly schedule.