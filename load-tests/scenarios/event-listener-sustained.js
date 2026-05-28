/**
 * Stellar Event-Listener Sustained Load Scenario
 * load-tests/scenarios/event-listener-sustained.js
 *
 * Drives a sustained synthetic event stream through the listener endpoint and
 * asserts that ingestion lag (time from request dispatch to acknowledgement)
 * stays under the defined threshold over the entire run.
 *
 * Run duration : 120 s steady state (EL_DURATION)
 * Volume       : 20 VUs firing continuously (EL_VUS)
 * Lag threshold: 500 ms (EL_LAG_THRESHOLD_MS)
 *
 * Environment variables:
 *   BASE_URL              API base URL (default: http://localhost:3001)
 *   EL_VUS                Virtual users (default: 20)
 *   EL_DURATION           Steady-state seconds (default: 120)
 *   EL_LAG_THRESHOLD_MS   Max acceptable lag ms (default: 500)
 */

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { config } from '../config/test-config.js';

// ── Custom metrics ────────────────────────────────────────────────────────

const ingestionLag   = new Trend('el_ingestion_lag_ms');
const eventCounter   = new Counter('el_events_fired');
const lagViolations  = new Counter('el_lag_violations');
const ackRate        = new Rate('el_ack_rate');

// ── Parameters ────────────────────────────────────────────────────────────

const VUS           = parseInt(__ENV.EL_VUS             || '20');
const DURATION      = parseInt(__ENV.EL_DURATION        || '120');
const LAG_THRESHOLD = parseInt(__ENV.EL_LAG_THRESHOLD_MS || '500');
const BASE_URL      = __ENV.BASE_URL || config.baseUrl;

// ── Options ───────────────────────────────────────────────────────────────

export const options = {
  stages: [
    { duration: '10s',       target: VUS },
    { duration: `${DURATION}s`, target: VUS },
    { duration: '10s',       target: 0 },
  ],
  thresholds: {
    // Ingestion lag p95 must stay under threshold
    el_ingestion_lag_ms: [`p(95)<${LAG_THRESHOLD}`],
    // Lag violations must be zero
    el_lag_violations: ['count<1'],
    // Acknowledgement rate must be high
    el_ack_rate: ['rate>0.99'],
  },
  tags: { test_type: 'event_listener_sustained' },
};

// ── Synthetic event payload factory ──────────────────────────────────────

const EVENT_TYPES = [
  'token_created',
  'token_burned',
  'stream_created',
  'stream_claimed',
  'vault_created',
];

function makeEvent(type) {
  return JSON.stringify({
    type,
    contractId:  'CTEST_CONTRACT_LOAD',
    ledger:      Math.floor(Math.random() * 1_000_000) + 500_000,
    ledgerCloseTime: new Date().toISOString(),
    transactionHash: `load-tx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    value:       { type, amount: String(Math.floor(Math.random() * 1_000_000)) },
  });
}

// ── VU loop ───────────────────────────────────────────────────────────────

export default function () {
  const eventType = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)];
  const payload   = makeEvent(eventType);
  const dispatchedAt = Date.now();

  const res = http.post(
    `${BASE_URL}/api/events/ingest`,
    payload,
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'EventIngest', event_type: eventType },
    }
  );

  const lagMs = Date.now() - dispatchedAt;
  const acked = res.status >= 200 && res.status < 300;

  ingestionLag.add(lagMs);
  eventCounter.add(1);
  ackRate.add(acked);

  if (lagMs > LAG_THRESHOLD) {
    lagViolations.add(1);
  }

  check(res, {
    'event acknowledged (2xx)':      (r) => r.status >= 200 && r.status < 300,
    [`lag < ${LAG_THRESHOLD}ms`]:    () => lagMs <= LAG_THRESHOLD,
  });
}

// ── Summary ───────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const lagP95       = data.metrics.el_ingestion_lag_ms?.values?.['p(95)'] ?? 0;
  const lagMax       = data.metrics.el_ingestion_lag_ms?.values?.max       ?? 0;
  const lagAvg       = data.metrics.el_ingestion_lag_ms?.values?.avg       ?? 0;
  const violations   = data.metrics.el_lag_violations?.values?.count       ?? 0;
  const totalEvents  = data.metrics.el_events_fired?.values?.count         ?? 0;
  const ackRateVal   = data.metrics.el_ack_rate?.values?.rate              ?? 0;

  const passed = lagP95 <= LAG_THRESHOLD && violations === 0 && ackRateVal >= 0.99;
  const status = passed ? 'PASSED' : 'FAILED';

  const summary = {
    passed,
    timestamp: new Date().toISOString(),
    vus: VUS,
    durationSec: DURATION,
    lagThresholdMs: LAG_THRESHOLD,
    metrics: { lagP95, lagMax, lagAvg, violations, totalEvents, ackRate: ackRateVal },
  };

  const lines = [
    '',
    `=== Event-Listener Sustained Load Test — ${status} ===`,
    `  Timestamp       : ${summary.timestamp}`,
    `  VUs             : ${VUS}`,
    `  Duration        : ${DURATION}s`,
    `  Lag threshold   : ${LAG_THRESHOLD} ms`,
    `  Total events    : ${totalEvents}`,
    '',
    '  Lag (ms):',
    `    p95           : ${lagP95.toFixed(1)}`,
    `    max           : ${lagMax.toFixed(1)}`,
    `    avg           : ${lagAvg.toFixed(1)}`,
    `    violations    : ${violations}`,
    '',
    `  Ack rate        : ${(ackRateVal * 100).toFixed(2)} %`,
    '',
  ].join('\n');

  return {
    'load-tests/results/event-listener-sustained-summary.json': JSON.stringify(summary, null, 2),
    stdout: lines,
  };
}
