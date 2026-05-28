import { describe, it, expect } from 'vitest';
import {
  computeLagMs,
  isLagWithinThreshold,
  buildLagReport,
  formatLagSummary,
} from '../lib/event-listener-helpers.js';

// ── computeLagMs ──────────────────────────────────────────────────────────

describe('computeLagMs', () => {
  it('returns the difference between ack and dispatch timestamps', () => {
    expect(computeLagMs(1000, 1300)).toBe(300);
  });

  it('returns 0 when ack equals dispatch (no lag)', () => {
    expect(computeLagMs(1000, 1000)).toBe(0);
  });

  it('returns 0 (floor) when ack is before dispatch (clock skew)', () => {
    expect(computeLagMs(1000, 900)).toBe(0);
  });

  it('handles large timestamps correctly', () => {
    const now = Date.now();
    expect(computeLagMs(now, now + 250)).toBe(250);
  });
});

// ── isLagWithinThreshold ──────────────────────────────────────────────────

describe('isLagWithinThreshold', () => {
  it('returns true when lag equals threshold exactly', () => {
    expect(isLagWithinThreshold(500, 500)).toBe(true);
  });

  it('returns true when lag is below threshold', () => {
    expect(isLagWithinThreshold(100, 500)).toBe(true);
  });

  it('returns false when lag exceeds threshold', () => {
    expect(isLagWithinThreshold(501, 500)).toBe(false);
  });

  it('returns false for zero threshold and any positive lag', () => {
    expect(isLagWithinThreshold(1, 0)).toBe(false);
  });

  it('returns true for zero lag and zero threshold', () => {
    expect(isLagWithinThreshold(0, 0)).toBe(true);
  });
});

// ── buildLagReport ────────────────────────────────────────────────────────

describe('buildLagReport', () => {
  it('returns a passing report when all samples are within threshold', () => {
    const report = buildLagReport([100, 200, 300, 400, 499], 500);
    expect(report.passed).toBe(true);
    expect(report.violations).toBe(0);
  });

  it('returns a failing report when any sample exceeds threshold', () => {
    const report = buildLagReport([100, 200, 600], 500);
    expect(report.passed).toBe(false);
    expect(report.violations).toBe(1);
  });

  it('counts multiple violations correctly', () => {
    const report = buildLagReport([600, 700, 800, 100], 500);
    expect(report.violations).toBe(3);
  });

  it('computes maxLag correctly', () => {
    const report = buildLagReport([100, 250, 400], 500);
    expect(report.maxLag).toBe(400);
  });

  it('computes avgLag correctly', () => {
    const report = buildLagReport([100, 300], 500);
    expect(report.avgLag).toBe(200);
  });

  it('reports total equal to sample count', () => {
    const report = buildLagReport([1, 2, 3, 4, 5], 500);
    expect(report.total).toBe(5);
  });

  it('returns a passing empty report for no samples', () => {
    const report = buildLagReport([], 500);
    expect(report.passed).toBe(true);
    expect(report.total).toBe(0);
    expect(report.maxLag).toBe(0);
  });

  it('stores thresholdMs', () => {
    const report = buildLagReport([100], 750);
    expect(report.thresholdMs).toBe(750);
  });
});

// ── formatLagSummary ──────────────────────────────────────────────────────

describe('formatLagSummary', () => {
  const passingReport = buildLagReport([100, 200, 300], 500);
  const ts = '2026-01-01T00:00:00.000Z';

  it('contains PASSED for a passing report', () => {
    expect(formatLagSummary(passingReport, ts)).toContain('PASSED');
  });

  it('contains FAILED for a failing report', () => {
    const failing = buildLagReport([600], 500);
    expect(formatLagSummary(failing, ts)).toContain('FAILED');
  });

  it('includes the lag threshold', () => {
    expect(formatLagSummary(passingReport, ts)).toContain('500');
  });

  it('includes violation count', () => {
    expect(formatLagSummary(passingReport, ts)).toContain('0');
  });

  it('uses the provided timestamp', () => {
    expect(formatLagSummary(passingReport, ts)).toContain(ts);
  });

  it('includes total event count', () => {
    expect(formatLagSummary(passingReport, ts)).toContain('3');
  });
});
