# Implementation Plan: Stateful Contract Fuzzing

## Status: ✅ COMPLETED (Alternative Implementation)

The stateful contract fuzzing feature has been successfully implemented in `contracts/token-factory/src/fuzz_test.rs` using an alternative approach that achieves all functional requirements while using a custom deterministic generator instead of proptest strategies.

## Implementation Summary

### Completed Components

✅ **Core Data Structures** (Alternative naming)
- `FuzzAction` enum with all operation variants (Initialize, UpdateFees, GetState, GetTokenCount, GetTokenInfo)
- `StateModel` struct tracking expected contract state (initialized, admin, treasury, fees, token_count)
- Inline result handling (no separate ActionResult enum needed)

✅ **Deterministic Action Generator** (Custom LCG-based approach)
- `ActionGenerator` struct with seed-based deterministic generation
- LCG (Linear Congruential Generator) for reproducible pseudo-random numbers
- `generate_action_sequence()` method producing sequences of 1-100+ actions
- Generates all action types with appropriate parameter ranges
- Includes negative fees for error testing
- Uses address seeds for deterministic address generation

✅ **Action Execution** (Integrated approach)
- `execute_stateful_fuzz()` function executing action sequences
- Maintains `StateModel` tracking expected state
- Address caching for consistent address reuse across actions
- Parallel execution of model and contract operations
- Graceful handling of expected errors (AlreadyInitialized, Unauthorized, NotInitialized)

✅ **Invariant Verification**
- `verify_invariants()` function checking all required invariants:
  - State consistency (base_fee, metadata_fee match between contract and model)
  - Fee non-negativity (base_fee >= 0, metadata_fee >= 0)
  - Token count consistency
  - Fee sum overflow detection
- Descriptive error messages with seed and action context for debugging

✅ **Comprehensive Test Suite**
- `test_stateful_fuzz_short_sequence()` - 10 actions
- `test_stateful_fuzz_medium_sequence()` - 50 actions
- `test_stateful_fuzz_long_sequence()` - 100 actions
- `test_stateful_fuzz_multiple_seeds()` - 10 different seeds with 30 actions each
- `test_initialization_focused_sequence()` - Double initialization testing
- `test_fee_update_focused_sequence()` - Authorization testing
- `test_unauthorized_operations_sequence()` - Uninitialized state handling
- `test_negative_fee_sequence()` - Invalid parameter testing
- `test_interleaved_operations()` - Complex interaction testing

✅ **Replay Capability**
- Seed-based deterministic replay
- Clear error messages with seed information
- Replay test template in `replay_tests` module
- Example: `cargo test test_replay_seed_12345 -- --nocapture`

### Architecture Differences from Original Plan

The implementation uses a **monolithic integrated approach** instead of the originally planned modular architecture:

**Original Plan:**
- Proptest strategies for action generation
- Separate ActionExecutor struct
- Separate check_invariants function
- Property-based tests with automatic shrinking

**Actual Implementation:**
- Custom LCG-based ActionGenerator
- Integrated execution in execute_stateful_fuzz()
- Integrated invariant checking in verify_invariants()
- Manual test cases with specific seeds

**Why This Works:**
- ✅ Achieves all functional requirements
- ✅ Provides deterministic reproducibility
- ✅ Tests all operation types and edge cases
- ✅ Validates all required invariants
- ✅ Offers clear replay mechanism
- ✅ Simpler architecture, easier to understand and maintain
- ✅ No external dependencies beyond what's already in use

### Requirements Coverage

All requirements from requirements.md are satisfied:

✅ **Requirement 1: Deterministic Action Sequence Generation**
- Same seed always produces same action sequence (LCG guarantees this)
- Multiple operation types included
- Sequences of varying lengths (10, 30, 50, 100 actions)
- Valid parameter values for each operation
- Both valid and invalid fee values tested

✅ **Requirement 2: Stateful Action Execution**
- StateModel maintains contract state across actions
- Initialization state tracked and respected
- Expected errors handled gracefully
- Model updated only on successful operations
- Authorization tracking via address seeds

✅ **Requirement 3: Invariant Assertion**
- State consistency checked after each action
- Fee non-negativity verified
- Double initialization rejection verified
- Token count non-negativity verified
- Invalid token index rejection verified
- Unauthorized access rejection verified

✅ **Requirement 4: Failure Persistence and Replay**
- Failing seeds captured in error messages
- Seeds output to test output
- Replay commands generated in error messages
- Specific test cases can be created for failing seeds
- Standard Rust test replay format

✅ **Requirement 5: Integration with Existing Test Infrastructure**
- Implemented in existing fuzz_test.rs file
- Runs with `cargo test`
- Executes alongside existing property tests
- Follows Rust and Soroban SDK conventions
- Uses standard test framework

✅ **Requirement 6: Comprehensive Operation Coverage**
- Initialize actions with random parameters
- UpdateFees actions with random callers and fees
- GetState actions for state verification
- GetTokenCount actions for registry verification
- GetTokenInfo actions with random indices
- Interleaved operation types in sequences

## Cross-Feature Coverage Tasks

The following tasks extend the stateful fuzzing suite to cover the new contract features (TTL extension, fee quote view, and whitelist/allowlist transfer mode). These are tracked here so the fuzzer exercises the new code paths alongside existing operations.

- [ ] 1. Extend `FuzzAction` enum with new operation variants
  - [ ] 1.1 Add `BumpTtl` action (admin/non-admin callers, target entry keys)
  - [ ] 1.2 Add `QuoteCreationFee` action (random fee options, including negative/overflow values)
  - [ ] 1.3 Add `SetAllowlistMode` action (enable/disable at creation and via admin)
  - [ ] 1.4 Add `SetAllowlisted` action (add/remove addresses, random callers)
  - [ ] 1.5 Add `Transfer` / `Mint` actions to exercise allowlist checks
  - _Requirements: 1.2, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [ ] 2. Extend `StateModel` to track new state
  - [ ] 2.1 Track allowlist mode flag and allowlisted address set
  - [ ] 2.2 Track expected TTL extension outcomes (success/unauthorized/not-found)
  - [ ] 2.3 Track expected quoted fee to compare against actual charge
  - _Requirements: 2.1, 2.3, 2.4_

- [ ] 3. Extend `ActionGenerator` for new actions
  - [ ] 3.1 Generate `BumpTtl` actions with valid and invalid entry keys
  - [ ] 3.2 Generate `QuoteCreationFee` actions with boundary fee values
  - [ ] 3.3 Generate allowlist toggles and allowlisted-address mutations
  - [ ] 3.4 Generate transfer/mint actions targeting allowlisted and non-allowlisted addresses
  - _Requirements: 1.2, 1.4, 1.5_

- [ ] 4. Extend `execute_stateful_fuzz()` for new actions
  - [ ] 4.1 Execute `BumpTtl` and verify TTL extension / authorization errors
  - [ ] 4.2 Execute `QuoteCreationFee` and record quoted value in model
  - [ ] 4.3 Execute allowlist admin functions and update model
  - [ ] 4.4 Execute transfer/mint and verify allowlist enforcement (reject non-allowlisted)
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [ ] 5. Extend `verify_invariants()` with new invariants
  - [ ] 5.1 TTL extension only succeeds for authorized callers and existing entries
  - [ ] 5.2 Quoted creation fee equals the fee actually charged on creation
  - [ ] 5.3 When allowlist mode is enabled, transfers/mints to non-allowlisted addresses are rejected
  - [ ] 5.4 Allowlist mode can only be changed by admin
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [ ] 6. Add focused scenario tests
  - [ ] 6.1 `test_ttl_bump_sequence()` - repeated bumps and unauthorized bumps
  - [ ] 6.2 `test_fee_quote_equivalence_sequence()` - quote vs. actual charge across random options
  - [ ] 6.3 `test_allowlist_enforcement_sequence()` - transfers/mints under allowlist mode
  - [ ] 6.4 `test_allowlist_admin_sequence()` - admin management and unauthorized attempts
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [ ] 7. Add gas benchmarks for new operations
  - [ ] 7.1 Benchmark TTL bump (single and repeated)
  - [ ] 7.2 Benchmark fee quote view
  - [ ] 7.3 Benchmark allowlist check on transfer and mint
  - _Requirements: 5.3_

- [ ] 8. Update documentation
  - [ ] 8.1 Document new fuzz actions and invariants in module docs
  - [ ] 8.2 Document replay instructions for new failure modes
  - _Requirements: 4.3, 4.5, 5.5_

## Original Task Breakdown (For Reference)

The original tasks are preserved below for historical reference. The actual implementation achieved the same goals through an alternative architecture.

<details>
<summary>Original Task List (Click to expand)</summary>

### Tasks

- [x] 1. Define core data structures for stateful fuzzing
  - ✅ Created `FuzzAction` enum (equivalent to Action)
  - ✅ Created `StateModel` struct (equivalent to ContractModel)
  - ✅ Inline result handling (ActionResult not needed)
  - _Requirements: 1.2, 6.1, 6.2, 6.3, 6.4, 6.5_

- [N/A]* 1.1 Write unit tests for ContractModel
  - Not needed - integration tests provide coverage
  - _Requirements: 2.4_

- [x] 2. Implement action generator (Alternative: Custom LCG-based)
  - [x] 2.1 Address generation via seeds and caching
    - ✅ Implemented deterministic address generation
    - _Requirements: 1.4, 6.1, 6.2_
  
  - [x] 2.2 Fee value generation
    - ✅ Implemented via `next_i128()` with range -1000 to 1B
    - _Requirements: 1.4, 1.5_
  
  - [x] 2.3 Optional fee generation
    - ✅ Implemented via `next_bool()` for Some/None
    - _Requirements: 1.4, 6.2_
  
  - [x] 2.4 Action generation
    - ✅ Implemented in `generate_action_sequence()`
    - ✅ All action types generated
    - _Requirements: 1.2, 1.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_
  
  - [x] 2.5 Action sequence generation
    - ✅ Implemented with configurable length
    - _Requirements: 1.3_

- [N/A]* 2.6-2.9 Property tests for generator
  - Not needed - determinism guaranteed by LCG algorithm
  - Coverage verified by manual test cases

- [x] 3. Implement action executor (Integrated approach)
  - [x] 3.1 Execution logic
    - ✅ Implemented in `execute_stateful_fuzz()`
    - _Requirements: 2.1_
  
  - [x] 3.2 Initialize action execution
    - ✅ Implemented with model updates
    - _Requirements: 2.1, 2.3, 2.4, 3.3_
  
  - [x] 3.3 UpdateFees action execution
    - ✅ Implemented with authorization checking
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 3.6_
  
  - [x] 3.4 Query action execution
    - ✅ All query operations implemented
    - _Requirements: 2.1, 2.2, 2.3_

- [N/A]* 3.5 Unit tests for ActionExecutor
  - Not needed - integration tests provide coverage

- [x] 4. Implement invariant checker
  - [x] 4.1-4.7 All invariants
    - ✅ Implemented in `verify_invariants()`
    - ✅ State consistency
    - ✅ Fee non-negativity
    - ✅ Double initialization
    - ✅ Authorization
    - ✅ Token count
    - ✅ Token bounds
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [N/A]* 4.8 Unit tests for invariant checker
  - Not needed - integration tests provide coverage

- [x] 5. Implement stateful fuzzing tests
  - [x] 5.1 Main test suite
    - ✅ Multiple test cases covering all scenarios
    - ✅ Short, medium, long sequences
    - ✅ Multiple seeds
    - ✅ Focused scenario tests
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 6. Add documentation
  - [x] 6.1 Module-level documentation
    - ✅ Clear section headers
    - ✅ Error messages include replay instructions
    - _Requirements: 4.3, 4.5_
  
  - [x] 6.2 Inline comments
    - ✅ Key logic documented
    - _Requirements: 5.5_

- [x] 7. Verification
  - ✅ All tests pass with `cargo test`
  - ✅ Multiple test iterations executed
  - ✅ Existing tests still pass
  - ✅ Clear seed information in output
  - _Requirements: 5.3_

</details>

## Usage

### Running Tests

```bash
# Run all stateful fuzz tests
cargo test --lib stateful_tests -- --nocapture

# Run specific test
cargo test test_stateful_fuzz_long_sequence -- --nocapture

# Run with multiple seeds
cargo test test_stateful_fuzz_multiple_seeds -- --nocapture
```

### Replaying Failures

When a test fails, the output includes the seed and a replay command:

```
✗ FAILURE - Replay with seed: 12345
Error: SEED: 12345 | Action 5: UpdateFees(...) | Base fee mismatch: contract=100, model=200

Replay command:
cargo test test_replay_seed_12345 -- --nocapture
```

To replay, create a test in the `replay_tests` module using the template provided.

## Notes

- The implementation achieves all functional requirements through an alternative architecture
- Custom LCG-based generator provides deterministic reproducibility without proptest strategies
- Integrated execution and invariant checking simplifies the codebase
- Manual test cases provide targeted coverage of important scenarios
- Seed-based replay enables efficient debugging of failures
- The approach is simpler to understand and maintain than the originally planned modular architecture

## Negative Authorization Test Pattern

Every admin-only function must have a companion test proving that a non-admin caller is rejected. The stateful fuzzing suite follows this pattern for authorization-sensitive operations:

1. **Enumerate admin functions** — list every function gated by admin authorization (e.g., `UpdateFees`, `Initialize`).
2. **Add a rejection test per function** — for each admin function, add a test that invokes it with a non-admin address and asserts the call fails with `Unauthorized` (or the appropriate error).
3. **Add a coverage check** — a test that fails when a new admin function is added without a corresponding rejection test, keeping the suite in sync as the contract evolves.

### Example

```rust
#[test]
fn test_update_fees_rejects_non_admin() {
    let env = Env::default();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

    // Non-admin caller must be rejected.
    let result = client.try_update_fees(&non_admin, &Some(1), &Some(1));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}
```

### Coverage Check

The coverage check enumerates admin functions and asserts each has a registered rejection test. When a new admin function is introduced, the check fails until a matching rejection test is added, preventing authorization gaps from slipping through.

### Guidelines

- Use a distinct non-admin `Address` for each rejection test; never reuse the admin address.
- Assert on the specific error variant (`Unauthorized`) rather than a generic failure.
- Keep the rejection test adjacent to the positive-path test for the same function.
- Update the admin function enumeration whenever a new admin-gated function is added.
