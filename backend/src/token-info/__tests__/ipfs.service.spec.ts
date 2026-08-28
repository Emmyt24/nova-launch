/**
 * Unit tests for `token-info/ipfs.service.ts` (issue #1876).
 *
 * ── Relationship to lib/ipfs ────────────────────────────────────────────────
 * This service is a *parallel* IPFS implementation that DUPLICATES, rather than
 * composes, the hardened handling already in `src/lib/ipfs`:
 *
 *   - It resolves an IPFS hash / `ipfs://` URI / raw CID to a single gateway URL
 *     and does a plain HTTP GET.
 *   - It does NOT perform the CID content-integrity check that
 *     `lib/ipfs/cidVerification.ts` (`verifyCIDContent`) provides.
 *   - It does NOT do the priority-ordered multi-gateway failover that
 *     `lib/ipfs/gatewayRouter.ts` provides — a single gateway failure just
 *     returns `null`.
 *
 * This divergence is flagged here for a future consolidation decision: the
 * token-info metadata fetch could instead go through the `lib/ipfs` gateway
 * router + CID verification path.
 *
 * ── Test setup notes ────────────────────────────────────────────────────────
 * - All network access is mocked: `HttpService.get` is a `vi.fn()` returning a
 *   controlled rxjs stream. No real IPFS gateway is contacted.
 * - The service imports `@nestjs/common`, `@nestjs/config` and `@nestjs/axios`,
 *   which are not installed in this package. They are stubbed with `vi.mock`
 *   below so the real service module can be exercised directly. The structure
 *   mirrors `src/__tests__/cidVerification.test.ts` (mocked fetch, success +
 *   failure paths per public method).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { of, throwError } from "rxjs";

vi.mock("@nestjs/common", () => ({
  Injectable: () => (target: unknown) => target,
  Logger: class {
    warn = vi.fn();
    log = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));
vi.mock("@nestjs/config", () => ({ ConfigService: class {} }));
vi.mock("@nestjs/axios", () => ({ HttpService: class {} }));

// Imported after the mocks are registered.
import { IpfsService } from "../ipfs.service";

const DEFAULT_GATEWAY = "https://ipfs.io/ipfs";

function makeConfig(values: Record<string, unknown> = {}) {
  const config: Record<string, unknown> = {
    IPFS_GATEWAY_URL: DEFAULT_GATEWAY,
    IPFS_TIMEOUT_MS: 5000,
    ...values,
  };
  return { get: vi.fn((key: string) => config[key]) };
}

function makeHttp() {
  return { get: vi.fn() };
}

function makeResponse<T>(data: T) {
  return {
    data,
    status: 200,
    statusText: "OK",
    headers: {},
    config: { headers: {} },
  };
}

function makeService(configValues?: Record<string, unknown>) {
  const config = makeConfig(configValues);
  const http = makeHttp();
  const service = new IpfsService(config as never, http as never);
  return { service, config, http };
}

describe("IpfsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("resolveUrl", () => {
    it("returns http/https URLs unchanged", () => {
      const { service } = makeService();
      expect(service.resolveUrl("https://example.com/meta.json")).toBe(
        "https://example.com/meta.json"
      );
      expect(service.resolveUrl("http://example.com/meta.json")).toBe(
        "http://example.com/meta.json"
      );
    });

    it("rewrites ipfs:// URIs to the configured gateway", () => {
      const { service } = makeService();
      expect(service.resolveUrl("ipfs://QmHash123")).toBe(
        `${DEFAULT_GATEWAY}/QmHash123`
      );
    });

    it("rewrites raw Qm... CIDs to the configured gateway", () => {
      const { service } = makeService();
      expect(service.resolveUrl("QmHash456")).toBe(
        `${DEFAULT_GATEWAY}/QmHash456`
      );
    });

    it("rewrites raw bafy... CIDs to the configured gateway", () => {
      const { service } = makeService();
      const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
      expect(service.resolveUrl(cid)).toBe(`${DEFAULT_GATEWAY}/${cid}`);
    });

    it("honours a custom IPFS_GATEWAY_URL from config", () => {
      const { service } = makeService({
        IPFS_GATEWAY_URL: "https://gateway.pinata.cloud/ipfs",
      });
      expect(service.resolveUrl("ipfs://QmHash123")).toBe(
        "https://gateway.pinata.cloud/ipfs/QmHash123"
      );
    });

    it("returns null for empty input", () => {
      const { service } = makeService();
      expect(service.resolveUrl("")).toBeNull();
    });

    it("returns null for an unrecognised format", () => {
      const { service } = makeService();
      expect(service.resolveUrl("notavalidhash")).toBeNull();
    });
  });

  describe("fetchMetadata — success paths", () => {
    it("fetches and maps metadata (external_url -> externalUrl)", async () => {
      const { service, http } = makeService();
      http.get.mockReturnValue(
        of(
          makeResponse({
            image: "https://example.com/img.png",
            description: "My token",
            external_url: "https://mytoken.com",
            attributes: [{ trait_type: "rarity", value: "rare" }],
          })
        )
      );

      const result = await service.fetchMetadata("ipfs://QmHash123");

      expect(result).toEqual({
        image: "https://example.com/img.png",
        description: "My token",
        externalUrl: "https://mytoken.com",
        attributes: [{ trait_type: "rarity", value: "rare" }],
      });
    });

    it("requests the resolved gateway URL with the configured timeout", async () => {
      const { service, http } = makeService({ IPFS_TIMEOUT_MS: 1234 });
      http.get.mockReturnValue(of(makeResponse({})));

      await service.fetchMetadata("QmHash456");

      expect(http.get).toHaveBeenCalledTimes(1);
      expect(http.get).toHaveBeenCalledWith(`${DEFAULT_GATEWAY}/QmHash456`, {
        timeout: 1234,
      });
    });

    it("drops non-string scalar fields during sanitisation", async () => {
      const { service, http } = makeService();
      http.get.mockReturnValue(
        of(makeResponse({ image: 123, description: null }))
      );

      const result = await service.fetchMetadata("https://example.com/meta.json");

      expect(result?.image).toBeUndefined();
      expect(result?.description).toBeUndefined();
    });

    it("drops a non-array attributes field", async () => {
      const { service, http } = makeService();
      http.get.mockReturnValue(
        of(makeResponse({ attributes: { not: "an array" } }))
      );

      const result = await service.fetchMetadata("https://example.com/meta.json");

      expect(result?.attributes).toBeUndefined();
    });

    it("returns an empty object when the gateway returns a non-object body", async () => {
      const { service, http } = makeService();
      http.get.mockReturnValue(of(makeResponse("plain text, not json")));

      const result = await service.fetchMetadata("https://example.com/meta.json");

      expect(result).toEqual({});
    });
  });

  describe("fetchMetadata — failure / error paths", () => {
    it("returns null for empty input without touching the network", async () => {
      const { service, http } = makeService();
      expect(await service.fetchMetadata("")).toBeNull();
      expect(http.get).not.toHaveBeenCalled();
    });

    it("returns null for an unresolvable hash without touching the network", async () => {
      const { service, http } = makeService();
      expect(await service.fetchMetadata("not-a-valid-reference")).toBeNull();
      expect(http.get).not.toHaveBeenCalled();
    });

    it("swallows a gateway/transport error and returns null", async () => {
      const { service, http } = makeService();
      http.get.mockReturnValue(throwError(() => new Error("ECONNRESET")));

      const result = await service.fetchMetadata("QmHash123");

      expect(result).toBeNull();
    });

    it("returns null when the gateway request times out", async () => {
      const { service, http } = makeService();
      http.get.mockReturnValue(
        throwError(() => new Error("timeout of 5000ms exceeded"))
      );

      const result = await service.fetchMetadata("ipfs://QmHash123");

      expect(result).toBeNull();
    });
  });
});
