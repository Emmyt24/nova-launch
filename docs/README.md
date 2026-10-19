# Nova Launch Documentation

---

## Frontend Deploy-Flow Testing

- **[FRONTEND_DEPLOY_FLOW_TESTING.md](./FRONTEND_DEPLOY_FLOW_TESTING.md)**
  - `useIPFSUpload` failure, retry (via `useRetry`) and abort-on-unmount tests
  - `useTransactionMonitor` polling, backoff, timeout and cleanup tests
  - `TokenDeployForm` validation boundaries and aria attributes
  - Plan and blockers for the Playwright deploy E2E (#2174)

---

## Free-Text Field Sanitization

- **[FREE_TEXT_SANITIZATION.md](./FREE_TEXT_SANITIZATION.md)**
  - Control-character stripping and NFC normalization for free-text fields
  - Per-field length limits and the 400 `VALIDATION_ERROR` shape
  - `escapeHtml()` at HTML output boundaries (email templates)

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

## Frontend Feature Documentation

### Webhook Management

- **[WEBHOOK_BULK_ACTIONS.md](./WEBHOOK_BULK_ACTIONS.md)**
  — Issue [#2162](https://github.com/Emmyt24/nova-launch/issues/2162)
  - Checkbox multi-selection on the webhook list
  - Batch enable, disable, and delete with confirmation dialog
  - Partial-failure feedback and API integration notes

- **[WEBHOOK_DELIVERY_LOG.md](./WEBHOOK_DELIVERY_LOG.md)**
  — Issue [#2163](https://github.com/Emmyt24/nova-launch/issues/2163)
  - Per-subscription delivery log with status, HTTP code, and attempt count
  - Status and date-range filter controls
  - Manual redeliver action and dead-letter queue deep links

### Vaults UI

- **[VAULT_BALANCE_CHART.md](./VAULT_BALANCE_CHART.md)**
  — Issue [#2164](https://github.com/Emmyt24/nova-launch/issues/2164)
  - Time-series line chart of vault balance (7d / 30d / 90d ranges)
  - Accessible data table fallback
  - Loading, empty, and error state handling

### Streams UI

- **[STREAM_PROGRESS_BAR.md](./STREAM_PROGRESS_BAR.md)**
  — Issue [#2165](https://github.com/Emmyt24/nova-launch/issues/2165)
  - Progress bar and remaining-time display on stream cards
  - State-aware rendering: active, paused, cancelled, completed
  - ARIA progressbar implementation and `prefers-reduced-motion` support

- **[MOBILE_TOKEN_NAME_OVERFLOW.md](./MOBILE_TOKEN_NAME_OVERFLOW.md)**
  — Issue [#2166](https://github.com/Emmyt24/nova-launch/issues/2166)
  - Root-cause analysis: four components with unguarded token-name renders
  - Fix patterns: `truncate` + `title`, `break-words`, `min-w-0`, responsive `sm:grid-cols-2`
  - Affected files: `TokenCard`, `ReviewStep`, `TokenAnalyticsPage`, `DashboardLayout`

- **[EMPTY_STATES_CTA.md](./EMPTY_STATES_CTA.md)**
  — Issue [#2167](https://github.com/Emmyt24/nova-launch/issues/2167)
  - Coverage audit of all dashboard views against the shared `EmptyState` component
  - Step-by-step fixes for `CampaignDashboard`, `VaultDashboard`, and `StreamDashboard`
  - Guide for adding new icons and a checklist for future dashboard views

- **[TOKEN_DEPLOY_CONFIRMATION_STEP.md](./TOKEN_DEPLOY_CONFIRMATION_STEP.md)**
  — Issue [#2168](https://github.com/Emmyt24/nova-launch/issues/2168)
  - Documents the existing `ReviewStep` and `ConfirmDialog` components that are built but not wired
  - Wiring guide: updated `FormStep` type, `ReviewStep` integration, `ConfirmDialog` modal, `ProgressIndicator`
  - Full data flow diagram and fee calculation reference

- **[ERROR_BOUNDARY_PER_ROUTE.md](./ERROR_BOUNDARY_PER_ROUTE.md)**
  — Issue [#2169](https://github.com/Emmyt24/nova-launch/issues/2169)
  - Explains current single-global-boundary limitation in `main.tsx` and `App.tsx`
  - New `RouteErrorFallback` component spec with route-specific recovery actions
  - `ErrorBoundary` render-prop upgrade and per-route wrapping pattern for `App.tsx`
  - Recovery action matrix across all five routes

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
