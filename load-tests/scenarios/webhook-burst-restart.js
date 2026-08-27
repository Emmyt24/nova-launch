import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { config } from '../config/test-config.js';

const deliveredCounter    = new Counter('whb_delivered');
const errorCounter        = new Counter('whb_errors');
const deadLetterCounter   = new Counter('whb_dead_letter');
const deliveryErrorRate   = new Rate('whb_error_rate');
const deliveryDuration    = new Trend('whb_delivery_duration_ms');

const VUS             = parseInt(__ENV.WHB_VUS            || '30');
const BURST_DURATION  = parseInt(__ENV.WHB_BURST_DURATION || '120');
const RESTART_AT_SEC  = parseInt(__ENV.WHB_RESTART_AT_SEC || '45');
const BASE_URL        = __ENV.BASE_URL || config.baseUrl;

export const options = {
  stages: [
    { duration: '10s',            target: VUS },
    { duration: `${BURST_DURATION}s`, target: VUS },
    { duration: '10s',            target: 0 },
  ],
  thresholds: {
    whb_error_rate:           ['rate<0.05'],
    whb_delivery_duration_ms: ['p(95)<5000'],
    checks:                   ['rate>0.95'],
  },
  tags: { test_type: 'webhook_burst_restart' },
};

let restartTriggered = false;

function triggerRestart() {
  if (restartTriggered) return;
  restartTriggered = true;
  const res = http.post(`${BASE_URL}/api/admin/restart`, '{}', {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'AdminRestart' },
  });
  console.log(`[RESTART] Triggered backend restart — status: ${res.status}`);
}

const EVENT_TYPES = [
  'TOKEN_CREATED',
  'TOKEN_BURNED',
  'STREAM_CREATED',
  'STREAM_CLAIMED',
  'VAULT_MATURED',
];

function makeWebhookEvent(type) {
  const txHash = `whb-burst-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return JSON.stringify({
    event: type,
    data: {
      tokenAddress: `GBURST_${Math.floor(Math.random() * 1000)}`,
      amount:       String(Math.floor(Math.random() * 10_000_000)),
      txHash,
      ledger:       Math.floor(Math.random() * 1_000_000) + 1_000_000,
      timestamp:    new Date().toISOString(),
    },
  });
}

export default function () {
  const elapsed = __ITER * (1 / VUS);

  if (elapsed >= RESTART_AT_SEC && !restartTriggered) {
    triggerRestart();
  }

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
  const deadLetter = res.status === 202;

  if (delivered) {
    deliveredCounter.add(1);
  } else if (deadLetter) {
    deadLetterCounter.add(1);
  } else {
    errorCounter.add(1);
  }

  deliveryErrorRate.add(!delivered);

  check(res, {
    'webhook accepted (2xx or 202)': (r) =>
      (r.status >= 200 && r.status < 300) || r.status === 202,
  });

  sleep(0.5);
}

export function handleSummary(data) {
  const delivered   = data.metrics.whb_delivered?.values?.count      ?? 0;
  const errors      = data.metrics.whb_errors?.values?.count         ?? 0;
  const deadLetter  = data.metrics.whb_dead_letter?.values?.count    ?? 0;
  const errRate     = data.metrics.whb_error_rate?.values?.rate       ?? 0;
  const p95         = data.metrics.whb_delivery_duration_ms?.values?.['p(95)'] ?? 0;
  const total       = delivered + errors + deadLetter;
  const accounted   = delivered + deadLetter;
  const lost        = total - accounted;
  const passed      = lost === 0 && errRate < 0.05;

  const summary = {
    passed,
    timestamp: new Date().toISOString(),
    vus: VUS,
    burstDurationSec: BURST_DURATION,
    restartAtSec: RESTART_AT_SEC,
    metrics: {
      sent: total,
      delivered,
      deadLettered: deadLetter,
      accounted,
      silentlyLost: lost,
      errorRate: errRate,
      p95LatencyMs: p95,
    },
  };

  const lines = [
    '',
    `=== Webhook Burst Restart — Post-Run Reconciliation ${passed ? 'PASSED' : 'FAILED'} ===`,
    `  Timestamp              : ${summary.timestamp}`,
    `  VUs                    : ${VUS}`,
    `  Burst duration         : ${BURST_DURATION}s`,
    `  Restart triggered at   : ${RESTART_AT_SEC}s`,
    '',
    '  Reconciliation:',
    `    Triggering events sent : ${total}`,
    `    Webhooks delivered     : ${delivered}`,
    `    Dead-lettered          : ${deadLetter}`,
    `    Accounted total        : ${accounted}`,
    `    Silently lost          : ${lost}  ${lost === 0 ? '✓' : '✗'}`,
    `    Error rate             : ${(errRate * 100).toFixed(2)} %`,
    `    p95 latency            : ${p95.toFixed(1)} ms`,
    '',
  ].join('\n');

  return {
    'load-tests/results/webhook-burst-restart-summary.json': JSON.stringify(summary, null, 2),
    stdout: lines,
  };
}
