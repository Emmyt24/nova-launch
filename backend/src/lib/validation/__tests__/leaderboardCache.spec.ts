import { describe, expect, it } from "vitest";
import {
  CACHE_TTL_MS,
  buildCacheKey,
  validateCacheEntry,
} from "../leaderboardCache";

// ---------------------------------------------------------------------------
// validateCacheEntry
// ---------------------------------------------------------------------------

describe("validateCacheEntry — absent / null / undefined entry", () => {
  it("returns fresh=false with ageMs=-1 when entry is null", () => {
    const result = validateCacheEntry(null, Date.now());
    expect(result).toEqual({ fresh: false, ageMs: -1, reason: "entry absent" });
  });

  it("returns fresh=false with ageMs=-1 when entry is undefined", () => {
    const result = validateCacheEntry(undefined, Date.now());
    expect(result).toEqual({ fresh: false, ageMs: -1, reason: "entry absent" });
  });
});

describe("validateCacheEntry — fresh entries", () => {
  const now = 1_000_000;

  it("is fresh when age is 0 (inserted at exactly now)", () => {
    const entry = { data: "x", timestamp: now };
    const result = validateCacheEntry(entry, now);
    expect(result.fresh).toBe(true);
    expect(result.ageMs).toBe(0);
  });

  it("is fresh when age is one ms before the TTL boundary", () => {
    const entry = { data: "x", timestamp: now - (CACHE_TTL_MS - 1) };
    const result = validateCacheEntry(entry, now);
    expect(result.fresh).toBe(true);
    expect(result.ageMs).toBe(CACHE_TTL_MS - 1);
  });

  it("is fresh for a negative age (future timestamp / clock skew)", () => {
    const entry = { data: "x", timestamp: now + 5000 };
    const result = validateCacheEntry(entry, now);
    expect(result.fresh).toBe(true);
    expect(result.ageMs).toBe(-5000);
  });
});

describe("validateCacheEntry — stale entries", () => {
  const now = 1_000_000;

  it("is stale when age equals the TTL exactly", () => {
    const entry = { data: "x", timestamp: now - CACHE_TTL_MS };
    const result = validateCacheEntry(entry, now);
    expect(result.fresh).toBe(false);
    expect(result.ageMs).toBe(CACHE_TTL_MS);
    expect(result.reason).toMatch(/expired/);
  });

  it("is stale when age exceeds the TTL", () => {
    const entry = { data: "x", timestamp: now - CACHE_TTL_MS - 1 };
    const result = validateCacheEntry(entry, now);
    expect(result.fresh).toBe(false);
    expect(result.ageMs).toBe(CACHE_TTL_MS + 1);
  });
});

describe("validateCacheEntry — custom ttlMs", () => {
  const now = 5000;
  const ttl = 1000;

  it("respects a shorter custom TTL", () => {
    const freshEntry = { data: 42, timestamp: now - 999 };
    expect(validateCacheEntry(freshEntry, now, ttl).fresh).toBe(true);

    const staleEntry = { data: 42, timestamp: now - 1000 };
    expect(validateCacheEntry(staleEntry, now, ttl).fresh).toBe(false);
  });

  it("uses CACHE_TTL_MS when ttlMs is omitted", () => {
    const entry = { data: 42, timestamp: now - (CACHE_TTL_MS - 1) };
    // no explicit ttlMs → should default to CACHE_TTL_MS and be fresh
    expect(validateCacheEntry(entry, now).fresh).toBe(true);
  });
});

describe("validateCacheEntry — typed data", () => {
  it("works with object payloads", () => {
    const now = Date.now();
    const entry = { data: { rankings: [{ address: "G123", score: 99 }] }, timestamp: now };
    const result = validateCacheEntry(entry, now);
    expect(result.fresh).toBe(true);
    expect(result.ageMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildCacheKey
// ---------------------------------------------------------------------------

describe("buildCacheKey", () => {
  it("produces the expected colon-delimited key", () => {
    expect(buildCacheKey("volume", "24h", 1, 20)).toBe("volume:24h:1:20");
  });

  it("differentiates type", () => {
    expect(buildCacheKey("volume", "7d", 1, 20)).not.toBe(
      buildCacheKey("holders", "7d", 1, 20),
    );
  });

  it("differentiates period", () => {
    expect(buildCacheKey("volume", "24h", 1, 20)).not.toBe(
      buildCacheKey("volume", "7d", 1, 20),
    );
  });

  it("differentiates page", () => {
    expect(buildCacheKey("volume", "24h", 1, 20)).not.toBe(
      buildCacheKey("volume", "24h", 2, 20),
    );
  });

  it("differentiates limit", () => {
    expect(buildCacheKey("volume", "24h", 1, 20)).not.toBe(
      buildCacheKey("volume", "24h", 1, 50),
    );
  });
});
