import { describe, it, expect } from 'vitest';
import {
  selectGraphQLQuery,
  computePercentile,
  meetsLatencyThresholds,
  buildLatencyReport,
  formatLatencySummary,
} from '../lib/graphql-helpers.js';

// ── selectGraphQLQuery ────────────────────────────────────────────────────

describe('selectGraphQLQuery', () => {
  it('returns tokens_list for roll < 0.40', () => {
    expect(selectGraphQLQuery(0)).toBe('tokens_list');
    expect(selectGraphQLQuery(0.20)).toBe('tokens_list');
    expect(selectGraphQLQuery(0.399)).toBe('tokens_list');
  });

  it('returns token_detail for roll in [0.40, 0.65)', () => {
    expect(selectGraphQLQuery(0.40)).toBe('token_detail');
    expect(selectGraphQLQuery(0.52)).toBe('token_detail');
    expect(selectGraphQLQuery(0.649)).toBe('token_detail');
  });

  it('returns streams_list for roll in [0.65, 0.85)', () => {
    expect(selectGraphQLQuery(0.65)).toBe('streams_list');
    expect(selectGraphQLQuery(0.75)).toBe('streams_list');
    expect(selectGraphQLQuery(0.849)).toBe('streams_list');
  });

  it('returns proposals_list for roll in [0.85, 1.00)', () => {
    expect(selectGraphQLQuery(0.85)).toBe('proposals_list');
    expect(selectGraphQLQuery(0.92)).toBe('proposals_list');
    expect(selectGraphQLQuery(0.999)).toBe('proposals_list');
  });

  it('produces the correct distribution over 10 000 samples', () => {
    const counts = { tokens_list: 0, token_detail: 0, streams_list: 0, proposals_list: 0 };
    const N = 10_000;
    for (let i = 0; i < N; i++) counts[selectGraphQLQuery(Math.random())]++;
    expect(counts.tokens_list / N).toBeGreaterThan(0.38);
    expect(counts.tokens_list / N).toBeLessThan(0.42);
    expect(counts.token_detail / N).toBeGreaterThan(0.23);
    expect(counts.token_detail / N).toBeLessThan(0.27);
    expect(counts.streams_list / N).toBeGreaterThan(0.18);
    expect(counts.streams_list / N).toBeLessThan(0.22);
    expect(counts.proposals_list / N).toBeGreaterThan(0.13);
    expect(counts.proposals_list / N).toBeLessThan(0.17);
  });
});

// ── computePercentile ─────────────────────────────────────────────────────

describe('computePercentile', () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('returns the median for p50', () => {
    expect(computePercentile(sorted, 50)).toBe(50);
  });

  it('returns the last element for p100', () => {
    expect(computePercentile(sorted, 100)).toBe(100);
  });

  it('returns the first element for p1 on a small array', () => {
    expect(computePercentile([42], 95)).toBe(42);
  });

  it('returns 0 for an empty array', () => {
    expect(computePercentile([], 95)).toBe(0);
  });

  it('p99 on a 100-element array returns the 99th element', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(computePercentile(arr, 99)).toBe(99);
  });
});

// ── meetsLatencyThresholds ────────────────────────────────────────────────

describe('meetsLatencyThresholds', () => {
  const thresholds = { p50: 200, p95: 500, p99: 1000 };

  it('passes when all latencies are below thresholds', () => {
    expect(meetsLatencyThresholds({ p50: 100, p95: 300, p99: 800 }, thresholds)).toBe(true);
  });

  it('passes when latencies exactly equal thresholds', () => {
    expect(meetsLatencyThresholds({ p50: 200, p95: 500, p99: 1000 }, thresholds)).toBe(true);
  });

  it('fails when p50 exceeds its threshold', () => {
    expect(meetsLatencyThresholds({ p50: 201, p95: 300, p99: 800 }, thresholds)).toBe(false);
  });

  it('fails when p95 exceeds its threshold', () => {
    expect(meetsLatencyThresholds({ p50: 100, p95: 501, p99: 800 }, thresholds)).toBe(false);
  });

  it('fails when p99 exceeds its threshold', () => {
    expect(meetsLatencyThresholds({ p50: 100, p95: 300, p99: 1001 }, thresholds)).toBe(false);
  });
});

// ── buildLatencyReport ────────────────────────────────────────────────────

describe('buildLatencyReport', () => {
  const thresholds = { p50: 200, p95: 500, p99: 1000 };

  it('returns a passing report when all samples are within thresholds', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 50);
    const report = buildLatencyReport(samples, thresholds);
    expect(report.passed).toBe(true);
  });

  it('returns a failing report when samples breach a threshold', () => {
    const samples = Array.from({ length: 100 }, () => 600);
    const report = buildLatencyReport(samples, thresholds);
    expect(report.passed).toBe(false);
  });

  it('reports the correct total', () => {
    const report = buildLatencyReport([100, 150, 200], thresholds);
    expect(report.total).toBe(3);
  });

  it('handles an empty sample array', () => {
    const report = buildLatencyReport([], thresholds);
    expect(report.passed).toBe(true);
    expect(report.total).toBe(0);
  });

  it('stores the thresholds reference', () => {
    const report = buildLatencyReport([100], thresholds);
    expect(report.thresholds).toBe(thresholds);
  });
});

// ── formatLatencySummary ──────────────────────────────────────────────────

describe('formatLatencySummary', () => {
  const thresholds = { p50: 200, p95: 500, p99: 1000 };
  const passingReport = buildLatencyReport([100, 150, 200], thresholds);
  const ts = '2026-01-01T00:00:00.000Z';

  it('contains PASSED for a passing report', () => {
    expect(formatLatencySummary(passingReport, ts)).toContain('PASSED');
  });

  it('contains FAILED for a failing report', () => {
    const failing = buildLatencyReport([600, 700, 800], thresholds);
    expect(formatLatencySummary(failing, ts)).toContain('FAILED');
  });

  it('includes threshold values', () => {
    const text = formatLatencySummary(passingReport, ts);
    expect(text).toContain('200');
    expect(text).toContain('500');
    expect(text).toContain('1000');
  });

  it('uses the provided timestamp', () => {
    expect(formatLatencySummary(passingReport, ts)).toContain(ts);
  });

  it('includes the total query count', () => {
    expect(formatLatencySummary(passingReport, ts)).toContain('3');
  });
});
