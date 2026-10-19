/**
 * GET /api/admin/reconcile/vaults/report (#2208)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import reconcileRouter from "../reconcile";

vi.mock("../../../lib/prisma", () => ({ prisma: {} }));

const mockBuildReport = vi.fn();

vi.mock("../../../services/consistency/onchainProjectionVerifier", () => ({
  OnChainProjectionVerifier: vi.fn().mockImplementation(() => ({
    buildVaultReconciliationReport: mockBuildReport,
  })),
}));

vi.mock("../../../middleware/auth", () => ({
  authenticateAdmin: (req: any, res: any, next: any) => {
    if (req.headers.authorization === "Bearer admin-token") return next();
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  },
}));

const app = express();
app.use(express.json());
app.use("/api/admin/reconcile", reconcileRouter);

const report = {
  consistent: false,
  generatedAt: "2026-10-19T00:00:00.000Z",
  durationMs: 12,
  summary: {
    projectedVaults: 1,
    onChainVaults: 1,
    mismatchedVaults: 1,
    totalMismatches: 1,
    missingOnChain: 0,
    missingInProjection: 0,
    fieldMismatches: 1,
    errors: 0,
  },
  mismatches: [
    {
      streamId: 1,
      kind: "field_mismatch",
      field: "status",
      projectionValue: "CREATED",
      onChainValue: "CLAIMED",
      severity: "error",
    },
  ],
  errors: [],
};

describe("GET /api/admin/reconcile/vaults/report", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects unauthenticated callers", async () => {
    const res = await request(app).get("/api/admin/reconcile/vaults/report");
    expect(res.status).toBe(401);
    expect(mockBuildReport).not.toHaveBeenCalled();
  });

  it("rejects non-admin tokens", async () => {
    const res = await request(app)
      .get("/api/admin/reconcile/vaults/report")
      .set("Authorization", "Bearer user-token");
    expect(res.status).toBe(401);
    expect(mockBuildReport).not.toHaveBeenCalled();
  });

  it("returns the structured report to admins", async () => {
    mockBuildReport.mockResolvedValue(report);

    const res = await request(app)
      .get("/api/admin/reconcile/vaults/report")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(report);
  });

  it("returns 500 without leaking internals when the report fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockBuildReport.mockRejectedValue(new Error("connection string postgres://secret"));

    const res = await request(app)
      .get("/api/admin/reconcile/vaults/report")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });
});
