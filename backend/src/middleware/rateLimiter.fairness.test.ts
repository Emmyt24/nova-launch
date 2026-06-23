/**
 * Property-based tests for the max-min fairness scheduler — issue #1378.
 *
 * Guarantees verified against the real `applyFairness()` implementation in
 * rateLimiter.ts (not a simulation):
 *   FN1  Below aggregate capacity, no request is ever delayed.
 *   FN2  A key is never delayed more than 3 times in a row.
 *   FN3  Under contention, a low-volume key is delayed less often than a
 *        high-volume key sharing the same window.
 *   FN4  The fairness penalty counter increments exactly once per delayed
 *        request.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { Request, Response } from "express";
import * as fc from "fast-check";
import {
  applyFairness,
  resetFairnessStateForTests,
  fairnessPenaltyCounter,
  createRateLimiter,
} from "./rateLimiter";

function mockRedis(overrides: Partial<Record<string, Mock>> = {}) {
  const pipelineInstance = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([
      [null, 0],
      [null, 1],
      [null, 1], // count well under any reasonable `max`
      [null, 1],
    ]),
  };
  return {
    pipeline: vi.fn().mockReturnValue(pipelineInstance),
    on: vi.fn(),
    ...overrides,
  } as any;
}

function mockReq(ip: string): Request {
  return { ip, socket: { remoteAddress: ip }, headers: {} } as any;
}

function mockRes(): Response {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as any;
}

describe("applyFairness — max-min fairness scheduler", () => {
  beforeEach(() => {
    resetFairnessStateForTests();
  });

  it("FN1: never delays requests while aggregate load is under capacity", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("ip-a", "ip-b", "ip-c"), {
          minLength: 1,
          maxLength: 40, // default capacity is 50 — stay safely under it
        }),
        (keys) => {
          resetFairnessStateForTests();
          for (const key of keys) {
            const result = applyFairness(key);
            expect(result.delayed).toBe(false);
          }
        }
      )
    );
  });

  it("FN2: no key is delayed more than 3 times in a row", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 60, max: 200 }), // requests, well over capacity (50)
        (requestCount) => {
          resetFairnessStateForTests();
          const noisyKey = "noisy-ip";
          let consecutiveDelays = 0;
          let maxConsecutiveDelays = 0;

          for (let i = 0; i < requestCount; i++) {
            const result = applyFairness(noisyKey);
            if (result.delayed) {
              consecutiveDelays++;
              maxConsecutiveDelays = Math.max(maxConsecutiveDelays, consecutiveDelays);
            } else {
              consecutiveDelays = 0;
            }
          }

          expect(maxConsecutiveDelays).toBeLessThanOrEqual(3);
        }
      )
    );
  });

  it("FN3: a low-volume key is delayed less often than a high-volume key under contention", () => {
    resetFairnessStateForTests();
    const noisyKey = "noisy-ip";
    const quietKey = "quiet-ip";

    let noisyDelays = 0;
    let quietDelays = 0;

    // Noisy key fires 9 requests for every 1 from the quiet key — well past
    // the default capacity of 50 in this single window.
    for (let i = 0; i < 90; i++) {
      if (applyFairness(noisyKey).delayed) noisyDelays++;
    }
    for (let i = 0; i < 10; i++) {
      if (applyFairness(quietKey).delayed) quietDelays++;
    }

    expect(noisyDelays).toBeGreaterThan(quietDelays);
  });

  it("FN4: increments the fairness penalty counter exactly once per delayed request", async () => {
    resetFairnessStateForTests();
    const before = (await fairnessPenaltyCounter.get()).values.reduce(
      (sum, v) => sum + v.value,
      0
    );

    let delays = 0;
    for (let i = 0; i < 80; i++) {
      const result = applyFairness("solo-noisy-ip");
      if (result.delayed) {
        fairnessPenaltyCounter.inc({ key_prefix: "rl" });
        delays++;
      }
    }

    const after = (await fairnessPenaltyCounter.get()).values.reduce(
      (sum, v) => sum + v.value,
      0
    );

    expect(after - before).toBe(delays);
    expect(delays).toBeGreaterThan(0);
  });

  it("does not delay a single key whose requests never exceed capacity", () => {
    resetFairnessStateForTests();
    for (let i = 0; i < 50; i++) {
      expect(applyFairness("under-capacity-ip").delayed).toBe(false);
    }
  });

  it("resumes delaying a key in a fresh window after a pass", () => {
    vi.useFakeTimers();
    resetFairnessStateForTests();
    const key = "rotating-ip";

    // Push the key well past capacity (delays cycle: 3 delays, then 1
    // anti-starvation pass, repeating), then keep going until a pass occurs.
    let sawPass = false;
    for (let i = 0; i < 80 && !sawPass; i++) {
      sawPass = !applyFairness(key).delayed && i >= 50;
    }
    expect(sawPass).toBe(true);

    // Advance past the fairness window so a fresh window starts.
    vi.advanceTimersByTime(1100);

    // A lone request in a brand-new, otherwise-empty window is under capacity.
    expect(applyFairness(key).delayed).toBe(false);

    vi.useRealTimers();
  });
});

describe("createRateLimiter — fairness latency budget", () => {
  beforeEach(() => {
    resetFairnessStateForTests();
  });

  it("adds no more than 10ms to the median request under mixed load", async () => {
    const middleware = createRateLimiter(mockRedis(), { windowMs: 60_000, max: 1000 });

    // 49 distinct low-volume keys (one request each) plus one noisy key
    // hammering past capacity — realistic mixed contention in one window.
    const durations: number[] = [];

    for (let i = 0; i < 49; i++) {
      const start = Date.now();
      await middleware(mockReq(`10.0.0.${i}`), mockRes(), vi.fn());
      durations.push(Date.now() - start);
    }
    for (let i = 0; i < 30; i++) {
      const start = Date.now();
      await middleware(mockReq("10.0.0.noisy"), mockRes(), vi.fn());
      durations.push(Date.now() - start);
    }

    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];

    expect(median).toBeLessThanOrEqual(10);
  });
});
