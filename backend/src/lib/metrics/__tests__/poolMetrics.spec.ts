/**
 * Unit tests — poolMetrics.ts
 * Issue: #1996 — Fix Pool-Saturation Metrics That Report 0% Load Forever When
 *                DB_POOL_SIZE Is Malformed
 *
 * Verifies that a malformed DB_POOL_SIZE env var causes the module to fall
 * back to the documented default of 10 and continue reporting real saturation
 * instead of being permanently pinned at 0.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture the value most recently set on a prom-client Gauge. */
function captureGaugeValue(gauge: any): number {
  // prom-client Gauge stores hashMap internally; for a label-less gauge the
  // key is "" (empty string) and the value is a { value, labels } object.
  const hashMap = gauge.hashMap as Record<string, { value: number }>;
  const entry = hashMap[""];
  return entry?.value ?? NaN;
}

// ---------------------------------------------------------------------------
// Issue #1996 — malformed DB_POOL_SIZE must not pin saturation at 0
// ---------------------------------------------------------------------------

describe("poolMetrics — malformed DB_POOL_SIZE (Issue #1996)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("falls back to pool size 10 and reports non-zero saturation when DB_POOL_SIZE is a non-numeric string", async () => {
    // Arrange — inject a malformed value before the module is (re-)loaded
    process.env.DB_POOL_SIZE = "not-a-number";

    // Act — dynamic import so the module reads the env var fresh
    const { registerPoolMetrics } = await import("../poolMetrics");

    // Build a minimal fake PrismaClient whose $use middleware we can drive
    let capturedMiddleware:
      | ((params: unknown, next: (p: unknown) => Promise<unknown>) => Promise<unknown>)
      | undefined;

    const fakePrisma = {
      $use: (mw: typeof capturedMiddleware) => {
        capturedMiddleware = mw;
      },
    } as any;

    // Re-import the gauges from the metrics index so we can read their values
    const metricsModule = await import("../index");
    const { dbPoolSaturation } = metricsModule;

    registerPoolMetrics(fakePrisma);

    // Simulate one in-flight query by calling the middleware manually
    let resolveQuery!: () => void;
    const queryPromise = new Promise<void>((res) => {
      resolveQuery = res;
    });

    // Start the "query" — middleware should increment inflight counter
    const middlewareRun = capturedMiddleware!(
      {},
      async (_params: unknown) => {
        await queryPromise;
        return {};
      }
    );

    // At this point the query is in-flight (inflight = 1)
    const saturationDuringQuery = captureGaugeValue(dbPoolSaturation);

    // The fallback pool size is 10, so saturation for 1 active query = 1/10 = 0.1
    // If the NaN bug were present, saturation would be 0.
    expect(saturationDuringQuery).toBeGreaterThan(0);
    expect(saturationDuringQuery).toBeCloseTo(0.1, 5);

    // Finish the query
    resolveQuery();
    await middlewareRun;

    // After the query, saturation should drop back to 0
    const saturationAfterQuery = captureGaugeValue(dbPoolSaturation);
    expect(saturationAfterQuery).toBe(0);
  });

  it("uses DB_POOL_SIZE when it is a valid positive integer", async () => {
    process.env.DB_POOL_SIZE = "20";

    const { registerPoolMetrics } = await import("../poolMetrics");
    const metricsModule = await import("../index");
    const { dbPoolSaturation } = metricsModule;

    let capturedMiddleware:
      | ((params: unknown, next: (p: unknown) => Promise<unknown>) => Promise<unknown>)
      | undefined;

    const fakePrisma = {
      $use: (mw: typeof capturedMiddleware) => {
        capturedMiddleware = mw;
      },
    } as any;

    registerPoolMetrics(fakePrisma);

    let resolveQuery!: () => void;
    const queryPromise = new Promise<void>((res) => { resolveQuery = res; });

    const middlewareRun = capturedMiddleware!(
      {},
      async (_p: unknown) => { await queryPromise; return {}; }
    );

    // 1 active out of 20 → 0.05
    const saturation = captureGaugeValue(dbPoolSaturation);
    expect(saturation).toBeCloseTo(0.05, 5);

    resolveQuery();
    await middlewareRun;
  });

  it("uses default pool size 10 when DB_POOL_SIZE is unset", async () => {
    delete process.env.DB_POOL_SIZE;

    const { registerPoolMetrics } = await import("../poolMetrics");
    const metricsModule = await import("../index");
    const { dbPoolSaturation } = metricsModule;

    let capturedMiddleware:
      | ((params: unknown, next: (p: unknown) => Promise<unknown>) => Promise<unknown>)
      | undefined;

    const fakePrisma = {
      $use: (mw: typeof capturedMiddleware) => { capturedMiddleware = mw; },
    } as any;

    registerPoolMetrics(fakePrisma);

    let resolveQuery!: () => void;
    const queryPromise = new Promise<void>((res) => { resolveQuery = res; });

    const middlewareRun = capturedMiddleware!(
      {},
      async (_p: unknown) => { await queryPromise; return {}; }
    );

    // 1 active out of default 10 → 0.1
    const saturation = captureGaugeValue(dbPoolSaturation);
    expect(saturation).toBeCloseTo(0.1, 5);

    resolveQuery();
    await middlewareRun;
  });
});
