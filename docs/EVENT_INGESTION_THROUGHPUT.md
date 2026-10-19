# Event Ingestion Throughput Load Test

Issue: #2213 · Scenario: `load-tests/scenarios/event-ingestion-throughput.js`
· Helpers: `load-tests/lib/event-ingestion-throughput-helpers.js`

Answers one question: **how many events per second can the backend ingest,
and how long does processing take at that rate?**

## What it measures

The scenario posts batches of governance events to
`POST /api/governance/events/ingest`. That endpoint runs every event through
`GovernanceEventParser` and writes it to the database *before* responding, so
the request duration is the server-side processing latency of the batch.

Each batch holds one `proposal_created` and `EI_BATCH_SIZE - 1` `vote_cast`
events on that proposal, each from a different voter. Every event is valid and
causes a real write.

It uses k6's **`ramping-arrival-rate`** executor, an open model. Batches are
started on the target timeline no matter how slowly the backend responds.
When the backend can't keep up, k6 runs out of free VUs and reports
`dropped_iterations`, so a throughput shortfall can't hide behind a lower
request rate. This is the difference from
`scenarios/event-listener-sustained.js`, which uses a fixed VU count and
measures acknowledgement lag.

## Targets

| Parameter | Default | Env var |
|---|---|---|
| Target rate | **200 events/s** | `EI_TARGET_EPS` |
| Batch size | 10 events (so 20 requests/s) | `EI_BATCH_SIZE` |
| Ramp-up | 15 s | `EI_RAMP_SEC` |
| Steady state | 60 s | `EI_STEADY_SEC` |
| p95 batch processing budget | **500 ms** | `EI_P95_THRESHOLD_MS` |
| Expected latency (sizes the VU pool) | 200 ms | `EI_EXPECTED_LATENCY_MS` |
| Max VUs | 200 | `EI_MAX_VUS` |

200 events/s matches the aggregate volume the event-listener sustained
scenario was designed for (20 VUs firing continuously). The 500 ms p95 budget
matches its ingestion-lag threshold, which keeps both scenarios on the same
latency budget.

### Pass criteria

A run passes when all three hold:

1. **Latency:** p95 of `ei_batch_processing_ms` < `EI_P95_THRESHOLD_MS`.
2. **Throughput sustained:** events processed ≥ 95 % of events demanded by the
   schedule. "Demanded" means sent plus dropped batches × batch size.
3. **No silent failures:** events processed ≥ 99 % of events sent. An event is
   processed only when the response marks it `success: true`.

k6 thresholds also enforce p95, a > 99 % batch acceptance rate, and a cap on
failed events, so k6 exits non-zero on a failing run.

## Running

Run from the repository root (summary paths are relative to it) against a
backend with a database:

```bash
k6 run load-tests/scenarios/event-ingestion-throughput.js

# Find the ceiling: raise the target until a criterion fails
k6 run --env EI_TARGET_EPS=400 --env EI_EXPECTED_LATENCY_MS=400 \
  load-tests/scenarios/event-ingestion-throughput.js
```

To find the throughput limit, step `EI_TARGET_EPS` up (200 → 400 → 800 …).
The highest rate that still passes is the sustainable throughput. Raise
`EI_EXPECTED_LATENCY_MS` or `EI_MAX_VUS` along with it, or k6 itself will run
short of VUs.

Helper unit tests: `cd load-tests && npm run test:unit`.

## Output

- **stdout:** a pass/fail summary with events sent, processed and failed,
  dropped batches, throughput against the plan, and batch latency
  p50/p95/p99/max.
- **`load-tests/results/event-ingestion-throughput-summary.json`:** the same
  data as JSON (`latencyMs.p95`, `throughputRatio`, `achievedEps`, …) for
  dashboards or comparing runs.

## Rate limiting

In `backend/src/index.ts` the governance router sits behind the API's per-IP
limiter (100 requests per 15 minutes). From a single load generator, every
batch after the 100th gets HTTP 429, and the run measures the limiter, not
ingestion. The scenario counts 429s in `ei_batches_rate_limited`, and the
summary prints a warning when any occur.

For a meaningful run, point the scenario at an environment where that limiter
doesn't apply to the load generator, such as a dedicated performance
environment. Don't relax the limiter in production. Treat any result that
carries the rate-limit warning as invalid.

## Results

Record each baseline run here: commit, environment, and the numbers from the
summary JSON.

| Date | Commit | Environment | Target (ev/s) | Processed / demanded | p95 (ms) | p99 (ms) | Result |
|---|---|---|---|---|---|---|---|
| _not yet run_ | | | 200 | | | | |

No baseline has been recorded yet. The scenario was added in #2213, and the
first run should happen against the performance environment, with the
rate-limit caveat above taken into account.
