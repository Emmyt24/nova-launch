/**
 * Tests for issue #2189 — API key rotation endpoint with grace period.
 *
 * Covers:
 *  - Per-rotation configurable grace window (and immediate invalidation with 0)
 *  - Grace bounds and the API_KEY_ROTATION_GRACE_MS default
 *  - Rotation is written to the audit trail
 *  - The key owner is notified
 *  - POST /api/admin/api-keys/:id/rotate and /rotation/commit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  ApiKeyManager,
  MAX_GRACE_MS,
  resolveDefaultGraceMs,
} from "../auth/apiKey";

// ---------------------------------------------------------------------------
// Module mocks — keep the service importable without Prisma or providers
// ---------------------------------------------------------------------------

const { createAuditLog, send, auth } = vi.hoisted(() => ({
  createAuditLog: vi.fn(),
  send: vi.fn(),
  auth: { admin: null as { id: string; role: string } | null },
}));

vi.mock("../config/database", () => ({ Database: { createAuditLog } }));
vi.mock("../services/notificationService", () => ({ default: { send } }));

vi.mock("../middleware/auth", () => ({
  authenticateAdmin: (req: any, res: any, next: any) => {
    if (!auth.admin) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    }
    req.admin = auth.admin;
    next();
  },
}));

import { ApiKeyRotationService } from "../services/apiKeyRotationService";
import { apiKeyManager } from "../auth/apiKey";
import apiKeysRouter from "../routes/admin/apiKeys";

const actor = { id: "admin-1", ipAddress: "10.0.0.1", userAgent: "vitest" };

beforeEach(() => {
  createAuditLog.mockReset().mockResolvedValue({});
  send.mockReset().mockResolvedValue([{ channel: "EMAIL", success: true, provider: "sendgrid", target: {} }]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// ApiKeyManager — configurable grace window
// ---------------------------------------------------------------------------

describe("ApiKeyManager.rotate — configurable grace", () => {
  it("keeps the old key valid for the requested window", () => {
    vi.useFakeTimers();
    const mgr = new ApiKeyManager();
    const { id, rawKey: oldKey } = mgr.create("svc");
    const { rawKey: newKey, graceEndsAt } = mgr.rotate(id, { graceMs: 60_000 });

    expect(graceEndsAt).toBe(Date.now() + 60_000);
    vi.advanceTimersByTime(59_000);
    expect(mgr.validate(oldKey)).not.toBeNull();
    expect(mgr.validate(newKey)).not.toBeNull();

    vi.advanceTimersByTime(2_000);
    expect(mgr.validate(oldKey)).toBeNull();
    expect(mgr.validate(newKey)).not.toBeNull();
  });

  it("invalidates the old key immediately with a grace of 0", () => {
    const mgr = new ApiKeyManager();
    const { id, rawKey: oldKey } = mgr.create("svc");
    const { rawKey: newKey } = mgr.rotate(id, { graceMs: 0 });

    expect(mgr.validate(oldKey)).toBeNull();
    expect(mgr.validate(newKey)).not.toBeNull();
    expect(mgr.get(id)?.status).toBe("active");
  });

  it("drops the oldest key when rotating during a grace period", () => {
    const mgr = new ApiKeyManager();
    const { id, rawKey: first } = mgr.create("svc");
    const { rawKey: second } = mgr.rotate(id, { graceMs: 60_000 });
    const { rawKey: third } = mgr.rotate(id, { graceMs: 60_000 });

    expect(mgr.validate(first)).toBeNull();
    expect(mgr.validate(second)).not.toBeNull();
    expect(mgr.validate(third)).not.toBeNull();
  });

  it.each([-1, 1.5, MAX_GRACE_MS + 1])("rejects an out-of-range grace of %s", (graceMs) => {
    const mgr = new ApiKeyManager();
    const { id, rawKey } = mgr.create("svc");
    expect(() => mgr.rotate(id, { graceMs })).toThrow(RangeError);
    // A rejected rotation must leave the original key untouched
    expect(mgr.validate(rawKey)).not.toBeNull();
  });

  it("records the owner on creation", () => {
    const mgr = new ApiKeyManager();
    const { id } = mgr.create("svc", { ownerId: "u1", ownerEmail: "owner@example.com" });
    expect(mgr.get(id)).toMatchObject({ ownerId: "u1", ownerEmail: "owner@example.com" });
  });
});

describe("resolveDefaultGraceMs", () => {
  it("defaults to 24 hours", () => {
    expect(resolveDefaultGraceMs(undefined)).toBe(24 * 60 * 60 * 1000);
  });

  it("reads API_KEY_ROTATION_GRACE_MS", () => {
    vi.stubEnv("API_KEY_ROTATION_GRACE_MS", "3600000");
    expect(resolveDefaultGraceMs()).toBe(3_600_000);
    expect(new ApiKeyManager().defaultGraceMs).toBe(3_600_000);
  });

  it("rejects invalid values", () => {
    expect(() => resolveDefaultGraceMs("abc")).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// ApiKeyRotationService — audit trail and owner notification
// ---------------------------------------------------------------------------

describe("ApiKeyRotationService", () => {
  function setup(owner = { ownerId: "owner-1", ownerEmail: "owner@example.com" }) {
    const mgr = new ApiKeyManager();
    const { id, rawKey } = mgr.create("svc", owner);
    const service = new ApiKeyRotationService(mgr, { createAuditLog }, { send });
    return { mgr, id, rawKey, service };
  }

  it("rotates and returns the new key with the grace end", async () => {
    const { mgr, id, rawKey, service } = setup();
    const result = await service.rotate({ keyId: id, graceMs: 120_000, actor });

    expect(result.rawKey).not.toBe(rawKey);
    expect(result.graceMs).toBe(120_000);
    expect(new Date(result.graceEndsAt).getTime()).toBeGreaterThan(Date.now());
    expect(mgr.validate(rawKey)).not.toBeNull();
    expect(mgr.validate(result.rawKey)).not.toBeNull();
  });

  it("logs the rotation in the audit trail without exposing key material", async () => {
    const { id, service } = setup();
    const result = await service.rotate({ keyId: id, graceMs: 120_000, actor });

    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: "admin-1",
        action: "API_KEY_ROTATED",
        resource: "api_key",
        resourceId: id,
        beforeState: { status: "active" },
        afterState: expect.objectContaining({ status: "rotating", graceMs: 120_000 }),
        ipAddress: "10.0.0.1",
        userAgent: "vitest",
      })
    );
    expect(JSON.stringify(createAuditLog.mock.calls)).not.toContain(result.rawKey);
  });

  it("notifies the owner by email", async () => {
    const { id, service } = setup();
    const result = await service.rotate({ keyId: id, graceMs: 120_000, actor });

    expect(result.ownerNotified).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [{ type: "EMAIL", destination: "owner@example.com" }],
        userId: "owner-1",
        payload: expect.objectContaining({
          subject: expect.stringContaining("rotated"),
          metadata: expect.objectContaining({ keyId: id }),
        }),
      })
    );
    expect(JSON.stringify(send.mock.calls)).not.toContain(result.rawKey);
  });

  it("skips notification when the key has no owner contact", async () => {
    const { id, service } = setup({ ownerId: "owner-1", ownerEmail: undefined as any });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await service.rotate({ keyId: id, actor });
    expect(result.ownerNotified).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("still rotates when the audit log or notification fails", async () => {
    const { mgr, id, service } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    createAuditLog.mockRejectedValueOnce(new Error("db down"));
    send.mockRejectedValueOnce(new Error("sendgrid down"));

    const result = await service.rotate({ keyId: id, graceMs: 1_000, actor });
    expect(mgr.validate(result.rawKey)).not.toBeNull();
    expect(result.ownerNotified).toBe(false);
  });

  it("audits an early commit", async () => {
    const { mgr, id, rawKey, service } = setup();
    await service.rotate({ keyId: id, graceMs: 60_000, actor });
    await service.commit(id, actor);

    expect(mgr.validate(rawKey)).toBeNull();
    expect(createAuditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "API_KEY_ROTATION_COMMITTED", resourceId: id })
    );
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe("POST /api/admin/api-keys/:id/rotate", () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/admin/api-keys", apiKeysRouter);
    return app;
  }

  function createKey(ownerId = "owner-1") {
    return apiKeyManager.create("route-svc", { ownerId, ownerEmail: "owner@example.com" });
  }

  it("returns 401 when unauthenticated", async () => {
    auth.admin = null;
    const { id } = createKey();
    const res = await request(buildApp()).post(`/api/admin/api-keys/${id}/rotate`).send({});
    expect(res.status).toBe(401);
  });

  it("lets the owner rotate with a custom grace period", async () => {
    auth.admin = { id: "owner-1", role: "admin" };
    const { id, rawKey } = createKey();

    const res = await request(buildApp())
      .post(`/api/admin/api-keys/${id}/rotate`)
      .send({ gracePeriodSeconds: 3600 });

    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.data).toMatchObject({ id, gracePeriodSeconds: 3600, ownerNotified: true });
    expect(res.body.data.apiKey).toMatch(/^nlk_/);
    expect(apiKeyManager.validate(rawKey)).not.toBeNull();
    expect(apiKeyManager.validate(res.body.data.apiKey)).not.toBeNull();
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "API_KEY_ROTATED", adminId: "owner-1" }));
  });

  it("lets a super admin rotate any key", async () => {
    auth.admin = { id: "sa-1", role: "super_admin" };
    const { id } = createKey("someone-else");
    const res = await request(buildApp()).post(`/api/admin/api-keys/${id}/rotate`).send({});
    expect(res.status).toBe(201);
  });

  it("forbids non-owners", async () => {
    auth.admin = { id: "other-admin", role: "admin" };
    const { id } = createKey();
    const res = await request(buildApp()).post(`/api/admin/api-keys/${id}/rotate`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 404 for unknown keys", async () => {
    auth.admin = { id: "sa-1", role: "super_admin" };
    const res = await request(buildApp()).post("/api/admin/api-keys/missing/rotate").send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 409 for revoked keys", async () => {
    auth.admin = { id: "sa-1", role: "super_admin" };
    const { id } = createKey();
    apiKeyManager.revoke(id);
    const res = await request(buildApp()).post(`/api/admin/api-keys/${id}/rotate`).send({});
    expect(res.status).toBe(409);
  });

  it.each([{ gracePeriodSeconds: -1 }, { gracePeriodSeconds: 31 * 24 * 3600 }, { gracePeriodSeconds: "1h" }, { unknown: 1 }])(
    "rejects an invalid body %o",
    async (body) => {
      auth.admin = { id: "sa-1", role: "super_admin" };
      const { id } = createKey();
      const res = await request(buildApp()).post(`/api/admin/api-keys/${id}/rotate`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  );

  it("commits a rotation early", async () => {
    auth.admin = { id: "owner-1", role: "admin" };
    const { id, rawKey } = createKey();
    const app = buildApp();
    await request(app).post(`/api/admin/api-keys/${id}/rotate`).send({ gracePeriodSeconds: 3600 });

    const res = await request(app).post(`/api/admin/api-keys/${id}/rotation/commit`);
    expect(res.status).toBe(200);
    expect(apiKeyManager.validate(rawKey)).toBeNull();
  });

  it("returns 409 when committing a key that is not rotating", async () => {
    auth.admin = { id: "owner-1", role: "admin" };
    const { id } = createKey();
    const res = await request(buildApp()).post(`/api/admin/api-keys/${id}/rotation/commit`);
    expect(res.status).toBe(409);
  });
});
