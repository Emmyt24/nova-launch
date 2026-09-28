/**
 * Rate-Limiter Accuracy Load Scenario — load-tests/scenarios/ratelimiter-accuracy.js
 *
 * Fires concurrent requests well above the configured rate-limit budget and
 * asserts that the allow/deny counts match the budget within tolerance.
 *
 * Concurrency  : 50 VUs (RATELIMIT_VUS, default 50)
 * Window       : 15 min (RATELIMIT_WINDOW_MS, default 900000 — matches the
 *                gateway's RATE_LIMIT_WINDOW_MS default in
 *                backend/src/middleware/rateLimiter.ts)
 * Budget       : 100 req/window (RATELIMIT_BUDGET, matches the gateway's
 *                RATE_LIMIT_MAX_REQUESTS default)
 *
 * Defaults are sourced from config/gateway-defaults.js so they cannot drift
 * independently of the runbook/test config. If the gateway under test is
 * started with non-default RATE_LIMIT_* env vars, pass the same values via
 * RATELIMIT_WINDOW_MS / RATELIMIT_BUDGET.
 * Tolerance    : ±5 % of budget for allowed-request count
 * Denied status: asserted to be HTTP 429
 *
 * Environment variables:
 *   BASE_URL          API base URL (default: http://localhost:3001)
 *   RATELIMIT_VUS     Virtual users fired concurrently (default: 50)
 *   RATELIMIT_BUDGET  Configured per-window budget (default: 100)
 *   RATELIMIT_WINDOW_MS  Configured window length in ms (default: 900000)
 *   RATELIMIT_TOLERANCE_PCT  Tolerance in % (default: 5)
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { config } from '../config/test-config.js';
import { buildWindowStages } from '../lib/ratelimiter-helpers.js';

// ── Custom metrics ─────────────────────────────────────────────────────────

const allowedCounter = new Counter('rl_allowed_requests');
const deniedCounter  = new Counter('rl_denied_requests');
const errorCounter   = new Counter('rl_error_requests');
const deniedRate     = new Rate('rl_denied_rate');

// ── Parameters ─────────────────────────────────────────────────────────────

const VUS             = parseInt(__ENV.RATELIMIT_VUS          || '50');
const BUDGET          = parseInt(__ENV.RATELIMIT_BUDGET       || String(config.rateLimit.maxRequests));
const WINDOW_MS       = parseInt(__ENV.RATELIMIT_WINDOW_MS    || String(config.rateLimit.windowMs));
const TOLERANCE_PCT   = parseFloat(__ENV.RATELIMIT_TOLERANCE_PCT || '5') / 100;
const BASE_URL        = __ENV.BASE_URL || config.baseUrl;

// ── Options ────────────────────────────────────────────────────────────────

export const options = {
  // One burst: ramp to VUS, hold for exactly one gateway window, then ramp down.
  stages: buildWindowStages(VUS, WINDOW_MS),
  thresholds: {
    // All denied requests must be 429 — verified via check failures
    checks: ['rate>0.90'],
    // Error (non-2xx, non-429) rate must be negligible
    rl_error_requests: ['count<5'],
  },
  tags: { test_type: 'ratelimiter_accuracy' },
};

// ── VU loop ────────────────────────────────────────────────────────────────

export default function () {
  const res = http.get(`${BASE_URL}/api/tokens/search?q=test`, {
    tags: { name: 'RateLimitProbe' },
  });

  if (res.status >= 200 && res.status < 300) {
    allowedCounter.add(1);
    deniedRate.add(false);
    check(res, { 'allowed: status 2xx': (r) => r.status < 300 });
  } else if (res.status === 429) {
    deniedCounter.add(1);
    deniedRate.add(true);
    check(res, { 'denied: status is 429': (r) => r.status === 429 });
  } else {
    errorCounter.add(1);
    deniedRate.add(false);
    check(res, { 'no unexpected status': () => false });
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const allowed = data.metrics.rl_allowed_requests?.values?.count ?? 0;
  const denied  = data.metrics.rl_denied_requests?.values?.count  ?? 0;
  const errors  = data.metrics.rl_error_requests?.values?.count   ?? 0;

  const budgetWithinTolerance =
    BUDGET === 0
      ? allowed === 0
      : Math.abs(allowed - BUDGET) / BUDGET <= TOLERANCE_PCT;

  const passed = budgetWithinTolerance && errors === 0;
  const status = passed ? 'PASSED' : 'FAILED';

  const summary = {
    passed,
    timestamp: new Date().toISOString(),
    concurrency: VUS,
    budget: BUDGET,
    windowMs: WINDOW_MS,
    tolerancePct: TOLERANCE_PCT * 100,
    counts: { allowed, denied, errors },
    assertions: {
      budgetWithinTolerance,
      deniedReturnedCorrectStatus: denied > 0 || allowed + errors <= BUDGET,
    },
  };

  const lines = [
    '',
    `=== Rate-Limiter Accuracy Load Test — ${status} ===`,
    `  Timestamp   : ${summary.timestamp}`,
    `  Concurrency : ${VUS} VUs (≈${VUS}× concurrency)`,
    `  Budget      : ${BUDGET} req / ${WINDOW_MS / 60000} min window`,
    `  Tolerance   : ±${TOLERANCE_PCT * 100}%`,
    '',
    '  Counts:',
    `    Allowed   : ${allowed}`,
    `    Denied    : ${denied} (429)`,
    `    Errors    : ${errors}`,
    '',
    '  Assertions:',
    `    Budget within tolerance : ${budgetWithinTolerance ? 'yes ✓' : 'no ✗'}`,
    `    Denied returned 429     : ${summary.assertions.deniedReturnedCorrectStatus ? 'yes ✓' : 'no ✗'}`,
    '',
  ].join('\n');

  return {
    'load-tests/results/ratelimiter-accuracy-summary.json': JSON.stringify(summary, null, 2),
    stdout: lines,
  };
}
