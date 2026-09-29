import axios, { AxiosError } from "axios";
import { gzip } from "zlib";
import { promisify } from "util";
import Redis from "ioredis";
import {
  WebhookSubscription,
  WebhookPayload,
  WebhookEventType,
  WebhookEventData,
} from "../types/webhook";
import webhookService from "./webhookService";
import webhookDeadLetterService from "./webhookDeadLetterService";
import {
  IntegrationMetrics,
  webhookDeliveryLatency,
  MetricsCollector,
} from "../lib/metrics";
import { CircuitBreaker } from "../lib/circuitBreaker";
import { WorkerPool } from "../lib/WorkerPool";
import {
  createRedisClient,
  incrementSlidingWindow,
} from "../middleware/rateLimiter";
import tenantWebhookRateLimiter, {
  TenantWebhookRateLimiter,
} from "./tenantWebhookRateLimiter";

const gzipAsync = promisify(gzip);

const TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || "5000");
const MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES || "3");
const RETRY_DELAY_MS = parseInt(process.env.WEBHOOK_RETRY_DELAY_MS || "1000");

// Bounded concurrency for the delivery worker pool. Workers fan out up to
// this many deliveries at once; everything beyond that waits in the pool's
// internal queue, which is what provides back-pressure under high
// subscription counts instead of unbounded `Promise.allSettled` fan-out.
const DEFAULT_WORKER_CONCURRENCY = "10";

/**
 * Parse WEBHOOK_WORKER_CONCURRENCY, failing fast with an error that names the
 * misconfigured env var rather than letting WorkerPool throw a generic
 * "concurrency must be >= 1" error during module load.
 */
export function parseWorkerConcurrency(
  raw: string | undefined = process.env.WEBHOOK_WORKER_CONCURRENCY
): number {
  const value = (raw || DEFAULT_WORKER_CONCURRENCY).trim();
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || !Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      `WEBHOOK_WORKER_CONCURRENCY must be a positive integer (got "${raw}")`
    );
  }
  return parsed;
}

// Per-tenant delivery rate limit, enforced inside each pool worker (not as
// HTTP middleware, since this code path is not a request handler).
const TENANT_RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.WEBHOOK_TENANT_RATE_LIMIT_WINDOW_MS || "60000"
);
const TENANT_RATE_LIMIT_MAX = parseInt(
  process.env.WEBHOOK_TENANT_RATE_LIMIT_MAX || "60"
);

interface DeliveryTask {
  subscription: WebhookSubscription;
  event: WebhookEventType;
  data: WebhookEventData;
  correlationId: string;
}

export interface WebhookDeliveryResult {
  success: boolean;
  statusCode: number | null;
  attempts: number;
  error: string | null;
}

export class WebhookDeliveryService {
  private circuitBreaker: CircuitBreaker;
  // Read at construction time so tests can override via process.env before new WebhookDeliveryService()
  private readonly compressionThresholdBytes: number;
  private readonly pool: WorkerPool<DeliveryTask>;
  // Lazily created so environments/tests without Redis never pay the
  // connection cost unless a delivery actually needs rate-limit checking.
  private rateLimitRedis: Redis | null = null;
  private readonly rateLimiter: TenantWebhookRateLimiter;

  constructor(rateLimiter: TenantWebhookRateLimiter = tenantWebhookRateLimiter) {
    this.rateLimiter = rateLimiter;
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: parseInt(process.env.WEBHOOK_CIRCUIT_BREAKER_FAILURE_THRESHOLD || "5"),
      successThreshold: parseInt(process.env.WEBHOOK_CIRCUIT_BREAKER_SUCCESS_THRESHOLD || "2"),
      timeoutMs: parseInt(process.env.WEBHOOK_CIRCUIT_BREAKER_TIMEOUT_MS || "60000"),
    });
    // Payloads larger than this threshold (bytes) are gzip-compressed on delivery.
    this.compressionThresholdBytes = parseInt(
      process.env.WEBHOOK_COMPRESSION_THRESHOLD_BYTES || "1024"
    );
    this.pool = new WorkerPool<DeliveryTask>({
      concurrency: parseWorkerConcurrency(),
      worker: async (task) => {
        await this.deliverWebhook(
          task.subscription,
          task.event,
          task.data,
          task.correlationId
        );
      },
    });
  }

  /**
   * Trigger webhooks for an event
   */
  async triggerEvent(
    event: WebhookEventType,
    data: WebhookEventData,
    tokenAddress?: string,
    correlationId?: string
  ): Promise<void> {
    const subscriptions = await webhookService.findMatchingSubscriptions(
      event,
      tokenAddress
    );

    const cid = correlationId || `whk_${Date.now().toString(36)}`;
    console.log(
      JSON.stringify({ event: 'webhook.trigger', correlationId: cid, webhookEvent: event, subscriptionCount: subscriptions.length })
    );

    // Deliver through the bounded worker pool. Concurrency is capped by
    // WEBHOOK_WORKER_CONCURRENCY; once every worker slot is busy, additional
    // enqueue() calls wait their turn rather than starting immediately —
    // this is the back-pressure mechanism for high subscription counts.
    this.reportPoolMetrics();
    await Promise.allSettled(
      subscriptions.map((subscription) =>
        this.pool.enqueue({ subscription, event, data, correlationId: cid })
      )
    );
    this.reportPoolMetrics();
  }

  /**
   * Publish current worker pool size / queue depth to Prometheus.
   */
  private reportPoolMetrics(): void {
    MetricsCollector.updateWebhookWorkerPool(
      this.pool.getConcurrency(),
      this.pool.getQueueDepth()
    );
  }

  /**
   * Enforce the per-tenant delivery rate limit for a subscription's owner.
   * Uses the same Redis-backed sliding-window limiter as the HTTP
   * middleware, but invoked directly since delivery happens outside of any
   * request/response cycle. Fails open (allows delivery) if Redis is
   * unavailable, matching the existing middleware's fail-open behavior —
   * a rate-limiter outage must not stop webhook delivery altogether.
   */
  /**
   * Tenant key for a subscription — see `tenantWebhookRateLimiter.ts` for why
   * `createdBy` is used until a real multi-tenant/organization concept exists.
   */
  private getTenantId(subscription: WebhookSubscription): string {
    return subscription.createdBy;
  }

  private async isWithinTenantRateLimit(tenantId: string): Promise<boolean> {
    // No Redis configured (e.g. local/test environments) — skip the check
    // rather than attempting a real network connection on every delivery.
    if (!process.env.REDIS_URL) {
      return true;
    }
    try {
      if (!this.rateLimitRedis) {
        this.rateLimitRedis = createRedisClient();
      }
      const count = await incrementSlidingWindow(
        this.rateLimitRedis,
        `rl:webhook:delivery:tenant:${tenantId}`,
        TENANT_RATE_LIMIT_WINDOW_MS
      );
      return count <= TENANT_RATE_LIMIT_MAX;
    } catch {
      return true;
    }
  }

  /**
   * Deliver webhook to a single subscription with circuit breaker and retry logic.
   *
   * ## Two-tier rate limiting design
   *
   * Every delivery passes through **two independent rate limiters applied in
   * sequence**. Understanding both is essential when tuning the related env
   * vars, especially in multi-instance deployments.
   *
   * ### Tier 1 — Redis sliding-window limiter (`isWithinTenantRateLimit`)
   *
   * - **What it protects against:** Bursty per-tenant delivery volume at the
   *   infrastructure level across the entire fleet. The window tracks how many
   *   deliveries a tenant has triggered within `WEBHOOK_TENANT_RATE_LIMIT_WINDOW_MS`
   *   (default 60 000 ms) and rejects deliveries that would exceed
   *   `WEBHOOK_TENANT_RATE_LIMIT_MAX` (default 60) within that window.
   * - **Failure mode — fail-open:** If Redis is unavailable (connection error,
   *   timeout, or `REDIS_URL` is not set) the check resolves `true`
   *   (allowed). A Redis outage therefore does **not** stop webhook delivery;
   *   it temporarily lifts this limiter only.
   * - **Multi-instance behavior:** The Redis key is shared across all running
   *   delivery-worker instances. Counts are global: 10 instances each firing
   *   6 deliveries/min for the same tenant all count toward the same window.
   *   This makes Tier 1 the authoritative cross-process bound.
   * - **Behavior on excess:** A single one-shot retry (after a brief back-off)
   *   is attempted before the delivery is skipped and logged as rate-limited.
   *   The delivery is **not** queued for later — it is dropped.
   *
   * ### Tier 2 — In-memory token-bucket limiter (`this.rateLimiter.acquire`)
   *
   * - **What it protects against:** Per-tenant delivery pacing within a single
   *   worker process. The bucket smooths out short bursts and prevents one
   *   active tenant from monopolizing outbound HTTP concurrency at the process
   *   level.
   * - **Failure mode — queue-not-drop:** `acquire()` never rejects. If the
   *   bucket is empty, the call suspends until a token refills. Deliveries are
   *   always eventually attempted; they are paced, not dropped.
   * - **Multi-instance caveat:** `TenantWebhookRateLimiter` is an in-memory
   *   `Map` (see `tenantWebhookRateLimiter.ts`). Each delivery-worker process
   *   maintains its own independent set of buckets. If N instances run in
   *   parallel, the effective throughput permitted by Tier 2 alone is
   *   `N × ratePerMinute`. Tier 1 (Redis) is therefore the cross-instance
   *   ceiling; Tier 2 is a per-process shaping layer beneath it.
   * - **Configuration:** `WEBHOOK_RATE_LIMIT_PER_MINUTE` (default 100) and
   *   `WEBHOOK_RATE_LIMIT_BURST` (default 20).
   *
   * ### Operator guidance — keeping the limits consistent
   *
   * To reason about effective limits:
   *
   * ```
   * Tier 1 Redis limit  : WEBHOOK_TENANT_RATE_LIMIT_MAX per WEBHOOK_TENANT_RATE_LIMIT_WINDOW_MS
   * Tier 2 bucket limit : WEBHOOK_RATE_LIMIT_PER_MINUTE (× number of worker instances)
   * ```
   *
   * - Set `WEBHOOK_TENANT_RATE_LIMIT_MAX` ≥ `WEBHOOK_RATE_LIMIT_PER_MINUTE × N` so
   *   that the Redis limit is the effective ceiling and the bucket limiter only
   *   shapes intra-process pacing. If the Redis limit is tighter than the
   *   per-process bucket, deliveries will be silently dropped at Tier 1 even
   *   though Tier 2 has capacity.
   * - If delivery workers are never run as more than one instance, the Tier 2
   *   config is the de-facto pacing control and the Redis limit acts as a
   *   safety ceiling — either configuration is valid as long as they are set
   *   consciously.
   *
   * @internal
   */
  async deliverWebhook(
    subscription: WebhookSubscription,
    event: WebhookEventType,
    data: WebhookEventData,
    correlationId?: string
  ): Promise<WebhookDeliveryResult> {
    const cid = correlationId || `whk_${Date.now().toString(36)}`;

    // Per-tenant rate limit: the subscription owner (createdBy) is the
    // closest thing to a tenant id on this model. One slow retry-after-delay
    // is attempted before skipping, since a worker holding a pool slot for a
    // single delayed check is preferable to dropping the delivery outright.
    const tenantId = subscription.createdBy;
    if (!(await this.isWithinTenantRateLimit(tenantId))) {
      await this.delay(TENANT_RATE_LIMIT_WINDOW_MS / TENANT_RATE_LIMIT_MAX);
      if (!(await this.isWithinTenantRateLimit(tenantId))) {
        console.warn(
          JSON.stringify({ event: 'webhook.rate_limited', correlationId: cid, subscriptionId: subscription.id, tenantId })
        );
        return { success: false, statusCode: null, attempts: 0, error: "Rate limited" };
      }
    }

    const payload = webhookService.createPayload(
      event,
      data,
      subscription.secret
    );

    // Attach correlation ID to payload headers (not body — body is signed)
    const extraHeaders: Record<string, string> = {
      'X-Correlation-Id': cid,
    };
    // Include originating tx hash if present in data
    const txHash = (data as unknown as Record<string, unknown>).transactionHash as string | undefined;
    if (txHash) extraHeaders['X-Tx-Hash'] = txHash;

    // Per-tenant token-bucket rate limiting gate — applied BEFORE any
    // outbound HTTP call. If the tenant is within budget this resolves
    // immediately; otherwise the delivery is queued (never dropped) and
    // resolves once a token refills (see TenantWebhookRateLimiter).
    await this.rateLimiter.acquire(tenantId);

    return this.circuitBreaker.execute(async (): Promise<WebhookDeliveryResult> => {
      let lastError: string | null = null;
      let statusCode: number | null = null;
      let success = false;
      let attempts = 0;
      const startMs = Date.now();

      const rawBody = JSON.stringify(payload);
      const useCompression = Buffer.byteLength(rawBody, "utf8") >= this.compressionThresholdBytes;
      let compressedBody: Buffer | null = null;
      if (useCompression) {
        compressedBody = await gzipAsync(rawBody) as Buffer;
      }

      // Track whether to fall back to uncompressed (e.g. after a 415 response)
      let compressionDisabled = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        attempts = attempt;
        try {
          console.log(
            JSON.stringify({ event: 'webhook.attempt', correlationId: cid, url: subscription.url, attempt, maxRetries: MAX_RETRIES, compressed: useCompression && !compressionDisabled, ...(txHash && { txHash }) })
          );

          const sendCompressed = useCompression && !compressionDisabled && compressedBody !== null;
          const requestBody = sendCompressed ? compressedBody : rawBody;
          const contentHeaders: Record<string, string> = sendCompressed
            ? { "Content-Type": "application/json", "Content-Encoding": "gzip" }
            : { "Content-Type": "application/json" };

          const response = await axios.post(subscription.url, requestBody, {
            timeout: TIMEOUT_MS,
            headers: {
              ...contentHeaders,
              "X-Webhook-Signature": payload.signature,
              "X-Webhook-Event": event,
              "User-Agent": "Nova-Launch-Webhook/1.0",
              ...extraHeaders,
            },
            validateStatus: (status) => status >= 200 && status < 300,
          });

          statusCode = response.status;
          success = true;
          lastError = null;

          console.log(
            JSON.stringify({ event: 'webhook.delivered', correlationId: cid, url: subscription.url, statusCode, ...(txHash && { txHash }) })
          );

          // Update last triggered timestamp
          await webhookService.updateLastTriggered(subscription.id);

          break; // Success, exit retry loop
        } catch (error) {
          const axiosError = error as AxiosError;
          statusCode = axiosError.response?.status || null;
          lastError = axiosError.message;

          console.error(
            JSON.stringify({ event: 'webhook.failed', correlationId: cid, url: subscription.url, attempt, statusCode, error: lastError, ...(txHash && { txHash }) })
          );

          // 415 Unsupported Media Type — consumer cannot accept encoded content;
          // disable compression and retry with the uncompressed body.
          if (statusCode === 415 && useCompression && !compressionDisabled) {
            compressionDisabled = true;
            continue;
          }

          // Other 4xx errors are non-retryable — stop immediately
          if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
            break;
          }

          // Wait before retrying (exponential backoff)
          if (attempt < MAX_RETRIES) {
            await this.delay(RETRY_DELAY_MS * Math.pow(2, attempt - 1));
          }
        }
      }

      // Emit delivery metrics
      const durationMs = Date.now() - startMs;
      const retries = attempts - 1;
      const outcome = success ? 'success' : (attempts >= MAX_RETRIES ? 'exhausted' : 'failed');
      IntegrationMetrics.recordWebhookDelivery(event, outcome, durationMs, retries);

      // Observe end-to-end latency histogram with outcome and attempt count labels.
      webhookDeliveryLatency.observe(
        { outcome, attempt_count: String(attempts) },
        durationMs / 1000
      );

      // Log the delivery attempt
      await webhookService.logDelivery(
        subscription.id,
        event,
        payload,
        statusCode,
        success,
        attempts,
        lastError
      );

      // Route exhausted deliveries to dead-letter store
      if (!success && attempts >= MAX_RETRIES) {
        try {
          const deadLetterId = await webhookDeadLetterService.storeDeadLetter(
            subscription.id,
            event,
            payload,
            statusCode,
            lastError,
            attempts
          );
          IntegrationMetrics.recordWebhookDeadLetter(event);
          console.warn(
            JSON.stringify({ event: 'webhook.deadletter', correlationId: cid, deadLetterId, subscriptionId: subscription.id, attempts: MAX_RETRIES, ...(txHash && { txHash }) })
          );
        } catch (dlError) {
          console.error(
            JSON.stringify({ event: 'webhook.deadletter.error', correlationId: cid, subscriptionId: subscription.id, error: dlError })
          );
        }
      } else if (!success) {
        console.warn(
          JSON.stringify({ event: 'webhook.failed', correlationId: cid, subscriptionId: subscription.id, attempts, ...(txHash && { txHash }) })
        );
      }

      return { success, statusCode, attempts, error: lastError };
    });
  }

  /**
   * Delay helper for retry logic
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Test webhook delivery (for testing endpoints)
   */
  async testWebhook(subscription: WebhookSubscription): Promise<boolean> {
    const testPayload = webhookService.createPayload(
      WebhookEventType.TOKEN_CREATED,
      {
        tokenAddress: "GTEST...",
        creator: "GTEST...",
        name: "Test Token",
        symbol: "TEST",
        decimals: 7,
        initialSupply: "1000000",
        transactionHash: "test-hash",
        ledger: 12345,
      },
      subscription.secret
    );

    try {
      const response = await axios.post(subscription.url, testPayload, {
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": testPayload.signature,
          "X-Webhook-Event": "test",
          "User-Agent": "Nova-Launch-Webhook/1.0",
        },
      });

      return response.status >= 200 && response.status < 300;
    } catch (error) {
      console.error("Test webhook failed:", error);
      return false;
    }
  }
}

export default new WebhookDeliveryService();
