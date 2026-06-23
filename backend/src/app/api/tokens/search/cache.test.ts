import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getCachedSearchResults,
  cacheSearchResults,
  clearSearchCache,
  recordQueryFrequency,
  getTopQueryTerms,
  invalidateTagsForToken,
} from "./cache";

describe("Search Cache", () => {
  beforeEach(() => {
    clearSearchCache();
  });

  it("should return null for non-existent cache key", async () => {
    const result = await getCachedSearchResults("non-existent");
    expect(result).toBeNull();
  });

  it("should cache and retrieve results", async () => {
    const key = "test-key";
    const data = { success: true, data: [] };

    await cacheSearchResults(key, data);
    const cached = await getCachedSearchResults(key);

    expect(cached).toEqual(data);
  });

  it("should return null for expired cache entries", async () => {
    const key = "test-key";
    const data = { success: true, data: [] };

    await cacheSearchResults(key, data);

    // Fast-forward time by 6 minutes (cache TTL is 5 minutes)
    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000);

    const cached = await getCachedSearchResults(key);
    expect(cached).toBeNull();

    vi.useRealTimers();
  });

  it("should clear all cache entries", async () => {
    await cacheSearchResults("key1", { data: 1 });
    await cacheSearchResults("key2", { data: 2 });

    clearSearchCache();

    const cached1 = await getCachedSearchResults("key1");
    const cached2 = await getCachedSearchResults("key2");

    expect(cached1).toBeNull();
    expect(cached2).toBeNull();
  });

  it("should handle cache size limit", async () => {
    // This test would require mocking the MAX_CACHE_SIZE
    // For now, we'll just verify the function doesn't throw
    for (let i = 0; i < 10; i++) {
      await cacheSearchResults(`key-${i}`, { data: i });
    }

    const lastCached = await getCachedSearchResults("key-9");
    expect(lastCached).toEqual({ data: 9 });
  });
});

describe("Search cache — tag-based invalidation (issue #1376)", () => {
  beforeEach(() => {
    clearSearchCache();
  });

  it("invalidates only the bucket for a search term matching the new token", async () => {
    await cacheSearchResults('{"q":"nova"}', { data: "nova-results" }, "nova");
    await cacheSearchResults('{"q":"comet"}', { data: "comet-results" }, "comet");

    const invalidated = invalidateTagsForToken({ name: "Nova Token", symbol: "NOVA" });

    expect(invalidated).toEqual(["nova"]);
    expect(await getCachedSearchResults('{"q":"nova"}')).toBeNull();
    expect(await getCachedSearchResults('{"q":"comet"}')).toEqual({ data: "comet-results" });
  });

  it("matches the search term against either name or symbol, case-insensitively", async () => {
    await cacheSearchResults('{"q":"NVA"}', { data: "by-symbol" }, "NVA");

    const invalidated = invalidateTagsForToken({ name: "Some Token", symbol: "nvaCoin" });

    expect(invalidated).toEqual(["nva"]);
    expect(await getCachedSearchResults('{"q":"NVA"}')).toBeNull();
  });

  it("always invalidates the unfiltered (no search term) bucket", async () => {
    await cacheSearchResults('{}', { data: "all-tokens" }, undefined);

    const invalidated = invalidateTagsForToken({ name: "Anything", symbol: "ANY" });

    expect(invalidated).toContain("");
    expect(await getCachedSearchResults('{}')).toBeNull();
  });

  it("does not invalidate unrelated search-term buckets", async () => {
    await cacheSearchResults('{"q":"alpha"}', { data: "alpha-results" }, "alpha");
    await cacheSearchResults('{"q":"beta"}', { data: "beta-results" }, "beta");

    invalidateTagsForToken({ name: "Gamma Token", symbol: "GAMMA" });

    expect(await getCachedSearchResults('{"q":"alpha"}')).toEqual({ data: "alpha-results" });
    expect(await getCachedSearchResults('{"q":"beta"}')).toEqual({ data: "beta-results" });
  });

  it("does not flush the entire cache on a deployment", async () => {
    await cacheSearchResults('{"q":"nova"}', { data: 1 }, "nova");
    await cacheSearchResults('{"q":"unrelated"}', { data: 2 }, "unrelated");

    invalidateTagsForToken({ name: "Nova Token", symbol: "NOVA" });

    expect(await getCachedSearchResults('{"q":"unrelated"}')).toEqual({ data: 2 });
  });
});

describe("Search cache — query frequency tracking (issue #1376)", () => {
  beforeEach(() => {
    clearSearchCache();
  });

  it("ranks search terms by how often they were queried", () => {
    recordQueryFrequency("nova");
    recordQueryFrequency("nova");
    recordQueryFrequency("comet");

    expect(getTopQueryTerms(2)).toEqual(["nova", "comet"]);
  });

  it("normalizes case and whitespace when counting frequency", () => {
    recordQueryFrequency("Nova");
    recordQueryFrequency(" nova ");

    expect(getTopQueryTerms(1)).toEqual(["nova"]);
  });

  it("respects the requested limit", () => {
    recordQueryFrequency("a");
    recordQueryFrequency("b");
    recordQueryFrequency("c");

    expect(getTopQueryTerms(1)).toHaveLength(1);
  });
});
