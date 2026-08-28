import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CacheService, GovernanceProposalCache } from "../cache";

describe("CacheService", () => {
  let cache: CacheService<string>;

  beforeEach(() => {
    cache = new CacheService(1000); // 1 second default TTL
  });

  afterEach(() => {
    cache.destroy();
  });

  describe("get() and set() basic operations", () => {
    it("returns null for missing keys", () => {
      const result = cache.get("missing");
      expect(result).toBeNull();
    });

    it("returns stored data for valid keys", () => {
      cache.set("key1", "value1");
      const result = cache.get("key1");
      expect(result).toBe("value1");
    });

    it("tracks hits and misses correctly", () => {
      cache.set("key1", "value1");
      cache.get("key1"); // hit
      cache.get("missing"); // miss
      cache.get("key1"); // hit

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });
  });

  describe("TTL and expiration", () => {
    it("respects custom TTL values", () => {
      cache.set("shortLive", "data", 100); // 100ms
      expect(cache.get("shortLive")).toBe("data");

      vi.useFakeTimers();
      vi.advanceTimersByTime(150);
      expect(cache.get("shortLive")).toBeNull();
      vi.useRealTimers();
    });

    it("uses default TTL when not specified", () => {
      const shortTTLCache = new CacheService(100);
      shortTTLCache.set("key", "value");
      expect(shortTTLCache.get("key")).toBe("value");

      vi.useFakeTimers();
      vi.advanceTimersByTime(150);
      expect(shortTTLCache.get("key")).toBeNull();
      vi.useRealTimers();

      shortTTLCache.destroy();
    });
  });

  describe("lazy expiry and stats sync (#1911)", () => {
    it("syncs stats.size immediately after lazy expiry in get()", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.set("key3", "value3");

      let stats = cache.getStats();
      expect(stats.size).toBe(3);

      // Expire key1
      vi.useFakeTimers();
      vi.advanceTimersByTime(1500); // Past default 1s TTL

      // Trigger lazy delete via get()
      cache.get("key1");

      // Stats should immediately reflect the deletion
      stats = cache.getStats();
      expect(stats.size).toBe(2);

      vi.useRealTimers();
    });

    it("does not update stats for non-expired entries on get()", () => {
      cache.set("key1", "value1");
      const statsBefore = cache.getStats();
      expect(statsBefore.size).toBe(1);

      // Access valid entry
      cache.get("key1");

      const statsAfter = cache.getStats();
      expect(statsAfter.size).toBe(1); // Size unchanged
    });

    it("correctly reports size after multiple lazy expires", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.set("key3", "value3");
      cache.set("key4", "value4");

      expect(cache.getStats().size).toBe(4);

      vi.useFakeTimers();
      vi.advanceTimersByTime(1500);

      // Trigger lazy deletes
      cache.get("key1");
      expect(cache.getStats().size).toBe(3);

      cache.get("key2");
      expect(cache.getStats().size).toBe(2);

      cache.get("key3");
      expect(cache.getStats().size).toBe(1);

      vi.useRealTimers();
    });
  });

  describe("invalidate operations", () => {
    it("invalidate() syncs stats.size", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");

      expect(cache.getStats().size).toBe(2);

      cache.invalidate("key1");
      expect(cache.getStats().size).toBe(1);

      cache.invalidate("key2");
      expect(cache.getStats().size).toBe(0);
    });

    it("invalidatePattern() syncs stats.size", () => {
      cache.set("user:123", "alice");
      cache.set("user:456", "bob");
      cache.set("post:789", "hello");

      expect(cache.getStats().size).toBe(3);

      cache.invalidatePattern(/^user:/);
      expect(cache.getStats().size).toBe(1);
    });
  });

  describe("set() operation", () => {
    it("updates stats.size on new entry", () => {
      expect(cache.getStats().size).toBe(0);
      cache.set("key1", "value1");
      expect(cache.getStats().size).toBe(1);
    });

    it("does not change stats.size when overwriting", () => {
      cache.set("key1", "value1");
      expect(cache.getStats().size).toBe(1);

      cache.set("key1", "newValue");
      expect(cache.getStats().size).toBe(1);
    });
  });

  describe("clear()", () => {
    it("resets all stats to zero", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.get("key1"); // hit
      cache.get("missing"); // miss

      cache.clear();

      const stats = cache.getStats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe("getStats() isolation", () => {
    it("returns a copy of stats, not a reference", () => {
      cache.set("key1", "value1");
      const stats1 = cache.getStats();
      const stats2 = cache.getStats();

      expect(stats1).toEqual(stats2);
      expect(stats1).not.toBe(stats2); // Different objects
    });
  });
});

describe("GovernanceProposalCache", () => {
  let cache: GovernanceProposalCache;

  beforeEach(() => {
    cache = new GovernanceProposalCache(1000);
  });

  afterEach(() => {
    cache.destroy();
  });

  describe("proposal operations", () => {
    it("stores and retrieves proposals", () => {
      const proposal = { id: "1", title: "Test Proposal" };
      cache.setProposal("1", proposal);

      const retrieved = cache.getProposal("1");
      expect(retrieved).toEqual(proposal);
    });

    it("getStats() reflects proposal storage", () => {
      cache.setProposal("1", { id: "1" });
      cache.setProposal("2", { id: "2" });

      const stats = cache.getStats();
      expect(stats.size).toBe(2);
    });
  });

  describe("proposals list operations", () => {
    it("stores and retrieves proposals lists", () => {
      const proposals = [{ id: "1" }, { id: "2" }];
      cache.setProposalsList(proposals, "active");

      const retrieved = cache.getProposalsList("active");
      expect(retrieved).toEqual(proposals);
    });

    it("supports different filters", () => {
      const activeProps = [{ id: "1" }];
      const allProps = [{ id: "1" }, { id: "2" }];

      cache.setProposalsList(activeProps, "active");
      cache.setProposalsList(allProps, "all");

      expect(cache.getProposalsList("active")).toEqual(activeProps);
      expect(cache.getProposalsList("all")).toEqual(allProps);
    });
  });

  describe("invalidation", () => {
    it("invalidateProposal() clears related lists", () => {
      const proposal = { id: "1" };
      const proposals = [proposal, { id: "2" }];

      cache.setProposal("1", proposal);
      cache.setProposalsList(proposals, "all");

      cache.invalidateProposal("1");

      expect(cache.getProposal("1")).toBeNull();
      expect(cache.getProposalsList("all")).toBeNull();
    });

    it("invalidateAllLists() clears all list filters", () => {
      cache.setProposalsList([{ id: "1" }], "active");
      cache.setProposalsList([{ id: "1" }, { id: "2" }], "all");

      cache.invalidateAllLists();

      expect(cache.getProposalsList("active")).toBeNull();
      expect(cache.getProposalsList("all")).toBeNull();
    });
  });

  describe("stats integration", () => {
    it("getStats() reflects accurate cache state", () => {
      cache.setProposal("1", { id: "1" });
      cache.setProposalsList([{ id: "1" }], "all");
      cache.setProposalsList([{ id: "1" }], "active");

      const stats = cache.getStats();
      expect(stats.size).toBe(3);
    });
  });
});
