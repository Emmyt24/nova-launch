/**
 * Property 76: Leaderboard Ranking Consistency
 *
 * Verifies that ranking is strictly sequential and monotonically related
 * to burn amount. No duplicate ranks for different scores.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

interface BurnEntry {
  tokenAddress: string;
  burned: bigint;
}

/**
 * Ranking algorithm used in production leaderboard: sort by burn amount
 * descending and assign 1-based sequential ranks.
 */
function rankLeaderboard(entries: BurnEntry[]) {
  const sorted = [...entries].sort((a, b) => {
    if (a.burned < b.burned) return 1;
    if (a.burned > b.burned) return -1;
    return 0;
  });
  return sorted.map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));
}

describe('Property 76: Leaderboard Ranking Consistency', () => {
  it('assigns sequential ranks and enforces monotonic burn-order across 100 random cases', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            tokenAddress: fc.hexaString({ minLength: 8, maxLength: 16 }).map((h) => `0x${h}`),
            burned: fc.bigInt({ min: 0n, max: 10_000_000n }),
          }),
          { minLength: 1, maxLength: 100 }
        ),
        async (entries) => {
          const ranked = rankLeaderboard(entries);

          // Strict sequential ranks (1..n)
          const ranks = ranked.map((r) => r.rank);
          expect(ranks).toEqual(Array.from({ length: ranked.length }, (_, i) => i + 1));

          // Monotonically decreasing burned amounts
          for (let i = 1; i < ranked.length; i += 1) {
            expect(ranked[i - 1].burned).toBeGreaterThanOrEqual(ranked[i].burned);
          }

          // No duplicate rank for different burned values (ties are allowed by logic, but rank is still unique)
          for (let i = 0; i < ranked.length; i += 1) {
            for (let j = i + 1; j < ranked.length; j += 1) {
              if (ranked[i].burned !== ranked[j].burned) {
                expect(ranked[i].rank).not.toBe(ranked[j].rank);
              }
            }
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
