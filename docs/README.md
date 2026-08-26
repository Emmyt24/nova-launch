# Nova Launch Documentation

---

## Database Backup & Point-in-Time Recovery

- **[DATABASE_BACKUP_PITR.md](./DATABASE_BACKUP_PITR.md)**
  - Architecture overview (base backups + WAL archiving)
  - Script usage: `backup-db.sh` and `restore-db.sh`
  - REST API reference (`/api/admin/backup/*`)
  - Step-by-step recovery procedure
  - Security notes and environment variables

---

## Token Burn Documentation

### Primary Specification

- **[token-burn-spec.md](./token-burn-spec.md)** (26KB, 952 lines)
  - Comprehensive architecture and specification
  - Function signatures with full documentation
  - Error codes and handling strategies
  - Event schema and indexing
  - Security analysis and threat model
  - Gas optimization strategies
  - State transition diagrams
  - Testing strategy and examples
  - Implementation checklist

### Supporting Documents

- **[BURN_QUICK_REF.md](./BURN_QUICK_REF.md)** (1.9KB)
  - Quick reference for developers
  - Function signatures at a glance
  - Error codes table
  - Gas costs comparison
  - Example usage

- **[PERFORMANCE_MONITORING_NEW_RELIC.md](./PERFORMANCE_MONITORING_NEW_RELIC.md)**
  - Frontend performance monitoring guide
  - New Relic event publishing setup
  - Operational and security notes

- **[BURN_SPEC_COMPLETION.md](./BURN_SPEC_COMPLETION.md)** (6.2KB)
  - Completion report for issue #150
  - Deliverables checklist
  - Requirements verification
  - Implementation status

### Related Documentation (Root Level)

- **BURN_FEATURE_DOCS.md** - User-facing feature documentation
- **BURN_SECURITY.md** - Detailed security analysis
- **BURN_MIGRATION_GUIDE.md** - Migration instructions
- **BURN_TESTS_IMPLEMENTATION.md** - Test implementation guide
- **BURN_DOCUMENTATION_SUMMARY.md** - Documentation overview

---

## Incident Response & Runbooks

Operational runbooks backing Prometheus alert rules:

- **[high-error-rate.md](./runbooks/high-error-rate.md)** — Diagnostic and recovery steps for elevated HTTP 5xx error rates (`HighErrorRate`).
- **[backend-down.md](./runbooks/backend-down.md)** — Recovery procedures when the backend service is unreachable (`BackendDown`).
- **[slo-availability.md](./runbooks/slo-availability.md)** — Handling API Availability SLO fast and slow burn rate alerts (`SLOAvailabilityFastBurn`, `SLOAvailabilitySlowBurn`).
- **[slo-latency.md](./runbooks/slo-latency.md)** — Investigating and mitigating API p95 latency SLO burn rate alerts (`SLOLatencyFastBurn`, `SLOLatencySlowBurn`).
- **[slo-webhooks.md](./runbooks/slo-webhooks.md)** — Resolving webhook delivery success rate SLO burn rate alerts (`SLOWebhookDeliveryFastBurn`, `SLOWebhookDeliverySlowBurn`).
- **[blockchain-rpc-errors.md](./runbooks/blockchain-rpc-errors.md)** — Investigating and resolving high Stellar/Soroban RPC error rates (`HighRPCErrorRate`).
- **[blockchain-event-pipeline.md](./runbooks/blockchain-event-pipeline.md)** — Mitigating event ingestion lag and token deployment failures (`CriticalEventIngestionLag`, `TokenDeploymentFailures`).

---

## Quick Links

### For Developers

1. Start with [BURN_QUICK_REF.md](./BURN_QUICK_REF.md)
2. Read full spec: [token-burn-spec.md](./token-burn-spec.md)
3. Check implementation: `../contracts/token-factory/src/lib.rs`

### For Reviewers

1. Review completion: [BURN_SPEC_COMPLETION.md](./BURN_SPEC_COMPLETION.md)
2. Verify spec: [token-burn-spec.md](./token-burn-spec.md)
3. Check tests: `../contracts/token-factory/src/test.rs`

### For Users

1. Feature guide: `../BURN_FEATURE_DOCS.md`
2. Security info: `../BURN_SECURITY.md`
3. Migration: `../BURN_MIGRATION_GUIDE.md`

---

**Issue:** #150 - Design Token Burn Architecture & Specification  
**Status:** ✅ Complete  
**Date:** February 23, 2026
