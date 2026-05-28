import { describe, it, expect } from 'vitest';
import {
  classifyResponse,
  withinTolerance,
  buildRateLimitReport,
  formatRateLimitSummary,
} from '../lib/ratelimiter-helpers.js';

// ── classifyResponse ──────────────────────────────────────────────────────

describe('classifyResponse', () => {
  it('classifies 200 as allowed', () => {
    expect(classifyResponse(200)).toBe('allowed');
  });

  it('classifies 201 as allowed', () => {
    expect(classifyResponse(201)).toBe('allowed');
  });

  it('classifies 299 as allowed', () => {
    expect(classifyResponse(299)).toBe('allowed');
  });

  it('classifies 429 as denied', () => {
    expect(classifyResponse(429)).toBe('denied');
  });

  it('classifies 400 as error', () => {
    expect(classifyResponse(400)).toBe('error');
  });

  it('classifies 500 as error', () => {
    expect(classifyResponse(500)).toBe('error');
  });

  it('classifies 503 as error', () => {
    expect(classifyResponse(503)).toBe('error');
  });
});

// ── withinTolerance ───────────────────────────────────────────────────────

describe('withinTolerance', () => {
  it('returns true when actual equals expected exactly', () => {
    expect(withinTolerance(100, 100, 0.05)).toBe(true);
  });

  it('returns true when actual is within tolerance below', () => {
    expect(withinTolerance(95, 100, 0.05)).toBe(true);
  });

  it('returns true when actual is within tolerance above', () => {
    expect(withinTolerance(105, 100, 0.05)).toBe(true);
  });

  it('returns false when actual is just outside tolerance below', () => {
    expect(withinTolerance(94, 100, 0.05)).toBe(false);
  });

  it('returns false when actual is just outside tolerance above', () => {
    expect(withinTolerance(106, 100, 0.05)).toBe(false);
  });

  it('returns true for 0 actual and 0 expected', () => {
    expect(withinTolerance(0, 0, 0.05)).toBe(true);
  });

  it('returns false for non-zero actual when expected is 0', () => {
    expect(withinTolerance(1, 0, 0.05)).toBe(false);
  });

  it('handles a 10% tolerance window correctly', () => {
    expect(withinTolerance(90, 100, 0.10)).toBe(true);
    expect(withinTolerance(110, 100, 0.10)).toBe(true);
    expect(withinTolerance(89, 100, 0.10)).toBe(false);
    expect(withinTolerance(111, 100, 0.10)).toBe(false);
  });
});

// ── buildRateLimitReport ──────────────────────────────────────────────────

describe('buildRateLimitReport', () => {
  it('marks report passed when allowed is within tolerance and no errors', () => {
    const report = buildRateLimitReport(98, 500, 0, 100, 0.05);
    expect(report.passed).toBe(true);
    expect(report.budgetWithinTolerance).toBe(true);
  });

  it('marks report failed when allowed is outside tolerance', () => {
    const report = buildRateLimitReport(50, 500, 0, 100, 0.05);
    expect(report.passed).toBe(false);
    expect(report.budgetWithinTolerance).toBe(false);
  });

  it('marks report failed when there are unexpected errors', () => {
    const report = buildRateLimitReport(100, 400, 10, 100, 0.05);
    expect(report.passed).toBe(false);
  });

  it('exposes all raw counts', () => {
    const report = buildRateLimitReport(97, 503, 0, 100, 0.05);
    expect(report.allowed).toBe(97);
    expect(report.denied).toBe(503);
    expect(report.errors).toBe(0);
  });

  it('stores budget and toleranceFraction', () => {
    const report = buildRateLimitReport(100, 500, 0, 100, 0.05);
    expect(report.budget).toBe(100);
    expect(report.toleranceFraction).toBe(0.05);
  });

  it('marks deniedCorrectStatus true when over-budget requests all got 429', () => {
    const report = buildRateLimitReport(100, 900, 0, 100, 0.05);
    expect(report.deniedCorrectStatus).toBe(true);
  });

  it('handles zero-request scenario', () => {
    const report = buildRateLimitReport(0, 0, 0, 100, 0.05);
    expect(report.budgetWithinTolerance).toBe(false);
  });
});

// ── formatRateLimitSummary ────────────────────────────────────────────────

describe('formatRateLimitSummary', () => {
  const passingReport = buildRateLimitReport(100, 900, 0, 100, 0.05);

  it('contains PASSED for a passing report', () => {
    expect(formatRateLimitSummary(passingReport, '2026-01-01T00:00:00.000Z')).toContain('PASSED');
  });

  it('contains FAILED for a failing report', () => {
    const failingReport = buildRateLimitReport(50, 950, 0, 100, 0.05);
    expect(formatRateLimitSummary(failingReport, '2026-01-01T00:00:00.000Z')).toContain('FAILED');
  });

  it('includes budget value', () => {
    expect(formatRateLimitSummary(passingReport, '2026-01-01T00:00:00.000Z')).toContain('100');
  });

  it('includes tolerance percentage', () => {
    expect(formatRateLimitSummary(passingReport, '2026-01-01T00:00:00.000Z')).toContain('5%');
  });

  it('includes allowed and denied counts', () => {
    const text = formatRateLimitSummary(passingReport, '2026-01-01T00:00:00.000Z');
    expect(text).toContain('100');
    expect(text).toContain('900');
  });

  it('uses provided timestamp', () => {
    const ts = '2026-05-27T10:00:00.000Z';
    expect(formatRateLimitSummary(passingReport, ts)).toContain(ts);
  });
});
