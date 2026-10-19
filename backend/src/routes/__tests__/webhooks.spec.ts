import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import webhooksRouter from "../webhooks";
import webhookService from "../../services/webhookService";
import webhookDeliveryService from "../../services/webhookDeliveryService";
import webhookDeadLetterService from "../../services/webhookDeadLetterService";
import * as cryptoUtils from "../../utils/crypto";

vi.mock("../../services/webhookService", () => ({
  default: {
    createSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    restoreSubscription: vi.fn(),
    listSubscriptions: vi.fn(),
    getSubscription: vi.fn(),
    updateSubscriptionStatus: vi.fn(),
    getDeliveryLogs: vi.fn(),
    getDeliveryLogById: vi.fn(),
  },
}));

vi.mock("../../services/webhookDeliveryService", () => ({
  default: {
    testWebhook: vi.fn(),
    deliverWebhook: vi.fn(),
  },
}));

vi.mock("../../services/webhookDeadLetterService", () => ({
  default: {
    listUnresolved: vi.fn(),
    getEntry: vi.fn(),
    markResolved: vi.fn(),
  },
}));

vi.mock("../../middleware/validation", () => ({
  validateSubscriptionCreate: vi.fn((req, res, next) => next()),
  validateSubscriptionId: vi.fn((req, res, next) => next()),
  validateListSubscriptions: vi.fn((req, res, next) => next()),
  validateDeliveryId: vi.fn((req, res, next) => next()),
}));

vi.mock("../../middleware/rateLimiter", () => ({
  webhookRateLimiter: vi.fn((req, res, next) => next()),
  webhookUserRateLimiter: vi.fn((req, res, next) => next()),
}));

vi.mock("../../utils/crypto", () => ({
  verifyStoredWebhookSignature: vi.fn(),
}));

describe("Webhooks Routes", () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/webhooks", webhooksRouter);
  });

  describe("POST /api/webhooks/subscribe", () => {
    it("creates a subscription successfully", async () => {
      const mockSub = {
        id: "sub-1",
        url: "https://example.com/hook",
        secret: "supersecret123",
      };
      vi.mocked(webhookService.createSubscription).mockResolvedValueOnce(
        mockSub as any
      );

      const res = await request(app)
        .post("/api/webhooks/subscribe")
        .send({ url: "https://example.com/hook" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(mockSub);
    });

    it("handles error during subscription creation", async () => {
      vi.mocked(webhookService.createSubscription).mockRejectedValueOnce(
        new Error("DB error")
      );

      const res = await request(app)
        .post("/api/webhooks/subscribe")
        .send({ url: "https://example.com/hook" });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Failed to create webhook subscription");
    });
  });

  describe("DELETE /api/webhooks/unsubscribe/:id", () => {
    it("returns 400 when createdBy is missing", async () => {
      const res = await request(app)
        .delete("/api/webhooks/unsubscribe/sub-1")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("createdBy address is required");
    });

    it("returns 404 when subscription not found or not deleted", async () => {
      vi.mocked(webhookService.deleteSubscription).mockResolvedValueOnce(false);

      const res = await request(app)
        .delete("/api/webhooks/unsubscribe/sub-1")
        .send({ createdBy: "user-addr" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Subscription not found or unauthorized");
    });

    it("deletes subscription successfully", async () => {
      vi.mocked(webhookService.deleteSubscription).mockResolvedValueOnce(true);

      const res = await request(app)
        .delete("/api/webhooks/unsubscribe/sub-1")
        .send({ createdBy: "user-addr" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 500 on server error", async () => {
      vi.mocked(webhookService.deleteSubscription).mockRejectedValueOnce(
        new Error("DB error")
      );

      const res = await request(app)
        .delete("/api/webhooks/unsubscribe/sub-1")
        .send({ createdBy: "user-addr" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to delete webhook subscription");
    });
  });

  describe("POST /api/webhooks/list", () => {
    it("lists subscriptions with masked secrets", async () => {
      const subs = [
        {
          id: "sub-1",
          secret: "1234567890abcdef",
          url: "https://example.com",
        },
      ];
      vi.mocked(webhookService.listSubscriptions).mockResolvedValueOnce(
        subs as any
      );

      const res = await request(app)
        .post("/api/webhooks/list")
        .send({ createdBy: "user-1", active: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data[0].secret).toBe("12345678...");
      expect(res.body.count).toBe(1);
    });

    it("returns 500 on listing error", async () => {
      vi.mocked(webhookService.listSubscriptions).mockRejectedValueOnce(
        new Error("DB error")
      );

      const res = await request(app)
        .post("/api/webhooks/list")
        .send({ createdBy: "user-1" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to list webhook subscriptions");
    });
  });

  describe("GET /api/webhooks/:id", () => {
    it("returns 404 if subscription not found", async () => {
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce(null);

      const res = await request(app).get("/api/webhooks/sub-1");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Subscription not found");
    });

    it("returns subscription with masked secret", async () => {
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce({
        id: "sub-1",
        secret: "abcdefghijklmnop",
      } as any);

      const res = await request(app).get("/api/webhooks/sub-1");

      expect(res.status).toBe(200);
      expect(res.body.data.secret).toBe("abcdefgh...");
    });

    it("returns 500 on exception", async () => {
      vi.mocked(webhookService.getSubscription).mockRejectedValueOnce(
        new Error("DB error")
      );

      const res = await request(app).get("/api/webhooks/sub-1");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to fetch webhook subscription");
    });
  });

  describe("PATCH /api/webhooks/:id/toggle", () => {
    it("returns 400 when active field is not boolean", async () => {
      const res = await request(app)
        .patch("/api/webhooks/sub-1/toggle")
        .send({ active: "true" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("active field must be a boolean");
    });

    it("returns 404 when updateSubscriptionStatus returns null/false", async () => {
      vi.mocked(webhookService.updateSubscriptionStatus).mockResolvedValueOnce(
        null as any
      );

      const res = await request(app)
        .patch("/api/webhooks/sub-1/toggle")
        .send({ active: true });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Subscription not found");
    });

    it("updates subscription status successfully", async () => {
      vi.mocked(webhookService.updateSubscriptionStatus).mockResolvedValueOnce({
        id: "sub-1",
        active: true,
      } as any);

      const res = await request(app)
        .patch("/api/webhooks/sub-1/toggle")
        .send({ active: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain("activated successfully");
    });

    it("returns 500 on error", async () => {
      vi.mocked(webhookService.updateSubscriptionStatus).mockRejectedValueOnce(
        new Error("DB error")
      );

      const res = await request(app)
        .patch("/api/webhooks/sub-1/toggle")
        .send({ active: false });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to toggle webhook subscription");
    });
  });

  describe("GET /api/webhooks/:id/logs", () => {
    it("fetches delivery logs successfully", async () => {
      const logs = [{ id: "log-1", status: "success" }];
      vi.mocked(webhookService.getDeliveryLogs).mockResolvedValueOnce(
        logs as any
      );

      const res = await request(app).get("/api/webhooks/sub-1/logs?limit=10");

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(logs);
      expect(res.body.count).toBe(1);
    });

    it("handles error fetching delivery logs", async () => {
      vi.mocked(webhookService.getDeliveryLogs).mockRejectedValueOnce(
        new Error("DB error")
      );

      const res = await request(app).get("/api/webhooks/sub-1/logs");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to fetch delivery logs");
    });
  });

  describe("GET /api/webhooks/deliveries/:id/verification", () => {
    it("returns 404 when delivery log is not found", async () => {
      vi.mocked(webhookService.getDeliveryLogById).mockResolvedValueOnce(null);

      const res = await request(app).get(
        "/api/webhooks/deliveries/del-1/verification"
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Delivery log not found");
    });

    it("returns 404 when associated subscription is not found", async () => {
      vi.mocked(webhookService.getDeliveryLogById).mockResolvedValueOnce({
        id: "del-1",
        subscriptionId: "sub-1",
      } as any);
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce(null);

      const res = await request(app).get(
        "/api/webhooks/deliveries/del-1/verification"
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Associated subscription not found");
    });

    it("verifies signature successfully", async () => {
      vi.mocked(webhookService.getDeliveryLogById).mockResolvedValueOnce({
        id: "del-1",
        subscriptionId: "sub-1",
        payload: {
          event: "burn",
          timestamp: 123456,
          data: { amount: 100 },
          signature: "mock-sig",
        },
      } as any);
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce({
        id: "sub-1",
        secret: "supersecret12345678",
      } as any);
      vi.mocked(cryptoUtils.verifyStoredWebhookSignature).mockReturnValueOnce(
        true
      );

      const res = await request(app).get(
        "/api/webhooks/deliveries/del-1/verification"
      );

      expect(res.status).toBe(200);
      expect(res.body.data.verified).toBe(true);
      expect(res.body.data.keyId).toBe("12345678");
    });

    it("returns 500 on verification exception", async () => {
      vi.mocked(webhookService.getDeliveryLogById).mockRejectedValueOnce(
        new Error("DB error")
      );

      const res = await request(app).get(
        "/api/webhooks/deliveries/del-1/verification"
      );

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to verify delivery signature");
    });
  });

  describe("POST /api/webhooks/:id/test", () => {
    it("returns 404 when subscription not found", async () => {
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce(null);

      const res = await request(app).post("/api/webhooks/sub-1/test");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Subscription not found");
    });

    it("returns test delivery status", async () => {
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce({
        id: "sub-1",
      } as any);
      vi.mocked(webhookDeliveryService.testWebhook).mockResolvedValueOnce(true);

      const res = await request(app).post("/api/webhooks/sub-1/test");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Test webhook delivered successfully");
    });

    it("returns failure message when testWebhook returns false", async () => {
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce({
        id: "sub-1",
      } as any);
      vi.mocked(webhookDeliveryService.testWebhook).mockResolvedValueOnce(false);

      const res = await request(app).post("/api/webhooks/sub-1/test");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Test webhook delivery failed");
    });

    it("returns 500 on exception", async () => {
      vi.mocked(webhookService.getSubscription).mockRejectedValueOnce(
        new Error("Network error")
      );

      const res = await request(app).post("/api/webhooks/sub-1/test");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to test webhook");
    });
  });

  describe("GET /api/webhooks/:id/dead-letters", () => {
    it("returns 404 if subscription does not exist", async () => {
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce(null);

      const res = await request(app).get("/api/webhooks/sub-1/dead-letters");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Subscription not found");
    });

    it("returns dead letters for subscription", async () => {
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce({
        id: "sub-1",
      } as any);
      vi.mocked(webhookDeadLetterService.listUnresolved).mockResolvedValueOnce([
        { id: "dl-1" },
      ] as any);

      const res = await request(app).get("/api/webhooks/sub-1/dead-letters");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("returns 500 on error", async () => {
      vi.mocked(webhookService.getSubscription).mockRejectedValueOnce(
        new Error("Error")
      );

      const res = await request(app).get("/api/webhooks/sub-1/dead-letters");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to fetch dead-letter deliveries");
    });
  });

  describe("POST /api/webhooks/dead-letters/:id/retry", () => {
    it("returns 404 when dead-letter entry not found", async () => {
      vi.mocked(webhookDeadLetterService.getEntry).mockResolvedValueOnce(null);

      const res = await request(app).post(
        "/api/webhooks/dead-letters/dl-1/retry"
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Dead-letter entry not found");
    });

    it("returns 404 when subscription not found", async () => {
      vi.mocked(webhookDeadLetterService.getEntry).mockResolvedValueOnce({
        id: "dl-1",
        subscriptionId: "sub-1",
        payload: JSON.stringify({}),
      } as any);
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce(null);

      const res = await request(app).post(
        "/api/webhooks/dead-letters/dl-1/retry"
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Associated subscription not found");
    });

    it("returns 502 when retry delivery fails", async () => {
      vi.mocked(webhookDeadLetterService.getEntry).mockResolvedValueOnce({
        id: "dl-1",
        subscriptionId: "sub-1",
        event: "token.mint",
        payload: JSON.stringify({ data: { foo: "bar" } }),
      } as any);
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce({
        id: "sub-1",
      } as any);
      vi.mocked(webhookDeliveryService.deliverWebhook).mockResolvedValueOnce({
        success: false,
      } as any);

      const res = await request(app).post(
        "/api/webhooks/dead-letters/dl-1/retry"
      );

      expect(res.status).toBe(502);
      expect(res.body.error).toBe(
        "Dead-letter delivery failed; entry remains unresolved"
      );
    });

    it("marks as resolved when retry succeeds", async () => {
      vi.mocked(webhookDeadLetterService.getEntry).mockResolvedValueOnce({
        id: "dl-1",
        subscriptionId: "sub-1",
        event: "token.mint",
        payload: JSON.stringify({ raw: "payload" }),
      } as any);
      vi.mocked(webhookService.getSubscription).mockResolvedValueOnce({
        id: "sub-1",
      } as any);
      vi.mocked(webhookDeliveryService.deliverWebhook).mockResolvedValueOnce({
        success: true,
      } as any);

      const res = await request(app).post(
        "/api/webhooks/dead-letters/dl-1/retry"
      );

      expect(res.status).toBe(200);
      expect(webhookDeadLetterService.markResolved).toHaveBeenCalledWith(
        "dl-1",
        "retried"
      );
    });

    it("returns 500 on exception", async () => {
      vi.mocked(webhookDeadLetterService.getEntry).mockRejectedValueOnce(
        new Error("DB error")
      );

      const res = await request(app).post(
        "/api/webhooks/dead-letters/dl-1/retry"
      );

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to retry dead-letter delivery");
    });
  });

  describe("POST /api/webhooks/dead-letters/:id/skip", () => {
    it("returns 404 when dead-letter entry not found", async () => {
      vi.mocked(webhookDeadLetterService.getEntry).mockResolvedValueOnce(null);

      const res = await request(app).post("/api/webhooks/dead-letters/dl-1/skip");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Dead-letter entry not found");
    });

    it("marks dead letter as skipped", async () => {
      vi.mocked(webhookDeadLetterService.getEntry).mockResolvedValueOnce({
        id: "dl-1",
      } as any);

      const res = await request(app).post("/api/webhooks/dead-letters/dl-1/skip");

      expect(res.status).toBe(200);
      expect(webhookDeadLetterService.markResolved).toHaveBeenCalledWith(
        "dl-1",
        "skipped"
      );
    });

    it("returns 500 on exception", async () => {
      vi.mocked(webhookDeadLetterService.getEntry).mockRejectedValueOnce(
        new Error("Error")
      );

      const res = await request(app).post("/api/webhooks/dead-letters/dl-1/skip");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to archive dead-letter delivery");
    });
  });
});
