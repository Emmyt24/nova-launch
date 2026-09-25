import { describe, it, expect } from "vitest";
import {
  InMemoryFencingTokenStore,
  createFencingToken,
  withFencingToken,
} from "../fencingToken";

describe("FencingTokenStore", () => {
  describe("InMemoryFencingTokenStore.markProcessed idempotency", () => {
    it("markProcessed is idempotent: calling twice does not throw", async () => {
      const store = new InMemoryFencingTokenStore();
      const tokenId = "1234567:0";

      // First call
      await expect(store.markProcessed(tokenId)).resolves.toBeUndefined();

      // Second call with same token should not throw
      await expect(store.markProcessed(tokenId)).resolves.toBeUndefined();
    });

    it("markProcessed second call is a no-op: isProcessed returns true both times", async () => {
      const store = new InMemoryFencingTokenStore();
      const tokenId = "7654321:5";

      await store.markProcessed(tokenId);
      const firstCheck = await store.isProcessed(tokenId);
      expect(firstCheck).toBe(true);

      // Second mark should not affect the stored state
      await store.markProcessed(tokenId);
      const secondCheck = await store.isProcessed(tokenId);
      expect(secondCheck).toBe(true);
    });

    it("withFencingToken does not throw when called twice with the same token", async () => {
      const store = new InMemoryFencingTokenStore();
      const token = createFencingToken(1234567, 0);
      let callCount = 0;

      const handler = async () => {
        callCount++;
        return "result";
      };

      // First call should execute the handler
      const firstResult = await withFencingToken(store, token, handler);
      expect(firstResult.skipped).toBe(false);
      expect(callCount).toBe(1);

      // Second call should skip (token already processed)
      const secondResult = await withFencingToken(store, token, handler);
      expect(secondResult.skipped).toBe(true);
      expect(callCount).toBe(1); // Handler not called again
    });
  });

  describe("InMemoryFencingTokenStore basic operations", () => {
    it("isProcessed returns false for tokens not in the store", async () => {
      const store = new InMemoryFencingTokenStore();
      const result = await store.isProcessed("nonexistent:0");
      expect(result).toBe(false);
    });

    it("markProcessed and isProcessed work together", async () => {
      const store = new InMemoryFencingTokenStore();
      const tokenId = "999:123";

      const beforeMark = await store.isProcessed(tokenId);
      expect(beforeMark).toBe(false);

      await store.markProcessed(tokenId);

      const afterMark = await store.isProcessed(tokenId);
      expect(afterMark).toBe(true);
    });

    it("remove deletes a token from the store", async () => {
      const store = new InMemoryFencingTokenStore();
      const tokenId = "500:10";

      await store.markProcessed(tokenId);
      expect(await store.isProcessed(tokenId)).toBe(true);

      await store.remove(tokenId);
      expect(await store.isProcessed(tokenId)).toBe(false);
    });

    it("size returns the current number of entries", async () => {
      const store = new InMemoryFencingTokenStore();

      expect(await store.size()).toBe(0);

      await store.markProcessed("1:0");
      expect(await store.size()).toBe(1);

      await store.markProcessed("2:0");
      expect(await store.size()).toBe(2);

      await store.remove("1:0");
      expect(await store.size()).toBe(1);
    });
  });

  describe("TTL expiry", () => {
    it("tokens expire after the TTL period", async () => {
      const ttlMs = 100;
      const store = new InMemoryFencingTokenStore(ttlMs);
      const tokenId = "expired:0";

      await store.markProcessed(tokenId);
      expect(await store.isProcessed(tokenId)).toBe(true);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, ttlMs + 10));

      expect(await store.isProcessed(tokenId)).toBe(false);
    });

    it("TTL of 0 means no expiry", async () => {
      const store = new InMemoryFencingTokenStore(0);
      const tokenId = "noexpiry:0";

      await store.markProcessed(tokenId);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should still be present
      expect(await store.isProcessed(tokenId)).toBe(true);
    });
  });
});
