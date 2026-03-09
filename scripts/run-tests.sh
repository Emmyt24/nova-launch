#!/bin/bash
# Comprehensive test runner for Nova Launch
# Runs all core test categories with configurable profiles

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
MODE="fast"
VERBOSE=false
WORKING_DIR="contracts/token-factory"

# Usage
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Run all core test categories for Nova Launch

OPTIONS:
    -m, --mode MODE       Test mode: fast, full, nightly (default: fast)
    -v, --verbose         Enable verbose output
    -h, --help           Show this help message

MODES:
    fast      Quick validation (unit + integration, ~2-5 min)
    full      Complete test suite (unit + integration + property, ~10-15 min)
    nightly   Exhaustive testing (all tests + benchmarks, ~30-60 min)

EXAMPLES:
    # Quick validation before commit
    $0 -m fast

    # Full test suite for PR
    $0 -m full

    # Nightly comprehensive testing
    $0 -m nightly -v

    # CI usage
    $0 -m full

EOF
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -m|--mode)
            MODE="$2"
            shift 2
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            usage
            ;;
    esac
done

# Validate mode
if [[ ! "$MODE" =~ ^(fast|full|nightly)$ ]]; then
    echo -e "${RED}Invalid mode: $MODE${NC}"
    echo "Valid modes: fast, full, nightly"
    exit 1
fi

# Print header
print_header() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
}

# Print section
print_section() {
    echo -e "\n${GREEN}▶ $1${NC}"
}

# Print result
print_result() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓ $2 passed${NC}"
    else
        echo -e "${RED}✗ $2 failed${NC}"
        return 1
    fi
}

# Track results
RESULTS=()
FAILED=0

# Run test suite
run_test() {
    local name=$1
    local cmd=$2
    
    print_section "$name"
    
    if [ "$VERBOSE" = true ]; then
        eval "$cmd"
    else
        eval "$cmd" > /dev/null 2>&1
    fi
    
    local result=$?
    RESULTS+=("$name:$result")
    
    if [ $result -ne 0 ]; then
        FAILED=$((FAILED + 1))
        echo -e "${RED}✗ Failed${NC}"
    else
        echo -e "${GREEN}✓ Passed${NC}"
    fi
    
    return $result
}

# Start
print_header "Nova Launch Test Suite - Mode: $MODE"
echo "Working directory: $WORKING_DIR"
echo "Started at: $(date)"
echo ""

cd "$WORKING_DIR"

# Fast mode: Unit + Integration tests
if [[ "$MODE" == "fast" ]]; then
    print_header "Fast Mode: Unit + Integration Tests"
    
    run_test "Unit Tests" "cargo test --lib --tests" || true
    run_test "Integration Tests" "cargo test --test '*'" || true
fi

# Full mode: Unit + Integration + Property tests
if [[ "$MODE" == "full" ]]; then
    print_header "Full Mode: Unit + Integration + Property Tests"
    
    run_test "Unit Tests" "cargo test --lib --tests" || true
    run_test "Integration Tests" "cargo test --test '*'" || true
    run_test "Property Tests" "cargo test --lib --profile ci -- --nocapture" || true
fi

# Nightly mode: All tests + Benchmarks + Fuzz
if [[ "$MODE" == "nightly" ]]; then
    print_header "Nightly Mode: Comprehensive Testing"
    
    run_test "Unit Tests" "cargo test --lib --tests" || true
    run_test "Integration Tests" "cargo test --test '*'" || true
    run_test "Property Tests (Extended)" "PROPTEST_CASES=200 cargo test --lib --profile ci -- --nocapture" || true
    
    # Benchmarks (if available)
    if [ -d "benches" ]; then
        run_test "Benchmarks" "cargo bench --no-run" || true
    fi
    
    # Build optimized WASM
    run_test "WASM Build" "cargo build --target wasm32-unknown-unknown --release" || true
fi

# Summary
echo ""
print_header "Test Summary"
echo "Mode: $MODE"
echo "Total suites: ${#RESULTS[@]}"
echo "Failed: $FAILED"
echo ""

# Print results
for result in "${RESULTS[@]}"; do
    IFS=':' read -r name code <<< "$result"
    if [ "$code" -eq 0 ]; then
        echo -e "${GREEN}✓${NC} $name"
    else
        echo -e "${RED}✗${NC} $name"
    fi
done

echo ""
echo "Completed at: $(date)"

# Exit with failure if any tests failed
if [ $FAILED -gt 0 ]; then
    echo -e "\n${RED}Some tests failed. See output above for details.${NC}"
    exit 1
else
    echo -e "\n${GREEN}All tests passed!${NC}"
    exit 0
fi
