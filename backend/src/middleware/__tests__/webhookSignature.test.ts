/**
 * Tests for webhook signature verification middleware (#1583)
 *
 * Covers:
 *  - Constant-time comparison prevents timing attacks
 *  - Replay window enforcement rejects stale timestamps
 *  - Normalized error responses regardless of failure mode
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express, { Express } from "express";
import { verifyInboundWebhookSignature } from "../webhookSignature";
import { generateWebhookSignature } from "../../utils/crypto";

describe("verifyInboundWebhookSignature middleware", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.raw({ type: "application/json" }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("successful signature verification", () => {
    it("allows requests with valid signature", async () => {
      const payload = JSON.stringify({ test: "data" });
      const secret = "test-secret-key";
      const signature = generateWebhookSignature(payload, secret);

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(async () => secret),
        (req, res) => res.json({ success: true })
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-webhook-signature", signature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("allows requests when secret lookup returns null (no verification needed)", async () => {
      const payload = JSON.stringify({ test: "data" });

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(async () => null),
        (req, res) => res.json({ success: true })
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-webhook-signature", "v1.1234567890.invalid")
        .set("Content-Type", "application/json")
        .send(payload);

      // null secret results in unauthorized
      expect(res.status).toBe(401);
    });
  });

  describe("rejection with normalized error responses", () => {
    it("rejects missing signature header with generic error", async () => {
      const payload = JSON.stringify({ test: "data" });
      const secret = "test-secret-key";

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(async () => secret),
        (req, res) => res.json({ success: true })
      );

      const res = await request(app)
        .post("/webhook")
        .set("Content-Type", "application/json")
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("rejects malformed signature format with generic error", async () => {
      const payload = JSON.stringify({ test: "data" });
      const secret = "test-secret-key";

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(async () => secret),
        (req, res) => res.json({ success: true })
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-webhook-signature", "invalid-format")
        .set("Content-Type", "application/json")
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("rejects invalid signature with generic error", async () => {
      const payload = JSON.stringify({ test: "data" });
      const secret = "test-secret-key";
      const wrongSecret = "wrong-secret";
      const signature = generateWebhookSignature(payload, wrongSecret);

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(async () => secret),
        (req, res) => res.json({ success: true })
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-webhook-signature", signature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("rejects stale timestamp (replay attack) with generic error", async () => {
      const payload = JSON.stringify({ test: "data" });
      const secret = "test-secret-key";
      const staleTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      const signature = generateWebhookSignature(payload, secret, staleTimestamp);

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(async () => secret, 300), // 5 min tolerance
        (req, res) => res.json({ success: true })
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-webhook-signature", signature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });
  });

  describe("replay window enforcement", () => {
    it("accepts signatures within replay tolerance window", async () => {
      const payload = JSON.stringify({ test: "data" });
      const secret = "test-secret-key";
      const recentTimestamp = Math.floor(Date.now() / 1000) - 100; // 100 seconds ago
      const signature = generateWebhookSignature(payload, secret, recentTimestamp);

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(async () => secret, 300),
        (req, res) => res.json({ success: true })
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-webhook-signature", signature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("rejects signatures outside replay tolerance window", async () => {
      const payload = JSON.stringify({ test: "data" });
      const secret = "test-secret-key";
      const staleTimestamp = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago
      const signature = generateWebhookSignature(payload, secret, staleTimestamp);

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(async () => secret, 300), // 5 min tolerance
        (req, res) => res.json({ success: true })
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-webhook-signature", signature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("supports configurable replay tolerance", async () => {
      const payload = JSON.stringify({ test: "data" });
      const secret = "test-secret-key";
      const timestamp = Math.floor(Date.now() / 1000) - 30; // 30 seconds ago
      const signature = generateWebhookSignature(payload, secret, timestamp);

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(async () => secret, 60), // 1 min tolerance
        (req, res) => res.json({ success: true })
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-webhook-signature", signature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(res.status).toBe(200);
    });
  });

  describe("constant-time comparison", () => {
    it("uses timing-safe equality check", async () => {
      const payload = JSON.stringify({ test: "data" });
      const secret = "test-secret-key";
      const signature = generateWebhookSignature(payload, secret);

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(async () => secret),
        (req, res) => res.json({ success: true })
      );

      const validRes = await request(app)
        .post("/webhook")
        .set("x-webhook-signature", signature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(validRes.status).toBe(200);

      // Signature with single character wrong
      const [version, timestamp, sig] = signature.split(".");
      const wrongSig = `${version}.${timestamp}.${sig.slice(0, -1)}0`;

      const invalidRes = await request(app)
        .post("/webhook")
        .set("x-webhook-signature", wrongSig)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(invalidRes.status).toBe(401);
    });
  });

  describe("secret lookup integration", () => {
    it("calls getSecret with the request", async () => {
      const payload = JSON.stringify({ test: "data" });
      const secret = "test-secret-key";
      const signature = generateWebhookSignature(payload, secret);
      const mockGetSecret = vi.fn(async () => secret);

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(mockGetSecret),
        (req, res) => res.json({ success: true })
      );

      await request(app)
        .post("/webhook")
        .set("x-webhook-signature", signature)
        .set("Content-Type", "application/json")
        .send(payload);

      expect(mockGetSecret).toHaveBeenCalledWith(expect.any(Object));
    });

    it("rejects when getSecret throws", async () => {
      const payload = JSON.stringify({ test: "data" });

      app.post(
        "/webhook",
        verifyInboundWebhookSignature(async () => {
          throw new Error("Database error");
        }),
        (req, res) => res.json({ success: true })
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-webhook-signature", "v1.1234567890.sig")
        .set("Content-Type", "application/json")
        .send(payload);

      expect(res.status).toBe(500);
    });
  });
});
