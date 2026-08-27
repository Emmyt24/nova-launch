/**
 * Smoke tests for the admin router mount (#1690).
 *
 * Verifies that every router file in the admin/ directory is actually
 * reachable through the composed admin/index.ts router — catching a
 * missing mount before it reaches production.
 *
 * Each sub-test sends a minimal request through the assembled router and
 * asserts that the response is NOT 404 (route-not-found), which would
 * indicate the router was never mounted.
 */

import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

// ─── mock native deps that are not installed in the test workspace ────────────
vi.mock("node-cache", () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
    del: vi.fn(),
    flushAll: vi.fn(),
  })),
}));

vi.mock("@pinata/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    pinByHash: vi.fn().mockResolvedValue({ id: "mock-id" }),
    unpin: vi.fn().mockResolvedValue({}),
    pinList: vi.fn().mockResolvedValue({ rows: [] }),
  })),
}));

// ─── universal auth bypass ───────────────────────────────────────────────────
vi.mock("../../../middleware/auth", () => ({
  authenticateAdmin: (_req: any, _res: any, next: any) => next(),
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
  AuthRequest: {},
}));

vi.mock("../../../middleware/auditLog", () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

// ─── stub heavy service dependencies so the router modules load cleanly ──────
vi.mock("../../../services/eventReplayService", () => ({
  EventReplayService: vi.fn().mockImplementation(() => ({
    replay: vi.fn().mockResolvedValue({}),
    clearAndRebuild: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock("../../../services/jobQueue", () => ({
  jobQueue: {
    failedJobs: vi.fn().mockReturnValue([]),
    retryJob: vi.fn().mockReturnValue(null),
    discardJob: vi.fn().mockReturnValue(false),
  },
  default: {
    failedJobs: vi.fn().mockReturnValue([]),
    retryJob: vi.fn().mockReturnValue(null),
    discardJob: vi.fn().mockReturnValue(false),
  },
}));

vi.mock("../../../config/startupValidation", () => ({
  runNetworkValidation: vi.fn().mockResolvedValue({
    horizon: { reachable: true, latencyMs: 42, passphraseMatches: true },
    rpc: { reachable: true },
    ipfs: { reachable: true },
  }),
}));

vi.mock("../../../config/env", () => ({
  validateEnv: vi.fn().mockReturnValue({
    JWT_SECRET: "test-secret",
    PORT: 3001,
  }),
}));

vi.mock("../../../services/consistency/onchainProjectionVerifier", () => ({
  OnChainProjectionVerifier: vi.fn().mockImplementation(() => ({
    reconcileProjection: vi.fn().mockResolvedValue({
      tokenAddress: "CTEST",
      fieldsUpdated: [],
      alreadyConsistent: true,
      lastReconciledAt: new Date(),
    }),
  })),
}));

vi.mock("../../../lib/prisma", () => ({
  prisma: {},
  default: {},
}));

vi.mock("../../../lib/ipfs/pinata", () => ({
  pinata: {},
  default: {},
}));

vi.mock("../../../lib/ipfs/pinataQueue", () => ({
  pinataQueue: { enqueue: vi.fn() },
  default: {},
}));

vi.mock("../../../lib/ipfs/cidVerification", () => ({
  verifyCIDContent: vi.fn().mockResolvedValue(true),
  verifyMetadataCID: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../lib/ipfs/pinMonitor", () => ({
  pinMonitor: { checkAll: vi.fn().mockResolvedValue([]) },
  default: {},
}));

vi.mock("../../../services/auditRetentionJob", () => ({
  checkpointStore: {
    load: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../../../config/database", () => ({
  Database: {
    getAuditLogs: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../../lib/metrics/pinataMetrics", () => ({
  registerPinataMetrics: vi.fn(),
  recordPinAttempt: vi.fn(),
  recordPinSuccess: vi.fn(),
  recordPinFailure: vi.fn(),
}));

vi.mock("../../../lib/circuitBreaker", () => ({
  CircuitBreaker: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockImplementation((fn: any) => fn()),
  })),
  registerCircuitBreaker: vi.fn(),
}));

// ─── assemble the full admin router ──────────────────────────────────────────
const { default: adminRouter } = await import("../index");

const app = express();
app.use(express.json());
app.use("/api/admin", adminRouter);

// ─── smoke tests ─────────────────────────────────────────────────────────────

describe("Admin router mount smoke tests (#1690 + #1689)", () => {
  it("eventReplay router is mounted — POST /api/admin/event-replay returns non-404", async () => {
    // The eventReplay router self-prefixes its routes with /event-replay,
    // so it is mounted at router root (/). A 403 confirms the route is reachable.
    const res = await request(app).post("/api/admin/event-replay");
    expect(res.status).not.toBe(404);
  });

  it("jobs router is mounted — GET /api/admin/jobs/failed returns non-404", async () => {
    const res = await request(app).get("/api/admin/jobs/failed");
    expect(res.status).not.toBe(404);
  });

  it("network router is mounted — GET /api/admin/network returns non-404", async () => {
    const res = await request(app).get("/api/admin/network");
    expect(res.status).not.toBe(404);
  });

  it("reconcile router is mounted — POST /api/admin/reconcile/CTEST returns non-404", async () => {
    const res = await request(app).post("/api/admin/reconcile/CTEST");
    expect(res.status).not.toBe(404);
  });

  it("treasury router is mounted — GET /api/admin/treasury returns non-404", async () => {
    const res = await request(app).get("/api/admin/treasury");
    expect(res.status).not.toBe(404);
  });

  it("governance router is mounted — GET /api/admin/governance returns non-404", async () => {
    const res = await request(app).get("/api/admin/governance");
    expect(res.status).not.toBe(404);
  });

  it("auditArchive router is mounted — GET /api/admin/audit/archive-status returns non-404 (#1689)", async () => {
    const res = await request(app).get("/api/admin/audit/archive-status");
    expect(res.status).not.toBe(404);
  });
});
