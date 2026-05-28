/**
 * Webhook Delivery Throughput Benchmark
 * load-tests/scenarios/webhook-throughput.js
 *
 * Generates a sustained stream of webhook-triggering events and asserts that
 * delivery throughput stays above the minimum target while error rate stays
 * within the acceptable bound.
 *
 * Methodology:
 *   - VUs POST to the webhook-trigger endpoint simulating real events.
 *   - Throughput is measured as successful 2xx responses per second.
 *   - Error rate is non-2xx responses / total attempts.
 *   - A test sink URL (WEBHOOK_SINK_URL) receives the outbound payloads.
 *
 * Thresholds:
 *   Min throughput : 50 deliveries/sec  (WHK_MIN_THROUGHPUT)
 *   Max error rate : 1 %                (WHK_MAX_ERROR_PCT)
 *
 * Environment variables:
 *   BASE_URL            API base URL (default: http://localhost:3001)
 *   WHK_VUS             Virtual users (default: 20)
 *   WHK_DURATION        Steady-state seconds (default: 60)
 *   WHK_MIN_THROUGHPUT  Minimum deliveries/sec (default: 50)
 *   WHK_MAX_ERROR_PCT   Maximum error percentage (default: 1)
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { config } from '../config/test-config.js';

// ── Custom metrics ────────────────────────────────────────────────────────

const deliveredCounter   = new Counter('whk_delivered');
const errorCounter       = new Counter('whk_errors');
const deliveryErrorRate  = new Rate('whk_error_rate');
const deliveryDuration   = new Trend('whk_delivery_duration_ms');

// ── Parameters ────────────────────────────────────────────────────────────

const VUS              = parseInt(__ENV.WHK_VUS             || '20');
const DURATION         = parseInt(__ENV.WHK_DURATION        || '60');
const MIN_THROUGHPUT   = parseFloat(__ENV.WHK_MIN_THROUGHPUT || '50');
const MAX_ERROR_PCT    = parseFloat(__ENV.WHK_MAX_ERROR_PCT  || '1') / 100;
const BASE_URL         = __ENV.BASE_URL || config.baseUrl;

// ── Options ───────────────────────────────────────────────────────────────

export const options = {
  stages: [
    { duration: '10s',       target: VUS },
    { duration: `${DURATION}s`, target: VUS },
    { duration: '10s',       target: 0 },
  ],
  thresholds: {
    whk_error_rate:            [`rate<${MAX_ERROR_PCT}`],
    whk_delivery_duration_ms:  ['p(95)<2000'],
    checks:                    ['rate>0.99'],
  },
  tags: { test_type: 'webhook_throughput' },
};

// ── Event payload factory ─────────────────────────────────────────────────

const EVENT_TYPES = [
  'TOKEN_CREATED',
  'TOKEN_BURNED',
  'STREAM_CREATED',
  'STREAM_CLAIMED',
];

function makeWebhookEvent(type) {
  return JSON.stringify({
    event: type,
    data: {
      tokenAddress: `GTOKEN_LOAD_${Math.floor(Math.random() * 100)}`,
      amount:       String(Math.floor(Math.random() * 1_000_000)),
      txHash:       `whk-load-tx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ledger:       Math.floor(Math.random() * 500_000) + 500_000,
      timestamp:    new Date().toISOString(),
    },
  });
}

// ── VU loop ───────────────────────────────────────────────────────────────

export default function () {
  const eventType = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)];
  const payload   = makeWebhookEvent(eventType);

  const res = http.post(
    `${BASE_URL}/api/webhooks/trigger`,
    payload,
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'WebhookTrigger', event_type: eventType },
    }
  );

  deliveryDuration.add(res.timings.duration);

  const delivered = res.status >= 200 && res.status < 300;

  if (delivered) {
    deliveredCounter.add(1);
  } else {
    errorCounter.add(1);
  }

  deliveryErrorRate.add(!delivered);

  check(res, {
    'webhook accepted (2xx)':   (r) => r.status >= 200 && r.status < 300,
    'delivery < 2000ms':        (r) => r.timings.duration < 2000,
  });
}

// ── Summary ───────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const delivered  = data.metrics.whk_delivered?.values?.count    ?? 0;
  const errors     = data.metrics.whk_errors?.values?.count       ?? 0;
  const errRate    = data.metrics.whk_error_rate?.values?.rate     ?? 0;
  const p95        = data.metrics.whk_delivery_duration_ms?.values?.['p(95)'] ?? 0;
  const total      = delivered + errors;
  const throughput = DURATION > 0 ? delivered / DURATION : 0;
  const passed     = throughput >= MIN_THROUGHPUT && errRate <= MAX_ERROR_PCT;
  const status     = passed ? 'PASSED' : 'FAILED';

  const summary = {
    passed,
    timestamp: new Date().toISOString(),
    vus: VUS,
    durationSec: DURATION,
    thresholds: { minThroughput: MIN_THROUGHPUT, maxErrorRate: MAX_ERROR_PCT },
    metrics: { delivered, errors, total, throughput, errorRate: errRate, p95LatencyMs: p95 },
  };

  const lines = [
    '',
    `=== Webhook Delivery Throughput Benchmark — ${status} ===`,
    `  Timestamp       : ${summary.timestamp}`,
    `  VUs             : ${VUS}`,
    `  Duration        : ${DURATION}s`,
    '',
    '  Delivery:',
    `    Delivered     : ${delivered}`,
    `    Errors        : ${errors}`,
    `    Total         : ${total}`,
    `    Throughput    : ${throughput.toFixed(2)} req/s  (threshold: >= ${MIN_THROUGHPUT})`,
    `    Error rate    : ${(errRate * 100).toFixed(2)} %  (threshold: <= ${MAX_ERROR_PCT * 100} %)`,
    `    p95 latency   : ${p95.toFixed(1)} ms`,
    '',
  ].join('\n');

  return {
    'load-tests/results/webhook-throughput-summary.json': JSON.stringify(summary, null, 2),
    stdout: lines,
  };
}
