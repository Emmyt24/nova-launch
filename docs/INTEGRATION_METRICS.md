# Integration Metrics

Production metrics for the Nova Launch integration pipeline. All metrics are registered in `monitoring/metrics/prometheus-config.ts`.

---

## Wallet Submission

### `wallet_submissions_total`
**Type:** Counter  
**Labels:** `network`, `status`

Counts every wallet transaction submission attempt.

| Label | Values |
|-------|--------|
| `network` | `mainnet`, `testnet`, `futurenet` |
| `status` | `success`, `failure` |

**Alert suggestion:** `rate(wallet_submissions_total{status="failure"}[5m]) / rate(wallet_submissions_total[5m]) > 0.1` — submission failure rate above 10%.

---

### `tx_confirmation_duration_seconds`
**Type:** Histogram  
**Labels:** `network`, `status`  
**Buckets:** 1, 5, 10, 30, 60, 120, 300 seconds

Time from wallet submission to on-chain confirmation.

**Alert suggestion:** `histogram_quantile(0.95, tx_confirmation_duration_seconds_bucket{status="confirmed"}) > 30` — p95 confirmation latency above 30 s.

---

## Event Ingestion

### `event_ingestion_lag_seconds`
**Type:** Histogram  
**Labels:** `event_type`  
**Buckets:** 0.5, 1, 2, 5, 10, 30, 60 seconds

Lag between ledger close time and the moment the backend finishes processing the event. Emitted in `StellarEventListener.processEvent()`.

| `event_type` examples | Description |
|-----------------------|-------------|
| `token_created` | New token deployed |
| `token_burned` | Self-burn |
| `token_admin_burned` | Admin clawback |
| `proposal_created` | Governance proposal |
| `vault_created` | Vault opened |
| `campaign_created` | Buyback campaign |

**Alert suggestion:** `histogram_quantile(0.99, event_ingestion_lag_seconds_bucket[10m]) > 60` — p99 ingestion lag above 60 s.

---

### `events_processed_total`
**Type:** Counter  
**Labels:** `event_type`, `status`

| `status` | Meaning |
|----------|---------|
| `success` | Event fully processed and projected |
| `failure` | Processing threw an exception |

**Alert suggestion:** `rate(events_processed_total{status="failure"}[5m]) > 0` — any processing errors.

---

### Listener ledger lag (chain head vs processed ledger)

Source: `backend/src/lib/metrics/listenerLagMetrics.ts`. The listener looks up
the chain head (`core_latest_ledger` from Horizon) at most once every
`LISTENER_HEAD_REFRESH_MS` (default `15000`) during polling, and once more during
the reconnect catchup check. It records the processed ledger after each event's
cursor is saved.

| Metric | Type | Meaning |
|--------|------|---------|
| `stellar_listener_latest_ledger` | Gauge | Latest ledger reported by Horizon |
| `stellar_listener_processed_ledger` | Gauge | Ledger of the last processed event |
| `stellar_listener_ledger_lag` | Gauge | `latest_ledger - processed_ledger`, floored at 0 |
| `stellar_listener_head_last_updated_timestamp_seconds` | Gauge | Unix time of the last successful head lookup |
| `stellar_listener_ledgers_processed_total` | Counter | Total ledgers the processed ledger has advanced |
| `stellar_listener_head_fetch_failures_total` | Counter | Failed or empty head lookups |

The head never moves backwards. If a processed event's ledger is beyond the last
known head, the head is raised to match it, so lag is never negative.

`StellarEventListener#getLedgerLag()` returns the same values as
`{ latestLedger, processedLedger, lag }`.

**Alert rules:** see `monitoring/prometheus/alerts/listener-lag.yml`. It defines:

- `EventListenerLagWarning`: lag above 60 ledgers for 5 minutes
- `EventListenerLagCritical`: lag above 720 ledgers for 5 minutes
- `EventListenerStalled`: lag with no progress
- `EventListenerHeadStale`: head not refreshed for more than 5 minutes

---

## Webhook Reliability

### `webhook_deliveries_total`
**Type:** Counter  
**Labels:** `status`, `event_type`

| `status` | Meaning |
|----------|---------|
| `success` | Delivered on first or subsequent attempt |
| `failure` | Non-retryable error or retries exhausted |

**Alert suggestion:** `rate(webhook_deliveries_total{status="failure"}[5m]) > 0` — any failed deliveries.

---

### `webhook_retries_total`
**Type:** Counter  
**Labels:** `event_type`

Counts retry attempts beyond the first. A rising rate indicates persistent endpoint instability.

**Alert suggestion:** `rate(webhook_retries_total[5m]) > 1` — sustained retry pressure.

---

### `webhook_delivery_duration_seconds`
**Type:** Histogram  
**Labels:** `status`, `event_type`  
**Buckets:** 0.1, 0.5, 1, 2, 5, 10 seconds

Time from first delivery attempt to final outcome (success or exhaustion).

---

## Client-Side Funnel (Analytics)

Emitted via `trackTxFunnel()` in `frontend/src/services/analytics.ts`. These are soft events sent to the analytics backend, not Prometheus counters.

| Event name | Trigger |
|------------|---------|
| `tx_simulation_passed` | Pre-signing simulation succeeded |
| `tx_simulation_failed` | Pre-signing simulation rejected |
| `tx_wallet_signed` | User approved in wallet |
| `tx_wallet_rejected` | User rejected in wallet |
| `tx_submitted` | Transaction sent to network |
| `tx_confirmed` | On-chain confirmation received |
| `tx_failed` | On-chain failure |

All events carry an `action` property (`deploy`, `burn`, `propose`, `vote`) for funnel segmentation.

---

## Dashboard Queries (Grafana)

```promql
# Wallet submission success rate (5 min window)
sum(rate(wallet_submissions_total{status="success"}[5m]))
/ sum(rate(wallet_submissions_total[5m]))

# p95 confirmation latency
histogram_quantile(0.95, sum by (le) (rate(tx_confirmation_duration_seconds_bucket[5m])))

# Listener ledger lag
max(stellar_listener_ledger_lag)

# p99 ingestion lag
histogram_quantile(0.99, sum by (le, event_type) (rate(event_ingestion_lag_seconds_bucket[10m])))

# Webhook success rate
sum(rate(webhook_deliveries_total{status="success"}[5m]))
/ sum(rate(webhook_deliveries_total[5m]))
```

