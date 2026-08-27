# Nova Launch — Monitoring Stack

Grafana + Prometheus observability for the Nova Launch platform.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Monitoring Stack                          │
│                                                                  │
│  ┌──────────────┐    scrape     ┌──────────────────────────┐    │
│  │  Prometheus  │◄──────────────│  nova-launch-backend:3001│    │
│  │  :9090       │               │  GET /metrics            │    │
│  └──────┬───────┘               └──────────────────────────┘    │
│         │ scrape                                                  │
│         ├──────────────────────► node-exporter:9100              │
│         ├──────────────────────► cadvisor:8080                   │
│         │                                                        │
│         │ alerts                                                  │
│         ▼                                                        │
│  ┌──────────────┐               ┌──────────────────────────┐    │
│  │ Alertmanager │──────────────►│  Slack / PagerDuty       │    │
│  │  :9093       │               └──────────────────────────┘    │
│  └──────────────┘                                                │
│                                                                  │
│  ┌──────────────┐    query      ┌──────────────────────────┐    │
│  │   Grafana    │◄──────────────│  Prometheus datasource   │    │
│  │  :3000       │               └──────────────────────────┘    │
│  └──────────────┘                                                │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Start the main application stack first
docker-compose up -d

# Then start the monitoring stack
docker-compose -f monitoring/docker-compose.yml up -d
```

| Service      | URL                   | Credentials        |
| ------------ | --------------------- | ------------------ |
| Grafana      | http://localhost:3000 | admin / nova-admin |
| Prometheus   | http://localhost:9090 | —                  |
| Alertmanager | http://localhost:9093 | —                  |

## Dashboards

Four pre-built dashboards are provisioned automatically:

| Dashboard              | UID               | Description                                  |
| ---------------------- | ----------------- | -------------------------------------------- |
| Nova Launch — Overview | `nova-overview`   | High-level health, throughput, and resources |
| API Performance        | `nova-api`        | HTTP latency, error rates, DB connections    |
| Blockchain Activity    | `nova-blockchain` | Token deployments, RPC calls, event pipeline |
| Infrastructure         | `nova-infra`      | CPU, memory, Node.js heap, containers        |

## Metrics Endpoint

The backend exposes Prometheus metrics at `GET /metrics` (port 3001).

Disable with `METRICS_ENABLED=false` in the backend environment.

**Security note:** In production, restrict `/metrics` to the internal network
(e.g. via nginx `allow 10.0.0.0/8; deny all;` or a Kubernetes NetworkPolicy).

## Alert Rules

| File                                        | Covers                                      |
| ------------------------------------------- | ------------------------------------------- |
| `prometheus/alerts/api.yml`                 | HTTP error rates, latency, backend down     |
| `prometheus/alerts/blockchain.yml`          | RPC errors, ingestion lag, deployment fails |
| `prometheus/alerts/infrastructure.yml`      | CPU, memory, disk, Node.js heap, containers |
| `prometheus/alerts/webhooks.yml`            | Webhook failures, retry storms, job queues  |
| `prometheus/alerts/slo-burn-rate.yml`       | SLO burn-rate alerts (P1/P2) — see below   |

## SLO Burn-Rate Alerts

Implements the **multi-window, multi-burn-rate** pattern from the
[Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/).

### SLO Definitions

| SLO                       | Target | Error Budget (30 days) |
| ------------------------- | ------ | ---------------------- |
| API Availability          | 99.9%  | 43.8 minutes           |
| API p95 Latency < 500ms   | 99%    | 7.3 hours              |
| Webhook Delivery Success  | 99%    | 7.3 hours              |

### Alert Thresholds

| Tier       | Window | Burn Rate | Severity | Meaning                              |
| ---------- | ------ | --------- | -------- | ------------------------------------ |
| Fast burn  | 5 min  | 14×       | critical (P1) | Budget exhausted in ~1 hour    |
| Slow burn  | 1 h    | 2×        | warning  (P2) | Budget exhausted in ~3 days    |

A **14× burn rate** means errors are arriving 14 times faster than the budget
allows. For the availability SLO (budget = 0.1%), this fires when the 5-minute
error rate exceeds **1.4%**.

## Alert–Dashboard Correlation

Every Prometheus alert rule includes a `dashboard_url` annotation linking to the
Grafana dashboard panel an on-call engineer should examine first when the alert
fires.

| Alert File                   | Targeted Dashboard          |
| ---------------------------- | --------------------------- |
| `prometheus/alerts/api.yml`  | `nova-api` (API Performance) |
| `prometheus/alerts/blockchain.yml` | `nova-blockchain` (Blockchain Activity) |
| `prometheus/alerts/infrastructure.yml` | `nova-infra` (Infrastructure) / `nova-api` |
| `prometheus/alerts/webhooks.yml` | `nova-api` (API Performance) |
| `prometheus/alerts/slo-burn-rate.yml` | `nova-slo-burn-rate` (SLO Burn Rate) |

### Convention for future alerts

Every new alert rule **must** include a `dashboard_url` annotation. The value
should be a full Grafana URL pointing to the most relevant dashboard panel, for
example:

```yaml
annotations:
  summary: "…"
  description: "…"
  dashboard_url: "https://grafana.example.com/d/nova-api?viewPanel=1"
```

If no existing panel is a good match, either create one and link to it, or link
to the most semantically related dashboard without a panel-specific query
parameter.

### Validating Alert Rules Locally

Install `promtool` (ships with every Prometheus release):

```bash
# macOS
brew install prometheus

# Linux — download from https://github.com/prometheus/prometheus/releases
# and put promtool on your PATH
```

Then run:

```bash
cd monitoring
make test-alerts          # validates every file in prometheus/alerts/
# or target a single file
promtool check rules prometheus/alerts/slo-burn-rate.yml
```

A successful run prints `SUCCESS: N rules found` and exits 0.

### SLO Dashboard

The Grafana dashboard `grafana/dashboards/slo-dashboard.json` (UID `nova-slo-burn-rate`)
is provisioned automatically on stack start. To import it manually:

1. Open Grafana → **Dashboards → Import**
2. Upload `monitoring/grafana/dashboards/slo-dashboard.json`
3. Select the **Prometheus** datasource
4. Click **Import**

The dashboard provides:

- **SLO Status row** — current availability/success rate for each SLO (colour-coded)
- **Burn Rates row** — time-series graphs of fast (5m) and slow (1h) burn rates with threshold lines
- **Error Budget Remaining row** — percentage of monthly budget still available

## Alertmanager Configuration

Edit `alertmanager/alertmanager.yml` and set:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

Or pass it as an environment variable when starting the stack:

```bash
SLACK_WEBHOOK_URL=https://... docker-compose -f monitoring/docker-compose.yml up -d
```

## Instrumentation

The backend uses `prom-client` via `backend/src/lib/metrics/index.ts`.

### Adding metrics to a service

```typescript
import { MetricsCollector } from "../lib/metrics";

// Record an HTTP request (done automatically by middleware)
MetricsCollector.recordHttpRequest("GET", "/api/tokens", 200, 0.05);

// Record a token deployment
MetricsCollector.recordTokenDeployment("testnet", "success", 12.5, 0.01);

// Record a contract interaction
MetricsCollector.recordContractInteraction(
  "token-factory",
  "deploy",
  "success",
  5.2,
  100_000,
);

// Record a database query
MetricsCollector.recordDatabaseQuery("SELECT", "tokens", "success", 0.003);

// Record a health check result
MetricsCollector.recordHealthCheck("database", true, 0.01);
```

### Blockchain / event pipeline

```typescript
import { IntegrationMetrics } from "../lib/metrics";

IntegrationMetrics.recordEventProcessed("TokenMinted", "success");
IntegrationMetrics.recordIngestionLag("TokenMinted", 2.3);
IntegrationMetrics.recordWebhookDelivery("success", "TokenMinted", 0.3);
```

## Directory Structure

```
monitoring/
├── docker-compose.yml              # Monitoring stack orchestration
├── README.md                       # This file
├── alertmanager/
│   └── alertmanager.yml            # Alert routing configuration
├── grafana/
│   ├── dashboards/                 # Pre-built Grafana dashboards (JSON)
│   │   ├── nova-overview.json
│   │   ├── nova-api.json
│   │   ├── nova-blockchain.json
│   │   └── nova-infrastructure.json
│   └── provisioning/
│       ├── dashboards/dashboards.yml
│       └── datasources/prometheus.yml
├── health-checks/
│   └── health-monitor.ts           # Health check framework
├── logging/
│   └── structured-logger.ts        # Winston structured logging
├── metrics/
│   └── prometheus-config.ts        # Prometheus metric definitions (reference)
└── prometheus/
    ├── prometheus.yml               # Prometheus scrape configuration
    └── alerts/
        ├── api.yml
        ├── blockchain.yml
        ├── infrastructure.yml
        ├── webhooks.yml
        └── slo-burn-rate.yml       # SLO burn-rate alerts (P1/P2)
```
