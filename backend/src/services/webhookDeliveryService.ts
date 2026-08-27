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
import { IntegrationMetrics } from "../monitoring/metrics/prometheus-config";
import {
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
const WORKER_CONCURRENCY = parseInt(process.env.WEBHOOK_WORKER_CONCURRENCY || "10");

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
      concurrency: WORKER_CONCURRENCY,
      worker: (task) =>
        this.deliverWebhook(
          task.subscription,
          task.event,
          task.data,
          task.correlationId
        ),
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
   * Deliver webhook to a single subscription with circuit breaker and retry logic
   * @internal
   */
  async deliverWebhook(
    subscription: WebhookSubscription,
    event: WebhookEventType,
    data: WebhookEventData,
    correlationId?: string
  ): Promise<void> {
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
        return;
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

    return this.circuitBreaker.execute(async () => {
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
