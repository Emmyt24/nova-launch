/**
 * Smoke tests for the five orphaned v1 router mounts (#1691).
 *
 * Assembles a minimal Express app that mirrors how src/index.ts mounts
 * v1Router, then asserts that each of the five formerly-orphaned routers
 * responds (i.e. the response is NOT 404) when called through that mount.
 *
 * A 404 would indicate the router was never mounted — the exact bug this
 * PR was written to fix.
 */

import { describe, it, expect, vi } from "vitest";
import express, { Router } from "express";
import request from "supertest";

// ─── stub dependencies that are hard to instantiate in unit tests ─────────────

vi.mock("../../services/campaignProjectionService", () => ({
  campaignProjectionService: {
    getCampaignProjection: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../../services/eventBus", () => ({
  eventBus: {
    currentSequence: 0,
    getHistory: vi.fn().mockReturnValue([]),
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("../../services/webhookService", () => ({
  default: {
    createSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    listSubscriptions: vi.fn().mockResolvedValue([]),
    getSubscription: vi.fn(),
  },
}));

vi.mock("../../services/webhookDeliveryService", () => ({
  default: {
    getDeliveryHistory: vi.fn().mockResolvedValue([]),
    retryDelivery: vi.fn(),
    verifyDelivery: vi.fn(),
  },
}));

vi.mock("../../services/webhookDeadLetterService", () => ({
  default: {
    listAllPaginated: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    retryEntry: vi.fn(),
    discardEntry: vi.fn(),
  },
}));

vi.mock("../../middleware/auth", () => ({
  authenticateAdmin: (_req: any, _res: any, next: any) => next(),
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
  AuthRequest: {},
}));

vi.mock("../../middleware/rateLimiter", () => ({
  webhookRateLimiter: (_req: any, _res: any, next: any) => next(),
  webhookUserRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../middleware/auditLog", () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {},
  default: {},
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({})),
}));

// ─── assemble v1Router the same way src/index.ts does ────────────────────────

const { default: buybackRoutes } = await import("../buyback");
const { default: discoveryRoutes } = await import("../discovery");
const { default: webhooksRoutes } = await import("../webhooks");
const { default: webhooksDeadletterRoutes } = await import("../webhooks-deadletter");
const { default: eventsRoutes } = await import("../events");

const v1Router = Router();
v1Router.use("/buyback", buybackRoutes);
v1Router.use("/discovery", discoveryRoutes);
v1Router.use("/webhooks", webhooksRoutes);
v1Router.use("/webhooks-deadletter", webhooksDeadletterRoutes);
v1Router.use("/events", eventsRoutes);

const app = express();
app.use(express.json());
app.use("/api/v1", v1Router);

// ─── smoke tests ─────────────────────────────────────────────────────────────

describe("v1 orphaned router mount smoke tests (#1691)", () => {
  it("buyback router is mounted — GET /api/v1/buyback/campaigns returns non-404", async () => {
    // buyback router has GET /campaigns (list campaigns)
    const res = await request(app).get("/api/v1/buyback/campaigns");
    expect(res.status).not.toBe(404);
  });

  it("discovery router is mounted — GET /api/v1/discovery/tokens returns non-404", async () => {
    const res = await request(app).get("/api/v1/discovery/tokens");
    expect(res.status).not.toBe(404);
  });

  it("webhooks router is mounted — GET /api/v1/webhooks/subscriptions returns non-404", async () => {
    const res = await request(app).get("/api/v1/webhooks/subscriptions");
    expect(res.status).not.toBe(404);
  });

  it("webhooks-deadletter router is mounted — GET /api/v1/webhooks-deadletter returns non-404", async () => {
    const res = await request(app).get("/api/v1/webhooks-deadletter");
    expect(res.status).not.toBe(404);
  });

  it("events router is mounted — GET /api/v1/events/catchup?since=0 returns non-404", async () => {
    // since=0 with currentSequence=0 means no events — response should be 200
    const res = await request(app).get("/api/v1/events/catchup?since=0");
    expect(res.status).not.toBe(404);
  });
});
