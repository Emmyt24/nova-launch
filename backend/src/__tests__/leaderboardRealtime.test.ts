/**
 * Tests for issue #1377 — real-time leaderboard updates.
 *
 * Covers:
 *  - registerLeaderboardSubscriber tracks active (type, period) interest
 *  - burn/deploy events only broadcast for actively-subscribed combinations
 *  - broadcasts are debounced to at most one push per 5s window
 *  - unrelated leaderboard kinds are not broadcast
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerLeaderboardSubscriber,
  resetLeaderboardSubscriptionsForTests,
  clearCache,
  TimePeriod,
  LEADERBOARD_UPDATED_TOPIC,
} from "../services/leaderboardService";
import { eventBus } from "../services/eventBus";
import { prisma } from "../lib/prisma";

vi.mock("../lib/prisma", () => ({
  prisma: {
    burnRecord: {
      groupBy: vi.fn(),
    },
    token: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

const mockToken = {
  id: "token1",
  address: "GNOVA1",
  name: "Nova Token",
  symbol: "NOVA",
  decimals: 7,
  totalSupply: BigInt(1000000),
  totalBurned: BigInt(100000),
  burnCount: 5,
  metadataUri: null,
  createdAt: new Date(),
};

function collectOne<T>(topic: string, timeoutMs = 200): Promise<T | null> {
  return new Promise((resolve) => {
    const sub = eventBus.subscribe<T>(topic, (event) => {
      sub.unsubscribe();
      resolve(event.payload);
    });
    setTimeout(() => {
      sub.unsubscribe();
      resolve(null);
    }, timeoutMs);
  });
}

describe("Real-time leaderboard updates (issue #1377)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    clearCache();
    resetLeaderboardSubscriptionsForTests();

    vi.mocked(prisma.burnRecord.groupBy).mockResolvedValue([
      {
        tokenId: "token1",
        _sum: { amount: BigInt(100000) },
        _count: { id: 5 },
      },
    ] as any);
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockToken] as any);
  });

  afterEach(() => {
    resetLeaderboardSubscriptionsForTests();
    vi.useRealTimers();
  });

  it("does not broadcast when there are no active subscribers", async () => {
    const received = collectOne(LEADERBOARD_UPDATED_TOPIC, 50);
    await eventBus.publish("burn.created", { tokenId: "token1" });
    await vi.advanceTimersByTimeAsync(6000);

    expect(await received).toBeNull();
  });

  it("broadcasts the leaderboard for an actively-subscribed (type, period)", async () => {
    const unregister = registerLeaderboardSubscriber("most-burned", TimePeriod.D7);
    const received = collectOne<any>(LEADERBOARD_UPDATED_TOPIC, 10000);

    await eventBus.publish("burn.created", { tokenId: "token1" });
    await vi.advanceTimersByTimeAsync(5000);

    const payload = await received;
    expect(payload).not.toBeNull();
    expect(payload.type).toBe("most-burned");
    expect(payload.period).toBe(TimePeriod.D7);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].token.address).toBe("GNOVA1");

    unregister();
  });

  it("does not broadcast a leaderboard kind unaffected by the event", async () => {
    registerLeaderboardSubscriber("newest", TimePeriod.ALL);
    const received = collectOne(LEADERBOARD_UPDATED_TOPIC, 50);

    // A burn does not affect the "newest" leaderboard.
    await eventBus.publish("burn.created", { tokenId: "token1" });
    await vi.advanceTimersByTimeAsync(6000);

    expect(await received).toBeNull();
  });

  it("debounces rapid bursts into a single broadcast", async () => {
    registerLeaderboardSubscriber("most-burned", TimePeriod.D7);

    let broadcastCount = 0;
    const sub = eventBus.subscribe(LEADERBOARD_UPDATED_TOPIC, () => {
      broadcastCount++;
    });

    // Five rapid burns within the debounce window should collapse to one push.
    for (let i = 0; i < 5; i++) {
      await eventBus.publish("burn.created", { tokenId: "token1" });
    }
    await vi.advanceTimersByTimeAsync(5000);

    expect(broadcastCount).toBe(1);
    sub.unsubscribe();
  });

  it("stops broadcasting once the subscriber unregisters", async () => {
    const unregister = registerLeaderboardSubscriber("most-burned", TimePeriod.D7);
    unregister();

    const received = collectOne(LEADERBOARD_UPDATED_TOPIC, 50);
    await eventBus.publish("burn.created", { tokenId: "token1" });
    await vi.advanceTimersByTimeAsync(6000);

    expect(await received).toBeNull();
  });

  it("treats burn.executed the same as burn.created", async () => {
    registerLeaderboardSubscriber("most-active", TimePeriod.D7);
    const received = collectOne<any>(LEADERBOARD_UPDATED_TOPIC, 10000);

    await eventBus.publish("burn.executed", { tokenId: "token1" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(await received).not.toBeNull();
  });

  it("treats token.deployed the same as token.created for newest/largest-supply", async () => {
    vi.mocked(prisma.token.count).mockResolvedValue(1);
    registerLeaderboardSubscriber("newest", TimePeriod.ALL);
    const received = collectOne<any>(LEADERBOARD_UPDATED_TOPIC, 10000);

    await eventBus.publish("token.deployed", {
      tokenId: "token1",
      name: "Nova Token",
      symbol: "NOVA",
    });
    await vi.advanceTimersByTimeAsync(5000);

    const payload = await received;
    expect(payload).not.toBeNull();
    expect(payload.type).toBe("newest");
  });
});
