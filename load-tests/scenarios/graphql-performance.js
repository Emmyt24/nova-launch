/**
 * GraphQL Query Performance Benchmark
 * load-tests/scenarios/graphql-performance.js
 *
 * Issues a representative mix of GraphQL queries concurrently and asserts
 * that p50/p95/p99 latency thresholds hold under load.
 *
 * Query mix:
 *   40% — tokens list          (paginated)
 *   25% — token detail         (single entity + nested burns)
 *   20% — streams list         (filtered by status)
 *   15% — proposals list       (governance aggregation)
 *
 * Thresholds:
 *   p50 < 200 ms · p95 < 500 ms · p99 < 1 000 ms · error rate < 1 %
 *
 * Environment variables:
 *   BASE_URL          API base URL (default: http://localhost:3001)
 *   GQL_VUS           Virtual users (default: 20)
 *   GQL_DURATION      Steady-state seconds (default: 60)
 */

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { config } from '../config/test-config.js';

// ── Custom metrics ────────────────────────────────────────────────────────

const gqlDuration    = new Trend('gql_duration_ms');
const gqlErrorRate   = new Rate('gql_error_rate');
const gqlRequests    = new Counter('gql_total_requests');

// ── Parameters ────────────────────────────────────────────────────────────

const VUS      = parseInt(__ENV.GQL_VUS      || '20');
const DURATION = parseInt(__ENV.GQL_DURATION || '60');
const BASE_URL = __ENV.BASE_URL || config.baseUrl;
const GQL_URL  = `${BASE_URL}/api/graphql`;

// ── Options ───────────────────────────────────────────────────────────────

export const options = {
  stages: [
    { duration: '10s',       target: VUS },
    { duration: `${DURATION}s`, target: VUS },
    { duration: '10s',       target: 0 },
  ],
  thresholds: {
    gql_duration_ms: ['p(50)<200', 'p(95)<500', 'p(99)<1000'],
    gql_error_rate:  ['rate<0.01'],
    checks:          ['rate>0.99'],
  },
  tags: { test_type: 'graphql_performance' },
};

// ── Query definitions ─────────────────────────────────────────────────────

const QUERIES = {
  tokens_list: /* GraphQL */ `
    query TokensList($limit: Int, $offset: Int) {
      tokens(limit: $limit, offset: $offset) {
        id address name symbol totalSupply burnCount
      }
    }
  `,
  token_detail: /* GraphQL */ `
    query TokenDetail($address: String!) {
      token(address: $address) {
        id address name symbol decimals totalSupply totalBurned burnCount
        burnRecords(limit: 5) { id amount txHash timestamp }
      }
    }
  `,
  streams_list: /* GraphQL */ `
    query StreamsList($status: StreamStatus, $limit: Int) {
      streams(status: $status, limit: $limit) {
        id streamId creator recipient amount status
      }
    }
  `,
  proposals_list: /* GraphQL */ `
    query ProposalsList($limit: Int) {
      proposals(limit: $limit) {
        id proposalId title status votesFor votesAgainst
      }
    }
  `,
};

const SAMPLE_ADDRESSES = [
  'GTOKEN_SAMPLE_A',
  'GTOKEN_SAMPLE_B',
  'GTOKEN_SAMPLE_C',
];

const STREAM_STATUSES = ['CREATED', 'CLAIMED', 'CANCELLED'];

function buildBody(queryKey) {
  switch (queryKey) {
    case 'tokens_list':
      return JSON.stringify({
        query: QUERIES.tokens_list,
        variables: { limit: 20, offset: Math.floor(Math.random() * 5) * 20 },
      });
    case 'token_detail':
      return JSON.stringify({
        query: QUERIES.token_detail,
        variables: { address: SAMPLE_ADDRESSES[Math.floor(Math.random() * SAMPLE_ADDRESSES.length)] },
      });
    case 'streams_list':
      return JSON.stringify({
        query: QUERIES.streams_list,
        variables: {
          status: STREAM_STATUSES[Math.floor(Math.random() * STREAM_STATUSES.length)],
          limit: 20,
        },
      });
    case 'proposals_list':
    default:
      return JSON.stringify({
        query: QUERIES.proposals_list,
        variables: { limit: 10 },
      });
  }
}

// ── VU loop ───────────────────────────────────────────────────────────────

export default function () {
  const roll = Math.random();
  const queryKey =
    roll < 0.40 ? 'tokens_list'
    : roll < 0.65 ? 'token_detail'
    : roll < 0.85 ? 'streams_list'
    : 'proposals_list';

  const res = http.post(GQL_URL, buildBody(queryKey), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: `GQL_${queryKey}` },
  });

  gqlDuration.add(res.timings.duration);
  gqlRequests.add(1);

  const ok =
    res.status === 200 &&
    !String(res.body).includes('"errors"');

  gqlErrorRate.add(!ok);

  check(res, {
    'graphql status 200':     (r) => r.status === 200,
    'no graphql errors':      (r) => !String(r.body).includes('"errors"'),
    'response time < 1000ms': (r) => r.timings.duration < 1000,
  });
}

// ── Summary ───────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const p50  = data.metrics.gql_duration_ms?.values?.['p(50)'] ?? 0;
  const p95  = data.metrics.gql_duration_ms?.values?.['p(95)'] ?? 0;
  const p99  = data.metrics.gql_duration_ms?.values?.['p(99)'] ?? 0;
  const errR = data.metrics.gql_error_rate?.values?.rate        ?? 0;
  const total = data.metrics.gql_total_requests?.values?.count  ?? 0;

  const passed = p50 < 200 && p95 < 500 && p99 < 1000 && errR < 0.01;
  const status  = passed ? 'PASSED' : 'FAILED';

  const summary = {
    passed,
    timestamp: new Date().toISOString(),
    vus: VUS,
    durationSec: DURATION,
    queryMix: { tokens_list: '40%', token_detail: '25%', streams_list: '20%', proposals_list: '15%' },
    thresholds: { p50: 200, p95: 500, p99: 1000, errorRate: 0.01 },
    metrics: { p50, p95, p99, errorRate: errR, totalRequests: total },
  };

  const lines = [
    '',
    `=== GraphQL Performance Benchmark — ${status} ===`,
    `  Timestamp     : ${summary.timestamp}`,
    `  VUs           : ${VUS}`,
    `  Duration      : ${DURATION}s`,
    `  Total queries : ${total}`,
    '',
    '  Query mix:',
    '    40% tokens_list · 25% token_detail · 20% streams_list · 15% proposals_list',
    '',
    '  Latency (ms):',
    `    p50 : ${p50.toFixed(1)}  (threshold: < 200)`,
    `    p95 : ${p95.toFixed(1)}  (threshold: < 500)`,
    `    p99 : ${p99.toFixed(1)}  (threshold: < 1 000)`,
    '',
    `  Error rate    : ${(errR * 100).toFixed(2)} %`,
    '',
  ].join('\n');

  return {
    'load-tests/results/graphql-performance-summary.json': JSON.stringify(summary, null, 2),
    stdout: lines,
  };
}
