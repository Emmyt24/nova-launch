/**
 * Leaderboard time window parameters (#2204):
 *  - 24h, 7d, 30d and all-time windows
 *  - each window cached separately (own key + own TTL)
 *  - parameter validation with clear 400 errors
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { prisma } from "../lib/prisma";
import leaderboardRoutes from "../routes/leaderboard";
import {
  TimePeriod,
  WINDOW_CACHE_TTL_MS,
  clearCache,
  getCachedKeys,
  getLargestSupplyLeaderboard,
  getMostBurnedLeaderboard,
  getNewestTokensLeaderboard,
} from "../services/leaderboardService";
import {
  LEADERBOARD_WINDOWS,
  parseLeaderboardWindow,
} from "../lib/validation/leaderboardWindow";

vi.mock("../lib/prisma", () => ({
  prisma: {
    burnRecord: { groupBy: vi.fn(), count: vi.fn() },
    token: { findMany: vi.fn(), count: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("../lib/leaderboardSortedSetCache", () => ({
  readTopFromSortedSet: vi.fn().mockResolvedValue(null),
  warmSortedSet: vi.fn().mockResolvedValue(undefined),
  incrementScore: vi.fn().mockResolvedValue(undefined),
  ensureMember: vi.fn().mockResolvedValue(undefined),
  getSortedSetStatus: vi.fn().mockResolvedValue({ reachable: false, warm: false }),
}));

const app = express();
app.use("/api/leaderboard", leaderboardRoutes);

function mockEmptyBoards() {
  vi.mocked(prisma.burnRecord.groupBy).mockResolvedValue([] as any);
  vi.mocked(prisma.token.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.token.count).mockResolvedValue(0 as any);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as any);
}

describe("parseLeaderboardWindow", () => {
  it.each(["24h", "7d", "30d", "all"])("accepts canonical window %s", (w) => {
    expect(parseLeaderboardWindow(w)).toEqual({ ok: true, window: w });
  });

  it.each([
    ["1d", TimePeriod.H24],
    ["DAY", TimePeriod.H24],
    ["1w", TimePeriod.D7],
    ["month", TimePeriod.D30],
    ["all-time", TimePeriod.ALL],
    ["AllTime", TimePeriod.ALL],
    [" 30D ", TimePeriod.D30],
  ])("normalises alias %s", (raw, expected) => {
    expect(parseLeaderboardWindow(raw)).toEqual({ ok: true, window: expected });
  });

  it("uses the fallback when absent", () => {
    expect(parseLeaderboardWindow(undefined)).toEqual({ ok: true, window: TimePeriod.D7 });
    expect(parseLeaderboardWindow("", TimePeriod.ALL)).toEqual({ ok: true, window: TimePeriod.ALL });
  });

  it.each(["1y", "90d", "7", "abc", "24hours"])("rejects %s", (raw) => {
    const result = parseLeaderboardWindow(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMETERS");
      expect(result.error.message).toContain("24h, 7d, 30d, all");
      expect(result.error.details.allowed).toEqual([...LEADERBOARD_WINDOWS]);
    }
  });

  it("rejects repeated parameters", () => {
    expect(parseLeaderboardWindow(["7d", "30d"]).ok).toBe(false);
  });
});

describe("leaderboard routes — window parameters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    mockEmptyBoards();
  });

  it.each(["most-burned", "most-active", "most-burners", "newest", "largest-supply"])(
    "%s returns 400 for an unsupported period",
    async (board) => {
      const res = await request(app).get(`/api/leaderboard/${board}?period=1y`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("INVALID_PARAMETERS");
      expect(res.body.error.details.allowed).toEqual(["24h", "7d", "30d", "all"]);
    }
  );

  it.each(["24h", "7d", "30d", "all"])("most-burned accepts period=%s", async (period) => {
    const res = await request(app).get(`/api/leaderboard/most-burned?period=${period}`);
    expect(res.status).toBe(200);
    expect(res.body.data.period).toBe(period);
  });

  it("accepts the window alias parameter", async () => {
    const res = await request(app).get("/api/leaderboard/most-active?window=all-time");
    expect(res.status).toBe(200);
    expect(res.body.data.period).toBe("all");
  });

  it("rejects period and window together", async () => {
    const res = await request(app).get("/api/leaderboard/most-active?period=7d&window=30d");
    expect(res.status).toBe(400);
  });

  it("defaults rank boards to 7d and token boards to all-time", async () => {
    const burned = await request(app).get("/api/leaderboard/most-burned");
    const newest = await request(app).get("/api/leaderboard/newest");
    expect(burned.body.data.period).toBe("7d");
    expect(newest.body.data.period).toBe("all");
  });
});

describe("leaderboard service — per-window caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    mockEmptyBoards();
  });

  afterEach(() => vi.useRealTimers());

  it("caches each window under its own key", async () => {
    for (const w of LEADERBOARD_WINDOWS) await getMostBurnedLeaderboard(w, 1, 10);
    expect(getCachedKeys("most-burned").sort()).toEqual(
      ["most-burned:24h:1:10", "most-burned:30d:1:10", "most-burned:7d:1:10", "most-burned:all:1:10"]
    );
  });

  it("serves a window from cache without affecting other windows", async () => {
    await getMostBurnedLeaderboard(TimePeriod.H24, 1, 10);
    const callsAfterFirst = vi.mocked(prisma.burnRecord.groupBy).mock.calls.length;

    await getMostBurnedLeaderboard(TimePeriod.H24, 1, 10);
    expect(vi.mocked(prisma.burnRecord.groupBy).mock.calls.length).toBe(callsAfterFirst);

    await getMostBurnedLeaderboard(TimePeriod.D30, 1, 10);
    expect(vi.mocked(prisma.burnRecord.groupBy).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("uses shorter TTLs for shorter windows", () => {
    expect(WINDOW_CACHE_TTL_MS[TimePeriod.H24]).toBeLessThan(WINDOW_CACHE_TTL_MS[TimePeriod.D7]);
    expect(WINDOW_CACHE_TTL_MS[TimePeriod.D7]).toBeLessThan(WINDOW_CACHE_TTL_MS[TimePeriod.D30]);
    expect(WINDOW_CACHE_TTL_MS[TimePeriod.D30]).toBeLessThan(WINDOW_CACHE_TTL_MS[TimePeriod.ALL]);
  });

  it("expires the 24h window before the all-time window", async () => {
    vi.useFakeTimers();
    await getMostBurnedLeaderboard(TimePeriod.H24, 1, 10);
    await getMostBurnedLeaderboard(TimePeriod.ALL, 1, 10);
    const before = vi.mocked(prisma.burnRecord.groupBy).mock.calls.length;

    vi.advanceTimersByTime(WINDOW_CACHE_TTL_MS[TimePeriod.H24] + 1);

    await getMostBurnedLeaderboard(TimePeriod.ALL, 1, 10);
    expect(vi.mocked(prisma.burnRecord.groupBy).mock.calls.length).toBe(before);

    await getMostBurnedLeaderboard(TimePeriod.H24, 1, 10);
    expect(vi.mocked(prisma.burnRecord.groupBy).mock.calls.length).toBeGreaterThan(before);
  });

  it("filters newest/largest-supply by creation date inside the window", async () => {
    await getNewestTokensLeaderboard(1, 10, TimePeriod.D7);
    await getLargestSupplyLeaderboard(1, 10, TimePeriod.H24);
    const [newestArgs, largestArgs] = vi.mocked(prisma.token.findMany).mock.calls.map((c) => c[0] as any);
    expect(newestArgs.where.createdAt.gte).toBeInstanceOf(Date);
    expect(largestArgs.where.createdAt.gte).toBeInstanceOf(Date);
    expect(getCachedKeys("newest")).toEqual(["newest:7d:1:10"]);
    expect(getCachedKeys("largest-supply")).toEqual(["largest-supply:24h:1:10"]);
  });

  it("does not filter all-time token boards", async () => {
    await getNewestTokensLeaderboard(1, 10);
    const args = vi.mocked(prisma.token.findMany).mock.calls[0][0] as any;
    expect(args.where).toEqual({});
  });
});
