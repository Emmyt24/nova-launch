/**
 * Contract-to-Backend Event Latency SLO Load Test
 * load-tests/event-latency-slo.js
 *
 * Measures end-to-end latency from an on-chain event being emitted to the
 * backend projection reflecting it — distinct from ingest-request
 * ack/throughput, which scenarios/event-listener-sustained.js already
 * covers. This is the metric that directly drives perceived product
 * responsiveness: "I created a proposal, when can I see it?"
 *
 * Flow per iteration:
 *   1. POST /api/governance/events/ingest with a synthetic proposal_created
 *      event (stand-in for an on-chain governance event picked up by the
 *      Stellar event listener) and record the dispatch time.
 *   2. Poll GET /api/governance/proposals/:proposalId — the read-side
 *      projection populated by GovernanceEventParser
 *      (backend/src/services/governanceEventParser.ts) — until it returns
 *      the proposal (confirmed) or the poll budget is exhausted (timed out).
 *   3. Record emit-to-projection latency = first confirmation time - dispatch time.
 *
 * Runs under sustained load (SLO_VUS concurrent streams for SLO_DURATION
 * seconds), not just at idle, per #1615.
 *
 * SLO: p95 emit-to-projection latency < 30000ms (30s). This reuses the
 * documented default WARNING threshold from
 * backend/src/monitoring/metrics/projectionLagThresholds.ts
 * (PROJECTION_LAG_THRESHOLDS.WARNING) and matches the HighEventIngestionLag
 * alert in monitoring/prometheus/alerts/blockchain.yml (p95 > 30s).
 *
 * Environment variables:
 *   BASE_URL              API base URL (default: http://localhost:3001)
 *   SLO_VUS               Concurrent emit streams (default: 10)
 *   SLO_DURATION          Steady-state seconds (default: 60)
 *   SLO_P95_THRESHOLD_MS  p95 SLO in ms (default: 30000)
 *   SLO_POLL_INTERVAL_MS  Poll interval while waiting for projection (default: 200)
 *   SLO_POLL_TIMEOUT_MS   Max time to wait before declaring an event lost (default: 10000)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { config } from './config/test-config.js';

// ── Custom metrics ──────────────────────────────────────────────────────────

const emitToProjectionLatency = new Trend('emit_to_projection_latency_ms');
const eventsEmitted           = new Counter('events_emitted');
const projectionConfirmedRate = new Rate('projection_confirmed_rate');
const projectionTimeouts      = new Counter('projection_timeouts');

// ── Parameters ────────────────────────────────────────────────────────────

const VUS           = parseInt(__ENV.SLO_VUS              || '10');
const DURATION       = parseInt(__ENV.SLO_DURATION         || '60');
const P95_THRESHOLD  = parseInt(__ENV.SLO_P95_THRESHOLD_MS || '30000');
const POLL_INTERVAL  = parseInt(__ENV.SLO_POLL_INTERVAL_MS || '200');
const POLL_TIMEOUT   = parseInt(__ENV.SLO_POLL_TIMEOUT_MS  || '10000');
const BASE_URL       = __ENV.BASE_URL || config.baseUrl;

// ── Options ───────────────────────────────────────────────────────────────

export const options = {
  stages: [
    { duration: '10s', target: VUS },
    { duration: `${DURATION}s`, target: VUS },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    // The SLO: p95 emit-to-projection latency under the documented budget.
    emit_to_projection_latency_ms: [`p(95)<${P95_THRESHOLD}`],
    projection_confirmed_rate: ['rate>0.99'],
  },
  tags: { test_type: 'event_latency_slo' },
};

// ── Synthetic proposal_created event factory ─────────────────────────────

function makeProposalId() {
  // Second-granular timestamp bucket + random suffix keeps ids unique across
  // VUs/iterations without colliding with real data.
  return Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 1000);
}

function makeProposalCreatedEvent(proposalId) {
  const now = new Date();
  const endTime = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  return {
    type: 'proposal_created',
    txHash: `load-slo-tx-${proposalId}`,
    ledger: Math.floor(Math.random() * 1_000_000) + 500_000,
    timestamp: now.toISOString(),
    contractId: 'CTEST_GOVERNANCE_LOAD',
    proposalId,
    tokenAddress: 'CTEST_TOKEN_LOAD',
    proposer: 'GLOAD_PROPOSER',
    title: `SLO load test proposal ${proposalId}`,
    proposalType: 'CUSTOM',
    startTime: now.toISOString(),
    endTime: endTime.toISOString(),
    quorum: '1000',
    threshold: '500',
  };
}

// ── VU loop ───────────────────────────────────────────────────────────────

export default function () {
  const proposalId = makeProposalId();
  const event = makeProposalCreatedEvent(proposalId);
  const dispatchedAt = Date.now();

  const emitRes = http.post(
    `${BASE_URL}/api/governance/events/ingest`,
    JSON.stringify({ events: [event] }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'GovernanceEventIngest' } }
  );

  eventsEmitted.add(1);
  const emitAccepted = emitRes.status >= 200 && emitRes.status < 300;
  check(emitRes, { 'event emit accepted (2xx)': () => emitAccepted });

  if (!emitAccepted) {
    projectionConfirmedRate.add(false);
    return;
  }

  // Poll the projection until it reflects the emitted event or the poll
  // budget is exhausted.
  let confirmed = false;
  const deadline = dispatchedAt + POLL_TIMEOUT;

  while (Date.now() < deadline) {
    const readRes = http.get(
      `${BASE_URL}/api/governance/proposals/${proposalId}`,
      { tags: { name: 'GovernanceProposalProjectionRead' } }
    );

    if (readRes.status === 200) {
      confirmed = true;
      break;
    }

    sleep(POLL_INTERVAL / 1000);
  }

  const latencyMs = Date.now() - dispatchedAt;
  projectionConfirmedRate.add(confirmed);

  if (confirmed) {
    emitToProjectionLatency.add(latencyMs);
  } else {
    projectionTimeouts.add(1);
  }

  check(null, { 'projection reflects event within poll budget': () => confirmed });
}

// ── Summary ───────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const p50 = data.metrics.emit_to_projection_latency_ms?.values?.['p(50)'] ?? 0;
  const p95 = data.metrics.emit_to_projection_latency_ms?.values?.['p(95)'] ?? 0;
  const p99 = data.metrics.emit_to_projection_latency_ms?.values?.['p(99)'] ?? 0;
  const avg = data.metrics.emit_to_projection_latency_ms?.values?.avg ?? 0;
  const max = data.metrics.emit_to_projection_latency_ms?.values?.max ?? 0;

  const totalEvents   = data.metrics.events_emitted?.values?.count ?? 0;
  const confirmedRate = data.metrics.projection_confirmed_rate?.values?.rate ?? 0;
  const timeouts      = data.metrics.projection_timeouts?.values?.count ?? 0;

  const passed = p95 <= P95_THRESHOLD && confirmedRate >= 0.99;
  const status = passed ? 'PASSED' : 'FAILED';

  const summary = {
    passed,
    timestamp: new Date().toISOString(),
    vus: VUS,
    durationSec: DURATION,
    p95ThresholdMs: P95_THRESHOLD,
    metrics: { p50, p95, p99, avg, max, totalEvents, confirmedRate, timeouts },
  };

  const lines = [
    '',
    `=== Contract-to-Backend Event Latency SLO — ${status} ===`,
    `  Timestamp        : ${summary.timestamp}`,
    `  VUs              : ${VUS}`,
    `  Duration         : ${DURATION}s`,
    `  p95 SLO threshold: ${P95_THRESHOLD} ms`,
    `  Total events     : ${totalEvents}`,
    '',
    '  Emit-to-projection latency (ms):',
    `    p50            : ${p50.toFixed(1)}`,
    `    p95            : ${p95.toFixed(1)}`,
    `    p99            : ${p99.toFixed(1)}`,
    `    avg            : ${avg.toFixed(1)}`,
    `    max            : ${max.toFixed(1)}`,
    '',
    `  Confirmed rate   : ${(confirmedRate * 100).toFixed(2)} %`,
    `  Timeouts         : ${timeouts}`,
    '',
  ].join('\n');

  return {
    'load-tests/results/event-latency-slo-summary.json': JSON.stringify(summary, null, 2),
    stdout: lines,
  };
}
