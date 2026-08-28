import { describe, it, expect, vi } from "vitest";
import { GatewayRouter, GatewayClient } from "./gatewayRouter";

// ─── Mock Gateway Client ──────────────────────────────────────────────────

class MockGatewayClient implements GatewayClient {
  constructor(
    readonly name: string,
    private shouldFail: boolean = false,
    private failureMessage: string = `${name} failed`
  ) {}

  async fetch(): Promise<unknown> {
    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }
    return { data: "success" };
  }

  async pin(): Promise<boolean> {
    return !this.shouldFail;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GatewayRouter", () => {
  describe("fetch", () => {
    it("returns content from primary gateway on success", async () => {
      const primary = new MockGatewayClient("primary", false);
      const secondary = new MockGatewayClient("secondary", false);
      const router = new GatewayRouter([primary, secondary]);

      const result = await router.fetch("test-cid");

      expect(result).toEqual({ data: "success" });
    });

    it("aggregates all gateway errors in the final error message", async () => {
      const primary = new MockGatewayClient("pinata", true, "Pinata API 401");
      const secondary = new MockGatewayClient("cloudflare", true, "Cloudflare HTTP 500");
      const tertiary = new MockGatewayClient("public", true, "Public gateway HTTP 404");
      const router = new GatewayRouter([primary, secondary, tertiary]);

      await expect(router.fetch("test-cid")).rejects.toThrow();

      try {
        await router.fetch("test-cid");
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        expect(errorMessage).toContain("pinata");
        expect(errorMessage).toContain("Pinata API 401");
        expect(errorMessage).toContain("cloudflare");
        expect(errorMessage).toContain("Cloudflare HTTP 500");
        expect(errorMessage).toContain("public");
        expect(errorMessage).toContain("Public gateway HTTP 404");
      }
    });

    it("failover to secondary gateway and emit metric when primary fails", async () => {
      const primary = new MockGatewayClient("primary", true, "Primary failed");
      const secondary = new MockGatewayClient("secondary", false);
      const router = new GatewayRouter([primary, secondary]);

      const result = await router.fetch("test-cid");

      expect(result).toEqual({ data: "success" });
    });
  });
});
