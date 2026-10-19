#!/bin/bash
set -e

echo "========================================="
echo "Running Differential Testing Suite"
echo "========================================="
echo ""

echo "1. Running comprehensive differential tests..."
cargo test comprehensive_differential_tests -- --nocapture --test-threads=1

echo ""
echo "2. Running property-based differential tests..."
cargo test differential_proptest -- --nocapture

echo ""
echo "3. Running vesting differential tests..."
cargo test differential_test -- --nocapture

echo ""
echo "========================================="
echo "4. Running contract vs backend vector differential test"
echo "========================================="
echo ""

# Shared test vectors live in contracts/token-factory/test-vectors/.
# Ownership: the token-factory contract team owns the vectors and the
# contract-side runner; the backend team owns the backend-side runner.
# Any change to a vector must be reviewed by both teams.
VECTOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-vectors"
CONTRACT_OUT="$(mktemp)"
BACKEND_OUT="$(mktemp)"
trap 'rm -f "$CONTRACT_OUT" "$BACKEND_OUT"' EXIT

if [ ! -d "$VECTOR_DIR" ]; then
  echo "✗ Test vector directory not found: $VECTOR_DIR"
  exit 1
fi

echo "Running contract-side vector test..."
if ! cargo test vector_differential_tests -- --nocapture --test-threads=1 > "$CONTRACT_OUT" 2>&1; then
  echo "✗ Contract-side vector test failed"
  cat "$CONTRACT_OUT"
  exit 1
fi

echo "Running backend-side vector test..."
if ! cargo test backend_vector_differential_tests -- --nocapture --test-threads=1 > "$BACKEND_OUT" 2>&1; then
  echo "✗ Backend-side vector test failed"
  cat "$BACKEND_OUT"
  exit 1
fi

# Extract only the normalized vector result lines so unrelated test harness
# output does not cause spurious diffs.
grep '^VECTOR_RESULT ' "$CONTRACT_OUT" > "${CONTRACT_OUT}.norm" || true
grep '^VECTOR_RESULT ' "$BACKEND_OUT" > "${BACKEND_OUT}.norm" || true

if [ ! -s "${CONTRACT_OUT}.norm" ]; then
  echo "✗ Contract-side vector test produced no VECTOR_RESULT lines"
  cat "$CONTRACT_OUT"
  rm -f "${CONTRACT_OUT}.norm" "${BACKEND_OUT}.norm"
  exit 1
fi

if [ ! -s "${BACKEND_OUT}.norm" ]; then
  echo "✗ Backend-side vector test produced no VECTOR_RESULT lines"
  cat "$BACKEND_OUT"
  rm -f "${CONTRACT_OUT}.norm" "${BACKEND_OUT}.norm"
  exit 1
fi

echo ""
echo "Diffing contract and backend vector outputs..."
if ! diff -u "${CONTRACT_OUT}.norm" "${BACKEND_OUT}.norm"; then
  echo ""
  echo "✗ MISMATCH: contract math and backend math diverge on shared test vectors"
  rm -f "${CONTRACT_OUT}.norm" "${BACKEND_OUT}.norm"
  exit 1
fi
rm -f "${CONTRACT_OUT}.norm" "${BACKEND_OUT}.norm"

echo ""
echo "========================================="
echo "✓ All differential tests passed"
echo "========================================="