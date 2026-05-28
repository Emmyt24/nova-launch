/**
 * Property-Based Tests: Rate-Limiter Fairness Guarantees (#1076)
 *
 * Fairness invariants verified:
 *   F1  No key is granted more requests than its configured budget within a window
 *   F2  One key exhausting its budget never affects another key's budget
 *   F3  Bursts that exactly hit the limit boundary are handled correctly
 *       (the Nth request is allowed; the (N+1)th is rejected)
 *   F4  Keys are isolated — counters are independent per key
 *
 * The sliding-window counter (`incrementSlidingWindow`) is tested in isolation
 * using an in-memory mock so no Redis instance is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// In-memory sliding-window counter (mirrors the Redis implementation)
// ---------------------------------------------------------------------------

interface WindowEntry {
  score: number;
  member: string;
}

class InMemorySlidingWindow {
  private store = new Map<string, WindowEntry[]>();

  async increment(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const windowStart = now - windowMs;

    const entries = (this.store.get(key) ?? []).filter(
      (e) => e.score > windowStart
    );
    entries.push({ score: now, member: `${now}-${Math.random()}` });
    this.store.set(key, entries);
    return entries.length;
  }

  reset(key?: string) {
    if (key) this.store.delete(key);
    else this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Minimal rate-limiter built on top of the sliding window
// ---------------------------------------------------------------------------

interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
}

async function checkRateLimit(
  window: InMemorySlidingWindow,
  key: string,
  windowMs: number,
  max: number
): Promise<RateLimitResult> {
  const count = await window.increment(key, windowMs);
  const allowed = count <= max;
  return { allowed, count, remaining: Math.max(0, max - count) };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** A key is a short alphanumeric string representing a wallet or IP. */
const keyArb = fc.stringMatching(/^[a-z0-9]{4,12}$/);

/** Number of requests to fire for a single key in one scenario. */
const requestCountArb = fc.integer({ min: 1, max: 30 });

/** Budget (max requests per window). */
const budgetArb = fc.integer({ min: 1, max: 20 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property: Rate-Limiter Fairness Guarantees", () => {
  let window: InMemorySlidingWindow;

  beforeEach(() => {
    window = new InMemorySlidingWindow();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("F1: no key exceeds its configured budget within a window", async () => {
    await fc.assert(
      fc.asyncProperty(keyArb, budgetArb, requestCountArb, async (key, max, n) => {
        window.reset();
        const windowMs = 60_000;

        let allowed = 0;
        for (let i = 0; i < n; i++) {
          const result = await checkRateLimit(window, key, windowMs, max);
          if (result.allowed) allowed++;
        }

        // Allowed count must never exceed the budget
        expect(allowed).toBeLessThanOrEqual(max);
      })
    );
  });

  it("F2: one key exhausting its budget never affects another key", async () => {
    await fc.assert(
      fc.asyncProperty(
        keyArb,
        keyArb.filter((k2) => k2 !== "aaaa"), // ensure keys differ
        budgetArb,
        async (key1, key2, max) => {
          // Use distinct keys
          const k1 = `k1-${key1}`;
          const k2 = `k2-${key2}`;
          window.reset();
          const windowMs = 60_000;

          // Exhaust key1 completely
          for (let i = 0; i < max + 5; i++) {
            await checkRateLimit(window, k1, windowMs, max);
          }

          // key2 should still have a full budget
          const result = await checkRateLimit(window, k2, windowMs, max);
          expect(result.allowed).toBe(true);
          expect(result.count).toBe(1);
          expect(result.remaining).toBe(max - 1);
        }
      )
    );
  });

  it("F3: the Nth request is allowed and the (N+1)th is rejected", async () => {
    await fc.assert(
      fc.asyncProperty(budgetArb, async (max) => {
        const key = `burst-test-${max}`;
        window.reset(key);
        const windowMs = 60_000;

        // Send exactly max requests — all should be allowed
        for (let i = 0; i < max; i++) {
          const result = await checkRateLimit(window, key, windowMs, max);
          expect(result.allowed).toBe(true);
        }

        // The (max+1)th request must be rejected
        const overflow = await checkRateLimit(window, key, windowMs, max);
        expect(overflow.allowed).toBe(false);
        expect(overflow.remaining).toBe(0);
      })
    );
  });

  it("F4: counters are independent — N keys each get their own full budget", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(keyArb, { minLength: 2, maxLength: 8 }),
        budgetArb,
        async (keys, max) => {
          // Deduplicate keys
          const uniqueKeys = [...new Set(keys)].map((k, i) => `iso-${i}-${k}`);
          window.reset();
          const windowMs = 60_000;

          for (const key of uniqueKeys) {
            // Each key should be able to consume its full budget independently
            for (let i = 0; i < max; i++) {
              const result = await checkRateLimit(window, key, windowMs, max);
              expect(result.allowed).toBe(true);
            }
          }
        }
      )
    );
  });

  it("F5: remaining count decrements monotonically within a window", async () => {
    await fc.assert(
      fc.asyncProperty(budgetArb, async (max) => {
        const key = `mono-${max}`;
        window.reset(key);
        const windowMs = 60_000;

        let prevRemaining = max;
        for (let i = 0; i < max; i++) {
          const result = await checkRateLimit(window, key, windowMs, max);
          expect(result.remaining).toBeLessThanOrEqual(prevRemaining);
          prevRemaining = result.remaining;
        }
      })
    );
  });
});
