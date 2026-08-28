# Gas Optimization Dashboard & Pipeline

Automated measurement, alerting, threshold regression testing, and monthly reporting pipeline for Soroban smart contract gas consumption on Stellar.

---

## Overview

The Gas Dashboard tracks, analyzes, and visualizes CPU instruction and memory consumption for Soroban smart contracts. By simulating contract invocations via `simulateTransaction` on the Soroban RPC, the pipeline extracts exact resource usage (`cpuInsns` and `memBytes`) without submitting live transactions or consuming on-chain fees.

---

## Environment Configuration

Configuration is loaded from environment variables or a local `.env` file. Copy the provided template to get started:

```bash
cp .env.example .env
```

### Key Environment Variables

| Variable | Description | Example / Default |
|---|---|---|
| `SOROBAN_RPC_URL` | Soroban RPC endpoint used for simulating contract transactions | `https://soroban-testnet.stellar.org` |
| `CONTRACT_ID` | Address of the deployed Soroban contract to measure | `C...` |
| `STELLAR_NETWORK` | Stellar network passphrase identifier (`testnet` / `mainnet`) | `testnet` |
| `HORIZON_URL` | Stellar Horizon server endpoint | `https://horizon-testnet.stellar.org` |
| `ALERT_WEBHOOK_URL` | Webhook URL (e.g., Slack) for dispatching gas alerts | `https://hooks.slack.com/services/...` |
| `ALERT_THRESHOLD_INCREASE`| Percentage increase from previous measurements triggering alerts | `20` |
| `VITE_API_BASE_URL` | Base API URL proxied by the Vite dev server | `/api` |
| `DATABASE_URL` | Optional PostgreSQL connection string for persistent metric storage | `postgresql://localhost:5432/gas_tracking` |

---

## Data Flow Architecture

```
                                  ┌──────────────────────────┐
                                  │   Soroban RPC Endpoint   │
                                  └─────────────┬────────────┘
                                                │ simulateTransaction
                                                ▼
┌──────────────────────┐              ┌──────────────────────────┐
│   npm run measure    │─────────────►│ data/measurements/*.json │
└──────────────────────┘              └──────┬────────────┬──────┘
                                             │            │
                      ┌──────────────────────┘            └──────────────────────┐
                      ▼                                                          ▼
       ┌──────────────────────────────┐                           ┌──────────────────────────────┐
       │        npm run alert         │                           │        npm run report        │
       │  (reads last 7 days metrics) │                           │  (reads measurements,        │
       └──────────────┬───────────────┘                           │   optimizations, benchmarks) │
                      │                                           └──────────────┬───────────────┘
                      ▼                                                          ▼
       ┌──────────────────────────────┐                           ┌──────────────────────────────┐
       │      ALERT_WEBHOOK_URL       │                           │ data/reports/monthly/        │
       │    (Slack notifications)     │                           │ (*.json & *.md summaries)    │
       └──────────────────────────────┘                           └──────────────────────────────┘

┌──────────────────────────────┐      diff vs.     ┌──────────────────────────────┐
│ data/snapshots/              │◄─────────────────►│ data/snapshots/             │
│   gas-baseline.json          │                   │   gas-current.json           │
└──────────────┬───────────────┘                   └──────────────┬───────────────┘
               │                                                  │
               └──────────────────────┬───────────────────────────┘
                                      ▼
                      ┌───────────────────────────────┐
                      │  npm run check:gas-thresholds │
                      └───────────────┬───────────────┘
                                      ▼
                      ┌───────────────────────────────┐
                      │ data/reports/                 │
                      │   gas-threshold-diff.md       │
                      └───────────────────────────────┘
```

---

## Pipeline Scripts & CLI Usage

The package defines five core automation scripts in `package.json`:

### 1. `npm run measure` (`scripts/measure.js` / `src/tracker/GasTracker.js`)
Connects to the configured `SOROBAN_RPC_URL` and simulates contract transactions for standard contract methods (`create_stream`, `withdraw`, `cancel_stream`, `pause_stream`). It records CPU instruction counts and memory footprint (`memBytes`), computes average metrics across operations, and writes the measurement snapshot to `data/measurements/YYYY-MM-DD.json`.

### 2. `npm run check:gas-thresholds` (`scripts/check-thresholds.js`)
Validates current gas measurements against predefined regression baselines. Compares `data/snapshots/gas-current.json` against `data/snapshots/gas-baseline.json` across all required operations (`create`, `mint`, `burn`, `claim`, `propose`, `vote`, `execute`). Outputs a Markdown comparison table to `data/reports/gas-threshold-diff.md` (and `$GITHUB_STEP_SUMMARY` in CI) and exits with code `1` if any operation exceeds the allowed threshold percentage (default 10%).

### 3. `npm run alert` (`scripts/alert.js` / `src/alerts/AlertSystem.js`)
Scans recent measurement history to detect unwanted gas inflation, regressions, and statistical anomalies. Reads the last 7 days of measurements from `data/measurements/`, evaluates day-over-day increases against warning (10%) and critical (20%) thresholds, and posts alert payloads to `ALERT_WEBHOOK_URL`.

### 4. `npm run report` (`scripts/report.js` / `src/reports/ReportGenerator.js`)
Aggregates historical data across a target month. Reads measurement series from `data/measurements/`, optimization metadata from `data/optimizations.json`, and industry benchmarks from `data/benchmarks.json`. Generates executive summaries, savings calculations, and trend graphs, outputting structured JSON to `data/reports/monthly/YYYY-MM.json` and formatted Markdown to `data/reports/monthly/YYYY-MM.md`.

### 5. `npm run schedule` (`scripts/scheduler.js`)
Daemon scheduler powered by `node-cron` for automated background maintenance. Schedules daily gas measurements at 2:00 AM (`0 2 * * *`), alert health checks every 6 hours (`0 */6 * * *`), and monthly executive report compilation on the 1st of each month at 9:00 AM (`0 9 1 * *`).

---

## Snapshot Schema & Policy

For details on baseline snapshots, current test snapshots, required operations, and historical archiving, see the [Gas Snapshot Documentation](./data/snapshots/README.md).

---

## Running the Dashboard UI

The interactive frontend dashboard is built with React 18, Vite, and Chart.js. It visualizes gas consumption trends, function cost breakdowns, efficiency scores, and recent contract optimizations.

```bash
# Start Vite development server (proxies /api to localhost:3000)
npm run dev

# Build production distribution
npm run build
```

The main dashboard view is defined in `src/dashboard/Dashboard.jsx` and includes time range filters (7d, 30d, 90d), key metrics cards, and fee trend visualizations.

---

## Testing

Run unit and component tests using Vitest:

```bash
npm run test:run
```
