/**
 * Unit tests for the token-info StellarService.
 *
 * Issue: #1877 — this Horizon-facing service had no dedicated test file. The
 * HTTP client is mocked (rxjs Observables via `of` / `throwError`); no real
 * network calls are made. Each public method is covered for both its success
 * path and at least one realistic failure mode.
 *
 * `@nestjs/common` is stubbed because only its `Logger` is used as a runtime
 * value and the package is not installed in this workspace; `ConfigService` /
 * `HttpService` are type-only imports in the service and need no stub.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { of, throwError } from "rxjs";

vi.mock("@nestjs/common", () => ({
  Injectable: () => (target: unknown) => target,
  Logger: class {
    log() {}
    error() {}
    warn() {}
    debug() {}
    verbose() {}
  },
}));

const { StellarService } = await import("../stellar.service");

const HORIZON_URL = "https://horizon-testnet.stellar.org";

function makeResponse<T>(data: T) {
  return { data, status: 200, statusText: "OK", headers: {}, config: {} };
}

function createService() {
  const httpService = { get: vi.fn() };
  const configService = {
    get: vi.fn((key: string) =>
      key === "STELLAR_HORIZON_URL" ? HORIZON_URL : undefined
    ),
  };
  const service = new StellarService(
    configService as never,
    httpService as never
  );
  return { service, httpService, configService };
}

describe("StellarService (token-info)", () => {
  let ctx: ReturnType<typeof createService>;

  beforeEach(() => {
    ctx = createService();
  });

  // ── parseAddress ────────────────────────────────────────────────────────
  describe("parseAddress", () => {
    it("splits a CODE:ISSUER pair", () => {
      expect(ctx.service.parseAddress("USDC:GISSUER")).toEqual({
        assetCode: "USDC",
        assetIssuer: "GISSUER",
      });
    });

    it("treats a bare address as the issuer of an unknown asset", () => {
      expect(ctx.service.parseAddress("GISSUERONLY")).toEqual({
        assetCode: "UNKNOWN",
        assetIssuer: "GISSUERONLY",
      });
    });
  });

  // ── getAssetData ────────────────────────────────────────────────────────
  describe("getAssetData", () => {
    it("returns the first Horizon asset record on success", async () => {
      const record = { asset_code: "USDC", asset_issuer: "GISSUER", amount: "10" };
      ctx.httpService.get.mockReturnValue(
        of(makeResponse({ _embedded: { records: [record] } }))
      );

      const result = await ctx.service.getAssetData("USDC", "GISSUER");

      expect(result).toEqual(record);
      expect(ctx.httpService.get).toHaveBeenCalledWith(
        `${HORIZON_URL}/assets?asset_code=USDC&asset_issuer=GISSUER&limit=1`
      );
    });

    it("returns null when Horizon has no matching asset", async () => {
      ctx.httpService.get.mockReturnValue(
        of(makeResponse({ _embedded: { records: [] } }))
      );

      expect(await ctx.service.getAssetData("FAKE", "GISSUER")).toBeNull();
    });

    it("returns null when the Horizon request fails", async () => {
      ctx.httpService.get.mockReturnValue(
        throwError(() => new Error("network down"))
      );

      expect(await ctx.service.getAssetData("USDC", "GISSUER")).toBeNull();
    });

    it("returns null on a malformed Horizon payload (missing _embedded)", async () => {
      ctx.httpService.get.mockReturnValue(of(makeResponse({})));

      expect(await ctx.service.getAssetData("USDC", "GISSUER")).toBeNull();
    });
  });

  // ── getAssetCreationInfo ────────────────────────────────────────────────
  describe("getAssetCreationInfo", () => {
    it("returns creator + timestamp from the create_account operation", async () => {
      ctx.httpService.get.mockReturnValue(
        of(
          makeResponse({
            _embedded: {
              records: [
                {
                  type: "create_account",
                  created_at: "2023-01-02T03:04:05Z",
                  source_account: "GCREATOR",
                },
              ],
            },
          })
        )
      );

      const result = await ctx.service.getAssetCreationInfo("USDC", "GISSUER");

      expect(result).toEqual({
        creatorAddress: "GCREATOR",
        createdAt: "2023-01-02T03:04:05Z",
      });
    });

    it("falls back to the issuer as creator when no operations are returned", async () => {
      ctx.httpService.get.mockReturnValue(
        of(makeResponse({ _embedded: { records: [] } }))
      );

      const result = await ctx.service.getAssetCreationInfo("USDC", "GISSUER");

      expect(result?.creatorAddress).toBe("GISSUER");
      expect(typeof result?.createdAt).toBe("string");
    });

    it("falls back to the issuer as creator when the request fails", async () => {
      ctx.httpService.get.mockReturnValue(
        throwError(() => new Error("horizon 500"))
      );

      const result = await ctx.service.getAssetCreationInfo("USDC", "GISSUER");

      expect(result?.creatorAddress).toBe("GISSUER");
    });
  });

  // ── getBurnStatistics ──────────────────────────────────────────────────
  describe("getBurnStatistics", () => {
    it("sums payments sent to the issuer and computes the burned percentage", async () => {
      ctx.httpService.get.mockReturnValue(
        of(
          makeResponse({
            _embedded: {
              records: [
                { type: "payment", asset_code: "USDC", to: "GISSUER", amount: "500" },
                { type: "payment", asset_code: "USDC", to: "GISSUER", amount: "300" },
                // not a burn — recipient is not the issuer
                { type: "payment", asset_code: "USDC", to: "GOTHER", amount: "100" },
                // not a burn — different asset
                { type: "payment", asset_code: "EURC", to: "GISSUER", amount: "999" },
              ],
            },
          })
        )
      );

      const result = await ctx.service.getBurnStatistics("USDC", "GISSUER", "10000");

      expect(result.burnCount).toBe(2);
      expect(result.totalBurned).toBe("800.0000000");
      expect(result.percentBurned).toBe("8.0000");
    });

    it('reports "0.0000" burned percentage when total supply is zero', async () => {
      ctx.httpService.get.mockReturnValue(
        of(
          makeResponse({
            _embedded: {
              records: [
                { type: "payment", asset_code: "USDC", to: "GISSUER", amount: "5" },
              ],
            },
          })
        )
      );

      const result = await ctx.service.getBurnStatistics("USDC", "GISSUER", "0");

      expect(result.percentBurned).toBe("0.0000");
      expect(result.burnCount).toBe(1);
    });

    it("returns zeroed stats when the Horizon request fails", async () => {
      ctx.httpService.get.mockReturnValue(
        throwError(() => new Error("timeout"))
      );

      expect(
        await ctx.service.getBurnStatistics("USDC", "GISSUER", "10000")
      ).toEqual({ totalBurned: "0", burnCount: 0, percentBurned: "0.0000" });
    });
  });

  // ── getVolumeData ──────────────────────────────────────────────────────
  describe("getVolumeData", () => {
    it("splits trade volume into 24h and 7d buckets", async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const threeDaysAgo = new Date(
        Date.now() - 3 * 24 * 60 * 60 * 1000
      ).toISOString();

      ctx.httpService.get.mockReturnValue(
        of(
          makeResponse({
            _embedded: {
              records: [
                { base_amount: "1000", counter_amount: "1", ledger_close_time: oneHourAgo },
                { base_amount: "500", counter_amount: "1", ledger_close_time: threeDaysAgo },
              ],
            },
          })
        )
      );

      const result = await ctx.service.getVolumeData("USDC", "GISSUER");

      expect(result.volume24h).toBe("1000.0000000");
      expect(result.volume7d).toBe("1500.0000000");
      expect(result.txCount24h).toBe(1);
    });

    it("returns zeroed volume when the Horizon request fails", async () => {
      ctx.httpService.get.mockReturnValue(
        throwError(() => new Error("connection reset"))
      );

      expect(await ctx.service.getVolumeData("USDC", "GISSUER")).toEqual({
        volume24h: "0",
        volume7d: "0",
        txCount24h: 0,
      });
    });
  });
});
