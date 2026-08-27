import { describe, it, expect } from 'vitest';
import { computeReconciliation, formatReconciliationSummary } from '../lib/webhook-burst-restart-helpers.js';

describe('computeReconciliation', () => {
  it('passes when all events are accounted for', () => {
    const r = computeReconciliation(100, 95, 5);
    expect(r.sent).toBe(100);
    expect(r.delivered).toBe(95);
    expect(r.deadLettered).toBe(5);
    expect(r.accounted).toBe(100);
    expect(r.lost).toBe(0);
    expect(r.passed).toBe(true);
  });

  it('fails when some events are silently lost', () => {
    const r = computeReconciliation(100, 80, 5);
    expect(r.accounted).toBe(85);
    expect(r.lost).toBe(15);
    expect(r.passed).toBe(false);
  });

  it('handles zero events', () => {
    const r = computeReconciliation(0, 0, 0);
    expect(r.accounted).toBe(0);
    expect(r.lost).toBe(0);
    expect(r.passed).toBe(true);
  });

  it('handles only dead-lettered events', () => {
    const r = computeReconciliation(50, 0, 50);
    expect(r.passed).toBe(true);
  });

  it('handles only delivered events', () => {
    const r = computeReconciliation(75, 75, 0);
    expect(r.passed).toBe(true);
  });
});

describe('formatReconciliationSummary', () => {
  it('includes PASSED for clean reconciliation', () => {
    const result = computeReconciliation(200, 198, 2);
    const summary = formatReconciliationSummary(result);
    expect(summary).toContain('PASSED');
    expect(summary).toContain('200');
  });

  it('includes FAILED when events are lost', () => {
    const result = computeReconciliation(200, 180, 5);
    const summary = formatReconciliationSummary(result);
    expect(summary).toContain('FAILED');
    expect(summary).toContain('15');
  });
});
