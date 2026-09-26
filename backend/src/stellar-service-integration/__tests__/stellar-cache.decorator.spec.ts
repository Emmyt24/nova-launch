import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CacheStellarRead,
  getStellarCache,
  initializeStellarCache,
  InvalidateStellarCache,
} from "../stellar-cache.decorator";

type AsyncMethod = (...args: any[]) => Promise<unknown>;

function decorateRead(
  queryType: Parameters<typeof CacheStellarRead>[0],
  method: AsyncMethod,
  options?: Parameters<typeof CacheStellarRead>[1]
): AsyncMethod {
  const descriptor: PropertyDescriptor = { value: method, configurable: true };
  CacheStellarRead(queryType, options)({}, "read", descriptor);
  return descriptor.value as AsyncMethod;
}

function decorateWrite(
  queryType: Parameters<typeof InvalidateStellarCache>[0],
  method: AsyncMethod,
  addressArgIndex = 0
): AsyncMethod {
  const descriptor: PropertyDescriptor = { value: method, configurable: true };
  InvalidateStellarCache(queryType, addressArgIndex)({}, "write", descriptor);
  return descriptor.value as AsyncMethod;
}

describe("Stellar cache decorators", () => {
  beforeEach(() => {
    initializeStellarCache();
  });

  it("initializes a replacement cache and returns the shared instance", () => {
    const first = getStellarCache();
    const replacement = initializeStellarCache(500);

    expect(replacement).not.toBe(first);
    expect(getStellarCache()).toBe(replacement);
  });

  it("caches successful reads while preserving the method receiver", async () => {
    const original = vi.fn(async function (this: { prefix: string }, address: string) {
      return `${this.prefix}:${address}`;
    });
    const read = decorateRead("tokenInfo", original);
    const receiver = { prefix: "token", read };

    await expect(receiver.read("GABC")).resolves.toBe("token:GABC");
    await expect(receiver.read("GABC")).resolves.toBe("token:GABC");

    expect(original).toHaveBeenCalledOnce();
    expect(getStellarCache().get("token:GABC")).toBe("token:GABC");
  });

  it("does not cache failed reads", async () => {
    const original = vi.fn().mockRejectedValue(new Error("RPC unavailable"));
    const read = decorateRead("account", original);

    await expect(read("GABC")).rejects.toThrow("RPC unavailable");
    await expect(read("GABC")).rejects.toThrow("RPC unavailable");
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("bypasses cached values when a fresh read is requested", async () => {
    const original = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("fresh");
    const read = decorateRead("transaction", original, { fresh: true });

    await expect(read("HASH")).resolves.toBe("first");
    await expect(read("HASH")).resolves.toBe("fresh");
    expect(original).toHaveBeenCalledTimes(2);
    expect(getStellarCache().get("tx:HASH")).toBeNull();
  });

  it("uses the contract and key arguments for contract-state cache entries", async () => {
    const original = vi.fn().mockResolvedValue({ balance: 12 });
    const read = decorateRead("contractState", original);

    await read("CONTRACT", "balance");
    await read("CONTRACT", "balance");

    expect(original).toHaveBeenCalledOnce();
    expect(getStellarCache().get("contract:CONTRACT:balance")).toEqual({
      balance: 12,
    });
  });

  it("invalidates matching address entries after a successful write", async () => {
    const cache = getStellarCache();
    cache.set("GABC:account", "stale-account");
    cache.set("GABC:token", "stale-token");
    cache.set("GXYZ:account", "other-account");
    const write = decorateWrite("account", vi.fn().mockResolvedValue("saved"));

    await expect(write("GABC")).resolves.toBe("saved");

    expect(cache.get("GABC:account")).toBeNull();
    expect(cache.get("GABC:token")).toBeNull();
    expect(cache.get("GXYZ:account")).toBe("other-account");
  });

  it("clears all entries for the all-invalidation mode", async () => {
    const cache = getStellarCache();
    cache.set("token:GABC", "token");
    const write = decorateWrite("all", vi.fn().mockResolvedValue("saved"));

    await write("GABC");

    expect(cache.getStats()).toEqual({ size: 0, keys: [] });
  });

  it("preserves cache entries when a write fails", async () => {
    const cache = getStellarCache();
    cache.set("GABC:account", "cached");
    const write = decorateWrite(
      "account",
      vi.fn().mockRejectedValue(new Error("write failed"))
    );

    await expect(write("GABC")).rejects.toThrow("write failed");
    expect(cache.get("GABC:account")).toBe("cached");
  });
});