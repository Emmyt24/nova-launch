/**
 * Tests: WebhookDeliveryService — Core Delivery Scenarios
 *
 * Covers the four scenarios that matter most for financial-event webhooks:
 *
 *  1. Successful delivery — 2xx response, updates last-triggered, logs success.
 *  2. Transient failure triggering retry — 5xx fails, then succeeds on retry.
 *  3. Dead-letter handoff on retry exhaustion — all MAX_RETRIES attempts fail,
 *     storeDeadLetter is called exactly once.
 *  4. Timeout handling — ETIMEDOUT network error is treated as a retryable
 *     failure and the subscription is eventually dead-lettered after exhaustion.
 *
 * HTTP is intercepted with `nock` so no real network calls are made.
 * Service side-effects (DB logs, dead-letter writes) are spied on so we can
 * assert calls without needing a real database.
 */

// Set env vars BEFORE any imports so module-level constants pick them up.
process.env.WEBHOOK_MAX_RETRIES = "3";
process.env.WEBHOOK_TIMEOUT_MS = "200";
// Zero retry delay keeps the test suite fast.
process.env.WEBHOOK_RETRY_DELAY_MS = "0";
// Disable Redis-backed rate limiting in tests (no REDIS_URL → fail-open).
delete process.env.REDIS_URL;
// Raise the in-memory token-bucket limits so rate limiting never interferes
// with these core delivery tests.
process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE = "100000";
process.env.WEBHOOK_RATE_LIMIT_BURST = "10000";

import nock from "nock";
import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import {
  WebhookEventType,
  WebhookSubscription,
  TokenCreatedEventData,
} from "../types/webhook";

// ---------------------------------------------------------------------------
// Constants (must match process.env overrides above)
// ---------------------------------------------------------------------------
const BASE_URL = "http://delivery-test.local";
const MAX_RETRIES = 3;
const TIMEOUT_MS = 200;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSubscription(path: string = "/hook"): WebhookSubscription {
  return {
    id: `sub-${Math.random().toString(36).slice(2)}`,
    url: `${BASE_URL}${path}`,
    events: [WebhookEventType.TOKEN_CREATED],
    secret: "test-secret",
    active: true,
    createdBy: "GTEST_CREATOR",
    createdAt: new Date(),
    lastTriggered: null,
    tokenAddress: null,
  };
}

const eventData: TokenCreatedEventData = {
  tokenAddress: "GTEST_TOKEN",
  creator: "GTEST_CREATOR",
  name: "Test Token",
  symbol: "TST",
  decimals: 7,
  initialSupply: "1000000",
  transactionHash: "test-tx-hash",
  ledger: 12345,
};

// ---------------------------------------------------------------------------
// Module-level handles (populated in beforeEach after vi.resetModules)
// ---------------------------------------------------------------------------

let service: import("../services/webhookDeliveryService").WebhookDeliveryService;
let webhookSvc: typeof import("../services/webhookService").default;
let deadLetterSvc: typeof import("../services/webhookDeadLetterService").default;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Reset module registry so module-level constants re-read env vars.
  vi.resetModules();

  // Import the real module instances that the delivery service will use.
  const wsMod = await import("../services/webhookService");
  webhookSvc = wsMod.default;

  const dlMod = await import("../services/webhookDeadLetterService");
  deadLetterSvc = dlMod.default;

  // Stub out DB-touching side effects so tests run without a real database.
  vi.spyOn(webhookSvc, "logDelivery").mockResolvedValue(undefined);
  vi.spyOn(webhookSvc, "updateLastTriggered").mockResolvedValue(undefined);
  vi.spyOn(deadLetterSvc, "storeDeadLetter").mockResolvedValue("dl-test-id");

  const mod = await import("../services/webhookDeliveryService");
  service = mod.default;
});

afterEach(() => {
  nock.cleanAll();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Successful delivery
// ---------------------------------------------------------------------------

describe("WebhookDeliveryService — successful delivery", () => {
  it("delivers to a 200 endpoint and marks success in the delivery log", async () => {
    nock(BASE_URL).post("/hook").reply(200);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    // logDelivery called exactly once with success=true
    expect(webhookSvc.logDelivery).toHaveBeenCalledTimes(1);
    const [, , , statusCode, success, attempts] = vi.mocked(
      webhookSvc.logDelivery
    ).mock.calls[0];
    expect(statusCode).toBe(200);
    expect(success).toBe(true);
    expect(attempts).toBe(1);

    expect(nock.isDone()).toBe(true);
  });

  it("calls updateLastTriggered exactly once on success", async () => {
    nock(BASE_URL).post("/hook").reply(200);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    expect(webhookSvc.updateLastTriggered).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webhookSvc.updateLastTriggered).mock.calls[0][0]).toBe(sub.id);
  });

  it("does NOT route a successful delivery to dead-letter", async () => {
    nock(BASE_URL).post("/hook").reply(200);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    expect(deadLetterSvc.storeDeadLetter).not.toHaveBeenCalled();
  });

  it("accepts any 2xx status code as a success", async () => {
    for (const status of [200, 201, 202, 204]) {
      nock(BASE_URL).post("/hook").reply(status);

      const sub = makeSubscription("/hook");
      await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

      const call = vi.mocked(webhookSvc.logDelivery).mock.calls.at(-1)!;
      expect(call[4]).toBe(true); // success
      nock.cleanAll();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Transient failure triggering retry
// ---------------------------------------------------------------------------

describe("WebhookDeliveryService — failure triggering retry", () => {
  it("retries after a 503 and succeeds on the second attempt", async () => {
    nock(BASE_URL).post("/hook").reply(503); // attempt 1: fail
    nock(BASE_URL).post("/hook").reply(200); // attempt 2: succeed

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    const [, , , statusCode, success, attempts] = vi.mocked(
      webhookSvc.logDelivery
    ).mock.calls[0];
    expect(success).toBe(true);
    expect(statusCode).toBe(200);
    expect(attempts).toBe(2);

    expect(webhookSvc.updateLastTriggered).toHaveBeenCalledTimes(1);
    expect(deadLetterSvc.storeDeadLetter).not.toHaveBeenCalled();
    expect(nock.isDone()).toBe(true);
  });

  it("retries after a network error (ECONNREFUSED) and succeeds on the second attempt", async () => {
    nock(BASE_URL).post("/hook").replyWithError("ECONNREFUSED");
    nock(BASE_URL).post("/hook").reply(200);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    const [, , , , success, attempts] = vi.mocked(webhookSvc.logDelivery).mock.calls[0];
    expect(success).toBe(true);
    expect(attempts).toBe(2);
    expect(nock.isDone()).toBe(true);
  });

  it("does NOT retry on a 4xx client error — stops after exactly 1 attempt", async () => {
    nock(BASE_URL).post("/hook").reply(400);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    const [, , , statusCode, success, attempts] = vi.mocked(
      webhookSvc.logDelivery
    ).mock.calls[0];
    expect(success).toBe(false);
    expect(statusCode).toBe(400);
    expect(attempts).toBe(1); // no retry on 4xx

    expect(nock.isDone()).toBe(true);
  });

  it("retries up to MAX_RETRIES times on persistent 5xx", async () => {
    nock(BASE_URL).post("/hook").times(MAX_RETRIES).reply(502);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    const [, , , , success, attempts] = vi.mocked(webhookSvc.logDelivery).mock.calls[0];
    expect(success).toBe(false);
    expect(attempts).toBe(MAX_RETRIES);
    expect(nock.isDone()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Dead-letter handoff on retry exhaustion
// ---------------------------------------------------------------------------

describe("WebhookDeliveryService — dead-letter handoff on retry exhaustion", () => {
  it("routes to dead-letter when all MAX_RETRIES attempts return 5xx", async () => {
    nock(BASE_URL).post("/hook").times(MAX_RETRIES).reply(500);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    expect(deadLetterSvc.storeDeadLetter).toHaveBeenCalledTimes(1);

    const [subscriptionId, event, , , , attemptCount] = vi.mocked(
      deadLetterSvc.storeDeadLetter
    ).mock.calls[0];
    expect(subscriptionId).toBe(sub.id);
    expect(event).toBe(WebhookEventType.TOKEN_CREATED);
    expect(attemptCount).toBe(MAX_RETRIES);
  });

  it("does NOT dead-letter when a retry eventually succeeds", async () => {
    nock(BASE_URL).post("/hook").reply(503);
    nock(BASE_URL).post("/hook").reply(200);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    expect(deadLetterSvc.storeDeadLetter).not.toHaveBeenCalled();
    expect(nock.isDone()).toBe(true);
  });

  it("dead-letters after exhaustion from 4xx (non-retryable, 1 attempt = exhausted)", async () => {
    // 4xx stops immediately after 1 attempt, attempts < MAX_RETRIES → not exhausted by count,
    // but we still log as failed. Verify no dead-letter for 4xx (it's a client config error,
    // not a transient server problem — DL policy is server-side exhaustion only).
    nock(BASE_URL).post("/hook").reply(404);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    // 4xx with attempts < MAX_RETRIES does NOT go to dead-letter
    // (the code checks `!success && attempts >= MAX_RETRIES`)
    expect(deadLetterSvc.storeDeadLetter).not.toHaveBeenCalled();
  });

  it("still logs the delivery even when dead-letter store throws", async () => {
    nock(BASE_URL).post("/hook").times(MAX_RETRIES).reply(500);

    vi.mocked(deadLetterSvc.storeDeadLetter).mockRejectedValueOnce(
      new Error("DB connection lost")
    );

    const sub = makeSubscription("/hook");
    // Should not throw even if storeDeadLetter fails
    await expect(
      service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData)
    ).resolves.not.toThrow();

    // Delivery was still logged
    expect(webhookSvc.logDelivery).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Timeout handling
// ---------------------------------------------------------------------------

describe("WebhookDeliveryService — timeout handling", () => {
  it("treats a timeout as a retryable error and retries MAX_RETRIES times", async () => {
    // Delay each reply longer than TIMEOUT_MS so axios times out
    nock(BASE_URL)
      .post("/hook")
      .times(MAX_RETRIES)
      .delay(TIMEOUT_MS + 300)
      .reply(200);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    const [, , , , success, attempts] = vi.mocked(webhookSvc.logDelivery).mock.calls[0];
    expect(success).toBe(false);
    expect(attempts).toBe(MAX_RETRIES);
  });

  it("routes a fully-timed-out delivery to dead-letter after MAX_RETRIES", async () => {
    nock(BASE_URL)
      .post("/hook")
      .times(MAX_RETRIES)
      .delay(TIMEOUT_MS + 300)
      .reply(200);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    expect(deadLetterSvc.storeDeadLetter).toHaveBeenCalledTimes(1);
    const [subscriptionId, , , , , attemptCount] = vi.mocked(
      deadLetterSvc.storeDeadLetter
    ).mock.calls[0];
    expect(subscriptionId).toBe(sub.id);
    expect(attemptCount).toBe(MAX_RETRIES);
  });

  it("succeeds if the endpoint recovers before retry exhaustion", async () => {
    // First call times out, second succeeds immediately
    nock(BASE_URL)
      .post("/hook")
      .delay(TIMEOUT_MS + 300)
      .reply(200);
    nock(BASE_URL).post("/hook").reply(200);

    const sub = makeSubscription("/hook");
    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData);

    const [, , , , success, attempts] = vi.mocked(webhookSvc.logDelivery).mock.calls[0];
    expect(success).toBe(true);
    expect(attempts).toBe(2);
    expect(deadLetterSvc.storeDeadLetter).not.toHaveBeenCalled();
  });
});
