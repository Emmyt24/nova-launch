# Nova Launch — GitHub Actions Workflows

## Overview

| Workflow                        | Trigger                   | Purpose                                                     |
| ------------------------------- | ------------------------- | ----------------------------------------------------------- |
| `backend-ci.yml`                | push/PR to `backend/**`   | Lint, type-check, test, build                               |
| `backend-reliability-nightly.yml` | nightly/manual/targeted PR | Backup restore, pagination, Redis fail-open, and event-schema contracts |
| `ci-cd-pipeline.yml`            | push/PR to main/develop   | Full Rust contract pipeline + deploy                        |
| `security-scanning.yml`         | push/PR/daily cron        | Vulnerability scanning (npm, Snyk, CodeQL, Trivy, Gitleaks) |
| `dependency-review.yml`         | PR to main/develop        | Block PRs introducing vulnerable/GPL deps                   |
| `security-tests.yml`            | push/PR to `backend/**`   | Application-level security test suite                       |
| `comprehensive-tests.yml`       | push/PR                   | Full test matrix                                            |
| `coverage-gates.yml`            | push/PR                   | Enforce >90% coverage threshold                             |
| `performance.yml`               | push/PR                   | Lighthouse + load tests                                     |
| `fuzz-testing.yml`              | schedule                  | Property-based + fuzz tests                                 |
| `property-tests.yml`            | push/PR                   | Fast-check property tests                                   |
| `campaign-chaos.yml`            | push/PR                   | Chaos engineering for campaigns                             |
| `campaign-consistency.yml`      | push/PR                   | Campaign state consistency                                  |
| `frontend-e2e.yml`              | push/PR to `frontend/**`  | Browser E2E tests                                           |
| `gas-benchmarks.yml`            | push/PR to `contracts/**` | Soroban gas benchmarks                                      |
| `wasm-size-check.yml`           | push/PR to `contracts/**` | Optimized WASM size check + history tracking                |
| `production-readiness-gate.yml` | push to main              | Final production gate                                       |
| `deploy.yml`                    | push to main/develop      | Deployment orchestration                                    |
| `error-code-stability.yml`      | push/PR                   | Error code regression                                       |

---

## WASM Size Check (`wasm-size-check.yml`)

Runs on every push/PR touching `contracts/**` and on manual dispatch.

### What it does

1. Builds the contract WASM in **release** mode with the size-optimized profile.
2. Reports the resulting `.wasm` size (raw bytes + KiB) in the job summary and as a PR comment.
3. Fails the job when the size exceeds the configured threshold.
4. Appends the measured size to the size-history file so growth is tracked over time.

### Optimization flags

The size-optimized build profile lives in `contracts/token-factory/Cargo.toml`:

```toml
[profile.release]
opt-level = "z"   # optimize for size, not speed
lto = true        # link-time optimization across crates
codegen-units = 1 # single codegen unit for maximum inlining/removal
panic = "abort"   # drop unwinding machinery
strip = "symbols" # strip debug symbols from the final WASM
```

Build locally with the same flags:

```bash
cd contracts/token-factory
cargo build --target wasm32-unknown-unknown --release
ls -l target/wasm32-unknown-unknown/release/*.wasm
```

> Note: `opt-level = "z"` trades runtime speed for size. Keep `lto = true`,
> `codegen-units = 1`, `panic = "abort"`, and `strip = "symbols"` in place —
> removing any of them noticeably increases the deployed WASM size.

### Size threshold

The maximum allowed size is configured via the `WASM_SIZE_LIMIT_BYTES`
environment variable in the workflow (default: `65536` bytes / 64 KiB).
To change the limit, update the `env:` block in `wasm-size-check.yml` and
document the new value here. The job fails with a clear message listing the
measured size, the limit, and the delta when the threshold is exceeded.

### Size history

Each successful run appends a line to `contracts/wasm-size-history.csv`:

```
timestamp,commit,contract,size_bytes
2024-01-01T00:00:00Z,abc1234,token-factory,48213
```

The history file is committed back by the workflow (on the default branch) so
size growth is reviewable in git history and can be charted over time.

---

## Security Scanning (`security-scanning.yml`)

Runs on every push, PR, and daily at 02:00 UTC.

### Jobs

| Job                  | Tool        | What it checks                           |
| -------------------- | ----------- | ---------------------------------------- |
| `npm-audit-backend`  | npm audit   | Node.js CVEs in backend deps             |
| `npm-audit-frontend` | npm audit   | Node.js CVEs in frontend deps            |
| `snyk-backend`       | Snyk        | Deep dep graph + license scan (backend)  |
| `snyk-frontend`      | Snyk        | Deep dep graph + license scan (frontend) |
| `snyk-contracts`     | Snyk        | Rust dep vulnerabilities                 |
| `cargo-audit`        | cargo-audit | Rust CVEs (RustSec advisory DB)          |
| `codeql`             | CodeQL      | SAST — JS/TS source code                 |
| `trivy-backend`      | Trivy       | Docker image CVEs                        |
| `secret-scan`        | Gitleaks    | Hardcoded credentials in git history     |
| `security-summary`   | —           | Aggregates results, posts PR comment     |

### Required Secrets

| Secret       | Where to get it             |
| ------------ | --------------------------- |
| `SNYK_TOKEN` | https://app.snyk.io/account |

Snyk jobs are skipped on forks (token not available).

### Severity Threshold

Default: `high` (fails on high + critical). Override via `workflow_dispatch`:

```
Actions → Security Scanning → Run workflow → fail_on_severity: medium
```

### SARIF Upload

All scanners upload SARIF results to the **Security → Code scanning** tab.
This gives a unified view of all findings across tools.

---

## Dependency Review (`dependency-review.yml`)

Runs on every PR to `main` or `develop`.

- Blocks PRs that introduce dependencies with **high or critical** CVEs
- Blocks dependencies with **GPL-2.0, GPL-3.0, or AGPL-3.0** licenses
- Posts a summary comment on the PR

---

## Dependabot (`dependabot.yml`)

Automated dependency update PRs, opened every Monday at 08:00 UTC.

| Ecosystem      | Directory                  | Schedule           |
| -------------- | -------------------------- | ------------------ |
| npm            | `/backend`                 | Weekly (Monday)    |
| npm            | `/frontend`                | Weekly (Monday)    |
| npm            | `/scripts/deployment`      | Weekly (Monday)    |
| cargo          | `/contracts/token-factory` | Weekly (Tuesday)   |
| github-actions | `/`                        | Weekly (Wednesday) |

Minor + patch updates are **grouped** into a single PR per ecosystem to reduce noise.
Security updates get their own PR immediately.

---

## Local Security Scanning

Run the full scan locally:

```bash
# Basic scan (npm audit + cargo audit + secret grep)
./scripts/security-scan.sh

# With Snyk (requires SNYK_TOKEN)
SNYK_TOKEN=<your-token> ./scripts/security-scan.sh

# Fail only on critical issues
./scripts/security-scan.sh --fail-on-severity critical

# Reports saved to security-reports/
```

Run the security scanning unit tests:

```bash
cd backend
npm run test:security:scanning
```

---

## Snyk Policy (`.snyk`)

The `.snyk` file at the repo root controls which vulnerabilities are ignored.
All ignores require a reason and expiry date. Edit only after security team review.

---

## Adding a New Workflow

1. Create `.github/workflows/<name>.yml`
2. Add an entry to this README
3. If it touches security, add a corresponding test in
   `backend/src/__tests__/security.dependency-scanning.test.ts`
