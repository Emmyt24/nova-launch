# CI/CD Pipeline Documentation

This document describes the multi-stage CI/CD pipeline for Nova Launch, designed to ensure code quality, security, and reliable deployments across Testnet and Mainnet environments.

## Pipeline Overview

The CI/CD pipeline consists of four main stages:

1. **Build & Lint Gate** - Code quality and compilation checks
2. **Security Audit** - Vulnerability scanning and static analysis
3. **Testing & Coverage** - Comprehensive testing with coverage requirements
4. **Multi-Stage Deployment** - Automated testnet and manual mainnet deployments

## Pipeline Triggers

- **Push Events**: `main`, `develop` branches
- **Pull Requests**: Against `main`, `develop` branches
- **Manual Triggers**: Mainnet deployments require manual approval

## Stage Details

### Stage 1: Build & Lint Gate

**Purpose**: Ensure code quality and successful compilation

**Actions**:
- Install Rust toolchain with `rustfmt` and `clippy`
- Add `wasm32-unknown-unknown` target
- Install Soroban CLI
- Run `cargo fmt --check` (fail on formatting issues)
- Run `cargo clippy` with `-D warnings` (fail on warnings)
- Build contracts for WASM target
- Optimize WASM using Soroban CLI

**Failure Conditions**:
- Formatting violations
- Clippy warnings
- Compilation errors
- WASM optimization failures

### Stage 2: Security Audit (OWASP Standards)

**Purpose**: Identify security vulnerabilities and code quality issues

**Actions**:
- Install and run `cargo audit` for dependency vulnerabilities
- Static analysis checks:
  - Detect `unsafe` code blocks
  - Scan for hardcoded secrets/passwords
  - Verify e2e documentation: ensure e2e/README.md exists and describes test execution
  - Identify `panic!` usage (should use `Result<T, Error>`)

**Failure Conditions**:
- Known vulnerabilities in dependencies
- Unsafe code without justification
- Hardcoded secrets detected
- Use of `panic!` instead of proper error handling

### Stage 3: Testing & Coverage

**Purpose**: Ensure comprehensive testing and maintain code coverage standards

**Actions**:
- Run `cargo test --all-features`
- Generate coverage report using `cargo-tarpaulin`
- Enforce 90% minimum coverage threshold
- Upload coverage reports to Codecov

**Failure Conditions**:
- Any test failures
- Coverage below 90% threshold
- Coverage report generation failures

### Stage 4: Multi-Stage Deployment

#### Testnet Deployment (Automatic)

**Trigger**: Push to `develop` branch
**Environment**: `testnet`
**Actions**:
- Build and optimize contracts
- Configure Soroban for Stellar Testnet
- Deploy using deployment orchestrator
- Verify deployment success

#### Mainnet Deployment (Manual Approval)

**Trigger**: Push to `main` branch + manual approval
**Environment**: `mainnet`
**Actions**:
- Require manual approval from authorized personnel
- Build and optimize contracts
- Configure Soroban for Stellar Mainnet
- Deploy using deployment orchestrator
- Create GitHub release with deployment details

## Environment Variables

### Required Secrets

Configure these secrets in GitHub repository settings under **Settings > Secrets and variables > Actions**.

#### Testnet Environment

| Secret Name | Description | Example |
|-------------|-------------|---------|
| `TESTNET_NETWORK_PASSPHRASE` | Stellar testnet passphrase | `Test SDF Network ; September 2015` |
| `TESTNET_RPC_URL` | Soroban testnet RPC endpoint | `https://soroban-testnet.stellar.org` |
| `TESTNET_ADMIN_SECRET_KEY` | Admin account secret key | `SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
| `TESTNET_TREASURY_SECRET_KEY` | Treasury account secret key | `SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |

#### Mainnet Environment

| Secret Name | Description | Example |
|-------------|-------------|---------|
| `MAINNET_NETWORK_PASSPHRASE` | Stellar mainnet passphrase | `Public Global Stellar Network ; September 2015` |
| `MAINNET_RPC_URL` | Soroban mainnet RPC endpoint | `https://soroban-mainnet.stellar.org` |
| `MAINNET_ADMIN_SECRET_KEY` | Admin account secret key | `SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
| `MAINNET_TREASURY_SECRET_KEY` | Treasury account secret key | `SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |

#### Additional Secrets

| Secret Name | Description |
|-------------|-------------|
| `GITHUB_TOKEN` | GitHub token for releases (auto-provided) |
| `CODECOV_TOKEN` | Codecov upload token (optional) |

### Environment Setup

#### GitHub Environments

Create two environments in **Settings > Environments**:

1. **testnet**
   - No protection rules (automatic deployment)
   - Add testnet-specific secrets

2. **mainnet**
   - Required reviewers: Add authorized personnel
   - Deployment branches: Limit to `main` branch
   - Add mainnet-specific secrets

## Local Development

### Prerequisites

- Rust 1.70+ with `wasm32-unknown-unknown` target
- Soroban CLI
- Node.js 18+ (for deployment orchestrator)

### Running CI Checks Locally

Use the provided script to simulate CI environment:

```bash
./scripts/ci-check.sh
```

This script will:
- Check code formatting
- Run clippy linting
- Build contracts
- Run security audits
- Execute tests
- Generate coverage reports
- Verify deployment orchestrator setup

### Manual Testing Commands

```bash
# Format code
cargo fmt

# Run clippy
cargo clippy --all-targets --all-features -- -D warnings

# Build contracts
cd contracts/token-factory
cargo build --target wasm32-unknown-unknown --release

# Run tests
cargo test --all-features

# Generate coverage
cargo tarpaulin --all-features --workspace --timeout 120 --out html
```

## Deployment Process

### Testnet Deployment

1. Create feature branch from `develop`
2. Implement changes
3. Run `./scripts/ci-check.sh` locally
4. Create PR to `develop`
5. Merge PR after approval
6. Pipeline automatically deploys to testnet

### Mainnet Deployment

1. Create PR from `develop` to `main`
2. Ensure all tests pass
3. Get code review approval
4. Merge to `main`
5. Pipeline triggers with manual approval step
6. Authorized personnel approve deployment
7. Pipeline deploys to mainnet and creates release

## Monitoring and Troubleshooting

### Pipeline Monitoring

- **GitHub Actions**: Monitor at `https://github.com/YOUR_ORG/nova-launch/actions`
- **Coverage Reports**: View at Codecov dashboard
- **Deployment Logs**: Check individual job logs for deployment details

### Common Issues

#### Build Failures

- **Formatting Issues**: Run `cargo fmt` locally
- **Clippy Warnings**: Fix warnings shown in clippy output
- **Compilation Errors**: Check Rust syntax and dependencies

#### Security Audit Failures

- **Dependency Vulnerabilities**: Update dependencies with `cargo update`
- **Unsafe Code**: Add justification comments or refactor
- **Hardcoded Secrets**: Move to environment variables

#### Test Failures

- **Unit Tests**: Fix failing test logic
- **Coverage**: Add tests to reach 90% threshold
- **Integration Tests**: Check test environment setup

#### Deployment Failures

- **Network Issues**: Verify RPC endpoints are accessible
- **Authentication**: Check secret key configuration
- **Contract Errors**: Review contract initialization parameters

### Emergency Procedures

#### Rollback Deployment

1. Identify previous working deployment
2. Manually deploy previous contract version
3. Update frontend configuration if needed
4. Create hotfix branch for permanent fix

#### Pipeline Bypass (Emergency Only)

For critical hotfixes:
1. Create emergency branch
2. Apply minimal fix
3. Deploy manually using deployment orchestrator
4. Create post-incident PR to update pipeline

## Security Considerations

- **Secret Management**: Never commit secrets to repository
- **Access Control**: Limit mainnet deployment approvers
- **Audit Trail**: All deployments are logged and tracked
- **Network Isolation**: Separate testnet/mainnet environments
- **Key Rotation**: Regularly rotate deployment keys

## Performance Metrics

- **Build Time**: Target < 10 minutes for full pipeline
- **Test Coverage**: Maintain > 90% coverage
- **Deployment Frequency**: Support multiple daily testnet deployments
- **Mean Time to Recovery**: < 30 minutes for rollbacks

## Maintenance

### Regular Tasks

- Update Rust toolchain monthly
- Review and update dependencies quarterly
- Rotate deployment keys annually
- Review and update security policies

### Pipeline Updates

When modifying the pipeline:
1. Test changes in feature branch
2. Document changes in this file
3. Get security team approval for security-related changes
4. Deploy during low-traffic periods