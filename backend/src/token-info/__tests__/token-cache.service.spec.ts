import { describe, it, expect, vi, beforeEach } from "vitest";
import { TokenCacheService } from "../token-cache.service";
import { Token } from "../token.interface";

function createStatefulCacheManager() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

const mockToken: Token = {
  basicInfo: {
    name: "TEST",
    symbol: "TEST",
    decimals: 7,
    address: "GABCDE",
  },
  supplyInfo: { total: "1000000", initial: "1000000", circulating: "900000" },
  burnInfo: { totalBurned: "0", burnCount: 0, percentBurned: "0" },
  creator: { address: "GABCDE", createdAt: "2024-01-01T00:00:00Z" },
  analytics: { volume24h: "0", volume7d: "0" },
};

describe("TokenCacheService — generalized invalidation", () => {
  let cacheManager: ReturnType<typeof createStatefulCacheManager>;
  let service: TokenCacheService;

  beforeEach(() => {
    cacheManager = createStatefulCacheManager();
    service = new TokenCacheService(cacheManager as any);
  });

  it("invalidates an include combination that isn't one of the 5 hardcoded ones", async () => {
    const address = "GABCDE";
    const include = ["metadata", "burns"]; // not in the hardcoded list
    const key = service.buildKey(address, include);

    await service.set(key, mockToken);
    expect(await service.get(key)).toEqual(mockToken);

    await service.invalidate(address);

    expect(await service.get(key)).toBeNull();
  });

  it("still invalidates the previously hardcoded combinations", async () => {
    const address = "GABCDE";
    const key = service.buildKey(address, ["metadata", "burns", "analytics"]);

    await service.set(key, mockToken);
    await service.invalidate(address);

    expect(await service.get(key)).toBeNull();
  });

  it("does not invalidate a different address's cached entries", async () => {
    const key = service.buildKey("OTHERADDRESS", ["metadata"]);
    await service.set(key, mockToken);

    await service.invalidate("GABCDE");

    expect(await service.get(key)).toEqual(mockToken);
  });
});
