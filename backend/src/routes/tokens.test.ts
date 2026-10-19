import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import tokenRoutes from "./tokens";
import { prisma } from "../lib/prisma";

// Mock Prisma
vi.mock("../lib/prisma", () => ({
  prisma: {
    token: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

const TENANT_ID = "GCREATOR1";

const app = express();
app.use(express.json());
app.use("/api/tokens", tokenRoutes);

/** Helper: attach the required tenant header to every request */
function withTenant(r: request.Test): request.Test {
  return r.set("X-Tenant-ID", TENANT_ID);
}

describe("GET /api/tokens/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockTokens = [
    {
      id: "1",
      address: "GABC123",
      creator: TENANT_ID,
      name: "Test Token",
      symbol: "TEST",
      decimals: 18,
      totalSupply: BigInt(1000000),
      initialSupply: BigInt(1000000),
      totalBurned: BigInt(100000),
      burnCount: 5,
      metadataUri: "ipfs://test",
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    },
    {
      id: "2",
      address: "GDEF456",
      creator: TENANT_ID,
      name: "Another Token",
      symbol: "ANOT",
      decimals: 18,
      totalSupply: BigInt(500000),
      initialSupply: BigInt(500000),
      totalBurned: BigInt(0),
      burnCount: 0,
      metadataUri: null,
      createdAt: new Date("2024-01-02"),
      updatedAt: new Date("2024-01-02"),
    },
  ];

  it("should return 400 when tenant header is missing", async () => {
    const response = await request(app).get("/api/tokens/search");
    expect(response.status).toBe(400);
  });

  it("should return all tokens with default pagination", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);
    vi.mocked(prisma.token.count).mockResolvedValue(2);

    const response = await withTenant(request(app).get("/api/tokens/search"));

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
      nextCursor: null,
      hasMore: false,
    });
  });

  it("should always scope queries to the tenant (creator)", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);
    vi.mocked(prisma.token.count).mockResolvedValue(2);

    await withTenant(request(app).get("/api/tokens/search"));

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: expect.arrayContaining([{ creator: TENANT_ID }]) },
      })
    );
  });

  it("should search by name (case insensitive)", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[0]]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const response = await withTenant(
      request(app).get("/api/tokens/search?q=test")
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].name).toBe("Test Token");
    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { creator: TENANT_ID },
            {
              OR: [
                { name: { contains: "test", mode: "insensitive" } },
                { symbol: { contains: "test", mode: "insensitive" } },
              ],
            },
          ]),
        },
      })
    );
  });

  it("should filter by date range", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[0]]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const response = await withTenant(
      request(app).get(
        "/api/tokens/search?startDate=2024-01-01T00:00:00.000Z&endDate=2024-01-31T23:59:59.999Z"
      )
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { creator: TENANT_ID },
            {
              createdAt: {
                gte: new Date("2024-01-01T00:00:00.000Z"),
                lte: new Date("2024-01-31T23:59:59.999Z"),
              },
            },
          ]),
        },
      })
    );
  });

  it("should filter by supply range", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[1]]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const response = await withTenant(
      request(app).get("/api/tokens/search?minSupply=100000&maxSupply=600000")
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { creator: TENANT_ID },
            {
              totalSupply: {
                gte: BigInt(100000),
                lte: BigInt(600000),
              },
            },
          ]),
        },
      })
    );
  });

  it("should filter by burn status - has burns", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[0]]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const response = await withTenant(
      request(app).get("/api/tokens/search?hasBurns=true")
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { creator: TENANT_ID },
            { burnCount: { gt: 0 } },
          ]),
        },
      })
    );
  });

  it("should filter by burn status - no burns", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[1]]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const response = await withTenant(
      request(app).get("/api/tokens/search?hasBurns=false")
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { creator: TENANT_ID },
            { burnCount: 0 },
          ]),
        },
      })
    );
  });

  it("should sort by created date descending (default), with id as tie-breaker", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);
    vi.mocked(prisma.token.count).mockResolvedValue(2);

    await withTenant(request(app).get("/api/tokens/search"));

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
    );
  });

  it("should sort by total burned ascending", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);
    vi.mocked(prisma.token.count).mockResolvedValue(2);

    await withTenant(
      request(app).get("/api/tokens/search?sortBy=burned&sortOrder=asc")
    );

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ totalBurned: "asc" }],
      })
    );
  });

  it("should sort by supply", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);
    vi.mocked(prisma.token.count).mockResolvedValue(2);

    await withTenant(
      request(app).get("/api/tokens/search?sortBy=supply&sortOrder=desc")
    );

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ totalSupply: "desc" }],
      })
    );
  });

  it("should sort by name", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);
    vi.mocked(prisma.token.count).mockResolvedValue(2);

    await withTenant(
      request(app).get("/api/tokens/search?sortBy=name&sortOrder=asc")
    );

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ name: "asc" }],
      })
    );
  });

  it("should handle pagination correctly (deprecated page/offset flow)", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[1]]);
    vi.mocked(prisma.token.count).mockResolvedValue(50);

    const response = await withTenant(
      request(app).get("/api/tokens/search?page=2&limit=10")
    );

    expect(response.body.pagination).toEqual({
      page: 2,
      limit: 10,
      total: 50,
      totalPages: 5,
      hasNext: true,
      hasPrev: true,
      nextCursor: null,
      hasMore: false,
    });
    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 11,
      })
    );
  });

  it("should enforce max limit of 50", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);
    vi.mocked(prisma.token.count).mockResolvedValue(2);

    await withTenant(request(app).get("/api/tokens/search?limit=100"));

    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 51,
      })
    );
  });

  it("should paginate by cursor on the created sort, returning a nextCursor when more results exist", async () => {
    // Service returns limit+1 rows so the route can detect hasMore.
    vi.mocked(prisma.token.findMany).mockResolvedValue([
      mockTokens[0],
      mockTokens[1],
    ]);
    vi.mocked(prisma.token.count).mockResolvedValue(5);

    const response = await withTenant(
      request(app).get("/api/tokens/search?limit=1")
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.pagination.hasMore).toBe(true);
    expect(typeof response.body.pagination.nextCursor).toBe("string");

    const decoded = JSON.parse(
      Buffer.from(response.body.pagination.nextCursor, "base64").toString(
        "utf-8"
      )
    );
    expect(decoded).toEqual({
      createdAt: mockTokens[0].createdAt.toISOString(),
      id: mockTokens[0].id,
    });
  });

  it("should apply the keyset WHERE condition when a cursor is supplied", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[1]]);
    vi.mocked(prisma.token.count).mockResolvedValue(2);

    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "2024-01-01T00:00:00.000Z", id: "1" })
    ).toString("base64");

    const response = await withTenant(
      request(app).get(`/api/tokens/search?cursor=${cursor}`)
    );

    expect(response.status).toBe(200);
    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { creator: TENANT_ID },
            {
              OR: [
                { createdAt: { lt: new Date("2024-01-01T00:00:00.000Z") } },
                {
                  createdAt: new Date("2024-01-01T00:00:00.000Z"),
                  id: { lt: "1" },
                },
              ],
            },
          ]),
        },
      })
    );
    // Cursor mode bypasses `skip` entirely.
    expect(prisma.token.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ skip: expect.anything() })
    );
  });

  it("should reject a cursor combined with a non-created sortBy", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "2024-01-01T00:00:00.000Z", id: "1" })
    ).toString("base64");

    const response = await withTenant(
      request(app).get(`/api/tokens/search?cursor=${cursor}&sortBy=name`)
    );

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it("should reject a malformed cursor", async () => {
    const response = await withTenant(
      request(app).get("/api/tokens/search?cursor=not-valid-base64-json")
    );

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it("should convert BigInt to string in response", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[0]]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const response = await withTenant(request(app).get("/api/tokens/search"));

    expect(typeof response.body.data[0].totalSupply).toBe("string");
    expect(typeof response.body.data[0].initialSupply).toBe("string");
    expect(typeof response.body.data[0].totalBurned).toBe("string");
    expect(response.body.data[0].totalSupply).toBe("1000000");
  });

  it("should return validation error for invalid parameters", async () => {
    const response = await withTenant(
      request(app).get("/api/tokens/search?sortBy=invalid")
    );

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.message).toBe("Invalid parameters");
  });

  it("should return validation error for invalid date format", async () => {
    const response = await withTenant(
      request(app).get("/api/tokens/search?startDate=not-a-date")
    );

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it("should return validation error for invalid supply format", async () => {
    const response = await withTenant(
      request(app).get("/api/tokens/search?minSupply=abc")
    );

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it("should combine multiple filters within tenant scope", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue([mockTokens[0]]);
    vi.mocked(prisma.token.count).mockResolvedValue(1);

    const response = await withTenant(
      request(app).get(
        "/api/tokens/search?q=test&hasBurns=true&minSupply=100000"
      )
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            { creator: TENANT_ID },
            { OR: expect.any(Array) },
            { burnCount: { gt: 0 } },
            { totalSupply: expect.objectContaining({ gte: BigInt(100000) }) },
          ]),
        },
      })
    );
  });

  it("should handle database errors gracefully", async () => {
    vi.mocked(prisma.token.findMany).mockRejectedValue(
      new Error("Database connection failed")
    );

    const response = await withTenant(request(app).get("/api/tokens/search"));

    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.error.message).toBe("Internal server error");
  });

  it("should include applied filters in response", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);
    vi.mocked(prisma.token.count).mockResolvedValue(2);

    const response = await withTenant(
      request(app).get(
        "/api/tokens/search?q=test&sortBy=burned&sortOrder=desc"
      )
    );

    expect(response.body.filters).toEqual({
      q: "test",
      creator: undefined,
      startDate: undefined,
      endDate: undefined,
      minSupply: undefined,
      maxSupply: undefined,
      hasBurns: undefined,
      sortBy: "burned",
      sortOrder: "desc",
      cursor: undefined,
    });
  });

  it("should use cache for repeated requests (per tenant)", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens);
    vi.mocked(prisma.token.count).mockResolvedValue(2);

    // First request
    const response1 = await withTenant(
      request(app).get("/api/tokens/search?q=test")
    );
    expect(response1.body.cached).toBeUndefined();

    // Second request (should be cached)
    const response2 = await withTenant(
      request(app).get("/api/tokens/search?q=test")
    );
    expect(response2.body.cached).toBe(true);

    // Prisma should only be called once
    expect(prisma.token.findMany).toHaveBeenCalledTimes(1);
  });
});
