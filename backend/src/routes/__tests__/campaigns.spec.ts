/**
 * Tests: buyback campaigns REST routes (#2002)
 *
 * Prisma is mocked so no database I/O happens; the idempotency middleware is
 * replaced with a pass-through so the shared in-memory store can't leak
 * state between tests.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    campaign: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    campaignExecution: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../../middleware/idempotency", () => ({
  idempotencyMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import campaignsRouter from "../campaigns";
import { prisma } from "../../lib/prisma";

const db = prisma as any;

const CREATOR = "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/campaigns", campaignsRouter);
  return app;
}

function makeCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp-uuid-1",
    campaignId: 7,
    tokenId: "token-1",
    creator: CREATOR,
    type: "BUYBACK",
    status: "ACTIVE",
    targetAmount: 1000000000000000000000n,
    currentAmount: 250n,
    startTime: new Date("2026-01-01T00:00:00.000Z"),
    endTime: null,
    metadata: null,
    txHash: "tx-hash-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    campaignId: 7,
    tokenId: "token-1",
    creator: CREATOR,
    type: "BUYBACK",
    targetAmount: "1000",
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-02-01T00:00:00.000Z",
    metadata: "{}",
    txHash: "tx-hash-1",
    ...overrides,
  };
}

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = makeApp();
});

describe("GET /api/campaigns/stats/:tokenId?", () => {
  it("returns global counters when no tokenId is given", async () => {
    db.campaign.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5);
    db.campaignExecution.count.mockResolvedValueOnce(42);

    const res = await request(app).get("/api/campaigns/stats").expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      totalCampaigns: 10,
      activeCampaigns: 4,
      completedCampaigns: 5,
      totalExecutions: 42,
    });
    expect(db.campaign.count).toHaveBeenCalledWith({ where: {} });
    expect(db.campaign.count).toHaveBeenCalledWith({
      where: { status: "ACTIVE" },
    });
    expect(db.campaignExecution.count).toHaveBeenCalledWith({ where: {} });
  });

  it("scopes every counter to the token when tokenId is given", async () => {
    db.campaign.count.mockResolvedValue(1);
    db.campaignExecution.count.mockResolvedValue(3);

    await request(app).get("/api/campaigns/stats/token-1").expect(200);

    expect(db.campaign.count).toHaveBeenCalledWith({
      where: { tokenId: "token-1" },
    });
    expect(db.campaign.count).toHaveBeenCalledWith({
      where: { tokenId: "token-1", status: "COMPLETED" },
    });
    expect(db.campaignExecution.count).toHaveBeenCalledWith({
      where: { campaign: { tokenId: "token-1" } },
    });
  });

  it("returns 500 when a count query fails", async () => {
    db.campaign.count.mockRejectedValue(new Error("db down"));
    db.campaignExecution.count.mockResolvedValue(0);

    const res = await request(app).get("/api/campaigns/stats").expect(500);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to fetch campaign stats",
    });
  });
});

describe("GET /api/campaigns/token/:tokenId", () => {
  it("returns serialized campaigns with BigInt amounts as strings", async () => {
    db.campaign.findMany.mockResolvedValueOnce([makeCampaign()]);

    const res = await request(app)
      .get("/api/campaigns/token/token-1")
      .expect(200);

    expect(db.campaign.findMany).toHaveBeenCalledWith({
      where: { tokenId: "token-1" },
      orderBy: { createdAt: "desc" },
    });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].targetAmount).toBe("1000000000000000000000");
    expect(res.body.data[0].currentAmount).toBe("250");
  });

  it("returns an empty list when the token has no campaigns", async () => {
    db.campaign.findMany.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/api/campaigns/token/unknown")
      .expect(200);

    expect(res.body.data).toEqual([]);
  });

  it("returns 500 when the query fails", async () => {
    db.campaign.findMany.mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .get("/api/campaigns/token/token-1")
      .expect(500);

    expect(res.body.error.message).toBe("Failed to fetch campaigns for token");
  });
});

describe("GET /api/campaigns/creator/:creator", () => {
  it("returns campaigns created by the address", async () => {
    db.campaign.findMany.mockResolvedValueOnce([makeCampaign()]);

    const res = await request(app)
      .get(`/api/campaigns/creator/${CREATOR}`)
      .expect(200);

    expect(db.campaign.findMany).toHaveBeenCalledWith({
      where: { creator: CREATOR },
      orderBy: { createdAt: "desc" },
    });
    expect(res.body.data[0].creator).toBe(CREATOR);
  });

  it("passes through amounts that are null instead of crashing", async () => {
    db.campaign.findMany.mockResolvedValueOnce([
      makeCampaign({ currentAmount: null }),
    ]);

    const res = await request(app)
      .get(`/api/campaigns/creator/${CREATOR}`)
      .expect(200);

    expect(res.body.data[0].currentAmount).toBeNull();
  });

  it("returns 500 when the query fails", async () => {
    db.campaign.findMany.mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .get(`/api/campaigns/creator/${CREATOR}`)
      .expect(500);

    expect(res.body.error.message).toBe(
      "Failed to fetch campaigns for creator"
    );
  });
});

describe("GET /api/campaigns/:campaignId", () => {
  it("returns the campaign looked up by numeric id", async () => {
    db.campaign.findUnique.mockResolvedValueOnce(makeCampaign());

    const res = await request(app).get("/api/campaigns/7").expect(200);

    expect(db.campaign.findUnique).toHaveBeenCalledWith({
      where: { campaignId: 7 },
    });
    expect(res.body.data.campaignId).toBe(7);
    expect(res.body.data.targetAmount).toBe("1000000000000000000000");
  });

  it("returns 404 when the campaign does not exist", async () => {
    db.campaign.findUnique.mockResolvedValueOnce(null);

    const res = await request(app).get("/api/campaigns/999").expect(404);

    expect(res.body.error).toMatchObject({
      code: "NOT_FOUND",
      message: "Campaign not found",
    });
  });

  it("returns 400 for a non-integer id without querying the database", async () => {
    const res = await request(app).get("/api/campaigns/abc").expect(400);

    expect(res.body.success).toBe(false);
    expect(db.campaign.findUnique).not.toHaveBeenCalled();
  });

  it("returns 500 when the lookup fails", async () => {
    db.campaign.findUnique.mockRejectedValueOnce(new Error("db down"));

    const res = await request(app).get("/api/campaigns/7").expect(500);

    expect(res.body.error.message).toBe("Failed to fetch campaign");
  });
});

describe("GET /api/campaigns/:campaignId/executions", () => {
  it("returns executions for the campaign's internal id with string amounts", async () => {
    db.campaign.findUnique.mockResolvedValueOnce(makeCampaign());
    db.campaignExecution.findMany.mockResolvedValueOnce([
      { id: "exec-1", campaignId: "cmp-uuid-1", amount: 500n },
    ]);

    const res = await request(app)
      .get("/api/campaigns/7/executions")
      .expect(200);

    expect(db.campaignExecution.findMany).toHaveBeenCalledWith({
      where: { campaignId: "cmp-uuid-1" },
      orderBy: { executedAt: "desc" },
    });
    expect(res.body.data).toEqual([
      { id: "exec-1", campaignId: "cmp-uuid-1", amount: "500" },
    ]);
  });

  it("returns 404 when the campaign does not exist", async () => {
    db.campaign.findUnique.mockResolvedValueOnce(null);

    await request(app).get("/api/campaigns/7/executions").expect(404);

    expect(db.campaignExecution.findMany).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid campaign id", async () => {
    await request(app).get("/api/campaigns/0/executions").expect(400);

    expect(db.campaign.findUnique).not.toHaveBeenCalled();
  });

  it("returns 500 when fetching executions fails", async () => {
    db.campaign.findUnique.mockResolvedValueOnce(makeCampaign());
    db.campaignExecution.findMany.mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .get("/api/campaigns/7/executions")
      .expect(500);

    expect(res.body.error.message).toBe("Failed to fetch execution history");
  });
});

describe("POST /api/campaigns", () => {
  it("records the campaign keyed by txHash and returns 201", async () => {
    db.campaign.upsert.mockResolvedValueOnce(
      makeCampaign({ targetAmount: 1000n })
    );

    const res = await request(app)
      .post("/api/campaigns")
      .send(validCreateBody())
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.targetAmount).toBe("1000");

    const call = db.campaign.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ txHash: "tx-hash-1" });
    expect(call.update).toEqual({});
    expect(call.create.targetAmount).toBe(1000n);
    expect(call.create.startTime).toEqual(
      new Date("2026-01-01T00:00:00.000Z")
    );
    expect(call.create.endTime).toEqual(new Date("2026-02-01T00:00:00.000Z"));
  });

  it("stores a null endTime when none is supplied", async () => {
    db.campaign.upsert.mockResolvedValueOnce(makeCampaign());

    const body = validCreateBody();
    delete (body as any).endTime;
    await request(app).post("/api/campaigns").send(body).expect(201);

    expect(db.campaign.upsert.mock.calls[0][0].create.endTime).toBeNull();
  });

  it("returns 400 for an invalid body without writing", async () => {
    const res = await request(app)
      .post("/api/campaigns")
      .send(validCreateBody({ type: "RUGPULL", targetAmount: "0" }))
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(db.campaign.upsert).not.toHaveBeenCalled();
  });

  it("returns 409 on a unique-constraint violation (P2002)", async () => {
    db.campaign.upsert.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const res = await request(app)
      .post("/api/campaigns")
      .send(validCreateBody())
      .expect(409);

    expect(res.body.error).toMatchObject({
      code: "CONFLICT",
      message: "Campaign already recorded",
    });
  });

  it("returns 500 on any other database error", async () => {
    db.campaign.upsert.mockRejectedValueOnce(new Error("db down"));

    const res = await request(app)
      .post("/api/campaigns")
      .send(validCreateBody())
      .expect(500);

    expect(res.body.error.message).toBe("Failed to record campaign");
  });
});
