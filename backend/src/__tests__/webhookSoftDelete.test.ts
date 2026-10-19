import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { WebhookService } from "../services/webhookService";
import { WebhookEventType } from "../types/webhook";

vi.mock("../database/db", () => ({
  default: {
    query: vi.fn(),
  },
}));

vi.mock("../middleware/rateLimiter", () => ({
  webhookRateLimiter: vi.fn((_req, _res, next) => next()),
  webhookUserRateLimiter: vi.fn((_req, _res, next) => next()),
}));

const OWNER = "G" + "A".repeat(55);
const SUB_ID = "11111111-1111-4111-8111-111111111111";

async function mockedQuery() {
  const db = await import("../database/db");
  return vi.mocked(db.default.query);
}

describe("Webhook soft delete (service)", () => {
  let service: WebhookService;

  beforeEach(() => {
    service = new WebhookService();
    vi.clearAllMocks();
  });

  it("soft-deletes by setting deleted_at instead of removing the row", async () => {
    const query = await mockedQuery();
    query.mockResolvedValueOnce({ rows: [{ id: SUB_ID }], rowCount: 1 } as any);

    const deleted = await service.deleteSubscription(SUB_ID, OWNER);

    expect(deleted).toBe(true);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/UPDATE webhook_subscriptions/);
    expect(sql).toMatch(/SET deleted_at = CURRENT_TIMESTAMP/);
    expect(sql).not.toMatch(/DELETE FROM/);
    expect(query.mock.calls[0][1]).toEqual([SUB_ID, OWNER]);
  });

  it("returns false when deleting an already-deleted or unknown subscription", async () => {
    const query = await mockedQuery();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    expect(await service.deleteSubscription(SUB_ID, OWNER)).toBe(false);
    expect(query.mock.calls[0][0]).toMatch(/deleted_at IS NULL/);
  });

  it("excludes deleted subscriptions from default queries", async () => {
    const query = await mockedQuery();
    query.mockResolvedValue({ rows: [], rowCount: 0 } as any);

    await service.getSubscription(SUB_ID);
    await service.listSubscriptions(OWNER);
    await service.findMatchingSubscriptions(WebhookEventType.TOKEN_CREATED);
    await service.updateSubscriptionStatus(SUB_ID, true);

    for (const call of query.mock.calls) {
      expect(call[0]).toMatch(/deleted_at IS NULL/);
    }
  });

  it("can include deleted subscriptions when explicitly requested", async () => {
    const query = await mockedQuery();
    query.mockResolvedValueOnce({
      rows: [
        {
          id: SUB_ID,
          url: "https://example.com/hook",
          token_address: null,
          events: [WebhookEventType.TOKEN_CREATED],
          secret: "s".repeat(64),
          active: true,
          created_by: OWNER,
          created_at: new Date(),
          last_triggered: null,
          deleted_at: new Date("2026-10-01T00:00:00Z"),
        },
      ],
      rowCount: 1,
    } as any);

    const sub = await service.getSubscription(SUB_ID, { includeDeleted: true });

    expect(query.mock.calls[0][0]).not.toMatch(/deleted_at IS NULL/);
    expect(sub?.deletedAt).toEqual(new Date("2026-10-01T00:00:00Z"));
  });

  it("restores a subscription within the retention window", async () => {
    const query = await mockedQuery();
    query.mockResolvedValueOnce({ rows: [{ id: SUB_ID }], rowCount: 1 } as any);

    const result = await service.restoreSubscription(SUB_ID, OWNER, 30);

    expect(result).toBe("restored");
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/SET deleted_at = NULL/);
    expect(sql).toMatch(/deleted_at > CURRENT_TIMESTAMP - \(\$3 \* INTERVAL '1 day'\)/);
    expect(params).toEqual([SUB_ID, OWNER, 30]);
  });

  it("reports retention_expired when the deleted row is past the window", async () => {
    const query = await mockedQuery();
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ deleted_at: new Date(0) }], rowCount: 1 } as any);

    expect(await service.restoreSubscription(SUB_ID, OWNER)).toBe("retention_expired");
  });

  it("reports not_found when there is no deleted row for the owner", async () => {
    const query = await mockedQuery();
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    expect(await service.restoreSubscription(SUB_ID, OWNER)).toBe("not_found");
  });

  it("purges only subscriptions deleted beyond the retention window", async () => {
    const query = await mockedQuery();
    query.mockResolvedValueOnce({ rows: [], rowCount: 3 } as any);

    expect(await service.purgeExpiredDeleted(7)).toBe(3);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM webhook_subscriptions/);
    expect(sql).toMatch(/deleted_at IS NOT NULL/);
    expect(params).toEqual([7]);
  });
});

describe("POST /api/webhooks/:id/restore", () => {
  let app: express.Application;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { default: router } = await import("../routes/webhooks");
    app = express();
    app.use(express.json());
    app.use("/api/webhooks", router);
  });

  it("requires createdBy", async () => {
    const res = await request(app).post(`/api/webhooks/${SUB_ID}/restore`).send({});
    expect(res.status).toBe(400);
  });

  it("restores a deleted subscription", async () => {
    const query = await mockedQuery();
    query.mockResolvedValueOnce({ rows: [{ id: SUB_ID }], rowCount: 1 } as any);

    const res = await request(app)
      .post(`/api/webhooks/${SUB_ID}/restore`)
      .send({ createdBy: OWNER });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 410 once the retention window has passed", async () => {
    const query = await mockedQuery();
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ deleted_at: new Date(0) }], rowCount: 1 } as any);

    const res = await request(app)
      .post(`/api/webhooks/${SUB_ID}/restore`)
      .send({ createdBy: OWNER });

    expect(res.status).toBe(410);
  });

  it("returns 404 when nothing restorable exists", async () => {
    const query = await mockedQuery();
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const res = await request(app)
      .post(`/api/webhooks/${SUB_ID}/restore`)
      .send({ createdBy: OWNER });

    expect(res.status).toBe(404);
  });
});
