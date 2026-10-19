# Governance Vote Accounting Contract

A Soroban smart contract for decentralized governance with property-based testing to ensure vote accounting invariants.

## Features

- Proposal creation with configurable quorum and threshold
- Token-weighted voting (vote weight = token balance)
- One-vote-per-address enforcement
- Monotonic vote tallies (votes only increase)
- Automated proposal finalization with quorum/threshold evaluation

## Property-Based Tests

This contract includes comprehensive property-based tests using `proptest` to validate critical invariants under randomized conditions.

### Running Property Tests

```bash
# Run all tests including property tests
cargo test

# Run only property tests
cargo test property_

# Run with verbose output
cargo test -- --nocapture
```

### Property Tests Included

1. **One Vote Per Address** (`property_one_vote_per_address`)
   - Validates that each address can only vote once per proposal
   - Tests with randomized vote weights and directions
   - Runs 100 iterations with different scenarios

2. **Monotonic Vote Totals** (`property_monotonic_vote_totals`)
   - Validates that vote tallies never decrease
   - Tests with random sequences of votes
   - Ensures both votes_for and votes_against only increase

3. **Quorum/Threshold Outcomes** (`property_quorum_threshold_outcomes`)
   - Validates correct proposal outcomes under random vote distributions
   - Tests all three outcomes: Passed, Rejected, Failed
   - Verifies quorum and threshold logic with randomized parameters

4. **Total Equals Sum** (`property_total_equals_sum`)
   - Validates that total votes = votes_for + votes_against
   - Tests with random vote sequences
   - Ensures accounting consistency

## Storage Layout

Storage keys and their namespacing convention are documented in
[`STORAGE_LAYOUT.md`](./STORAGE_LAYOUT.md). All governance keys are prefixed with
`gov:` (e.g. `gov:proposal:<id>`, `gov:vote:<id>:<voter>`) to avoid collisions
with other contracts sharing the same ledger space. A test
(`test_no_duplicate_storage_keys`) asserts that no two keys collide.

## CI Integration

Property tests are integrated into the CI pipeline via GitHub Actions (`.github/workflows/ci.yml`):

```yaml
- name: Run governance property tests
  run: cargo test --manifest-path contracts/governance/Cargo.toml
```

All property tests must pass before code can be merged.

## Building

```bash
# Build the contract
cargo build --target wasm32-unknown-unknown --release

# Run tests
cargo test
```

## Contract Interface

### Initialize
```rust
pub fn initialize(env: Env, token_address: Address) -> Result<(), VoteError>
```

### Create Proposal
```rust
pub fn create_proposal(
    env: Env,
    creator: Address,
    description: String,
    voting_period: u64,
    quorum: i128,
    threshold_percent: u32,
) -> u32
```

### Cast Vote
```rust
pub fn cast_vote(
    env: Env,
    voter: Address,
    proposal_id: u32,
    in_favor: bool,
) -> Result<(), VoteError>
```

### Finalize Proposal
```rust
pub fn finalize_proposal(
    env: Env,
    proposal_id: u32,
) -> Result<ProposalStatus, FinalizationError>
```

## Testing Strategy

The contract uses a dual testing approach:

1. **Unit Tests**: Validate specific scenarios and edge cases
2. **Property Tests**: Validate invariants across randomized inputs (100+ iterations each)

This ensures both correctness for known cases and robustness under unexpected conditions.
