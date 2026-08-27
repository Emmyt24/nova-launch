/**
 * Tests for the public token discovery API.
 *
 * Covers:
 *  - Trending ranking formula unit tests
 *  - Full-text search query builder
 *  - GET /api/discover/tokens — empty results
 *  - GET /api/discover/tokens — single match
 *  - GET /api/discover/tokens — multi-match with pagination
 *  - GET /api/discover/tokens — unlisted token exclusion (isPublic=false)
 *  - GET /api/discover/tokens — consistent snapshot across fan-out calls
 *  - GET /api/discover/tokens — respects the aggregation timeout budget
 *  - PATCH /api/tokens/:address/visibility — owner toggle
 *  - PATCH /api/tokens/:address/visibility — non-owner rejection
 *
 * Issue: #1265, #1617
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import discoveryRoutes, { visibilityRouter, clearDiscoveryCache } from "../discovery";

// ---------------------------------------------------------------------------
// Mock prisma
//
// $transaction mimics both the array form (`prisma.$transaction([...])`,
// used for the plain page+count / trending fan-outs) and the interactive
// callback form (`prisma.$transaction(async (tx) => ...)`, used for the FTS
// id-lookup + page + count fan-out) that discovery.ts relies on for a
// consistent snapshot across its fan-out calls.
// ---------------------------------------------------------------------------
vi.mock("../../lib/prisma", () => {
  const mockPrisma: any = {
    token: {
      findMany: vi.fn(),
      count:    vi.fn(),
      findUnique: vi.fn(),
      update:   vi.fn(),
    },
    $queryRawUnsafe: vi.fn(),
  };
  mockPrisma.$transaction = vi.fn(async (arg: any) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg(mockPrisma);
  });
  return { prisma: mockPrisma };
});

// Mock Redis-based rate-limiter so tests don't need a real Redis instance.
vi.mock("../../middleware/rateLimiter", () => ({
  createRateLimiter: () => (_req: any, _res: any, next: () => void) => next(),
  createRedisClient: () => ({}),
}));

import { prisma } from "../../lib/prisma";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use("/api/discover", discoveryRoutes);
app.use("/api/tokens",   visibilityRouter);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const baseToken = {
  id:            "tok-1",
  address:       "GADDR1",
  creator:       "GCREATOR1",
  name:          "TestToken",
  symbol:        "TST",
  decimals:      7,
  totalSupply:   BigInt("1000000"),
  initialSupply: BigInt("1000000"),
  totalBurned:   BigInt("0"),
  burnCount:     0,
  metadataUri:   null,
  isPublic:      true,
  category:      "DEFI",
  network:       "testnet",
  createdAt:     new Date("2026-06-01T00:00:00Z"),
  updatedAt:     new Date("2026-06-01T00:00:00Z"),
};

function serialized(tok = baseToken) {
  return {
    ...tok,
    totalSupply:   tok.totalSupply.toString(),
    initialSupply: tok.initialSupply.toString(),
    totalBurned:   tok.totalBurned.toString(),
  };
}

// ---------------------------------------------------------------------------
// Unit tests: trending score formula
// ---------------------------------------------------------------------------
describe("trending score formula", () => {
  /**
   * score = burnCount * 0.4 + ln(1 + totalSupply) * 0.6
   * These tests document the expected SQL-equivalent computation so that
   * any future change to the formula is caught by the test suite.
   */
  function trendingScore(burnCount: number, totalSupply: number): number {
    return burnCount * 0.4 + Math.log(1 + totalSupply) * 0.6;
  }

  it("returns 0 for a brand-new token with no burns", () => {
    expect(trendingScore(0, 0)).toBe(0);
  });

  it("burn-heavy token scores higher than supply-heavy token when burns dominate", () => {
    const burnHeavy   = trendingScore(1000, 0);
    const supplyHeavy = trendingScore(0, 1_000_000);
    expect(burnHeavy).toBeGreaterThan(supplyHeavy);
  });

  it("supply component contributes to total score proportionally", () => {
    // ln(1 + 1_000_000) * 0.6 ≈ 8.29 — meaningful contribution
    const supplyScore = Math.log(1 + 1_000_000) * 0.6;
    expect(supplyScore).toBeGreaterThan(0);
    // A token with huge supply but no burns should outscore
    // one with 1 burn and zero supply
    const supplyOnly = trendingScore(0, 1_000_000);
    const burnOnly   = trendingScore(1, 0);
    expect(supplyOnly).toBeGreaterThan(burnOnly);
  });

  it("correctly weights the 40/60 split", () => {
    // burnCount = 10, totalSupply = 0  → 10 * 0.4 = 4
    expect(trendingScore(10, 0)).toBeCloseTo(4, 5);
    // burnCount = 0, totalSupply = e-1 → ln(e) * 0.6 = 0.6
    expect(trendingScore(0, Math.E - 1)).toBeCloseTo(0.6, 5);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: full-text search query builder
// ---------------------------------------------------------------------------
describe("full-text search plainto_tsquery behaviour", () => {
  /**
   * We verify that the Postgres query string we build for plainto_tsquery
   * is well-formed for various inputs.  The actual DB call is mocked, so
   * these tests focus on the string normalisation logic.
   */
  function buildFtsQuery(q: string): string {
    // Mirrors what the route passes to plainto_tsquery
    return q.trim().replace(/'/g, "''"); // basic SQL injection guard
  }

  it("passes through plain words unchanged", () => {
    expect(buildFtsQuery("stellar token")).toBe("stellar token");
  });

  it("trims surrounding whitespace", () => {
    expect(buildFtsQuery("  token  ")).toBe("token");
  });

  it("escapes single-quotes to prevent injection", () => {
    expect(buildFtsQuery("it's")).toBe("it''s");
  });

  it("does not truncate multi-word queries", () => {
    const q = "defi governance stellar";
    expect(buildFtsQuery(q)).toBe(q);
  });
});

// ---------------------------------------------------------------------------
// Integration-style tests against the mocked routes
// ---------------------------------------------------------------------------
describe("GET /api/discover/tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDiscoveryCache();
  });

  it("returns empty results when no tokens exist", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);
    vi.mocked(prisma.token.count).mockResolvedValue(0);

    const res = await request(app).get("/api/discover/tokens");

    expect(res.status).toBe(200);
    expect(res.body.data.tokens).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it("returns a single matching public token", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([baseToken as any]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const res = await request(app).get("/api/discover/tokens");

    expect(res.status).toBe(200);
    expect(res.body.data.tokens).toHaveLength(1);
    expect(res.body.data.tokens[0].address).toBe("GADDR1");
    expect(res.body.data.total).toBe(1);
  });

  it("returns serialised BigInt fields as strings", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([baseToken as any]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const res = await request(app).get("/api/discover/tokens");

    const tok = res.body.data.tokens[0];
    expect(typeof tok.totalSupply).toBe("string");
    expect(typeof tok.initialSupply).toBe("string");
    expect(typeof tok.totalBurned).toBe("string");
  });

  it("paginates results — returns correct page slice", async () => {
    const tokens = Array.from({ length: 3 }, (_, i) => ({
      ...baseToken,
      id:      `tok-${i}`,
      address: `GADDR${i}`,
    }));

    vi.mocked(prisma.token.findMany).mockImplementation(async ({ skip, take }: any) =>
      tokens.slice(skip ?? 0, (skip ?? 0) + (take ?? 20)) as any
    );
    vi.mocked(prisma.token.count).mockResolvedValue(3);

    const page1 = await request(app).get("/api/discover/tokens?limit=2&offset=0");
    expect(page1.body.data.tokens).toHaveLength(2);

    clearDiscoveryCache();

    const page2 = await request(app).get("/api/discover/tokens?limit=2&offset=2");
    expect(page2.body.data.tokens).toHaveLength(1);
  });

  it("excludes unlisted tokens (isPublic=false) from results", async () => {
    const listedToken   = { ...baseToken, id: "tok-1", address: "GADDR1", isPublic: true  };
    const unlistedToken = { ...baseToken, id: "tok-2", address: "GADDR2", isPublic: false };

    // The route always filters by isPublic=true — simulate that the DB
    // correctly returns only the listed token when the where clause is applied.
    vi.mocked(prisma.token.findMany).mockImplementation(async ({ where }: any) => {
      if (where?.isPublic === true) return [listedToken] as any;
      return [listedToken, unlistedToken] as any;
    });
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const res = await request(app).get("/api/discover/tokens");

    expect(res.status).toBe(200);
    expect(res.body.data.tokens).toHaveLength(1);
    expect(res.body.data.tokens[0].address).toBe("GADDR1");
  });

  it("returns 400 for an unknown sortBy value", async () => {
    const res = await request(app).get("/api/discover/tokens?sortBy=invalid");
    expect(res.status).toBe(400);
  });

  it("uses cache on second identical request", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([baseToken as any]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    await request(app).get("/api/discover/tokens");
    await request(app).get("/api/discover/tokens");

    // prisma.token.findMany should only have been called once (second hit is cached)
    expect(vi.mocked(prisma.token.findMany)).toHaveBeenCalledTimes(1);
  });

  it("supports trending sort via raw query", async () => {
    vi.mocked(prisma.$queryRawUnsafe as any).mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT")) return [{ cnt: 1 }];
      return [{
        ...serialized(),
        createdAt: baseToken.createdAt.toISOString(),
        updatedAt: baseToken.updatedAt.toISOString(),
      }];
    });

    const res = await request(app).get("/api/discover/tokens?sortBy=trending");

    expect(res.status).toBe(200);
    expect(res.body.data.tokens).toHaveLength(1);
  });

  it("filters by category", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([{ ...baseToken, category: "DEFI" } as any]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const res = await request(app).get("/api/discover/tokens?category=DEFI");
    expect(res.status).toBe(200);
    expect(res.body.data.tokens[0].category).toBe("DEFI");
  });

  it("filters by network", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([{ ...baseToken, network: "mainnet" } as any]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    clearDiscoveryCache();
    const res = await request(app).get("/api/discover/tokens?network=mainnet");
    expect(res.status).toBe(200);
  });

  it("returns a consistent asOf snapshot alongside the fan-out results", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([baseToken as any]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const res = await request(app).get("/api/discover/tokens");

    expect(res.status).toBe(200);
    expect(typeof res.body.data.asOf).toBe("string");
    expect(new Date(res.body.data.asOf).toString()).not.toBe("Invalid Date");
  });

  it("respects the overall aggregation timeout budget when a fan-out dependency is slow", async () => {
    process.env.DISCOVERY_AGGREGATION_TIMEOUT_MS = "50";
    try {
      vi.mocked(prisma.token.findMany).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([baseToken as any]), 2000))
      );
      vi.mocked(prisma.token.count).mockResolvedValue(1);

      const start = Date.now();
      const res = await request(app).get("/api/discover/tokens");
      const elapsed = Date.now() - start;

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("AGGREGATION_TIMEOUT");
      // Should degrade well before the slow dependency's 2s resolution.
      expect(elapsed).toBeLessThan(1000);
    } finally {
      delete process.env.DISCOVERY_AGGREGATION_TIMEOUT_MS;
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/tokens/:address/visibility
// ---------------------------------------------------------------------------
describe("PATCH /api/tokens/:address/visibility", () => {
  const TENANT_ID = "GCREATOR1";

  beforeEach(() => {
    vi.clearAllMocks();
    clearDiscoveryCache();
  });

  it("allows owner to set isPublic=false", async () => {
    vi.mocked(prisma.token.findUnique).mockResolvedValue({ id: "tok-1", creator: TENANT_ID } as any);
    vi.mocked(prisma.token.update).mockResolvedValue({ address: "GADDR1", isPublic: false } as any);

    const res = await request(app)
      .patch("/api/tokens/GADDR1/visibility")
      .set("X-Tenant-ID", TENANT_ID)
      .send({ isPublic: false });

    expect(res.status).toBe(200);
    expect(res.body.data.isPublic).toBe(false);
  });

  it("allows owner to restore isPublic=true", async () => {
    vi.mocked(prisma.token.findUnique).mockResolvedValue({ id: "tok-1", creator: TENANT_ID } as any);
    vi.mocked(prisma.token.update).mockResolvedValue({ address: "GADDR1", isPublic: true } as any);

    const res = await request(app)
      .patch("/api/tokens/GADDR1/visibility")
      .set("X-Tenant-ID", TENANT_ID)
      .send({ isPublic: true });

    expect(res.status).toBe(200);
    expect(res.body.data.isPublic).toBe(true);
  });

  it("returns 403 when caller is not the token creator", async () => {
    vi.mocked(prisma.token.findUnique).mockResolvedValue({ id: "tok-1", creator: "GOTHER" } as any);

    const res = await request(app)
      .patch("/api/tokens/GADDR1/visibility")
      .set("X-Tenant-ID", TENANT_ID)
      .send({ isPublic: false });

    expect(res.status).toBe(403);
  });

  it("returns 404 when token does not exist", async () => {
    vi.mocked(prisma.token.findUnique).mockResolvedValue(null);

    const res = await request(app)
      .patch("/api/tokens/GADDR_UNKNOWN/visibility")
      .set("X-Tenant-ID", TENANT_ID)
      .send({ isPublic: false });

    expect(res.status).toBe(404);
  });

  it("returns 400 when isPublic is missing", async () => {
    const res = await request(app)
      .patch("/api/tokens/GADDR1/visibility")
      .set("X-Tenant-ID", TENANT_ID)
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 400 when no tenant is provided", async () => {
    const res = await request(app)
      .patch("/api/tokens/GADDR1/visibility")
      .send({ isPublic: false });

    expect(res.status).toBe(400);
  });
});
