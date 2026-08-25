/**
 * Tests for the dividend distribution routes (#1759).
 *
 * The router is exercised end-to-end via supertest with `dividendService`
 * mocked at the module boundary, so these tests verify request validation,
 * status-code mapping, and correct delegation to the service — not the
 * Soroban RPC / Prisma internals (covered separately in
 * services/__tests__/dividendService.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { Express } from "express";

vi.mock("../../middleware/auth", () => ({
  authenticateAdmin: (req: any, res: any, next: any) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token === "valid-admin-token") {
      next();
    } else {
      res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      });
    }
  },
}));

const mockDividendService = vi.hoisted(() => ({
  buildInitiateDistributionTx: vi.fn(),
  buildClaimDividendTx: vi.fn(),
  buildReclaimUnclaimedTx: vi.fn(),
  submitSignedDividendTx: vi.fn(),
  getDistribution: vi.fn(),
  hasClaimedDividend: vi.fn(),
  getDividendClaimedTotal: vi.fn(),
  getDistributionCount: vi.fn(),
  listClaimsForDistribution: vi.fn(),
  listHolderSnapshotsForDistribution: vi.fn(),
  ingestDividendEvent: vi.fn(),
}));

vi.mock("../../services/dividendService", () => mockDividendService);

let app: Express;
const ADMIN_ADDR = "GADMINADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HOLDER_ADDR = "GHOLDERADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ASSET_ADDR = "CASSETADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

beforeEach(async () => {
  vi.clearAllMocks();
  app = express();
  app.use(express.json());
  const dividendRoutes = (await import("../dividends")).default;
  app.use("/api/dividends", dividendRoutes);
});

describe("POST /api/dividends/initiate", () => {
  it("rejects requests without a valid admin token", async () => {
    const res = await request(app).post("/api/dividends/initiate").send({});
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body with 400", async () => {
    const res = await request(app)
      .post("/api/dividends/initiate")
      .set("Authorization", "Bearer valid-admin-token")
      .send({ admin: "not-an-address" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INPUT");
    expect(
      mockDividendService.buildInitiateDistributionTx
    ).not.toHaveBeenCalled();
  });

  it("builds an unsigned transaction for a valid request", async () => {
    mockDividendService.buildInitiateDistributionTx.mockResolvedValue({
      xdr: "AAAA...",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    const body = {
      admin: ADMIN_ADDR,
      tokenIndex: 0,
      asset: ASSET_ADDR,
      totalAmount: "1000000",
      claimDeadlineLedger: 999999,
    };

    const res = await request(app)
      .post("/api/dividends/initiate")
      .set("Authorization", "Bearer valid-admin-token")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.xdr).toBe("AAAA...");
    expect(
      mockDividendService.buildInitiateDistributionTx
    ).toHaveBeenCalledWith(body);
  });

  it("maps a service error to a 400 with the error message", async () => {
    mockDividendService.buildInitiateDistributionTx.mockRejectedValue(
      new Error("Unauthorized (contract error #2)")
    );

    const res = await request(app)
      .post("/api/dividends/initiate")
      .set("Authorization", "Bearer valid-admin-token")
      .send({
        admin: ADMIN_ADDR,
        tokenIndex: 0,
        asset: ASSET_ADDR,
        totalAmount: "1000000",
        claimDeadlineLedger: 999999,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Unauthorized/);
  });
});

describe("POST /api/dividends/claim", () => {
  it("does not require admin auth", async () => {
    mockDividendService.buildClaimDividendTx.mockResolvedValue({
      xdr: "BBBB...",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    const res = await request(app)
      .post("/api/dividends/claim")
      .send({ holder: HOLDER_ADDR, distributionId: 1 });

    expect(res.status).toBe(200);
    expect(res.body.data.xdr).toBe("BBBB...");
  });

  it("rejects a negative distributionId", async () => {
    const res = await request(app)
      .post("/api/dividends/claim")
      .send({ holder: HOLDER_ADDR, distributionId: -1 });
    expect(res.status).toBe(400);
  });

  it("maps a 'not found' service error to 404", async () => {
    mockDividendService.buildClaimDividendTx.mockRejectedValue(
      new Error("DistributionNotFound (contract error #100)")
    );
    const res = await request(app)
      .post("/api/dividends/claim")
      .send({ holder: HOLDER_ADDR, distributionId: 999 });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/dividends/reclaim", () => {
  it("requires admin auth", async () => {
    const res = await request(app)
      .post("/api/dividends/reclaim")
      .send({ admin: ADMIN_ADDR, distributionId: 1 });
    expect(res.status).toBe(401);
    expect(mockDividendService.buildReclaimUnclaimedTx).not.toHaveBeenCalled();
  });

  it("builds an unsigned transaction when authorized", async () => {
    mockDividendService.buildReclaimUnclaimedTx.mockResolvedValue({
      xdr: "CCCC...",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    const res = await request(app)
      .post("/api/dividends/reclaim")
      .set("Authorization", "Bearer valid-admin-token")
      .send({ admin: ADMIN_ADDR, distributionId: 1 });

    expect(res.status).toBe(200);
    expect(res.body.data.xdr).toBe("CCCC...");
  });
});

describe("POST /api/dividends/submit", () => {
  it("relays a signed XDR", async () => {
    mockDividendService.submitSignedDividendTx.mockResolvedValue({
      hash: "deadbeef",
      successful: true,
    });
    const res = await request(app)
      .post("/api/dividends/submit")
      .send({ signedXdr: "AAAA..." });
    expect(res.status).toBe(200);
    expect(res.body.data.hash).toBe("deadbeef");
  });

  it("rejects an empty signedXdr", async () => {
    const res = await request(app)
      .post("/api/dividends/submit")
      .send({ signedXdr: "" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/dividends/:distributionId", () => {
  it("returns the live distribution record", async () => {
    const record = {
      id: 1,
      tokenIndex: 0,
      asset: ASSET_ADDR,
      totalAmount: "1000000",
      snapshotLedger: 100,
      totalSupplyAtSnapshot: "1000",
      claimDeadlineLedger: 200,
      reclaimed: false,
      createdAt: "2026-08-24T00:00:00.000Z",
    };
    mockDividendService.getDistribution.mockResolvedValue(record);

    const res = await request(app).get("/api/dividends/1");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(record);
  });

  it("rejects a non-numeric distribution id", async () => {
    const res = await request(app).get("/api/dividends/not-a-number");
    expect(res.status).toBe(400);
  });

  it("maps a not-found service error to 404", async () => {
    mockDividendService.getDistribution.mockRejectedValue(
      new Error("DistributionNotFound (contract error #100)")
    );
    const res = await request(app).get("/api/dividends/999");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/dividends/:distributionId/claimed/:holder", () => {
  it("returns claimed status", async () => {
    mockDividendService.hasClaimedDividend.mockResolvedValue(true);
    const res = await request(app).get(
      `/api/dividends/1/claimed/${HOLDER_ADDR}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.claimed).toBe(true);
  });

  it("rejects an invalid holder address", async () => {
    const res = await request(app).get(
      "/api/dividends/1/claimed/not-an-address"
    );
    expect(res.status).toBe(400);
    expect(mockDividendService.hasClaimedDividend).not.toHaveBeenCalled();
  });
});

describe("GET /api/dividends/:distributionId/claims", () => {
  it("returns a paginated claim list", async () => {
    mockDividendService.listClaimsForDistribution.mockResolvedValue({
      claims: [
        {
          claimant: HOLDER_ADDR,
          amount: "500",
          txHash: "tx1",
          claimedAt: "2026-08-24T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });

    const res = await request(app).get("/api/dividends/1/claims?limit=10");
    expect(res.status).toBe(200);
    expect(res.body.data.claims).toHaveLength(1);
    expect(mockDividendService.listClaimsForDistribution).toHaveBeenCalledWith(
      1,
      { limit: 10 }
    );
  });
});

describe("POST /api/dividends/events/ingest", () => {
  const validEvent = {
    topic: "div_clm1",
    topicValues: [1],
    data: [HOLDER_ADDR, "500"],
    txHash: "tx1",
    ledger: 100,
    ledgerCloseTime: "2026-08-24T00:00:00.000Z",
  };

  it("requires admin auth", async () => {
    const res = await request(app)
      .post("/api/dividends/events/ingest")
      .send({ events: [validEvent] });
    expect(res.status).toBe(401);
  });

  it("ingests each event and reports per-event results", async () => {
    mockDividendService.ingestDividendEvent.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post("/api/dividends/events/ingest")
      .set("Authorization", "Bearer valid-admin-token")
      .send({ events: [validEvent] });

    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(1);
    expect(res.body.data.results[0]).toMatchObject({
      success: true,
      topic: "div_clm1",
    });
  });

  it("reports a per-event failure without failing the whole batch", async () => {
    mockDividendService.ingestDividendEvent.mockRejectedValueOnce(
      new Error("boom")
    );

    const res = await request(app)
      .post("/api/dividends/events/ingest")
      .set("Authorization", "Bearer valid-admin-token")
      .send({ events: [validEvent] });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0]).toMatchObject({
      success: false,
      error: "boom",
    });
  });
});
