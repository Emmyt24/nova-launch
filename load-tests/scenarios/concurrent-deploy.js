/**
 * Concurrent Token-Deployment Stress Scenario
 * load-tests/scenarios/concurrent-deploy.js
 *
 * Simulates many concurrent token deployment requests to stress-test the
 * deployment pipeline and surface bottlenecks under parallel load.
 *
 * Environment variables:
 *   BASE_URL              API base URL            (default: http://localhost:3001)
 *   CONCURRENT_VUS        Concurrent virtual users (default: 20)
 *   DEPLOY_DURATION       Steady-state seconds     (default: 60)
 *   DEPLOY_RAMP_DURATION  Ramp-up/down seconds     (default: 15)
 *
 * Pass/fail thresholds:
 *   p95 latency  < 3 000 ms
 *   p99 latency  < 6 000 ms
 *   Error rate   < 5 %
 *   Total deploys ≥ CONCURRENT_VUS × 2  (sanity floor)
 *
 * Running locally:
 *   # default (20 VUs, 60 s):
 *   k6 run scenarios/concurrent-deploy.js
 *
 *   # high-concurrency soak:
 *   k6 run --env CONCURRENT_VUS=50 --env DEPLOY_DURATION=120 scenarios/concurrent-deploy.js
 *
 *   # against a different stack:
 *   k6 run --env BASE_URL=http://staging.example.com scenarios/concurrent-deploy.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';
import { config } from '../config/test-config.js';
import {
  buildDeployPayload,
  selectDeployVariant,
  buildDeploySummary,
  formatDeploySummary,
} from '../lib/concurrent-deploy-helpers.js';

// ── Custom metrics ─────────────────────────────────────────────────────────────

const deployErrorRate = new Rate('deploy_errors');
const deployDuration = new Trend('deploy_duration');
const deployCounter = new Counter('deploy_total');
const activeDeployments = new Gauge('active_deployments');

// ── Options ────────────────────────────────────────────────────────────────────

const CONCURRENT_VUS = parseInt(__ENV.CONCURRENT_VUS || '20');
const DEPLOY_DURATION = parseInt(__ENV.DEPLOY_DURATION || '60');
const RAMP_DURATION = parseInt(__ENV.DEPLOY_RAMP_DURATION || '15');

export const options = {
  stages: [
    { duration: `${RAMP_DURATION}s`, target: CONCURRENT_VUS },
    { duration: `${DEPLOY_DURATION}s`, target: CONCURRENT_VUS },
    { duration: `${RAMP_DURATION}s`, target: 0 },
  ],
  thresholds: {
    deploy_errors: ['rate<0.05'],
    http_req_failed: ['rate<0.05'],
    deploy_duration: ['p(95)<3000', 'p(99)<6000'],
    deploy_total: [`count>=${CONCURRENT_VUS * 2}`],
  },
  tags: { test_type: 'concurrent_deploy' },
};

// ── VU loop ────────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || config.baseUrl;

export default function () {
  activeDeployments.add(1);

  const variant = selectDeployVariant(Math.random());

  group('token_deployment', () => {
    const payload = buildDeployPayload(variant);

    const res = http.post(
      `${BASE_URL}/api/tokens/deploy`,
      JSON.stringify(payload),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { name: 'ConcurrentDeploy', variant },
        timeout: '15s',
      }
    );

    const ok = check(res, {
      'deploy status 2xx':             (r) => r.status >= 200 && r.status < 300,
      'deploy response time < 3000ms': (r) => r.timings.duration < 3000,
      'deploy response has body':      (r) => r.body && r.body.length > 0,
    });

    deployErrorRate.add(!ok);
    deployDuration.add(res.timings.duration);
    deployCounter.add(1);
  });

  activeDeployments.add(-1);
  sleep(Math.random() * 0.5 + 0.1);
}

// ── Summary ────────────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const summary = buildDeploySummary(data, CONCURRENT_VUS, DEPLOY_DURATION);

  return {
    'results/concurrent-deploy-summary.json': JSON.stringify(summary, null, 2),
    stdout: formatDeploySummary(summary),
  };
}
