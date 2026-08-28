/**
 * Edge-case coverage for AnalyticsService's guarded arithmetic.
 *
 * Issue: #1875 — exercise the zero-division / BigInt-truncation branches that
 * calcChangePercent, averageBurnAmount and burnFrequencyPerDay guard against.
 *
 * The service is a plain class (its constructor accepts an injectable
 * PrismaDep), so no NestJS testing harness is needed. Its query helpers talk to
 * a module-level `prisma` client, which we replace with an in-memory fake that
 * routes each SQL string to a canned result set.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Fake prisma client ─────────────────────────────────────────────────────
//
// getTokenAnalytics() fires a fixed set of raw queries. We route them by a
// distinctive fragment of their SQL text. The "current period" PeriodStats row
// is the only one the tests below care about, so it is overridable per-test.

let currentPeriodRow = { volume: "0", count: 0, uniqueBurners: 0 };

const emptyPeriodRow = { volume: "0", count: 0, uniqueBurners: 0 };

function routeQueryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = Array.isArray(strings) ? strings.join(" ? ") : String(strings);

  // countBurnEvents — must be > 0 or getTokenAnalytics throws a 404
  if (sql.includes("AS cnt")) {
    return Promise.resolve([{ cnt: 1 }]);
  }

  // getAllTimeStats
  if (sql.includes('"totalCount"')) {
    return Promise.resolve([
      { totalVolume: "0", totalCount: 0, uniqueBurners: 0 },
    ]);
  }

  // getLargestBurn
  if (sql.includes('"txHash"')) {
    return Promise.resolve([]);
  }

  // getBurnTypeDistribution
  if (sql.includes("GROUP BY burn_type")) {
    return Promise.resolve([]);
  }

  // getPeriodStats — called for the current window, the previous window and the
  // fixed 24h/7d/30d windows. Only the current 90d window (~90 days wide) needs
  // test-controlled data; every other window returns zeroes.
  if (sql.includes("AS volume,")) {
    const start = values[1] as Date;
    const daysAgo = Math.round((Date.now() - start.getTime()) / 86_400_000);
    return Promise.resolve([daysAgo === 90 ? currentPeriodRow : emptyPeriodRow]);
  }

  return Promise.resolve([]);
}

// Installed before the service module is imported: its module scope resolves
// `prisma` off the global object, and it instantiates a singleton on load.
(globalThis as Record<string, unknown>).prisma = {
  $queryRaw: vi.fn(routeQueryRaw),
  $queryRawUnsafe: vi.fn(() => Promise.resolve([])),
  analyticsBucket: { upsert: vi.fn(), findMany: vi.fn() },
};

const { AnalyticsService } = await import("../analytics.service");

beforeEach(() => {
  currentPeriodRow = { volume: "0", count: 0, uniqueBurners: 0 };
});

function makeService() {
  return new AnalyticsService({ analyticsBucket: {} } as never);
}

// ─── calcChangePercent: division-by-zero guard ──────────────────────────────

describe("AnalyticsService.calcChangePercent — zero previous period", () => {
  it("returns 100 when the previous period was zero and the current period grew", () => {
    const svc = makeService() as unknown as {
      calcChangePercent(prev: bigint, curr: bigint): number;
    };
    expect(svc.calcChangePercent(0n, 100n)).toBe(100);
  });

  it("returns 0 when both the previous and current periods are zero", () => {
    const svc = makeService() as unknown as {
      calcChangePercent(prev: bigint, curr: bigint): number;
    };
    expect(svc.calcChangePercent(0n, 0n)).toBe(0);
  });

  it("still computes a normal percentage when the previous period is non-zero", () => {
    const svc = makeService() as unknown as {
      calcChangePercent(prev: bigint, curr: bigint): number;
    };
    expect(svc.calcChangePercent(100n, 150n)).toBe(50);
  });

  it("surfaces the guard through getTokenAnalytics (prev period has no burns)", async () => {
    currentPeriodRow = { volume: "500", count: 5, uniqueBurners: 2 };
    const result = await makeService().getTokenAnalytics("0xToken", "90d");

    // previous 90d window returns zeroes -> guard yields 100, not NaN / Infinity
    expect(result.volumeChangePercent).toBe(100);
    expect(result.countChangePercent).toBe(100);
  });
});

// ─── averageBurnAmount: BigInt truncation ──────────────────────────────────

describe("AnalyticsService.averageBurnAmount — BigInt division truncates", () => {
  it("truncates a non-evenly-divisible volume/count pair toward zero", async () => {
    currentPeriodRow = { volume: "7", count: 2, uniqueBurners: 1 };
    const result = await makeService().getTokenAnalytics("0xToken", "90d");

    // 7n / 2n === 3n — the fractional 0.5 is dropped, not rounded.
    expect(result.averageBurnAmount).toBe("3");
    expect(result.averageBurnAmount).not.toBe("3.5");
    expect(result.averageBurnAmount).not.toBe("4");
  });

  it("truncates large integer amounts without floating-point drift", async () => {
    currentPeriodRow = {
      volume: "1000000000000000000007",
      count: 2,
      uniqueBurners: 1,
    };
    const result = await makeService().getTokenAnalytics("0xToken", "90d");

    expect(result.averageBurnAmount).toBe("500000000000000000003");
  });

  it('returns "0" when the current period has no burns (count === 0 guard)', async () => {
    currentPeriodRow = { volume: "0", count: 0, uniqueBurners: 0 };
    const result = await makeService().getTokenAnalytics("0xToken", "90d");

    expect(result.averageBurnAmount).toBe("0");
  });
});

// ─── burnFrequencyPerDay: zero-duration window guard ───────────────────────

describe("AnalyticsService.burnFrequencyPerDay — zero-duration window", () => {
  it("returns 0 (not Infinity / NaN) when windowDurationDays is zero", async () => {
    const svc = makeService();
    vi.spyOn(
      svc as unknown as { windowDurationDays(w: unknown): number },
      "windowDurationDays"
    ).mockReturnValue(0);

    currentPeriodRow = { volume: "500", count: 5, uniqueBurners: 2 };
    const result = await svc.getTokenAnalytics("0xToken", "90d");

    expect(result.burnFrequencyPerDay).toBe(0);
  });

  it("computes a finite rate for a normal (non-zero) window", async () => {
    currentPeriodRow = { volume: "900", count: 9, uniqueBurners: 3 };
    const result = await makeService().getTokenAnalytics("0xToken", "90d");

    // 9 burns / 90 days, rounded to 2dp
    expect(result.burnFrequencyPerDay).toBe(0.1);
    expect(Number.isFinite(result.burnFrequencyPerDay)).toBe(true);
  });
});
