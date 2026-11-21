/**
 * Per-tenant webhook delivery rate limiter (token-bucket algorithm).
 *
 * Problem: `webhookDeliveryService` dispatches webhook deliveries for all
 * matching subscriptions with no notion of fairness between tenants. A
 * single tenant that triggers a burst of events (e.g. a large batch token
 * deployment) can flood outbound HTTP delivery, starving other tenants'
 * webhooks of timely delivery and putting unnecessary load on downstream
 * endpoints.
 *
 * What is a "tenant" here?
 *   This codebase's webhook layer (see `types/webhook.ts` /
 *   `services/webhookService.ts`) has no dedicated tenant/org table —
 *   `WebhookSubscription.createdBy` (the address that registered the
 *   subscription) is the closest existing identifier that scopes a
 *   subscription to a single account. We use `createdBy` as the tenant key.
 *   If a real multi-tenant/organization concept is introduced later, swap
 *   the key extraction in `webhookDeliveryService.ts` (search for
 *   `getTenantId`) to use that identifier instead — no changes are needed
 *   here in the limiter itself, which is keyed by an opaque string.
 *
 * Algorithm: classic token bucket per tenant.
 *   - Each tenant has a bucket holding up to `burstCapacity` tokens.
 *   - Tokens refill continuously at `ratePerMinute / 60` tokens/sec.
 *   - A delivery costs 1 token. If a token is available, it is consumed and
 *     the delivery proceeds immediately (`acquire()` resolves immediately).
 *   - If no token is available, the request is queued (FIFO) and resolved
 *     later, once enough time has passed for a token to refill — it is
 *     NEVER dropped.
 *
 * Why in-memory and not Redis-backed?
 *   `backend/src/middleware/rateLimiter.ts` shows this codebase already has
 *   a Redis-backed limiter for HTTP ingress when distributed correctness
 *   matters (rate limits shared across multiple API instances). Outbound
 *   webhook delivery is driven by a single delivery worker process per
 *   deployment today (there is no multi-instance fan-out of
 *   `WebhookDeliveryService`), so an in-memory `Map`-based bucket (the same
 *   pattern as `services/cache.ts`'s `CacheService`) is sufficient, avoids
 *   adding a Redis round-trip to the hot delivery path, and keeps the
 *   queue/drain logic trivially testable with fake timers. If delivery is
 *   ever sharded across processes, swap the storage in this class for a
 *   Redis Lua-script token bucket (e.g. reusing `createRedisClient()` from
 *   `middleware/rateLimiter.ts`) while keeping the same public API.
 *
 * Configuration / extension point:
 *   - Defaults come from env vars: `WEBHOOK_RATE_LIMIT_PER_MINUTE` (default
 *     100) and `WEBHOOK_RATE_LIMIT_BURST` (default 20).
 *   - Per-tenant overrides can be registered at runtime via
 *     `setTenantOverride(tenantId, config)` / `clearTenantOverride(tenantId)`.
 *     This is an in-memory map for now. If a tenant/settings table is added
 *     to the Prisma schema later, load overrides from that table on
 *     startup (or lazily on first lookup) and call `setTenantOverride` —
 *     the rest of the rate limiter requires no changes.
 *
 * Lifecycle:
 *   The per-bucket drain timer is `unref()`'d so it never keeps the Node
 *   process alive on its own (graceful shutdown, tests with
 *   `--detectOpenHandles`). Call `stop()` to clear all pending drain timers
 *   and release queued waiters; the limiter is unusable afterwards.
 */

import { Counter } from "prom-client";
import { register } from "../lib/metrics";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TenantRateLimitConfig {
  /** Sustained delivery rate, in deliveries per minute. */
  ratePerMinute: number;
  /** Maximum burst size — the bucket's token capacity. */
  burstCapacity: number;
}

function readDefaultConfig(): TenantRateLimitConfig {
  return {
    ratePerMinute: parseInt(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE || "100", 10),
    burstCapacity: parseInt(process.env.WEBHOOK_RATE_LIMIT_BURST || "20", 10),
  };
}

// ---------------------------------------------------------------------------
// Metrics
//
// Named to match the issue's logical event names (webhook.delivery.queued /
// webhook.delivery.rate_limited) while following this codebase's existing
// Prometheus naming convention of `snake_case_total` counters (see
// `webhook_deliveries_total` etc. in `lib/metrics/index.ts`).
// ---------------------------------------------------------------------------

export const webhookDeliveryQueuedTotal = new Counter({
  name: "webhook_delivery_queued_total",
  help: "Total number of webhook deliveries queued because the tenant's rate-limit token bucket was empty (webhook.delivery.queued)",
  labelNames: ["tenant_id"],
  registers: [register],
});

export const webhookDeliveryRateLimitedTotal = new Counter({
  name: "webhook_delivery_rate_limited_total",
  help: "Total number of webhook delivery requests that exceeded the tenant's immediate token budget (webhook.delivery.rate_limited)",
  labelNames: ["tenant_id"],
  registers: [register],
});

/** Logical metric names referenced by the issue, kept alongside the Prometheus counters above for log/metric correlation. */
export const WEBHOOK_RATE_LIMIT_METRIC_NAMES = {
  QUEUED: "webhook.delivery.queued",
  RATE_LIMITED: "webhook.delivery.rate_limited",
} as const;

// ---------------------------------------------------------------------------
// Token bucket state
// ---------------------------------------------------------------------------

interface TokenBucket {
  tokens: number;
  lastRefill: number; // epoch ms
  config: TenantRateLimitConfig;
  /** FIFO queue of deliveries waiting for a token. */
  queue: Array<() => void>;
  /** Handle for the scheduled drain check, if one is pending. */
  drainTimer: NodeJS.Timeout | null;
}

/**
 * Per-tenant token-bucket rate limiter gating outbound webhook delivery.
 *
 * Usage: call `await limiter.acquire(tenantId)` immediately before the
 * outbound HTTP call. It resolves as soon as a token is available for that
 * tenant — immediately if the bucket has capacity, or after enough time has
 * elapsed for the bucket to refill if the tenant is currently over budget.
 * Callers are queued (never dropped) while waiting.
 */
export class TenantWebhookRateLimiter {
  private readonly buckets: Map<string, TokenBucket> = new Map();
  private readonly defaultConfig: TenantRateLimitConfig;
  private readonly overrides: Map<string, TenantRateLimitConfig> = new Map();
  private stopped = false;

  constructor(defaultConfig: TenantRateLimitConfig = readDefaultConfig()) {
    this.defaultConfig = defaultConfig;
  }

  /**
   * Register a per-tenant override. Extension point for a future
   * settings/tenant-config table — load rows at startup (or on demand) and
   * call this for each tenant.
   */
  setTenantOverride(tenantId: string, config: TenantRateLimitConfig): void {
    this.overrides.set(tenantId, config);
    // If a bucket already exists, re-clamp its tokens to the new capacity
    // and remember the new config for future refills.
    const bucket = this.buckets.get(tenantId);
    if (bucket) {
      bucket.config = config;
      bucket.tokens = Math.min(bucket.tokens, config.burstCapacity);
    }
  }

  clearTenantOverride(tenantId: string): void {
    this.overrides.delete(tenantId);
    const bucket = this.buckets.get(tenantId);
    if (bucket) bucket.config = this.defaultConfig;
  }

  getConfigForTenant(tenantId: string): TenantRateLimitConfig {
    return this.overrides.get(tenantId) || this.defaultConfig;
  }

  /**
   * Stop the limiter: clear every pending drain timer and release any
   * queued waiters so shutdown does not hang. The limiter is unusable
   * afterwards. Safe to call multiple times.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const bucket of this.buckets.values()) {
      if (bucket.drainTimer) {
        clearInterval(bucket.drainTimer);
        bucket.drainTimer = null;
      }
      const waiters = bucket.queue.splice(0);
      for (const resolve of waiters) resolve();
    }
    this.buckets.clear();
  }

  /**
   * Resolve once a token is available for `tenantId`, consuming it.
   * Resolves synchronously-soon (next microtask) when capacity is
   * immediately available; otherwise the caller is queued and resolved
   * later by the drain loop as tokens refill. Never rejects, never drops.
   */
  acquire(tenantId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const bucket = this.getOrCreateBucket(tenantId);
    this.refill(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return Promise.resolve();
    }

    // Over budget: queue the request and emit rate-limit/queued metrics.
    webhookDeliveryRateLim

/* … truncated 2987 chars — edit only what you need near the top … */
