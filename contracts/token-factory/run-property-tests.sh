#!/bin/bash
# Property-based test runner for token factory contract
# Ensures deterministic, reproducible test runs

set -e

echo "🧪 Running Property-Based Tests for Token Factory"
echo "=================================================="

# Check if cargo is available
if ! command -v cargo &> /dev/null; then
    echo "❌ Error: cargo not found. Please install Rust toolchain."
    echo "   Visit: https://rustup.rs/"
    exit 1
fi

# Set environment variables for deterministic proptest runs
export PROPTEST_CASES="${PROPTEST_CASES:-100}"
export PROPTEST_MAX_SHRINK_ITERS="${PROPTEST_MAX_SHRINK_ITERS:-1000}"

echo "📊 Test Configuration:"
echo "   - Cases per property: $PROPTEST_CASES"
echo "   - Max shrink iterations: $PROPTEST_MAX_SHRINK_ITERS"
echo ""

# Run property tests with CI profile
echo "🔍 Running burn property tests..."
cargo test --lib --profile ci burn_property_test -- --nocapture

echo ""
echo "🔍 Running supply conservation tests..."
cargo test --lib --profile ci supply_conservation_test -- --nocapture

echo ""
echo "🔍 Running total supply invariant tests (all mutations)..."
cargo test --lib --profile ci total_supply_invariant -- --nocapture

echo ""
echo "🔍 Running vesting claim fuzz tests..."
cargo test --lib --profile ci vesting_fuzz_test -- --nocapture

echo ""
echo "🔍 Running vault claim fuzz tests..."
cargo test --lib --profile ci vault_fuzz_test -- --nocapture

echo ""
echo "✅ All property tests passed!"
echo ""
echo "📈 Test Coverage:"
echo "   - Supply conservation invariants"
echo "   - Total supply equals sum of balances across mint/burn/clawback/batch mutations"
echo "   - Burn monotonicity (total_burned, burn_count)"
echo "   - Balance consistency"
echo "   - Max supply enforcement"
echo "   - Amount validity"
echo "   - Accumulation correctness"
echo "   - Vesting claim math (no overflow, monotonic, claimed <= total)"
echo "   - Vault claim math (no overflow, monotonic, claimed <= total)"