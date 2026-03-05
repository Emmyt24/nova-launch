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
echo "✓ All differential tests passed"
echo "========================================="
