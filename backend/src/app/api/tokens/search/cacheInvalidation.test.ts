/**
 * Integration tests for issue #1376 — search cache invalidation on
 * `token.deployed` events, plus warm-up of popular search terms.
 *
 * Avoids importing `route.ts` directly since it depends on `next/server`,
 * which isn't installed in this Express backend; the event listener and
 * warm-up job are exercised the same way they run in production — by
 * publishing on the real event bus and reading the cache module.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eventBus } from "../../../../services/eventBus";

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    token: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  })),
}));

describe("Search cache invalidation on token.deployed (issue #1376)", () => {
  beforeEach(async () => {
    const { clearSearchCache } = await import("./cache");
    clearSearchCache();
    await import("./cacheInvalidation");
  });

  it("invalidates the affected search-term bucket within 1 second of deployment", async () => {
    const { cacheSearchResults, getCachedSearchResults } = await import("./cache");

    await cacheSearchResults('{"q":"nova"}', { data: "stale-nova-results" }, "nova");

    const start = Date.now();
    await eventBus.publish("token.deployed", {
      tokenId: "tok_1",
      address: "GNOVA1",
      creator: "GCREATOR",
      name: "Nova Token",
      symbol: "NOVA",
    });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    expect(await getCachedSearchResults('{"q":"nova"}')).toBeNull();
  });

  it("leaves unrelated search-term buckets cached", async () => {
    const { cacheSearchResults, getCachedSearchResults } = await import("./cache");

    await cacheSearchResults('{"q":"nova"}', { data: "nova-results" }, "nova");
    await cacheSearchResults('{"q":"comet"}', { data: "comet-results" }, "comet");

    await eventBus.publish("token.deployed", {
      tokenId: "tok_2",
      address: "GNOVA2",
      creator: "GCREATOR",
      name: "Nova Token",
      symbol: "NOVA",
    });

    expect(await getCachedSearchResults('{"q":"comet"}')).toEqual({
      data: "comet-results",
    });
  });

  it("warms up the cache for a popular invalidated search term", async () => {
    const { cacheSearchResults, recordQueryFrequency, getCachedSearchResults } =
      await import("./cache");

    // Simulate "nova" being a popular search term, then cache a stale result for it.
    for (let i = 0; i < 5; i++) recordQueryFrequency("nova");
    await cacheSearchResults('{"q":"nova"}', { data: "stale" }, "nova");

    await eventBus.publish("token.deployed", {
      tokenId: "tok_3",
      address: "GNOVA3",
      creator: "GCREATOR",
      name: "Nova Token",
      symbol: "NOVA",
    });

    // Warm-up re-populates the canonical cache key for a plain `q=nova` search.
    const rewarmed = await getCachedSearchResults('{"q":"nova","sortBy":"created","sortOrder":"desc","page":"1","limit":"20"}');
    expect(rewarmed).not.toBeNull();
    expect(rewarmed.success).toBe(true);
  });

  it("does not warm up an invalidated term that was never popular", async () => {
    const { cacheSearchResults, getCachedSearchResults } = await import("./cache");

    await cacheSearchResults('{"q":"obscure"}', { data: "stale" }, "obscure");

    await eventBus.publish("token.deployed", {
      tokenId: "tok_4",
      address: "GOBS1",
      creator: "GCREATOR",
      name: "Obscure Token",
      symbol: "OBSCURE",
    });

    const rewarmed = await getCachedSearchResults('{"q":"obscure","sortBy":"created","sortOrder":"desc","page":"1","limit":"20"}');
    expect(rewarmed).toBeNull();
  });

  it("ignores deployment events missing name/symbol", async () => {
    const { cacheSearchResults, getCachedSearchResults } = await import("./cache");

    await cacheSearchResults('{"q":"nova"}', { data: "nova-results" }, "nova");

    await expect(
      eventBus.publish("token.deployed", { tokenId: "tok_5" })
    ).resolves.toBeDefined();

    expect(await getCachedSearchResults('{"q":"nova"}')).toEqual({
      data: "nova-results",
    });
  });
});
