/**
 * Vesting progress utilities.
 *
 * Progress is computed from Stellar ledger numbers (not wall-clock time),
 * since vesting schedules in the streaming/vesting contract are defined
 * in terms of ledgers: `(currentLedger - startLedger) / (endLedger - startLedger)`.
 */

/**
 * Compute the vesting progress as a percentage in the range [0, 100].
 *
 * Rules:
 * - If `startLedger` or `endLedger` is missing (null/undefined/NaN), the
 *   schedule is considered fully vested and `100` is returned.
 * - If `endLedger <= startLedger`, the schedule is invalid/degenerate and
 *   `100` is returned (nothing left to vest).
 * - If `currentLedger` is before `startLedger`, `0` is returned.
 * - If `currentLedger` is at or after `endLedger`, `100` is returned.
 * - Otherwise, the linear percentage is returned, clamped to [0, 100].
 *
 * @param startLedger - The ledger at which vesting begins.
 * @param endLedger - The ledger at which vesting completes.
 * @param currentLedger - The current ledger number (e.g. from Horizon).
 * @returns A percentage between 0 and 100 (inclusive).
 */
export function computeVestingProgress(
  startLedger: number | null | undefined,
  endLedger: number | null | undefined,
  currentLedger: number | null | undefined,
): number {
  // Missing schedule bounds => treat as fully vested.
  if (
    startLedger === null ||
    startLedger === undefined ||
    endLedger === null ||
    endLedger === undefined ||
    Number.isNaN(startLedger) ||
    Number.isNaN(endLedger)
  ) {
    return 100;
  }

  // Degenerate or invalid schedule => nothing left to vest.
  if (endLedger <= startLedger) {
    return 100;
  }

  // Missing current ledger => cannot determine progress; treat as not started.
  if (
    currentLedger === null ||
    currentLedger === undefined ||
    Number.isNaN(currentLedger)
  ) {
    return 0;
  }

  // Before vesting starts.
  if (currentLedger <= startLedger) {
    return 0;
  }

  // At or after vesting ends.
  if (currentLedger >= endLedger) {
    return 100;
  }

  const elapsed = currentLedger - startLedger;
  const duration = endLedger - startLedger;
  const percentage = (elapsed / duration) * 100;

  // Clamp defensively to [0, 100].
  return Math.min(100, Math.max(0, percentage));
}

/**
 * Convenience helper: returns true when the vesting schedule has fully
 * matured at the given ledger.
 */
export function isFullyVested(
  startLedger: number | null | undefined,
  endLedger: number | null | undefined,
  currentLedger: number | null | undefined,
): boolean {
  return computeVestingProgress(startLedger, endLedger, currentLedger) >= 100;
}
```

```typescript
import { describe, it, expect } from 'vitest';
import { computeVestingProgress, isFullyVested } from './vestingProgress';

describe('computeVestingProgress', () => {
  const start = 1000;
  const end = 2000;

  it('returns 0 when currentLedger is before startLedger', () => {
    expect(computeVestingProgress(start, end, 500)).toBe(0);
    expect(computeVestingProgress(start, end, 999)).toBe(0);
  });

  it('returns 0 when currentLedger equals startLedger', () => {
    expect(computeVestingProgress(start, end, 1000)).toBe(0);
  });

  it('returns the correct percentage mid-vest', () => {
    expect(computeVestingProgress(start, end, 1500)).toBe(50);
    expect(computeVestingProgress(start, end, 1250)).toBe(25);
    expect(computeVestingProgress(start, end, 1750)).toBe(75);
  });

  it('returns 100 when currentLedger equals endLedger', () => {
    expect(computeVestingProgress(start, end, 2000)).toBe(100);
  });

  it('returns 100 when currentLedger is after endLedger', () => {
    expect(computeVestingProgress(start, end, 2500)).toBe(100);
    expect(computeVestingProgress(start, end, 999999)).toBe(100);
  });

  it('returns 100 when startLedger is missing', () => {
    expect(computeVestingProgress(null, end, 1500)).toBe(100);
    expect(computeVestingProgress(undefined, end, 1500)).toBe(100);
    expect(computeVestingProgress(NaN, end, 1500)).toBe(100);
  });

  it('returns 100 when endLedger is missing', () => {
    expect(computeVestingProgress(start, null, 1500)).toBe(100);
    expect(computeVestingProgress(start, undefined, 1500)).toBe(100);
    expect(computeVestingProgress(start, NaN, 1500)).toBe(100);
  });

  it('returns 100 for an invalid schedule where endLedger <= startLedger', () => {
    expect(computeVestingProgress(2000, 2000, 1500)).toBe(100);
    expect(computeVestingProgress(2000, 1000, 1500)).toBe(100);
  });

  it('returns 0 when currentLedger is missing', () => {
    expect(computeVestingProgress(start, end, null)).toBe(0);
    expect(computeVestingProgress(start, end, undefined)).toBe(0);
    expect(computeVestingProgress(start, end, NaN)).toBe(0);
  });

  it('clamps the result to the [0, 100] range', () => {
    const before = computeVestingProgress(start, end, -5000);
    const after = computeVestingProgress(start, end, 50000);
    expect(before).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThanOrEqual(100);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThanOrEqual(100);
  });

  it('handles fractional progress correctly', () => {
    const progress = computeVestingProgress(0, 3, 1);
    expect(progress).toBeCloseTo(33.333, 2);
  });
});

describe('isFullyVested', () => {
  it('returns false before the schedule matures', () => {
    expect(isFullyVested(1000, 2000, 1500)).toBe(false);
  });

  it('returns true at or after the schedule matures', () => {
    expect(isFullyVested(1000, 2000, 2000)).toBe(true);
    expect(isFullyVested(1000, 2000, 2500)).toBe(true);
  });

  it('returns true for an invalid schedule', () => {
    expect(isFullyVested(2000, 1000, 1500)).toBe(true);
    expect(isFullyVested(null, 2000, 1500)).toBe(true);
  });
});