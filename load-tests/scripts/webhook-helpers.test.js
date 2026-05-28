import { describe, it, expect } from 'vitest';
import {
  computeThroughput,
  computeErrorRate,
  passesThresholds,
  buildThroughputReport,
  formatThroughputSummary,
} from '../lib/webhook-helpers.js';

// ── computeThroughput ─────────────────────────────────────────────────────

describe('computeThroughput', () => {
  it('returns deliveries per second correctly', () => {
    expect(computeThroughput(300, 60)).toBeCloseTo(5);
  });

  it('returns 0 for zero duration', () => {
    expect(computeThroughput(100, 0)).toBe(0);
  });

  it('returns 0 for negative duration', () => {
    expect(computeThroughput(100, -5)).toBe(0);
  });

  it('returns 0 for zero deliveries', () => {
    expect(computeThroughput(0, 60)).toBe(0);
  });

  it('handles fractional seconds', () => {
    expect(computeThroughput(10, 0.5)).toBeCloseTo(20);
  });
});

// ── computeErrorRate ──────────────────────────────────────────────────────

describe('computeErrorRate', () => {
  it('returns the fraction of errors to total', () => {
    expect(computeErrorRate(10, 100)).toBeCloseTo(0.1);
  });

  it('returns 0 for zero errors', () => {
    expect(computeErrorRate(0, 100)).toBe(0);
  });

  it('returns 0 for zero total attempts', () => {
    expect(computeErrorRate(0, 0)).toBe(0);
  });

  it('returns 1.0 when all attempts fail', () => {
    expect(computeErrorRate(50, 50)).toBe(1);
  });
});

// ── passesThresholds ──────────────────────────────────────────────────────

describe('passesThresholds', () => {
  it('passes when throughput meets minimum and error rate is below maximum', () => {
    expect(passesThresholds(60, 0.005, 50, 0.01)).toBe(true);
  });

  it('passes when metrics exactly equal thresholds', () => {
    expect(passesThresholds(50, 0.01, 50, 0.01)).toBe(true);
  });

  it('fails when throughput is below minimum', () => {
    expect(passesThresholds(49, 0.005, 50, 0.01)).toBe(false);
  });

  it('fails when error rate exceeds maximum', () => {
    expect(passesThresholds(60, 0.02, 50, 0.01)).toBe(false);
  });

  it('fails when both constraints are violated', () => {
    expect(passesThresholds(10, 0.5, 50, 0.01)).toBe(false);
  });
});

// ── buildThroughputReport ─────────────────────────────────────────────────

describe('buildThroughputReport', () => {
  const thresholds = { minThroughput: 50, maxErrorRate: 0.01 };

  it('marks report passed when thresholds are met', () => {
    const report = buildThroughputReport(3600, 10, 60, thresholds);
    expect(report.passed).toBe(true);
  });

  it('marks report failed when throughput is too low', () => {
    const report = buildThroughputReport(100, 0, 60, thresholds);
    expect(report.passed).toBe(false);
  });

  it('marks report failed when error rate is too high', () => {
    const report = buildThroughputReport(3000, 100, 60, thresholds);
    expect(report.passed).toBe(false);
  });

  it('computes total as delivered + errors', () => {
    const report = buildThroughputReport(500, 10, 60, thresholds);
    expect(report.total).toBe(510);
  });

  it('computes throughput correctly', () => {
    const report = buildThroughputReport(3000, 0, 60, thresholds);
    expect(report.throughput).toBeCloseTo(50);
  });

  it('computes error rate correctly', () => {
    const report = buildThroughputReport(990, 10, 60, thresholds);
    expect(report.errorRate).toBeCloseTo(0.01);
  });

  it('stores durationSec and thresholds', () => {
    const report = buildThroughputReport(3000, 0, 60, thresholds);
    expect(report.durationSec).toBe(60);
    expect(report.thresholds).toBe(thresholds);
  });
});

// ── formatThroughputSummary ───────────────────────────────────────────────

describe('formatThroughputSummary', () => {
  const thresholds = { minThroughput: 50, maxErrorRate: 0.01 };
  const passingReport = buildThroughputReport(3600, 10, 60, thresholds);
  const ts = '2026-01-01T00:00:00.000Z';

  it('contains PASSED for a passing report', () => {
    expect(formatThroughputSummary(passingReport, ts)).toContain('PASSED');
  });

  it('contains FAILED for a failing report', () => {
    const failing = buildThroughputReport(100, 10, 60, thresholds);
    expect(formatThroughputSummary(failing, ts)).toContain('FAILED');
  });

  it('includes the throughput value', () => {
    expect(formatThroughputSummary(passingReport, ts)).toContain('60.00');
  });

  it('includes the minimum throughput threshold', () => {
    expect(formatThroughputSummary(passingReport, ts)).toContain('50');
  });

  it('uses the provided timestamp', () => {
    expect(formatThroughputSummary(passingReport, ts)).toContain(ts);
  });

  it('includes delivered and error counts', () => {
    const text = formatThroughputSummary(passingReport, ts);
    expect(text).toContain('3600');
    expect(text).toContain('10');
  });
});
