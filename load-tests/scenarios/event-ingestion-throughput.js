/**
 * Event Ingestion Throughput Load Scenario
 * load-tests/scenarios/event-ingestion-throughput.js
 *
 * Finds whether the event ingestion path can sustain a target rate of events
 * per second, and reports p95 processing latency while it does (#2213).
 *
 * Unlike scenarios/event-listener-sustained.js (fixed VUs firing as fast as
 * responses allow, measuring ack lag) this uses an *open* arrival-rate model:
 * batches are scheduled on the target timeline regardless of how slowly the
 * backend responds. A backend that cannot keep up therefore shows up as
 * dropped batches and a throughput shortfall, not as a silently lower rate.
 *
 * Endpoint: POST /api/governance/events/ingest processes every event in the
 * batch synchronously (GovernanceEventParser → database) before responding,
 * so request duration is the server-side processing latency for the batch.
 *
 * Each batch is one proposal_created plus (EI_BATCH_SIZE - 1) vote_cast
 * events on that proposal, from distinct voters.
 *
 * Pass criteria (see docs/EVENT_INGESTION_THROUGHPUT.md):
 *   - p95 batch processing latency  < EI_P95_THRESHOLD_MS   (default 500 ms)
 *   - events processed / demanded   ≥ 95 %                  (target sustained)
 *   - events processed / sent       ≥ 99 %                  (no silent failures)
 *
 * Environment variables:
 *   BASE_URL                API base URL (default: http://localhost:3001)
 *   EI_TARGET_EPS           Target events per second (default: 200)
 *   EI_BATCH_SIZE           Events per ingest request (default: 10)
 *   EI_RAMP_SEC             Ramp-up seconds (default: 15)
 *   EI_STEADY_SEC           Steady-state seconds at target (default: 60)
 *   EI_P95_THRESHOLD_MS     p95 batch latency budget (default: 500)
 *   EI_EXPECTED_LATENCY_MS  Expected batch latency, sizes the VU pool (default: 200)
 *   EI_MAX_VUS              Upper bound on VUs (default: 200)
 */

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';
import { config } from '../config/test-config.js';
import {
  DEFAULT_TARGET_EPS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_P95_THRESHOLD_MS,
  parsePositiveInt,
  computeRequestRate,
  buildArrivalStages,
  estimatePreAllocatedVus,
  countProcessedEvents,
  buildEventBatch,
  buildThroughputReport,
  formatThroughputSummary,
} from '../lib/event-ingestion-throughput-helpers.js';

// ── Parameters ────────────────────────────────────────────────────────────

const BASE_URL       = __ENV.BASE_URL || config.baseUrl;
const TARGET_EPS     = parsePositiveInt(__ENV.EI_TARGET_EPS, DEFAULT_TARGET_EPS);
const BATCH_SIZE     = parsePositiveInt(__ENV.EI_BATCH_SIZE, DEFAULT_BATCH_SIZE);
const RAMP_SEC       = parsePositiveInt(__ENV.EI_RAMP_SEC, 15);
const STEADY_SEC     = parsePositiveInt(__ENV.EI_STEADY_SEC, 60);
const P95_THRESHOLD  = parsePositiveInt(__ENV.EI_P95_THRESHOLD_MS, DEFAULT_P95_THRESHOLD_MS);
const EXPECTED_MS    = parsePositiveInt(__ENV.EI_EXPECTED_LATENCY_MS, 200);
const MAX_VUS        = parsePositiveInt(__ENV.EI_MAX_VUS, 200);

const REQUEST_RATE   = computeRequestRate(TARGET_EPS, BATCH_SIZE);
const PRE_ALLOCATED  = Math.min(MAX_VUS, estimatePreAllocatedVus(REQUEST_RATE, EXPECTED_MS));

// ── Custom metrics ────────────────────────────────────────────────────────

const batchProcessingLatency = new Trend('ei_batch_processing_ms', true);
const eventsSent             = new Counter('ei_events_sent');
const eventsProcessed        = new Counter('ei_events_processed');
const eventsFailed           = new Counter('ei_events_failed');
const batchAccepted          = new Rate('ei_batch_accepted_rate');
// The governance router sits behind the API's per-IP rate limiter
// (backend/src/index.ts). 429s mean the run measured the limiter, not
// ingestion — counted separately so the summary can say so.
const batchesRateLimited     = new Counter('ei_batches_rate_limited');

// ── Options ───────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    event_ingestion: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: PRE_ALLOCATED,
      maxVUs: MAX_VUS,
      stages: buildArrivalStages(REQUEST_RATE, RAMP_SEC, STEADY_SEC),
    },
  },
  thresholds: {
    ei_batch_processing_ms: [`p(95)<${P95_THRESHOLD}`],
    ei_batch_accepted_rate: ['rate>0.99'],
    ei_events_failed: [`count<${Math.max(1, Math.floor(TARGET_EPS * STEADY_SEC * 0.01))}`],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  tags: { test_type: 'event_ingestion_throughput' },
};

// ── VU loop ───────────────────────────────────────────────────────────────

export default function () {
  // Unique per iteration across all VUs; offset keeps ids clear of real data.
  const proposalId = 900_000_000 + exec.scenario.iterationInTest;
  const events = buildEventBatch(proposalId, BATCH_SIZE);

  const res = http.post(
    `${BASE_URL}/api/governance/events/ingest`,
    JSON.stringify({ events }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'GovernanceEventIngestBatch' },
    }
  );

  eventsSent.add(events.length);
  const accepted = res.status >= 200 && res.status < 300;
  batchAccepted.add(accepted);

  if (!accepted) {
    if (res.status === 429) batchesRateLimited.add(1);
    eventsFailed.add(events.length);
    check(res, { 'batch accepted (2xx)': () => false });
    return;
  }

  // Only successful batches feed the latency trend, so error fast-paths
  // cannot flatter the p95.
  batchProcessingLatency.add(res.timings.duration);

  let body = null;
  try {
    body = res.json();
  } catch (_) {
    // counted as fully failed below
  }
  // Events missing from the response count as failed too.
  const { processed } = countProcessedEvents(body);
  eventsProcessed.add(processed);
  eventsFailed.add(events.length - processed);

  check(res, {
    'batch accepted (2xx)': () => true,
    'all events processed': () => processed === events.length,
    [`batch processed < ${P95_THRESHOLD}ms`]: (r) => r.timings.duration < P95_THRESHOLD,
  });
}

// ── Summary ───────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const m = data.metrics;
  const latency = m.ei_batch_processing_ms?.values ?? {};
  const testDurationSec = (data.state?.testRunDurationMs ?? 0) / 1000;

  const report = buildThroughputReport({
    targetEps: TARGET_EPS,
    steadySec: STEADY_SEC,
    eventsSent: m.ei_events_sent?.values?.count ?? 0,
    eventsProcessed: m.ei_events_processed?.values?.count ?? 0,
    eventsFailed: m.ei_events_failed?.values?.count ?? 0,
    processingP95Ms: latency['p(95)'] ?? 0,
    p95ThresholdMs: P95_THRESHOLD,
    droppedIterations: m.dropped_iterations?.values?.count ?? 0,
    batchSize: BATCH_SIZE,
    testDurationSec,
  });

  const rateLimited = m.ei_batches_rate_limited?.values?.count ?? 0;
  const timestamp = new Date().toISOString();
  const summary = {
    ...report,
    batchesRateLimited: rateLimited,
    timestamp,
    baseUrl: BASE_URL,
    batchSize: BATCH_SIZE,
    requestRate: REQUEST_RATE,
    rampSec: RAMP_SEC,
    testDurationSec,
    latencyMs: {
      p50: latency.med ?? 0,
      p90: latency['p(90)'] ?? 0,
      p95: latency['p(95)'] ?? 0,
      p99: latency['p(99)'] ?? 0,
      max: latency.max ?? 0,
      avg: latency.avg ?? 0,
    },
  };

  return {
    'load-tests/results/event-ingestion-throughput-summary.json': JSON.stringify(summary, null, 2),
    stdout: formatThroughputSummary(report, {
      timestamp,
      batchSize: BATCH_SIZE,
      p50: summary.latencyMs.p50,
      p99: summary.latencyMs.p99,
      max: summary.latencyMs.max,
      rateLimited,
    }),
  };
}
