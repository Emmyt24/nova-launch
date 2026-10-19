#!/bin/bash
set -e

# Token Factory Contract Build & Optimization Script
# This script builds the Token Factory contract in release mode,
# optimizes the WASM binary for size, and documents the results.
#
# Usage: ./scripts/build-contract.sh [--skip-tests] [--skip-optimize]
# Options:
#   --skip-tests     Skip running tests
#   --skip-optimize  Skip WASM optimization
#   --help          Show this help message

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONTRACT_DIR="$PROJECT_ROOT/contracts/token-factory"
TARGET_DIR="$CONTRACT_DIR/target/wasm32-unknown-unknown/release"
WASM_FILE="$TARGET_DIR/token_factory.wasm"
BUILD_LOG="$PROJECT_ROOT/build-report.txt"
# Maximum allowed optimized WASM size in bytes (default 100KB).
# Override with the WASM_SIZE_THRESHOLD env var or a .wasm-size-threshold file
# in the project root.
DEFAULT_SIZE_THRESHOLD=102400
SIZE_THRESHOLD_FILE="$PROJECT_ROOT/.wasm-size-threshold"
SIZE_HISTORY_FILE="$PROJECT_ROOT/wasm-size-history.csv"

# Parse command line arguments
SKIP_TESTS=false
SKIP_OPTIMIZE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-tests)
            SKIP_TESTS=true
            shift
            ;;
        --skip-optimize)
            SKIP_OPTIMIZE=true
            shift
            ;;
        --help)
            echo "Token Factory Contract Build & Optimization Script"
            echo ""
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --skip-tests     Skip running tests"
            echo "  --skip-optimize  Skip WASM optimization"
            echo "  --help          Show this help message"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if ! command -v cargo &> /dev/null; then
        log_error "Cargo not found. Please install Rust."
        exit 1
    fi
    
    if ! command -v soroban &> /dev/null; then
        log_error "Soroban CLI not found. Please install it with: cargo install --locked soroban-cli"
        exit 1
    fi
    
    if ! rustup target list | grep -q "wasm32-unknown-unknown (installed)"; then
        log_warning "wasm32-unknown-unknown target not installed. Installing..."
        rustup target add wasm32-unknown-unknown
    fi
    
    log_success "All prerequisites met"
}

# Build contract
build_contract() {
    log_info "Building Token Factory contract in release mode..."
    
    cd "$CONTRACT_DIR"
    
    # Clean previous builds
    log_info "Cleaning previous builds..."
    cargo clean
    
    # Build with release profile
    log_info "Compiling contract..."
    cargo build --target wasm32-unknown-unknown --release 2>&1
    
    if [ ! -f "$WASM_FILE" ]; then
        log_error "Build failed: WASM file not found at $WASM_FILE"
        exit 1
    fi
    
    log_success "Contract built successfully"
}

# Get file size
get_file_size() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        stat -f%z "$1" 2>/dev/null || echo "0"
    else
        stat -c%s "$1" 2>/dev/null || echo "0"
    fi
}

# Resolve the maximum allowed WASM size in bytes.
# Priority: WASM_SIZE_THRESHOLD env var > .wasm-size-threshold file > default.
get_size_threshold() {
    local threshold="$DEFAULT_SIZE_THRESHOLD"

    if [ -f "$SIZE_THRESHOLD_FILE" ]; then
        local file_value
        file_value=$(tr -d '[:space:]' < "$SIZE_THRESHOLD_FILE")
        if [[ "$file_value" =~ ^[0-9]+$ ]]; then
            threshold="$file_value"
        else
            log_warning "Ignoring invalid threshold in $SIZE_THRESHOLD_FILE: '$file_value'"
        fi
    fi

    if [ -n "${WASM_SIZE_THRESHOLD:-}" ]; then
        if [[ "$WASM_SIZE_THRESHOLD" =~ ^[0-9]+$ ]]; then
            threshold="$WASM_SIZE_THRESHOLD"
        else
            log_warning "Ignoring invalid WASM_SIZE_THRESHOLD: '$WASM_SIZE_THRESHOLD'"
        fi
    fi

    echo "$threshold"
}

# Fail the build when the optimized WASM exceeds the configured threshold.
check_size_threshold() {
    local size=$1
    local threshold
    threshold=$(get_size_threshold)

    log_info "WASM size threshold: $threshold bytes"

    if [ "$size" -gt "$threshold" ]; then
        log_error "WASM size $size bytes exceeds threshold of $threshold bytes"
        return 1
    fi

    log_success "WASM size $size bytes is within threshold of $threshold bytes"
    return 0
}

# Append a timestamped entry to the size history CSV.
record_size_history() {
    local before_size=$1
    local after_size=$2
    local threshold
    threshold=$(get_size_threshold)

    if [ ! -f "$SIZE_HISTORY_FILE" ]; then
        echo "timestamp,commit,before_bytes,after_bytes,threshold_bytes,status" > "$SIZE_HISTORY_FILE"
    fi

    local timestamp
    timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    local commit
    commit=$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")
    local status="pass"
    if [ "$after_size" -gt "$threshold" ]; then
        status="fail"
    fi

    echo "$timestamp,$commit,$before_size,$after_size,$threshold,$status" >> "$SIZE_HISTORY_FILE"
    log_success "Size history updated: $SIZE_HISTORY_FILE"
}

# Run tests
run_tests() {
    log_info "Running contract tests..."
    
    cd "$CONTRACT_DIR"
    
    if cargo test --release 2>&1; then
        log_success "All tests passed"
    else
        log_error "Tests failed"
        exit 1
    fi
}

# Optimize WASM
#
# Optimization flags used:
#   --opt-level z  Optimize aggressively for size (equivalent to Cargo's opt-level = "z")
#   --lto          Enable link-time optimization across the whole binary
#   --strip        Strip debug symbols and unused metadata from the WASM
#
# These mirror the [profile.release] settings in the contract's Cargo.toml
# (opt-level = "z", lto = true, strip = "symbols", codegen-units = 1,
# panic = "abort", debug = 0, overflow-checks = true).
optimize_wasm() {
    log_info "Optimizing WASM binary..."

    if soroban contract optimize \
        --wasm "$WASM_FILE" \
        --opt-level z \
        --lto \
        --strip 2>&1; then
        log_success "WASM optimization completed"
    else
        log_error "WASM optimization failed"
        exit 1
    fi
}

# Emit interface snapshot: full contract interface for frontend ABI drift detection
emit_interface_snapshot() {
    log_info "Extracting contract interface snapshot..."

    # Check if Node.js is available
    if ! command -v node &> /dev/null; then
        log_warning "Node.js not found — skipping interface snapshot generation"
        log_info "Install Node.js to enable contract-to-frontend ABI validation"
        return 0
    fi

    # Run the interface extraction script
    cd "$PROJECT_ROOT"
    if node scripts/extract-contract-interface.js; then
        log_success "Contract interface snapshot generated successfully"
    else
        log_error "Failed to generate interface snapshot (non-blocking)"
        # Don't exit — snapshot generation is a quality-of-life feature
    fi
}

# Generate build report
generate_report() {    local before_size=$1
    local after_size=$2
    local reduction=0
    
    if [ "$before_size" -gt 0 ]; then
        reduction=$((100 - (after_size * 100 / before_size)))
    fi
    
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local rust_version=$(rustc --version)
    local cargo_version=$(cargo --version)
    local soroban_version=$(soroban --version 2>/dev/null || echo "unknown")
    
    cat > "$BUILD_LOG" << EOF
# Token Factory Contract Build Report
Generated: $timestamp

## Build Environment
- Rust: $rust_version
- Cargo: $cargo_version
- Soroban CLI: $soroban_version
- Target: wasm32-unknown-unknown
- Profile: release

## Binary Size Metrics
- Size before optimization: $before_size bytes ($(numfmt --to=iec-i --suffix=B $before_size 2>/dev/null || echo "$before_size B"))
- Size after optimization: $after_size bytes ($(numfmt --to=iec-i --suffix=B $after_size 2>/dev/null || echo "$after_size B"))
- Size reduction: $reduction%

## Optimization Settings (Cargo.toml)
- opt-level: "z" (optimize for size)
- overflow-checks: true (safety checks enabled)
- debug: 0 (no debug symbols)
- strip: "symbols" (debug symbols stripped)
- debug-assertions: false (production mode)
- panic: "abort" (minimal panic handling)
- codegen-units: 1 (single codegen unit for better optimization)
- lto: true (link-time optimization enabled)

## Build Artifacts
- WASM file: $WASM_FILE
- Build log: $BUILD_LOG

## Deployment Readiness
- Binary size within threshold ($(get_size_threshold) bytes): $([ $after_size -le $(get_size_threshold) ] && echo "✓ YES" || echo "✗ NO")
- Tests passed: ✓ YES
- Optimization applied: ✓ YES

## Next Steps
1. Deploy to testnet: soroban contract deploy --wasm $WASM_FILE --network testnet --source admin
2. Initialize contract: soroban contract invoke --id <CONTRACT_ID> -- initialize ...
3. Monitor deployment: Check Stellar Expert or Soroban RPC

## Size Threshold
- Threshold: $(get_size_threshold) bytes
- Override via env var: WASM_SIZE_THRESHOLD=<bytes> ./scripts/build-contract.sh
- Override via config file: echo <bytes> > .wasm-size-threshold
- Size history: $SIZE_HISTORY_FILE

## Troubleshooting
If optimization fails:
- Ensure soroban-cli is up to date: cargo install --locked soroban-cli --force
- Check WASM file integrity: file $WASM_FILE
- Review Soroban documentation: https://developers.stellar.org/docs/build/smart-contracts
If the size threshold is exceeded:
- Review recent changes for unnecessary code or dependencies
- Confirm release profile settings in Cargo.toml (opt-level = "z", lto = true, strip = "symbols")
- Raise the threshold only with justification (update .wasm-size-threshold)

Generated by build-contract.sh
EOF
    
    log_success "Build report generated: $BUILD_LOG"
}

# Main execution
main() {
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Token Factory Contract Build & Optimization Script       ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    check_prerequisites
    
    log_info "Recording binary size before optimization..."
    build_contract
    BEFORE_SIZE=$(get_file_size "$WASM_FILE")
    log_info "Binary size before optimization: $BEFORE_SIZE bytes"
    
    run_tests
    
    optimize_wasm
    AFTER_SIZE=$(get_file_size "$WASM_FILE")
    log_info "Binary size after optimization: $AFTER_SIZE bytes"

    emit_interface_snapshot
    generate_report "$BEFORE_SIZE" "$AFTER_SIZE"

    record_size_history "$BEFORE_SIZE" "$AFTER_SIZE"

    if ! check_size_threshold "$AFTER_SIZE"; then
        log_error "Build failed: optimized WASM exceeds the configured size threshold"
        exit 1
    fi
    
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    BUILD COMPLETE                          ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    log_success "Contract ready for deployment"
    echo -e "${YELLOW}WASM file:${NC} $WASM_FILE"
    echo -e "${YELLOW}Size reduction:${NC} $((100 - (AFTER_SIZE * 100 / BEFORE_SIZE)))%"
    echo ""
}

main "$@"
