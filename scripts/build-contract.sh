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
optimize_wasm() {
    log_info "Optimizing WASM binary..."
    
    if soroban contract optimize --wasm "$WASM_FILE" 2>&1; then
        log_success "WASM optimization completed"
    else
        log_error "WASM optimization failed"
        exit 1
    fi
}

# Emit ABI artifact: list of exported function names for frontend drift detection
emit_abi_artifact() {
    local abi_file="$PROJECT_ROOT/frontend/src/contracts/factoryAbi.json"
    log_info "Emitting ABI artifact to $abi_file..."

    # Extract pub fn names from lib.rs (excluding env: Env — those are the contract methods)
    local lib_rs="$CONTRACT_DIR/src/lib.rs"
    local methods
    methods=$(grep -oP 'pub fn \K[a-z_]+(?=\s*\()' "$lib_rs" | sort | uniq | jq -R . | jq -s .)

    cat > "$abi_file" <<EOF
{
  "contract": "token_factory",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "methods": $methods
}
EOF
    log_success "ABI artifact written to $abi_file"
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
- Binary size < 100KB: $([ $after_size -lt 102400 ] && echo "✓ YES" || echo "✗ NO")
- Tests passed: ✓ YES
- Optimization applied: ✓ YES

## Next Steps
1. Deploy to testnet: soroban contract deploy --wasm $WASM_FILE --network testnet --source admin
2. Initialize contract: soroban contract invoke --id <CONTRACT_ID> -- initialize ...
3. Monitor deployment: Check Stellar Expert or Soroban RPC

## Troubleshooting
If optimization fails:
- Ensure soroban-cli is up to date: cargo install --locked soroban-cli --force
- Check WASM file integrity: file $WASM_FILE
- Review Soroban documentation: https://developers.stellar.org/docs/build/smart-contracts

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

    emit_abi_artifact
    generate_report "$BEFORE_SIZE" "$AFTER_SIZE"
    
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
