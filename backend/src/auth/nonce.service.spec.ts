/**
 * nonce.service.spec.ts
 *
 * Tests for the Redis-backed NonceService.  The Redis client is injected so
 * these tests run entirely in-memory with no real Redis connection required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NonceService } from "./nonce.service";
import { AUTH_CONSTANTS } from "./auth.constants";

// ---------------------------------------------------------------------------
// Minimal in-memory Redis mock
// ---------------------------------------------------------------------------

type StoreValue = { value: string; expiresAt: number };

function buildRedisMock() {
  const store = new Map<string, StoreValue>();

  const get = vi.fn(async (key: string): Promise<string | null> => {
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value;
  });

  const set = vi.fn(
    async (
      key: string,
      value: string,
      exFlag?: string,
      ttlSeconds?: number
    ): Promise<string> => {
      const expiresAt =
        exFlag === "EX" && ttlSeconds
          ? Date.now() + ttlSeconds * 1000
          : Infinity;
      store.set(key, { value, expiresAt });
      return "OK";
    }
  );

  const del = vi.fn(async (key: string): Promise<number> => {
    return store.delete(key) ? 1 : 0;
  });

  const scan = vi.fn(
    async (
      _cursor: string,
      _matchFlag: string,
      _pattern: string,
      _countFlag: string,
      _count: number
    ): Promise<[string, string[]]> => {
      return ["0", []];
    }
  );

  /**
   * eval simulates the Lua consume-nonce script by running equivalent JS
   * logic against the same in-memory store.
   */
  const eval_ = vi.fn(
    async (
      _script: string,
      _numkeys: number,
      key: string,
      publicKey: string
    ): Promise<number> => {
      const raw = await get(key);
      if (!raw) return -1;

      const entry = JSON.parse(raw) as {
        publicKey: string;
        expiresAt: number;
        used: boolean;
      };

      if (entry.used) return -2;
      if (entry.publicKey !== publicKey) return -3;

      entry.used = true;
      // KEEPTTL simulation: preserve existing expiry
      const existing = store.get(key);
      const expiresAt = existing ? existing.expiresAt : Infinity;
      store.set(key, { value: JSON.stringify(entry), expiresAt });
      return 1;
    }
  );

  const disconnect = vi.fn();

  return {
    store,
    get,
    set,
    del,
    scan,
    eval: eval_,
    disconnect,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NonceService (Redis-backed)", () => {
  let service: NonceService;
  let redisMock: ReturnType<typeof buildRedisMock>;

  beforeEach(() => {
    redisMock = buildRedisMock();
    // Cast to `any` so the constructor accepts our minimal mock shape
    service = new NonceService(redisMock as unknown as import("ioredis").Redis);
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // generateNonce
  // -------------------------------------------------------------------------
  describe("generateNonce", () => {
    it("returns a nonce, future expiresAt and a message containing the nonce", () => {
      const result = service.generateNonce("GPUBKEY1");
      expect(result.nonce).toBeTruthy();
      expect(result.expiresAt).toBeGreaterThan(Date.now());
      expect(result.message).toContain(result.nonce);
    });

    it("generates a unique nonce on each call", () => {
      const r1 = service.generateNonce("GPUBKEY1");
      const r2 = service.generateNonce("GPUBKEY1");
      expect(r1.nonce).not.toBe(r2.nonce);
    });

    it("sets expiry within expected window", () => {
      const before = Date.now();
      const result = service.generateNonce("GPUBKEY1");
      const after = Date.now();

      expect(result.expiresAt).toBeGreaterThanOrEqual(
        before + AUTH_CONSTANTS.NONCE_EXPIRY_MS - 10
      );
      expect(result.expiresAt).toBeLessThanOrEqual(
        after + AUTH_CONSTANTS.NONCE_EXPIRY_MS + 10
      );
    });

    it("stores the nonce in Redis via SET EX", async () => {
      const result = service.generateNonce("GPUBKEY1");
      // Allow the fire-and-forget promise to settle
      await new Promise((r) => setImmediate(r));

      expect(redisMock.set).toHaveBeenCalledWith(
        `nonce:${result.nonce}`,
        expect.any(String),
        "EX",
        300
      );
    });
  });

  // -------------------------------------------------------------------------
  // consumeNonce
  // -------------------------------------------------------------------------
  describe("consumeNonce", () => {
    it("returns true for a fresh, valid nonce", async () => {
      const { nonce } = service.generateNonce("GPUBKEY1");
      await new Promise((r) => setImmediate(r)); // let SET settle

      await expect(service.consumeNonce(nonce, "GPUBKEY1")).resolves.toBe(true);
    });

    it("returns false on second consumption (replay protection)", async () => {
      const { nonce } = service.generateNonce("GPUBKEY1");
      await new Promise((r) => setImmediate(r));

      await service.consumeNonce(nonce, "GPUBKEY1"); // first — should succeed
      await expect(service.consumeNonce(nonce, "GPUBKEY1")).resolves.toBe(
        false
      );
    });

    it("returns false for an unknown / never-issued nonce", async () => {
      await expect(
        service.consumeNonce("00000000-dead-beef-0000-000000000000", "GPUBKEY1")
      ).resolves.toBe(false);
    });

    it("returns false for a wrong public key", async () => {
      const { nonce } = service.generateNonce("GPUBKEY1");
      await new Promise((r) => setImmediate(r));

      await expect(service.consumeNonce(nonce, "GDIFFERENTKEY")).resolves.toBe(
        false
      );
    });

    it("returns false for an expired nonce", async () => {
      const { nonce } = service.generateNonce("GPUBKEY1");
      await new Promise((r) => setImmediate(r));

      // Force-expire the entry in the mock store
      const key = `nonce:${nonce}`;
      const existing = redisMock.store.get(key)!;
      redisMock.store.set(key, { ...existing, expiresAt: Date.now() - 1 });

      await expect(service.consumeNonce(nonce, "GPUBKEY1")).resolves.toBe(
        false
      );
    });

    it("returns false and logs an error when Redis throws", async () => {
      const { nonce } = service.generateNonce("GPUBKEY1");
      await new Promise((r) => setImmediate(r));

      redisMock.eval.mockRejectedValueOnce(new Error("Redis connection lost"));

      await expect(service.consumeNonce(nonce, "GPUBKEY1")).resolves.toBe(
        false
      );
    });
  });
});
