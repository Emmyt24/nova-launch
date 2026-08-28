import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import exportRoutes from "./export";
import { prisma } from "../lib/prisma";

// ─── Mock Prisma ──────────────────────────────────────────────────────────

vi.mock("../lib/prisma", () => ({
  prisma: {
    token: {
      findMany: vi.fn(),
    },
    burnRecord: {
      findMany: vi.fn(),
    },
  },
}));

// ─── Test app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/api/export", exportRoutes);

// ─── Fixtures ─────────────────────────────────────────────────────────────

const mockTokens = [
  {
    id: "token-1",
    address: "GABC123",
    creator: "GCREATOR1",
    name: "Test Token",
    symbol: "TEST",
    decimals: 7,
    totalSupply: BigInt("1000000000"),
    initialSupply: BigInt("1000000000"),
    totalBurned: BigInt("50000000"),
    burnCount: 3,
    metadataUri: "ipfs://QmTest",
    createdAt: new Date("2024-01-15T10:00:00.000Z"),
    updatedAt: new Date("2024-01-16T10:00:00.000Z"),
  },
  {
    id: "token-2",
    address: "GDEF456",
    creator: "GCREATOR2",
    name: 'Token "Special"',
    symbol: "SPEC",
    decimals: 18,
    totalSupply: BigInt("500000000"),
    initialSupply: BigInt("500000000"),
    totalBurned: BigInt("0"),
    burnCount: 0,
    metadataUri: null,
    createdAt: new Date("2024-02-01T08:00:00.000Z"),
    updatedAt: new Date("2024-02-01T08:00:00.000Z"),
  },
];

const mockBurnRecords = [
  {
    id: "burn-1",
    tokenId: "token-1",
    from: "GBURNER1",
    amount: BigInt("10000000"),
    burnedBy: "GBURNER1",
    isAdminBurn: false,
    txHash: "abc123",
    timestamp: new Date("2024-01-20T12:00:00.000Z"),
  },
  {
    id: "burn-2",
    tokenId: "token-1",
    from: "GBURNER2",
    amount: BigInt("40000000"),
    burnedBy: "GADMIN1",
    isAdminBurn: true,
    txHash: "def456",
    timestamp: new Date("2024-01-21T14:00:00.000Z"),
  },
];

// ─── Tests: GET /api/export/tokens ────────────────────────────────────────

describe("GET /api/export/tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── JSON format (default) ──────────────────────────────────────────────

  it("returns JSON by default", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);

    const res = await request(app).get("/api/export/tokens");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.exportedAt).toBeDefined();
  });

  it("serialises BigInt fields as strings in JSON", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[0]]);

    const res = await request(app).get("/api/export/tokens?format=json");

    expect(res.status).toBe(200);
    const token = res.body.data[0];
    expect(token.totalSupply).toBe("1000000000");
    expect(token.initialSupply).toBe("1000000000");
    expect(token.totalBurned).toBe("50000000");
  });

  it("converts null metadataUri to empty string in JSON", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[1]]);

    const res = await request(app).get("/api/export/tokens?format=json");

    expect(res.status).toBe(200);
    expect(res.body.data[0].metadataUri).toBe("");
  });

  it("returns ISO-8601 date strings in JSON", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[0]]);

    const res = await request(app).get("/api/export/tokens?format=json");

    expect(res.body.data[0].createdAt).toBe("2024-01-15T10:00:00.000Z");
    expect(res.body.data[0].updatedAt).toBe("2024-01-16T10:00:00.000Z");
  });

  // ── CSV format ─────────────────────────────────────────────────────────

  it("returns CSV when format=csv", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);

    const res = await request(app).get("/api/export/tokens?format=csv");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/tokens-export\.csv/);
  });

  it("CSV contains header row and correct number of data rows", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);

    const res = await request(app).get("/api/export/tokens?format=csv");

    const lines = res.text.trim().split("\n");
    expect(lines).toHaveLength(3); // 1 header + 2 data rows
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("address");
    expect(lines[0]).toContain("totalSupply");
  });

  it("CSV escapes double-quotes in cell values", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[1]]);

    const res = await request(app).get("/api/export/tokens?format=csv");

    // Token name is: Token "Special"
    expect(res.text).toContain('"Token ""Special"""');
  });

  it("CSV neutralizes formula-injection characters", async () => {
    const formulaTokens = [
      {
        id: "token-formula",
        address: "GFORMULA",
        creator: "GCREATOR1",
        name: "=HYPERLINK(\"http://evil.example\",\"click\")",
        symbol: "+CMD",
        decimals: 7,
        totalSupply: BigInt("1000000"),
        initialSupply: BigInt("1000000"),
        totalBurned: BigInt("0"),
        burnCount: 0,
        metadataUri: "@SUM(A1:A9)",
        createdAt: new Date("2024-01-15T10:00:00.000Z"),
        updatedAt: new Date("2024-01-15T10:00:00.000Z"),
      },
    ];
    vi.mocked(prisma.token.findMany).mockResolvedValue(formulaTokens);

    const res = await request(app).get("/api/export/tokens?format=csv");

    // Values starting with =, +, -, @ should be prefixed with '
    expect(res.text).toContain("'=HYPERLINK");
    expect(res.text).toContain("'+CMD");
    expect(res.text).toContain("'@SUM(A1:A9)");
    // Normal values should not be prefixed
    expect(res.text).not.toContain("'=GFORMULA");
  });

  it("returns empty CSV body when no tokens exist", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);

    const res = await request(app).get("/api/export/tokens?format=csv");

    expect(res.status).toBe(200);
    expect(res.text).toBe("");
  });

  // ── Date range filtering ───────────────────────────────────────────────

  it("passes startDate filter to prisma", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);

    await request(app).get(
      "/api/export/tokens?startDate=2024-01-01T00:00:00.000Z"
    );

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: { gte: new Date("2024-01-01T00:00:00.000Z") },
        },
      })
    );
  });

  it("passes endDate filter to prisma", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);

    await request(app).get(
      "/api/export/tokens?endDate=2024-12-31T23:59:59.000Z"
    );

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: { lte: new Date("2024-12-31T23:59:59.000Z") },
        },
      })
    );
  });

  it("passes both startDate and endDate filters to prisma", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);

    await request(app).get(
      "/api/export/tokens?startDate=2024-01-01T00:00:00.000Z&endDate=2024-06-30T23:59:59.000Z"
    );

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date("2024-01-01T00:00:00.000Z"),
            lte: new Date("2024-06-30T23:59:59.000Z"),
          },
        },
      })
    );
  });

  it("passes no where clause when no date filters provided", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);

    await request(app).get("/api/export/tokens");

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });

  // ── Limit parameter ────────────────────────────────────────────────────

  it("defaults limit to 1000", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);

    await request(app).get("/api/export/tokens");

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1000 })
    );
  });

  it("respects custom limit", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([]);

    await request(app).get("/api/export/tokens?limit=50");

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 })
    );
  });

  it("returns 400 when limit exceeds 10000", async () => {
    const res = await request(app).get("/api/export/tokens?limit=99999");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when limit is 0", async () => {
    const res = await request(app).get("/api/export/tokens?limit=0");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ── Validation errors ──────────────────────────────────────────────────

  it("returns 400 for invalid format value", async () => {
    const res = await request(app).get("/api/export/tokens?format=xml");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid startDate", async () => {
    const res = await request(app).get(
      "/api/export/tokens?startDate=not-a-date"
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for invalid endDate", async () => {
    const res = await request(app).get("/api/export/tokens?endDate=2024-13-01");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for non-numeric limit", async () => {
    const res = await request(app).get("/api/export/tokens?limit=abc");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ── Error handling ─────────────────────────────────────────────────────

  it("returns 500 when prisma throws", async () => {
    vi.mocked(prisma.token.findMany).mockRejectedValue(
      new Error("DB connection lost")
    );

    const res = await request(app).get("/api/export/tokens");

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });
});

// ─── Tests: GET /api/export/burn-records ──────────────────────────────────

describe("GET /api/export/burn-records", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── JSON format ────────────────────────────────────────────────────────

  it("returns JSON by default", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue(mockBurnRecords);

    const res = await request(app).get("/api/export/burn-records");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.data).toHaveLength(2);
  });

  it("serialises BigInt amount as string in JSON", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue([
      mockBurnRecords[0],
    ]);

    const res = await request(app).get("/api/export/burn-records?format=json");

    expect(res.body.data[0].amount).toBe("10000000");
  });

  it("includes isAdminBurn boolean field", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue(mockBurnRecords);

    const res = await request(app).get("/api/export/burn-records?format=json");

    expect(res.body.data[0].isAdminBurn).toBe(false);
    expect(res.body.data[1].isAdminBurn).toBe(true);
  });

  it("returns ISO-8601 timestamp strings", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue([
      mockBurnRecords[0],
    ]);

    const res = await request(app).get("/api/export/burn-records?format=json");

    expect(res.body.data[0].timestamp).toBe("2024-01-20T12:00:00.000Z");
  });

  // ── CSV format ─────────────────────────────────────────────────────────

  it("returns CSV when format=csv", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue(mockBurnRecords);

    const res = await request(app).get("/api/export/burn-records?format=csv");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(
      /burn-records-export\.csv/
    );
  });

  it("CSV contains header row and correct number of data rows", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue(mockBurnRecords);

    const res = await request(app).get("/api/export/burn-records?format=csv");

    const lines = res.text.trim().split("\n");
    expect(lines).toHaveLength(3); // 1 header + 2 data rows
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("tokenId");
    expect(lines[0]).toContain("amount");
    expect(lines[0]).toContain("isAdminBurn");
  });

  it("returns empty CSV body when no burn records exist", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue([]);

    const res = await request(app).get("/api/export/burn-records?format=csv");

    expect(res.status).toBe(200);
    expect(res.text).toBe("");
  });

  // ── Date range filtering ───────────────────────────────────────────────

  it("passes startDate filter on timestamp field to prisma", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue([]);

    await request(app).get(
      "/api/export/burn-records?startDate=2024-01-01T00:00:00.000Z"
    );

    expect(prisma.burnRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          timestamp: { gte: new Date("2024-01-01T00:00:00.000Z") },
        },
      })
    );
  });

  it("passes endDate filter on timestamp field to prisma", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue([]);

    await request(app).get(
      "/api/export/burn-records?endDate=2024-12-31T23:59:59.000Z"
    );

    expect(prisma.burnRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          timestamp: { lte: new Date("2024-12-31T23:59:59.000Z") },
        },
      })
    );
  });

  it("passes both date filters to prisma", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue([]);

    await request(app).get(
      "/api/export/burn-records?startDate=2024-01-01T00:00:00.000Z&endDate=2024-06-30T23:59:59.000Z"
    );

    expect(prisma.burnRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          timestamp: {
            gte: new Date("2024-01-01T00:00:00.000Z"),
            lte: new Date("2024-06-30T23:59:59.000Z"),
          },
        },
      })
    );
  });

  it("passes no where clause when no date filters provided", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue([]);

    await request(app).get("/api/export/burn-records");

    expect(prisma.burnRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });

  // ── Limit parameter ────────────────────────────────────────────────────

  it("defaults limit to 1000", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue([]);

    await request(app).get("/api/export/burn-records");

    expect(prisma.burnRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1000 })
    );
  });

  it("respects custom limit", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockResolvedValue([]);

    await request(app).get("/api/export/burn-records?limit=200");

    expect(prisma.burnRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 })
    );
  });

  it("returns 400 when limit exceeds 10000", async () => {
    const res = await request(app).get("/api/export/burn-records?limit=10001");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  // ── Validation errors ──────────────────────────────────────────────────

  it("returns 400 for invalid format value", async () => {
    const res = await request(app).get("/api/export/burn-records?format=xlsx");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for invalid startDate", async () => {
    const res = await request(app).get(
      "/api/export/burn-records?startDate=bad-date"
    );

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ── Error handling ─────────────────────────────────────────────────────

  it("returns 500 when prisma throws", async () => {
    vi.mocked(prisma.burnRecord.findMany).mockRejectedValue(
      new Error("Query timeout")
    );

    const res = await request(app).get("/api/export/burn-records");

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });
});
