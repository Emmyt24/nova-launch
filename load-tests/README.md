# Load tests

This directory contains the Nova Launch k6 load-test suite. Tests exercise read-heavy API traffic, search, gateway-facing API behavior, event ingestion, GraphQL subscriptions, webhook paths, concurrent deployments, rate limiting, and the contract-to-backend event latency SLO. Test data in the scripts is synthetic; do not use production payloads, credentials, tokens, addresses, or personal data in scenarios or result artifacts.

## Prerequisites

- A running API/backend target reachable from the load-test host.
- k6 installed and available on `PATH`.
- Node.js 18+ and npm for the local helper/unit-test scripts.
- Dependencies installed in this directory when using the npm scripts:

  ```bash
  cd load-tests
  npm install
  ```

The default API target is `http://localhost:3001`. Set `BASE_URL` to the target under test; for gateway coverage, use the gateway URL (normally `http://localhost:4000`). Run load tests only against an isolated environment with synthetic data.

## Scenarios

The npm scripts map to these k6 entry points:

| Command | Scenario | Purpose |
| --- | --- | --- |
| `npm run test:normal` | `scenarios/normal-load.js` | Sustained normal search, filtering, pagination, and query traffic. |
| `npm run test:peak` | `scenarios/peak-load.js` | Ramp to peak traffic with weighted search/filter/pagination operations. |
| `npm run test:stress` | `scenarios/stress-test.js` | Progressive load to the configured breaking-point range. |
| `npm run test:spike` | `scenarios/spike-test.js` | Sudden traffic spikes and recovery behavior. |
| `npm run test:api` | `scenarios/api-load.js` | General API endpoint load. |
| `npm run test:search` | `scenarios/search-load.js` | Search, filters, sorting, pagination, and cache behavior. |
| `npm run test:ci` | `scenarios/ci-load.js` | Short CI mix: token search/list, health/version, leaderboard, and stats. |
| `npm run test:concurrent-deploy` | `scenarios/concurrent-deploy.js` | Concurrent deployment behavior. |
| `npm run test:graphql-subscription-load` | `scenarios/graphql-subscription-load.js` | GraphQL subscription concurrency. |
| `npm run test:event-ingestion-throughput` | `scenarios/event-ingestion-throughput.js` | Event-ingestion throughput and acknowledgements. |
| `npm run test:event-latency-slo` | `event-latency-slo.js` | Emit-to-projection latency SLO. |
| `npm run test:ratelimiter` | `scenarios/ratelimiter-accuracy.js` | Rate-limiter behavior and accuracy. |
| `npm run test:all` | normal, peak, stress | Run the primary normal/peak/stress sequence. |

Additional scenario files under `scenarios/` cover event listeners, leaderboards, token search, webhook throughput, and webhook burst/restart behavior. Run a file directly when it has no npm alias:

```bash
k6 run scenarios/event-listener-sustained.js
```

## Configuration

Common configuration is loaded from `config/test-config.js`; scenario-specific stages and thresholds remain in each scenario file. The following environment variables are supported by the CI and event-latency SLO scripts:

| Variable | Default | Use |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3001` | API or gateway base URL. |
| `CI_VUS` | `10` | Steady-state virtual users for `test:ci`. |
| `CI_DURATION` | `60` | Steady-state seconds for `test:ci`. |
| `FAIL_ON_THRESHOLD` | enabled by the script/tooling | Collect data without failing CI when set to `false`, where supported. |
| `SLO_VUS` | `10` | Concurrent streams for the event-latency SLO. |
| `SLO_DURATION` | `60` | Steady-state seconds for the event-latency SLO. |
| `SLO_P95_THRESHOLD_MS` | `30000` | Maximum permitted p95 emit-to-projection latency. |
| `SLO_POLL_INTERVAL_MS` | `200` | Poll interval while waiting for a projection. |
| `SLO_POLL_TIMEOUT_MS` | `10000` | Maximum projection wait per emitted event. |

Example with a gateway target and short CI run:

```bash
cd load-tests
BASE_URL=http://localhost:4000 npm run test:ci
```

## Event latency SLO

Run the dedicated SLO script with:

```bash
cd load-tests
npm run test:event-latency-slo
```

Each iteration posts a synthetic `proposal_created` event to `/api/governance/events/ingest`, polls the corresponding proposal projection, and records emit-to-projection latency. The pass criteria are p95 latency below `SLO_P95_THRESHOLD_MS` (30 seconds by default) and a projection confirmation rate above 99%.

The script writes `results/event-latency-slo-summary.json` and prints output shaped like:

```text
=== Contract-to-Backend Event Latency SLO — PASSED ===
  VUs              : 10
  Duration         : 60s
  p95 SLO threshold: 30000 ms
  Total events     : <count>
  Emit-to-projection latency (ms):
    p50            : <value>
    p95            : <value>
    p99            : <value>
  Confirmed rate   : <value> %
  Timeouts         : 0
```

Interpret the result as an end-to-end projection signal, not an ingest acknowledgement metric. A `FAILED` result means p95 exceeded the configured budget or confirmation rate fell to 99% or below. Investigate backend projection lag, event listener health, Redis/database capacity, and gateway/API errors in the isolated target environment before changing thresholds.

## Results and interpretation

Most scenarios print a human-readable summary and write JSON or text reports under `load-tests/results/`. k6 threshold failures make the command fail; a passing command means the configured thresholds were met for that run, not that the system has unlimited capacity. Record the target URL, scenario, non-secret configuration, commit, and run timestamp with external reports, but do not include authorization headers, secret values, PII, or raw production payloads.
