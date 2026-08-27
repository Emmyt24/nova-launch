import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import searchRoutes, { clearSearchCache } from "./search";
import { prisma } from "../lib/prisma";

// Mock Prisma
vi.mock("../lib/prisma", () => ({
  prisma: {
    token: { findMany: vi.fn(), count: vi.fn() },
    proposal: { findMany: vi.fn(), count: vi.fn() },
  },
}));

const app = express();
app.use(express.json());
app.use("/api/search", searchRoutes);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockToken = {
  id: "tok-1",
  address: "GABC123",
  name: "Stellar Token",
  symbol: "STL",
  creator: "GCREATOR1",
  totalSupply: BigInt(1_000_000),
  createdAt: new Date("2024-01-01"),
};

const mockProposal = {
  id: "prop-1",
  proposalId: 1,
  title: "Stellar upgrade proposal",
  proposer: "GPROPOSER1",
  status: "ACTIVE",
  createdAt: new Date("2024-02-01"),
};

function setupMocks(opts: {
  tokens?: typeof mockToken[];
  tokenCount?: number;
  proposals?: typeof mockProposal[];
  proposalCount?: number;
}) {
  vi.mocked(prisma.token.findMany).mockResolvedValue(opts.tokens ?? []);
  vi.mocked(prisma.token.count).mockResolvedValue(opts.tokenCount ?? 0);
  vi.mocked(prisma.proposal.findMany).mockResolvedValue(opts.proposals ?? []);
  vi.mocked(prisma.proposal.count).mockResolvedValue(opts.proposalCount ?? 0);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSearchCache();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns results across all entity types", async () => {
    setupMocks({
      tokens: [mockToken],
      tokenCount: 1,
      proposals: [mockProposal],
      proposalCount: 1,
    });

    const res = await request(app).get("/api/search?q=stellar");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.query).toBe("stellar");
    expect(res.body.tokens).toHaveLength(1);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.totals).toEqual({ tokens: 1, proposals: 1 });
  });

  it("serialises token totalSupply as string", async () => {
    setupMocks({ tokens: [mockToken], tokenCount: 1 });

    const res = await request(app).get("/api/search?q=stellar");

    expect(typeof res.body.tokens[0].totalSupply).toBe("string");
    expect(res.body.tokens[0].totalSupply).toBe("1000000");
  });

  it("includes correct type discriminator on each hit", async () => {
    setupMocks({
      tokens: [mockToken],
      tokenCount: 1,
      proposals: [mockProposal],
      proposalCount: 1,
    });

    const res = await request(app).get("/api/search?q=stellar");

    expect(res.body.tokens[0].type).toBe("token");
    expect(res.body.proposals[0].type).toBe("proposal");
  });

  // ── types filter ────────────────────────────────────────────────────────────

  it("searches only tokens when types=tokens", async () => {
    setupMocks({ tokens: [mockToken], tokenCount: 1 });

    const res = await request(app).get("/api/search?q=stellar&types=tokens");

    expect(res.status).toBe(200);
    expect(res.body.tokens).toHaveLength(1);
    expect(res.body.proposals).toHaveLength(0);
    expect(prisma.proposal.findMany).not.toHaveBeenCalled();
  });

  it("searches only proposals when types=proposals", async () => {
    setupMocks({ proposals: [mockProposal], proposalCount: 1 });

    const res = await request(app).get("/api/search?q=upgrade&types=proposals");

    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(1);
    expect(prisma.token.findMany).not.toHaveBeenCalled();
  });

  it("accepts multiple types in comma-separated list", async () => {
    setupMocks({ tokens: [mockToken], tokenCount: 1, proposals: [mockProposal], proposalCount: 1 });

    const res = await request(app).get("/api/search?q=stellar&types=tokens,proposals");

    expect(res.status).toBe(200);
    expect(res.body.tokens).toHaveLength(1);
    expect(res.body.proposals).toHaveLength(1);
  });

  it("silently ignores unknown type values", async () => {
    setupMocks({ tokens: [mockToken], tokenCount: 1 });

    const res = await request(app).get("/api/search?q=stellar&types=tokens,unknown");

    expect(res.status).toBe(200);
    expect(res.body.tokens).toHaveLength(1);
  });

  // ── limit ───────────────────────────────────────────────────────────────────

  it("passes limit to Prisma take", async () => {
    setupMocks({ tokens: [mockToken], tokenCount: 1 });

    await request(app).get("/api/search?q=stellar&limit=5&types=tokens");

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 })
    );
  });

  it("caps limit at 20", async () => {
    setupMocks({ tokens: [mockToken], tokenCount: 1 });

    await request(app).get("/api/search?q=stellar&limit=999&types=tokens");

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 })
    );
  });

  it("enforces minimum limit of 1", async () => {
    setupMocks({ tokens: [mockToken], tokenCount: 1 });

    await request(app).get("/api/search?q=stellar&limit=0&types=tokens");

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 })
    );
  });

  // ── full-text search fields ─────────────────────────────────────────────────

  it("searches tokens by name, symbol, and address", async () => {
    setupMocks({ tokens: [mockToken], tokenCount: 1 });

    await request(app).get("/api/search?q=STL&types=tokens");

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { name: { contains: "STL", mode: "insensitive" } },
            { symbol: { contains: "STL", mode: "insensitive" } },
            { address: { contains: "STL", mode: "insensitive" } },
          ],
        },
      })
    );
  });

  it("searches proposals by title and description", async () => {
    setupMocks({ proposals: [mockProposal], proposalCount: 1 });

    await request(app).get("/api/search?q=upgrade&types=proposals");

    expect(prisma.proposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { title: { contains: "upgrade", mode: "insensitive" } },
            { description: { contains: "upgrade", mode: "insensitive" } },
          ],
        },
      })
    );
  });

  // ── caching ─────────────────────────────────────────────────────────────────

  it("caches results and returns cached flag on second request", async () => {
    setupMocks({ tokens: [mockToken], tokenCount: 1 });

    const res1 = await request(app).get("/api/search?q=cache-test&types=tokens");
    expect(res1.body.cached).toBeUndefined();

    const res2 = await request(app).get("/api/search?q=cache-test&types=tokens");
    expect(res2.body.cached).toBe(true);

    // Prisma called only once despite two requests.
    expect(prisma.token.findMany).toHaveBeenCalledTimes(1);
  });

  // ── validation errors ───────────────────────────────────────────────────────

  it("returns 400 when q is missing", async () => {
    const res = await request(app).get("/api/search");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Invalid parameters");
  });

  it("returns 400 when q is empty string", async () => {
    const res = await request(app).get("/api/search?q=");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when q exceeds 100 characters", async () => {
    const longQ = "a".repeat(101);
    const res = await request(app).get(`/api/search?q=${longQ}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ── error handling ──────────────────────────────────────────────────────────

  it("returns 500 on database error", async () => {
    vi.mocked(prisma.token.findMany).mockRejectedValue(new Error("DB down"));
    vi.mocked(prisma.token.count).mockRejectedValue(new Error("DB down"));
    vi.mocked(prisma.proposal.findMany).mockResolvedValue([]);
    vi.mocked(prisma.proposal.count).mockResolvedValue(0);

    const res = await request(app).get("/api/search?q=error-test");

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Internal server error");
  });

  // ── empty results ───────────────────────────────────────────────────────────

  it("returns empty arrays when nothing matches", async () => {
    setupMocks({});

    const res = await request(app).get("/api/search?q=nomatch");

    expect(res.status).toBe(200);
    expect(res.body.tokens).toEqual([]);
    expect(res.body.proposals).toEqual([]);
    expect(res.body.totals).toEqual({ tokens: 0, proposals: 0 });
  });

  // ── response shape ──────────────────────────────────────────────────────────

  it("includes query string in response", async () => {
    setupMocks({});

    const res = await request(app).get("/api/search?q=myquery");

    expect(res.body.query).toBe("myquery");
  });

  it("returns ISO 8601 dates", async () => {
    setupMocks({ tokens: [mockToken], tokenCount: 1 });

    const res = await request(app).get("/api/search?q=stellar&types=tokens");

    expect(res.body.tokens[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
