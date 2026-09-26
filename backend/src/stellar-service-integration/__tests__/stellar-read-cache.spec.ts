import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StellarCacheKeyBuilder, StellarReadCache } from "../stellar-read-cache";

vi.mock("@nestjs/common", () => ({
  Logger: class Logger {
    constructor(_context?: string) {}
  },
}));

describe("StellarReadCache", () => {
  let cache: StellarReadCache;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    cache = new StellarReadCache(100);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for missing and expired entries", () => {
    expect(cache.get("missing")).toBeNull();
    cache.set("short-lived", "value", 10);
    vi.advanceTimersByTime(11);

    expect(cache.get("short-lived")).toBeNull();
    expect(cache.getStats()).toEqual({ size: 0, keys: [] });
  });

  it("stores values with the default or a custom TTL", () => {
    cache.set("default", { account: "GABC" });
    cache.set("custom", "value", 20);

    expect(cache.get("default")).toEqual({ account: "GABC" });
    expect(cache.get("custom")).toBe("value");
    vi.advanceTimersByTime(21);
    expect(cache.get("custom")).toBeNull();
    expect(cache.get("default")).toEqual({ account: "GABC" });
  });

  it("invalidates an existing key and safely ignores a missing key", () => {
    cache.set("token:GABC", "token");

    cache.invalidate("not-present");
    expect(cache.get("token:GABC")).toBe("token");
    cache.invalidate("token:GABC");
    expect(cache.get("token:GABC")).toBeNull();
  });

  it("invalidates keys with an address prefix and preserves unrelated entries", () => {
    cache.set("GABC:account", 1);
    cache.set("GABC:contract:state", 2);
    cache.set("GXYZ:account", 3);

    cache.invalidateByAddress("GABC");

    expect(cache.getStats()).toEqual({ size: 1, keys: ["GXYZ:account"] });
  });

  it("clears all entries, including when called repeatedly", () => {
    cache.set("one", 1);
    cache.set("two", 2);

    cache.clear();
    cache.clear();

    expect(cache.getStats()).toEqual({ size: 0, keys: [] });
  });

  it("reports its current size and keys", () => {
    cache.set("token:GABC", "token");
    cache.set("account:GXYZ", "account");

    expect(cache.getStats()).toEqual({
      size: 2,
      keys: ["token:GABC", "account:GXYZ"],
    });
  });
});

describe("StellarCacheKeyBuilder", () => {
  it("builds keys for each supported query and preserves empty components", () => {
    expect(StellarCacheKeyBuilder.tokenInfo("GABC")).toBe("token:GABC");
    expect(StellarCacheKeyBuilder.account("GABC")).toBe("account:GABC");
    expect(StellarCacheKeyBuilder.factoryState()).toBe("factory:state");
    expect(StellarCacheKeyBuilder.transaction("HASH")).toBe("tx:HASH");
    expect(StellarCacheKeyBuilder.contractState("CONTRACT", "balance")).toBe(
      "contract:CONTRACT:balance"
    );
    expect(StellarCacheKeyBuilder.contractState("CONTRACT", "")).toBe(
      "contract:CONTRACT:"
    );
  });
});