/**
 * Leaderboard Cache Invalidation Logic
 *
 * Encapsulates the TTL-based cache invalidation rules for leaderboard
 * responses. Extracted from leaderboardService.ts so the logic can be
 * exercised in isolation by property tests without requiring a database
 * connection or Prisma mocks.
 *
 * Cache behaviour:
 *   - Entries are stored with a `timestamp` (ms since Unix epoch).
 *   - An entry is considered FRESH when:
 *       now - entry.timestamp < CACHE_TTL_MS
 *   - An entry is considered STALE (expired) when:
 *       now - entry.timestamp >= CACHE_TTL_MS
 *   - Stale entries are evicted on read and `null` is returned.
 *   - Fresh entries are returned as-is without a database round-trip.
 *
 * TTL:
 *   - Default: 5 minutes (300 000 ms), matching leaderboardService.ts.
 *   - Configurable via the `ttlMs` parameter for testing.
 *
 * Security considerations:
 *   - Stale data is never served; eviction is eager (on read).
 *   - Cache keys include type, period, page, and limit to prevent
 *     cross-query cache poisoning.
 *   - `now` is injected so tests remain deterministic without real-clock
 *     dependency.
 *
 * Edge cases:
 *   - `age === 0` (entry inserted at exactly `now`) is FRESH.
 *   - `age === ttlMs - 1` is FRESH (one ms before expiry).
 *   - `age === ttlMs` is STALE (exactly at TTL boundary).
 *   - `age > ttlMs` is STALE.
 *   - Negative age (clock skew / future timestamp) is treated as FRESH
 *     to avoid evicting entries that were written with a slightly ahead
 *     clock; callers should ensure monotonic timestamps in production.
 *
 * Follow-up work:
 *   - Add a maximum cache size (LRU eviction) to bound memory usage.
 *   - Expose cache hit/miss metrics for observability.
 *   - Consider per-period TTL tuning (e.g. shorter TTL for 24h period).
 */

export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface CacheEntry<T> {
  data: T;
  /** Unix epoch milliseconds when the entry was stored. */
  timestamp: number;
}

export interface CacheValidationResult {
  /** True when the entry exists and has not expired. */
  fresh: boolean;
  /** Age of the entry in milliseconds (now - timestamp). */
  ageMs: number;
  /** Human-readable reason for the result. */
  reason: string;
}

/**
 * Determine whether a cache entry is still fresh.
 *
 * @param entry    - The cache entry to evaluate (or null/undefined if absent).
 * @param now      - Current time in ms; defaults to `Date.now()`.
 * @param ttlMs    - TTL in ms; defaults to `CACHE_TTL_MS` (5 minutes).
 */
export function validateCacheEntry<T>(
  entry: CacheEntry<T> | null | undefined,
  now: number = Date.now(),
  ttlMs: number = CACHE_TTL_MS,
): CacheValidationResult {
  if (entry == null) {
    return { fresh: false, ageMs: -1, reason: 'entry absent' };
  }

  const ageMs = now - entry.timestamp;

  if (ageMs >= ttlMs) {
    return {
      fresh: false,
      ageMs,
      reason: `entry expired: age ${ageMs}ms >= ttl ${ttlMs}ms`,
    };
  }

  return {
    fresh: true,
    ageMs,
    reason: `entry fresh: age ${ageMs}ms < ttl ${ttlMs}ms`,
  };
}

/**
 * Build a canonical cache key for a leaderboard query.
 *
 * Mirrors the `getCacheKey` helper in leaderboardService.ts.
 */
export function buildCacheKey(
  type: string,
  period: string,
  page: number,
  limit: number,
): string {
  return `${type}:${period}:${page}:${limit}`;
}
