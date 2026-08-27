import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import tokensRouter from "../tokens";

vi.mock("../../../config/database", () => ({
  Database: {
    getAllTokens: vi.fn(),
    findTokenById: vi.fn(),
    updateToken: vi.fn(),
    softDeleteToken: vi.fn(),
    findUserByAddress: vi.fn(),
  },
}));

vi.mock("../../../middleware/auth", () => ({
  authenticateAdmin: (_req: any, _res: any, next: any) => next(),
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../../middleware/auditLog", () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

async function getDb() {
  return (await import("../../../config/database")).Database;
}

const app = express();
app.use(express.json());
app.use("/api/admin/tokens", tokensRouter);

const makeToken = (o: Record<string, unknown> = {}) => ({
  id: `t-${Math.random()}`,
  name: "Test Token",
  symbol: "TST",
  contractAddress: "CTOKEN123",
  creatorAddress: "GCREATOR",
  flagged: false,
  burned: "0",
  createdAt: new Date("2026-01-01"),
  ...o,
});

describe("GET /api/admin/tokens - pagination", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns default page of 50 when no pagination params given", async () => {
    const db = await getDb();
    const tokens = Array.from({ length: 80 }, (_, i) =>
      makeToken({ id: `t-${i}`, contractAddress: `CTOKEN${i}` })
    );
    vi.mocked(db.getAllTokens).mockResolvedValue(tokens as any);

    const res = await request(app).get("/api/admin/tokens").expect(200);

    expect(res.body.data.tokens).toHaveLength(50);
    expect(res.body.data.pagination.total).toBe(80);
    expect(res.body.data.pagination.limit).toBe(50);
    expect(res.body.data.pagination.offset).toBe(0);
    expect(res.body.data.pagination.hasMore).toBe(true);
  });

  it("returns correct page when offset is specified", async () => {
    const db = await getDb();
    const tokens = Array.from({ length: 80 }, (_, i) =>
      makeToken({ id: `t-${i}` })
    );
    vi.mocked(db.getAllTokens).mockResolvedValue(tokens as any);

    const res = await request(app)
      .get("/api/admin/tokens?offset=50&limit=50")
      .expect(200);

    expect(res.body.data.tokens).toHaveLength(30);
    expect(res.body.data.pagination.total).toBe(80);
    expect(res.body.data.pagination.offset).toBe(50);
    expect(res.body.data.pagination.hasMore).toBe(false);
  });

  it("caps limit at 100", async () => {
    const db = await getDb();
    const tokens = Array.from({ length: 200 }, (_, i) =>
      makeToken({ id: `t-${i}` })
    );
    vi.mocked(db.getAllTokens).mockResolvedValue(tokens as any);

    const res = await request(app)
      .get("/api/admin/tokens?limit=999")
      .expect(200);

    expect(res.body.data.tokens).toHaveLength(100);
    expect(res.body.data.pagination.limit).toBe(100);
  });

  it("returns hasMore false when result fits within one page", async () => {
    const db = await getDb();
    vi.mocked(db.getAllTokens).mockResolvedValue([makeToken()] as any);

    const res = await request(app).get("/api/admin/tokens").expect(200);

    expect(res.body.data.pagination.hasMore).toBe(false);
    expect(res.body.data.pagination.total).toBe(1);
  });

  it("returns total-count metadata correctly", async () => {
    const db = await getDb();
    const tokens = Array.from({ length: 5 }, (_, i) => makeToken({ id: `t-${i}` }));
    vi.mocked(db.getAllTokens).mockResolvedValue(tokens as any);

    const res = await request(app)
      .get("/api/admin/tokens?limit=2&offset=0")
      .expect(200);

    expect(res.body.data.pagination.total).toBe(5);
    expect(res.body.data.tokens).toHaveLength(2);
    expect(res.body.data.pagination.hasMore).toBe(true);
  });

  it("rejects non-numeric limit with 400", async () => {
    const res = await request(app)
      .get("/api/admin/tokens?limit=abc")
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects non-numeric offset with 400", async () => {
    const res = await request(app)
      .get("/api/admin/tokens?offset=xyz")
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
