/**
 * Webhook Retry → Dead-Letter → Redelivery Integration Tests (#2212)
 *
 * End-to-end coverage of retry exhaustion and the dead-letter handoff:
 *
 *   1. A real HTTP mock receiver (node:http on an ephemeral port) returns
 *      scripted failures — 5xx, dropped connections, 4xx — then recovers.
 *   2. The real WebhookDeliveryService retries with exponential backoff; the
 *      test records every backoff delay and every arrival at the receiver to
 *      verify the schedule (base · 2^(attempt-1), no delay after the last).
 *   3. Exhausted deliveries flow through the real WebhookDeadLetterService
 *      into an in-memory stand-in for the `webhook_dead_letters` table.
 *   4. Redelivery goes through the real admin router
 *      (POST /api/webhooks/dead-letter/:id/retry and /:id/requeue).
 *
 * Only the database driver, auth/audit middleware, and the subscription
 * store are stubbed — the delivery, retry, dead-letter and routing code
 * under test is all real.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// ── Environment (must be set before the services are imported) ─────────────

const RETRY = vi.hoisted(() => {
  const config = { maxRetries: 4, baseDelayMs: 20, timeoutMs: 500 };
  process.env.WEBHOOK_MAX_RETRIES = String(config.maxRetries);
  process.env.WEBHOOK_RETRY_DELAY_MS = String(config.baseDelayMs);
  process.env.WEBHOOK_TIMEOUT_MS = String(config.timeoutMs);
  process.env.WEBHOOK_DLQ_MAX_REQUEUE_CYCLES = "2";
  // Keep the per-tenant limiters out of the way; this suite is about retries.
  process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE = "100000";
  process.env.WEBHOOK_RATE_LIMIT_BURST = "10000";
  delete process.env.REDIS_URL;
  return config;
});

// ── In-memory webhook_dead_letters table behind the real service ──────────

const deadLetterTable = vi.hoisted(() => {
  type Row = Record<string, any>;
  const rows = new Map<string, Row>();
  const now = () => new Date().toISOString();

  async function query(sql: string, params: any[] = []) {
    const text = sql.replace(/\s+/g, " ").trim();

    if (text.startsWith("INSERT INTO webhook_dead_letters")) {
      const [
        id,
        subscriptionId,
        event,
        payload,
        statusCode,
        lastError,
        attempts,
      ] = params;
      rows.set(id, {
        id,
        subscription_id: subscriptionId,
        event,
        payload,
        status_code: statusCode,
        last_error: lastError,
        attempt_count: attempts,
        requeue_count: 0,
        created_at: now(),
        updated_at: now(),
        resolved_at: null,
        resolution: null,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    if (text.startsWith("SELECT * FROM webhook_dead_letters WHERE id = $1")) {
      const row = rows.get(params[0]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }

    if (text.includes("SET resolved_at = CURRENT_TIMESTAMP, resolution = $1")) {
      const row = rows.get(params[1]);
      if (!row) return { rows: [], rowCount: 0 };
      Object.assign(row, {
        resolved_at: now(),
        resolution: params[0],
        updated_at: now(),
      });
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (text.includes("SET requeue_count = requeue_count + 1")) {
      const row = rows.get(params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      Object.assign(row, {
        requeue_count: row.requeue_count + 1,
        resolved_at: null,
        resolution: null,
        updated_at: now(),
      });
      return { rows: [{ ...row }], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL in webhook DLQ integration test: ${text}`);
  }

  return { rows, query };
});

vi.mock("../database/db", () => ({
  default: { query: deadLetterTable.query },
  query: deadLetterTable.query,
}));

vi.mock("../middleware/auth", () => ({
  authenticateAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/auditLog", () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

import http from "http";
import { AddressInfo } from "net";
import express from "express";
import request from "supertest";
import {
  WebhookEventType,
  WebhookSubscription,
  TokenCreatedEventData,
} from "../types/webhook";
import webhookDeliveryService, {
  WebhookDeliveryService,
} from "../services/webhookDeliveryService";
import webhookService from "../services/webhookService";
import { generateWebhookSignature } from "../utils/crypto";
import deadLetterRouter from "../routes/webhooks-deadletter";

// ── Mock receiver ──────────────────────────────────────────────────────────

/** A scripted response: an HTTP status, or "drop" to destroy the socket. */
type Scripted = number | "drop";

interface ReceivedRequest {
  path: string;
  at: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

class MockReceiver {
  private server = http.createServer((req, res) => this.handle(req, res));
  private scripts = new Map<string, Scripted[]>();
  private fallback = new Map<string, Scripted>();
  received: ReceivedRequest[] = [];
  baseUrl = "";

  async start(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Respond to `path` with `responses` in order, then `then` forever. */
  script(path: string, responses: Scripted[], then: Scripted = 200): void {
    this.scripts.set(path, [...responses]);
    this.fallback.set(path, then);
  }

  hits(path: string): ReceivedRequest[] {
    return this.received.filter((r) => r.path === path);
  }

  reset(): void {
    this.scripts.clear();
    this.fallback.clear();
    this.received = [];
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "/";
      const raw = Buffer.concat(chunks).toString("utf8");
      this.received.push({
        path,
        at: performance.now(),
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });

      const queue = this.scripts.get(path) ?? [];
      const next =
        queue.length > 0 ? queue.shift()! : (this.fallback.get(path) ?? 404);

      if (next === "drop") {
        req.socket.destroy();
        return;
      }
      res.writeHead(next, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: next >= 200 && next < 300 }));
    });
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const SECRET = "dlq-integration-secret-32-bytes!!";
const receiver = new MockReceiver();
const subscriptions = new Map<string, WebhookSubscription>();
let subscriptionSeq = 0;

function makeSubscription(path: string): WebhookSubscription {
  const subscription: WebhookSubscription = {
    id: `sub-dlq-${++subscriptionSeq}`,
    url: `${receiver.baseUrl}${path}`,
    events: [WebhookEventType.TOKEN_CREATED],
    secret: SECRET,
    active: true,
    createdBy: "GCREATOR_DLQ_TEST",
    createdAt: new Date(),
    lastTriggered: null,
    tokenAddress: null,
  };
  subscriptions.set(subscription.id, subscription);
  return subscription;
}

const tokenCreated: TokenCreatedEventData = {
  tokenAddress: "CTOKEN_DLQ_TEST",
  creator: "GCREATOR_DLQ_TEST",
  name: "Dead Letter Token",
  symbol: "DLQ",
  decimals: 7,
  initialSupply: "1000000",
  transactionHash: "dlq-test-tx-hash",
  ledger: 4242,
};

/** Backoff delays requested by the delivery service, in call order. */
let backoffDelays: number[] = [];

/** The schedule the delivery service is expected to follow for N attempts. */
function expectedBackoff(attempts: number): number[] {
  return Array.from(
    { length: attempts - 1 },
    (_, i) => RETRY.baseDelayMs * 2 ** i
  );
}

function deadLetters() {
  return [...deadLetterTable.rows.values()];
}

function deliver(subscription: WebhookSubscription) {
  return webhookDeliveryService.deliverWebhook(
    subscription,
    WebhookEventType.TOKEN_CREATED,
    tokenCreated,
    `cid-${subscription.id}`
  );
}

const app = express();
app.use(express.json());
app.use("/api/webhooks/dead-letter", deadLetterRouter);

// ── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  await receiver.start();
});

afterAll(async () => {
  await receiver.stop();
});

beforeEach(() => {
  receiver.reset();
  deadLetterTable.rows.clear();
  backoffDelays = [];

  // Record each backoff and still wait for real, so arrival gaps at the
  // receiver reflect the schedule.
  const realDelay = (WebhookDeliveryService.prototype as any).delay;
  vi.spyOn(WebhookDeliveryService.prototype as any, "delay").mockImplementation(
    function (this: unknown, ms: unknown) {
      backoffDelays.push(ms as number);
      return realDelay.call(this, ms);
    }
  );

  // The delivery service logs every attempt as structured JSON; keep output quiet.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  vi.spyOn(webhookService, "logDelivery").mockResolvedValue(undefined);
  vi.spyOn(webhookService, "updateLastTriggered").mockResolvedValue(undefined);
  vi.spyOn(webhookService, "getSubscription").mockImplementation(
    async (id: string) => subscriptions.get(id) ?? null
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Retry exhaustion and backoff ───────────────────────────────────────────

describe("retry exhaustion", () => {
  it("retries a persistently failing receiver with exponential backoff, then gives up", async () => {
    const subscription = makeSubscription("/always-503");
    receiver.script("/always-503", [], 503);

    const result = await deliver(subscription);

    expect(result).toMatchObject({
      success: false,
      statusCode: 503,
      attempts: RETRY.maxRetries,
    });
    expect(receiver.hits("/always-503")).toHaveLength(RETRY.maxRetries);
    expect(backoffDelays).toEqual(expectedBackoff(RETRY.maxRetries)); // [20, 40, 80]
  });

  it("spaces attempts at the receiver according to the backoff schedule", async () => {
    const subscription = makeSubscription("/spacing");
    receiver.script("/spacing", [], 500);

    await deliver(subscription);

    const arrivals = receiver.hits("/spacing").map((h) => h.at);
    const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
    const schedule = expectedBackoff(RETRY.maxRetries);

    expect(gaps).toHaveLength(schedule.length);
    gaps.forEach((gap, i) => {
      // Timers never fire early by more than clock granularity.
      expect(gap).toBeGreaterThanOrEqual(schedule[i] - 2);
    });
    // Gaps grow with the schedule: each wait is longer than the last.
    expect(gaps[2]).toBeGreaterThan(gaps[0]);
  });

  it("sends the same signed payload and correlation id on every attempt", async () => {
    const subscription = makeSubscription("/same-payload");
    receiver.script("/same-payload", [], 502);

    await deliver(subscription);

    const hits = receiver.hits("/same-payload");
    const first = hits[0];
    const { signature, ...unsigned } = first.body;
    expect(first.headers["x-webhook-signature"]).toBe(signature);
    expect(signature).toBe(
      generateWebhookSignature(JSON.stringify(unsigned), SECRET)
    );

    for (const hit of hits) {
      expect(hit.body).toEqual(first.body);
      expect(hit.headers["x-correlation-id"]).toBe(`cid-${subscription.id}`);
      expect(hit.headers["x-webhook-event"]).toBe(
        WebhookEventType.TOKEN_CREATED
      );
    }
  });

  it("treats dropped connections as retryable network failures", async () => {
    const subscription = makeSubscription("/drop");
    receiver.script("/drop", [], "drop");

    const result = await deliver(subscription);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.attempts).toBe(RETRY.maxRetries);
    expect(receiver.hits("/drop")).toHaveLength(RETRY.maxRetries);
    expect(backoffDelays).toEqual(expectedBackoff(RETRY.maxRetries));
  });

  it("stops retrying once the receiver recovers", async () => {
    const subscription = makeSubscription("/recovers");
    receiver.script("/recovers", [503, 503], 200);

    const result = await deliver(subscription);

    expect(result).toMatchObject({
      success: true,
      statusCode: 200,
      attempts: 3,
    });
    expect(receiver.hits("/recovers")).toHaveLength(3);
    expect(backoffDelays).toEqual(expectedBackoff(3)); // [20, 40]
    expect(deadLetters()).toHaveLength(0);
  });

  it("does not retry non-retryable 4xx responses", async () => {
    const subscription = makeSubscription("/bad-request");
    receiver.script("/bad-request", [], 400);

    const result = await deliver(subscription);

    expect(result).toMatchObject({
      success: false,
      statusCode: 400,
      attempts: 1,
    });
    expect(receiver.hits("/bad-request")).toHaveLength(1);
    expect(backoffDelays).toEqual([]);
  });
});

// ── Dead-letter handoff ────────────────────────────────────────────────────

describe("dead-letter handoff", () => {
  it("stores exactly one dead-letter entry when retries are exhausted", async () => {
    const subscription = makeSubscription("/dlq-entry");
    receiver.script("/dlq-entry", [], 503);

    await deliver(subscription);

    const entries = deadLetters();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatchObject({
      subscription_id: subscription.id,
      event: WebhookEventType.TOKEN_CREATED,
      status_code: 503,
      attempt_count: RETRY.maxRetries,
      requeue_count: 0,
      resolved_at: null,
    });
    expect(entry.last_error).toContain("503");
  });

  it("preserves the exact payload that was delivered", async () => {
    const subscription = makeSubscription("/dlq-payload");
    receiver.script("/dlq-payload", [], 500);

    await deliver(subscription);

    const [entry] = deadLetters();
    const lastDelivered = receiver.hits("/dlq-payload").at(-1)!.body;
    expect(JSON.parse(entry.payload)).toEqual(lastDelivered);
    expect(JSON.parse(entry.payload).data).toEqual(tokenCreated);
  });

  it("dead-letters network failures with a null status code", async () => {
    const subscription = makeSubscription("/dlq-drop");
    receiver.script("/dlq-drop", [], "drop");

    await deliver(subscription);

    const [entry] = deadLetters();
    expect(entry.status_code).toBeNull();
    expect(entry.last_error).toBeTruthy();
  });

  it("logs a single failed delivery record with the final attempt count", async () => {
    const subscription = makeSubscription("/dlq-log");
    receiver.script("/dlq-log", [], 503);

    await deliver(subscription);

    expect(webhookService.logDelivery).toHaveBeenCalledOnce();
    const args = vi.mocked(webhookService.logDelivery).mock.calls[0];
    expect(args[0]).toBe(subscription.id);
    expect(args[3]).toBe(503); // statusCode
    expect(args[4]).toBe(false); // success
    expect(args[5]).toBe(RETRY.maxRetries); // attempts
  });

  it("does not dead-letter a non-retryable failure that stopped early", async () => {
    const subscription = makeSubscription("/dlq-4xx");
    receiver.script("/dlq-4xx", [], 422);

    await deliver(subscription);

    expect(deadLetters()).toHaveLength(0);
  });
});

// ── Redelivery from the dead-letter queue ──────────────────────────────────

describe("redelivery from the dead-letter queue", () => {
  async function exhaustInto(path: string) {
    const subscription = makeSubscription(path);
    receiver.script(path, [], 503);
    await deliver(subscription);
    const [entry] = deadLetters();
    receiver.reset();
    backoffDelays = [];
    return { subscription, entry };
  }

  it("redelivers the original event data and resolves the entry", async () => {
    const { entry } = await exhaustInto("/redeliver-ok");
    const originalPayload = JSON.parse(entry.payload);
    receiver.script("/redeliver-ok", [], 200);

    const res = await request(app).post(
      `/api/webhooks/dead-letter/${entry.id}/retry`
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: entry.id });

    const hits = receiver.hits("/redeliver-ok");
    expect(hits).toHaveLength(1);
    expect(hits[0].body.event).toBe(originalPayload.event);
    expect(hits[0].body.data).toEqual(originalPayload.data);

    // Redelivery is freshly signed for the current timestamp.
    const { signature, ...unsigned } = hits[0].body;
    expect(signature).toBe(
      generateWebhookSignature(JSON.stringify(unsigned), SECRET)
    );
    expect(hits[0].headers["x-correlation-id"]).toBe(`admin_retry_${entry.id}`);

    const stored = deadLetterTable.rows.get(entry.id)!;
    expect(stored.resolution).toBe("retried");
    expect(stored.resolved_at).not.toBeNull();
  });

  it("starts redelivery with a fresh attempt counter", async () => {
    const { entry } = await exhaustInto("/redeliver-fresh");
    receiver.script("/redeliver-fresh", [503], 200);

    const res = await request(app).post(
      `/api/webhooks/dead-letter/${entry.id}/retry`
    );

    expect(res.status).toBe(200);
    // Two attempts: the exhausted counter was not resumed.
    expect(receiver.hits("/redeliver-fresh")).toHaveLength(2);
    expect(backoffDelays).toEqual(expectedBackoff(2));
  });

  it("keeps the entry unresolved when redelivery fails again", async () => {
    const { entry } = await exhaustInto("/redeliver-fail");
    receiver.script("/redeliver-fail", [], 503);

    const res = await request(app).post(
      `/api/webhooks/dead-letter/${entry.id}/retry`
    );

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("DELIVERY_FAILED");
    expect(receiver.hits("/redeliver-fail")).toHaveLength(RETRY.maxRetries);
    expect(deadLetterTable.rows.get(entry.id)!.resolved_at).toBeNull();
    // The failed redelivery exhausted its own retries and was dead-lettered anew.
    expect(deadLetters()).toHaveLength(2);
  });

  it("refuses to redeliver an entry that is already resolved", async () => {
    const { entry } = await exhaustInto("/redeliver-twice");
    receiver.script("/redeliver-twice", [], 200);

    await request(app)
      .post(`/api/webhooks/dead-letter/${entry.id}/retry`)
      .expect(200);
    const res = await request(app).post(
      `/api/webhooks/dead-letter/${entry.id}/retry`
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_RESOLVED");
    expect(receiver.hits("/redeliver-twice")).toHaveLength(1);
  });

  it("returns 404 for an unknown dead-letter entry", async () => {
    const res = await request(app).post(
      "/api/webhooks/dead-letter/does-not-exist/retry"
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("requeues and redelivers, incrementing the requeue counter", async () => {
    const { entry } = await exhaustInto("/requeue-ok");
    receiver.script("/requeue-ok", [], 200);

    const res = await request(app).post(
      `/api/webhooks/dead-letter/${entry.id}/requeue`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.requeueCount).toBe(1);
    expect(receiver.hits("/requeue-ok")).toHaveLength(1);
    expect(receiver.hits("/requeue-ok")[0].headers["x-correlation-id"]).toBe(
      `requeue_${entry.id}`
    );
    expect(deadLetterTable.rows.get(entry.id)!.resolution).toBe("retried");
  });

  it("blocks requeueing a poison message after the requeue cap", async () => {
    const { entry } = await exhaustInto("/requeue-poison");
    receiver.script("/requeue-poison", [], 503);

    // WEBHOOK_DLQ_MAX_REQUEUE_CYCLES=2: two requeues are allowed, both fail.
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post(
        `/api/webhooks/dead-letter/${entry.id}/requeue`
      );
      expect(res.status).toBe(502);
    }
    const hitsBefore = receiver.hits("/requeue-poison").length;

    const res = await request(app).post(
      `/api/webhooks/dead-letter/${entry.id}/requeue`
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("POISON_MESSAGE");
    expect(deadLetterTable.rows.get(entry.id)!.requeue_count).toBe(2);
    // The guard short-circuits before any delivery attempt.
    expect(receiver.hits("/requeue-poison")).toHaveLength(hitsBefore);
  });
});
