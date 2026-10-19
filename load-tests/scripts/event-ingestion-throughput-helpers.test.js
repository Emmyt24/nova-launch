import { describe, it, expect } from 'vitest';
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

// ── defaults ──────────────────────────────────────────────────────────────

describe('defaults', () => {
  it('targets 200 events/s in batches of 10 with a 500 ms p95 budget', () => {
    expect(DEFAULT_TARGET_EPS).toBe(200);
    expect(DEFAULT_BATCH_SIZE).toBe(10);
    expect(DEFAULT_P95_THRESHOLD_MS).toBe(500);
  });
});

// ── parsePositiveInt ──────────────────────────────────────────────────────

describe('parsePositiveInt', () => {
  it('parses positive integers', () => {
    expect(parsePositiveInt('250', 1)).toBe(250);
  });

  it('falls back for missing, non-numeric, zero and negative input', () => {
    expect(parsePositiveInt(undefined, 7)).toBe(7);
    expect(parsePositiveInt('abc', 7)).toBe(7);
    expect(parsePositiveInt('0', 7)).toBe(7);
    expect(parsePositiveInt('-5', 7)).toBe(7);
  });
});

// ── computeRequestRate ────────────────────────────────────────────────────

describe('computeRequestRate', () => {
  it('divides the event rate by the batch size', () => {
    expect(computeRequestRate(200, 10)).toBe(20);
  });

  it('rounds up so the target is never undershot', () => {
    expect(computeRequestRate(205, 10)).toBe(21);
  });

  it('rejects non-positive input', () => {
    expect(() => computeRequestRate(0, 10)).toThrow();
    expect(() => computeRequestRate(100, 0)).toThrow();
  });
});

// ── buildArrivalStages ────────────────────────────────────────────────────

describe('buildArrivalStages', () => {
  it('ramps up, holds the target rate, then ramps down', () => {
    expect(buildArrivalStages(20, 15, 60)).toEqual([
      { duration: '15s', target: 20 },
      { duration: '60s', target: 20 },
      { duration: '5s', target: 0 },
    ]);
  });
});

// ── estimatePreAllocatedVus ───────────────────────────────────────────────

describe('estimatePreAllocatedVus', () => {
  it('allocates twice the expected in-flight requests', () => {
    // 20 req/s × 0.5 s = 10 in flight → 20 VUs
    expect(estimatePreAllocatedVus(20, 500)).toBe(20);
  });

  it('never allocates fewer than the minimum', () => {
    expect(estimatePreAllocatedVus(1, 10)).toBe(5);
    expect(estimatePreAllocatedVus(1, 10, 3)).toBe(3);
  });
});

// ── countProcessedEvents ──────────────────────────────────────────────────

describe('countProcessedEvents', () => {
  it('counts successful and failed results', () => {
    const body = {
      data: { results: [{ success: true }, { success: false }, { success: true }] },
    };
    expect(countProcessedEvents(body)).toEqual({ processed: 2, failed: 1 });
  });

  it('treats non-true success values as failures', () => {
    const body = { data: { results: [{ success: 'yes' }, null, {}] } };
    expect(countProcessedEvents(body)).toEqual({ processed: 0, failed: 3 });
  });

  it('returns zeros for malformed bodies', () => {
    expect(countProcessedEvents(null)).toEqual({ processed: 0, failed: 0 });
    expect(countProcessedEvents({ data: {} })).toEqual({ processed: 0, failed: 0 });
    expect(countProcessedEvents({ data: { results: 'x' } })).toEqual({ processed: 0, failed: 0 });
  });
});

// ── buildEventBatch ───────────────────────────────────────────────────────

describe('buildEventBatch', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('produces exactly batchSize events', () => {
    expect(buildEventBatch(1, 10, now)).toHaveLength(10);
    expect(buildEventBatch(1, 1, now)).toHaveLength(1);
  });

  it('starts with a proposal_created followed by vote_cast events on it', () => {
    const [created, ...votes] = buildEventBatch(42, 4, now);
    expect(created.type).toBe('proposal_created');
    expect(created.proposalId).toBe(42);
    expect(created.startTime).toBe(now.toISOString());
    expect(new Date(created.endTime).getTime()).toBeGreaterThan(now.getTime());
    for (const vote of votes) {
      expect(vote.type).toBe('vote_cast');
      expect(vote.proposalId).toBe(42);
    }
  });

  it('uses unique transaction hashes and voters', () => {
    const batch = buildEventBatch(7, 10, now);
    expect(new Set(batch.map((e) => e.txHash)).size).toBe(10);
    const voters = batch.filter((e) => e.type === 'vote_cast').map((e) => e.voter);
    expect(new Set(voters).size).toBe(voters.length);
  });

  it('defaults the timestamp to now', () => {
    const before = Date.now();
    const [created] = buildEventBatch(1, 1);
    expect(new Date(created.timestamp).getTime()).toBeGreaterThanOrEqual(before);
  });
});

// ── buildThroughputReport ─────────────────────────────────────────────────

const healthyRun = {
  targetEps: 200,
  steadySec: 60,
  eventsSent: 15_000,
  eventsProcessed: 15_000,
  eventsFailed: 0,
  processingP95Ms: 180,
  p95ThresholdMs: 500,
  droppedIterations: 0,
  batchSize: 10,
  testDurationSec: 80,
};

describe('buildThroughputReport', () => {
  it('passes a run that sustains the target within the latency budget', () => {
    const r = buildThroughputReport(healthyRun);
    expect(r.passed).toBe(true);
    expect(r.latencyOk).toBe(true);
    expect(r.throughputOk).toBe(true);
    expect(r.successOk).toBe(true);
    expect(r.successRate).toBe(1);
    expect(r.throughputRatio).toBe(1);
    expect(r.achievedEps).toBeCloseTo(187.5);
  });

  it('fails when p95 exceeds the budget', () => {
    const r = buildThroughputReport({ ...healthyRun, processingP95Ms: 501 });
    expect(r.passed).toBe(false);
    expect(r.latencyOk).toBe(false);
  });

  it('fails when dropped batches show the target was not sustained', () => {
    // 1 000 dropped batches × 10 events = 10 000 demanded but never sent.
    const r = buildThroughputReport({ ...healthyRun, droppedIterations: 1_000 });
    expect(r.throughputRatio).toBeCloseTo(15_000 / 25_000);
    expect(r.throughputOk).toBe(false);
    expect(r.passed).toBe(false);
  });

  it('fails when more than 1 % of sent events were not processed', () => {
    const r = buildThroughputReport({
      ...healthyRun,
      eventsProcessed: 14_700,
      eventsFailed: 300,
    });
    expect(r.successOk).toBe(false);
    expect(r.passed).toBe(false);
  });

  it('honours a custom minimum throughput ratio', () => {
    const r = buildThroughputReport({
      ...healthyRun,
      droppedIterations: 1_000,
      minThroughputRatio: 0.5,
    });
    expect(r.throughputOk).toBe(true);
  });

  it('handles an empty run without dividing by zero', () => {
    const r = buildThroughputReport({
      ...healthyRun,
      eventsSent: 0,
      eventsProcessed: 0,
      testDurationSec: 0,
    });
    expect(r.achievedEps).toBe(0);
    expect(r.successRate).toBe(0);
    expect(r.throughputRatio).toBe(0);
    expect(r.passed).toBe(false);
  });
});

// ── formatThroughputSummary ───────────────────────────────────────────────

describe('formatThroughputSummary', () => {
  const extra = { timestamp: '2026-01-01T00:00:00.000Z', batchSize: 10, p50: 90, p99: 300, max: 420 };

  it('reports PASSED with the p95 and its budget', () => {
    const text = formatThroughputSummary(buildThroughputReport(healthyRun), extra);
    expect(text).toContain('Event Ingestion Throughput — PASSED');
    expect(text).toContain('200 events/s (10 per batch)');
    expect(text).toContain('180.0 ms (budget 500 ms)');
    expect(text).not.toContain('←');
    expect(text).not.toContain('WARNING');
  });

  it('flags every failed criterion', () => {
    const report = buildThroughputReport({
      ...healthyRun,
      processingP95Ms: 900,
      droppedIterations: 1_000,
      eventsProcessed: 10_000,
      eventsFailed: 5_000,
    });
    const text = formatThroughputSummary(report, extra);
    expect(text).toContain('FAILED');
    expect(text).toContain('← over budget');
    expect(text).toContain('← below target');
    expect(text).toContain('← below 99 %');
  });

  it('warns when the rate limiter capped the run', () => {
    const text = formatThroughputSummary(buildThroughputReport(healthyRun), {
      ...extra,
      rateLimited: 12,
    });
    expect(text).toContain('WARNING: 12 batches were rate limited (HTTP 429)');
  });

  it('renders missing latency percentiles as zero', () => {
    const text = formatThroughputSummary(buildThroughputReport(healthyRun), {
      timestamp: 't',
      batchSize: 10,
    });
    expect(text).toContain('p50              : 0.0 ms');
  });
});
