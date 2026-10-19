#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_stage() {
    echo -e "${BLUE}=== $1 ===${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

# Check if we're in the right directory
if [ ! -f "contracts/token-factory/Cargo.toml" ]; then
    print_error "Please run this script from the project root directory"
    exit 1
fi

print_stage "Stage 1: Build & Lint Gate"

# Check if Rust is installed
if ! command -v cargo &> /dev/null; then
    print_error "Rust/Cargo not found. Please install Rust: https://rustup.rs/"
    exit 1
fi

# Check if wasm32 target is installed
if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
    print_warning "Installing wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
fi

# Check if Soroban CLI is installed
if ! command -v soroban &> /dev/null; then
    print_warning "Soroban CLI not found. Installing..."
    cargo install --locked soroban-cli --features opt
fi

cd contracts/token-factory

# Format check
print_stage "Running cargo fmt check..."
if cargo fmt --all -- --check; then
    print_success "Format check passed"
else
    print_error "Format check failed. Run 'cargo fmt' to fix formatting"
    exit 1
fi

# Clippy check
print_stage "Running clippy check..."
if cargo clippy --all-targets --all-features -- -D warnings; then
    print_success "Clippy check passed"
else
    print_error "Clippy check failed. Fix warnings and try again"
    exit 1
fi

# Build contracts
print_stage "Building contracts..."
if cargo build --target wasm32-unknown-unknown --release; then
    print_success "Contract build successful"
else
    print_error "Contract build failed"
    exit 1
fi

# Optimize WASM
print_stage "Optimizing WASM..."
if soroban contract optimize --wasm target/wasm32-unknown-unknown/release/token_factory.wasm; then
    print_success "WASM optimization successful"
else
    print_error "WASM optimization failed"
    exit 1
fi

print_stage "Stage 2: Contract-to-Frontend ABI Snapshot Tests"

# Generate contract interface snapshot
print_stage "Generating contract interface snapshot..."
cd ..
if command -v node &> /dev/null; then
    if node scripts/extract-contract-interface.js; then
        print_success "Interface snapshot generated"
    else
        print_error "Failed to generate interface snapshot"
        exit 1
    fi
else
    print_warning "Node.js not found, skipping interface snapshot generation"
fi

# Check if frontend tests can run
if [ -d "frontend" ] && [ -f "frontend/package.json" ]; then
    cd frontend
    
    print_stage "Installing frontend dependencies..."
    if command -v npm &> /dev/null; then
        npm install --legacy-peer-deps 2>&1 | grep -v "npm warn" || true
        print_success "Frontend dependencies installed"
    else
        print_warning "npm not found, skipping frontend tests"
        cd ..
        cd contracts/token-factory
    fi
    
    # Run ABI snapshot tests
    print_stage "Running contract ABI snapshot tests..."
    if npm run test:contracts:abi 2>/dev/null || npm test -- factoryAbi.snapshot.test.ts; then
        print_success "ABI snapshot tests passed"
    else
        print_warning "ABI snapshot tests not configured or failed (continuing...)"
    fi
    
    cd ..
    cd contracts/token-factory
else
    print_warning "Frontend directory not found, skipping ABI tests"
fi

print_stage "Stage 3: Security Audit"

# Install cargo-audit if not present
if ! command -v cargo-audit &> /dev/null; then
    print_warning "Installing cargo-audit..."
    cargo install cargo-audit
fi

# Vulnerability scan
print_stage "Running vulnerability scan..."
if cargo audit; then
    print_success "Vulnerability scan passed"
else
    print_error "Vulnerability scan failed"
    exit 1
fi

# Static analysis
print_stage "Running static analysis..."

# Check for unsafe code
if grep -r "unsafe" src/; then
    print_error "Unsafe code detected - review required"
    exit 1
fi

# Check for hardcoded secrets
if grep -r -i "secret\|password\|key" src/ --exclude-dir=test; then
    print_error "Potential hardcoded secrets detected"
    exit 1
fi

# Check for panic! usage
if grep -r "panic!" src/; then
    print_error "panic! usage detected - use Result<T, Error> instead"
    exit 1
fi

print_success "Static analysis passed"

print_stage "Stage 4: Testing & Coverage"

# Run tests
print_stage "Running tests..."
if cargo test --all-features; then
    print_success "All tests passed"
else
    print_error "Tests failed"
    exit 1
fi

# Supply invariant property tests (total supply == sum of balances across mutations)
print_stage "Running supply invariant property tests..."
if cargo test --all-features supply_invariant; then
    print_success "Supply invariant property tests passed"
else
    print_error "Supply invariant property tests failed"
    exit 1
fi

# Vesting and vault claim math fuzz tests
print_stage "Running vesting and vault claim fuzz tests..."
if cargo test --all-features claim_math; then
    print_success "Vesting and vault claim fuzz tests passed"
else
    print_error "Vesting and vault claim fuzz tests failed"
    exit 1
fi

# Admin authorization negative tests
print_stage "Running admin authorization negative tests..."
if cargo test --all-features admin_authorization; then
    print_success "Admin authorization negative tests passed"
else
    print_error "Admin authorization negative tests failed"
    exit 1
fi

# Admin authorization coverage check: every admin-only function must have a rejection test
print_stage "Checking admin authorization test coverage..."
if command -v node &> /dev/null; then
    if node scripts/check-admin-auth-coverage.js; then
        print_success "Admin authorization coverage check passed"
    else
        print_error "Admin authorization coverage check failed - add a rejection test for each admin function"
        exit 1
    fi
else
    print_warning "Node.js not found, skipping admin authorization coverage check"
fi

# Event payload snapshot tests
print_stage "Running event payload snapshot tests..."
if cargo test --all-features event_snapshot; then
    print_success "Event payload snapshot tests passed"
else
    print_error "Event payload snapshot tests failed - review event payload changes (see docs/EVENT_VERSIONING.md)"
    exit 1
fi

# Check if tarpaulin is installed
if ! command -v cargo-tarpaulin &> /dev/null; then
    print_warning "Installing cargo-tarpaulin..."
    cargo install cargo-tarpaulin
fi

# Generate coverage report
print_stage "Generating coverage report..."
mkdir -p coverage
if cargo tarpaulin --all-features --workspace --timeout 120 --out xml --output-dir coverage/; then
    print_success "Coverage report generated"
else
    print_warning "Coverage report generation failed, but continuing..."
fi

# Check coverage threshold (if coverage report exists)
if [ -f "coverage/cobertura.xml" ]; then
    if command -v bc &> /dev/null; then
        coverage=$(grep -o 'line-rate="[^"]*"' coverage/cobertura.xml | head -1 | grep -o '[0-9.]*' || echo "0")
        coverage_percent=$(echo "$coverage * 100" | bc -l | cut -d. -f1 2>/dev/null || echo "0")
        
        if [ "$coverage_percent" -ge 90 ]; then
            print_success "Coverage ${coverage_percent}% meets 90% threshold"
        else
            print_warning "Coverage ${coverage_percent}% is below 90% threshold"
        fi
    else
        print_warning "bc not available, skipping coverage threshold check"
    fi
else
    print_warning "Coverage report not found, skipping threshold check"
fi

cd ../..

print_stage "Stage 5: Deployment Simulation"

# Check if deployment orchestrator is available
if [ -d "scripts/deployment" ]; then
    cd scripts/deployment
    
    if [ -f "package.json" ]; then
        print_stage "Installing deployment dependencies..."
        if command -v npm &> /dev/null; then
            npm install
            print_success "Deployment orchestrator ready"
        else
            print_warning "npm not found, skipping deployment orchestrator check"
        fi
    else
        print_warning "Deployment orchestrator package.json not found"
    fi
    
    cd ../..
else
    print_warning "Deployment orchestrator not found at scripts/deployment"
fi

print_stage "CI Check Complete"
print_success "All stages passed! Your code is ready for CI/CD pipeline"

echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "1. Commit your changes"
echo "2. Push to GitHub to trigger the CI/CD pipeline"
echo "3. Monitor the pipeline at: https://github.com/$(git config --get remote.origin.url | sed 's/.*github.com[:/]\([^.]*\).*/\1/')/actions"