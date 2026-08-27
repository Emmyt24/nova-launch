/**
 * Tests for TenantWebhookRateLimiter — the per-tenant token-bucket rate
 * limiter gating outbound webhook delivery (Issue #1336).
 *
 * Covers:
 *   - Default config (100/min, burst 20) is read from env vars at construction.
 *   - Burst capacity is respected: the first `burstCapacity` acquisitions
 *     resolve immediately; the next one is queued, not dropped.
 *   - Queued acquisitions eventually resolve once tokens refill (using
 *     vi.useFakeTimers() to advance time deterministically).
 *   - Tenants are isolated: one tenant's exhausted bucket never blocks or
 *     drains tokens from another tenant's bucket.
 *   - Per-tenant overrides (setTenantOverride/clearTenantOverride) work as
 *     the documented extension point for future settings-table integration.
 *   - Metrics (webhook_delivery_queued_total / webhook_delivery_rate_limited_total)
 *     are incremented per tenant exactly when deliveries are queued/rate-limited.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("TenantWebhookRateLimiter", () => {
  let TenantWebhookRateLimiter: typeof import("../services/tenantWebhookRateLimiter").TenantWebhookRateLimiter;
  let webhookDeliveryQueuedTotal: typeof import("../services/tenantWebhookRateLimiter").webhookDeliveryQueuedTotal;
  let webhookDeliveryRateLimitedTotal: typeof import("../services/tenantWebhookRateLimiter").webhookDeliveryRateLimitedTotal;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../services/tenantWebhookRateLimiter");
    TenantWebhookRateLimiter = mod.TenantWebhookRateLimiter;
    webhookDeliveryQueuedTotal = mod.webhookDeliveryQueuedTotal;
    webhookDeliveryRateLimitedTotal = mod.webhookDeliveryRateLimitedTotal;
    webhookDeliveryQueuedTotal.reset();
    webhookDeliveryRateLimitedTotal.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Defaults / configuration
  // -------------------------------------------------------------------------

  describe("default configuration", () => {
    it("defaults to 100/min and burst 20 when no env vars are set", () => {
      delete process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE;
      delete process.env.WEBHOOK_RATE_LIMIT_BURST;
      const limiter = new TenantWebhookRateLimiter();
      const config = limiter.getConfigForTenant("tenant-a");
      expect(config.ratePerMinute).toBe(100);
      expect(config.burstCapacity).toBe(20);
      limiter.destroy();
    });

    it("reads defaults from WEBHOOK_RATE_LIMIT_PER_MINUTE / WEBHOOK_RATE_LIMIT_BURST env vars", async () => {
      process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE = "240";
      process.env.WEBHOOK_RATE_LIMIT_BURST = "5";
      vi.resetModules();
      const mod = await import("../services/tenantWebhookRateLimiter");
      const limiter = new mod.TenantWebhookRateLimiter();
      const config = limiter.getConfigForTenant("tenant-a");
      expect(config.ratePerMinute).toBe(240);
      expect(config.burstCapacity).toBe(5);
      limiter.destroy();
      delete process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE;
      delete process.env.WEBHOOK_RATE_LIMIT_BURST;
    });
  });

  // -------------------------------------------------------------------------
  // Burst behavior — immediate vs queued
  // -------------------------------------------------------------------------

  describe("burst capacity", () => {
    it("allows exactly burstCapacity immediate acquisitions before queuing", async () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });
      const tenant = "tenant-burst";

      const resolvedFlags: boolean[] = [];
      const promises = Array.from({ length: 20 }, () => {
        const p = limiter.acquire(tenant).then(() => {
          resolvedFlags.push(true);
        });
        return p;
      });

      await Promise.all(promises);
      expect(resolvedFlags).toHaveLength(20);
      // Bucket should now be empty (0 tokens, modulo negligible elapsed-time refill)
      expect(limiter.getAvailableTokens(tenant)).toBeLessThan(1);

      limiter.destroy();
    });

    it("queues the (burstCapacity + 1)th acquisition instead of dropping it", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60, // 1 token/sec — easy to reason about
        burstCapacity: 3,
      });
      const tenant = "tenant-overflow";

      // Consume all 3 burst tokens immediately.
      await limiter.acquire(tenant);
      await limiter.acquire(tenant);
      await limiter.acquire(tenant);
      expect(limiter.getQueueLength(tenant)).toBe(0);

      // The 4th acquisition must NOT resolve immediately — it should queue.
      let fourthResolved = false;
      const fourth = limiter.acquire(tenant).then(() => {
        fourthResolved = true;
      });

      // Give pending microtasks a chance to run without advancing real time.
      await Promise.resolve();
      await Promise.resolve();
      expect(fourthResolved).toBe(false);
      expect(limiter.getQueueLength(tenant)).toBe(1);

      // Advance fake time by 1 token's worth (1000ms at 60/min) plus the
      // drain-check interval so the queued caller is resolved, not dropped.
      await vi.advanceTimersByTimeAsync(1100);

      expect(fourthResolved).toBe(true);
      expect(limiter.getQueueLength(tenant)).toBe(0);

      limiter.destroy();
    });

    it("never drops excess deliveries — all queued callers eventually resolve", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60, // 1 token/sec
        burstCapacity: 2,
      });
      const tenant = "tenant-no-drop";

      const TOTAL_REQUESTS = 10;
      let resolvedCount = 0;
      const promises = Array.from({ length: TOTAL_REQUESTS }, () =>
        limiter.acquire(tenant).then(() => {
          resolvedCount++;
        })
      );

      // Immediately, only burstCapacity (2) should be resolved; the rest queued.
      await Promise.resolve();
      await Promise.resolve();
      expect(resolvedCount).toBe(2);
      expect(limiter.getQueueLength(tenant)).toBe(TOTAL_REQUESTS - 2);

      // Advance time enough for all remaining tokens to refill (8 more
      // tokens at 1/sec => ~8s, with margin for the drain check interval).
      await vi.advanceTimersByTimeAsync(9000);

      expect(resolvedCount).toBe(TOTAL_REQUESTS);
      expect(limiter.getQueueLength(tenant)).toBe(0);

      await Promise.all(promises);
      limiter.destroy();
    });

    it("exact boundary: the Nth request (= burstCapacity) resolves immediately; the (N+1)th is queued", async () => {
      // Precisely validates the boundary between "within burst" and "over
      // burst" at the token-bucket level. Request N uses the last token and
      // must resolve without queuing; request N+1 finds the bucket empty and
      // must be queued — never dropped.
      vi.useFakeTimers();
      const BURST = 5;
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60, // 1 token/sec — easy math
        burstCapacity: BURST,
      });
      const tenant = "boundary-tenant";

      // Requests 1 … N: all must resolve immediately (consume each token).
      const immediateResults: boolean[] = [];
      for (let i = 0; i < BURST; i++) {
        let resolved = false;
        // These resolve in the same microtask checkpoint because the bucket
        // still has tokens at the point acquire() is called.
        await limiter.acquire(tenant).then(() => {
          resolved = true;
        });
        immediateResults.push(resolved);
      }
      expect(immediateResults).toHaveLength(BURST);
      expect(immediateResults.every(Boolean)).toBe(true);

      // Bucket must now be empty.
      expect(limiter.getAvailableTokens(tenant)).toBeLessThan(1);

      // Request N+1: the bucket is empty — this must be queued, not resolved.
      let nPlusOneResolved = false;
      const nPlusOne = limiter.acquire(tenant).then(() => {
        nPlusOneResolved = true;
      });

      // Flush microtasks — the promise should still be pending.
      await Promise.resolve();
      await Promise.resolve();
      expect(nPlusOneResolved).toBe(false);
      expect(limiter.getQueueLength(tenant)).toBe(1);

      // Advance time to allow one token to refill and the drain to fire.
      await vi.advanceTimersByTimeAsync(1100);
      expect(nPlusOneResolved).toBe(true);
      expect(limiter.getQueueLength(tenant)).toBe(0);

      await nPlusOne;
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("one tenant exhausting its bucket does not affect another tenant", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60,
        burstCapacity: 2,
      });

      // Exhaust tenant A's bucket and queue 3 more.
      await limiter.acquire("tenant-a");
      await limiter.acquire("tenant-a");
      let aResolvedExtra = false;
      limiter.acquire("tenant-a").then(() => {
        aResolvedExtra = true;
      });
      await Promise.resolve();
      expect(limiter.getQueueLength("tenant-a")).toBe(1);
      expect(aResolvedExtra).toBe(false);

      // Tenant B should still have its full burst capacity available.
      expect(limiter.getAvailableTokens("tenant-b")).toBe(2);
      let bResolved = false;
      await limiter.acquire("tenant-b").then(() => {
        bResolved = true;
      });
      expect(bResolved).toBe(true);
      expect(limiter.getQueueLength("tenant-b")).toBe(0);

      limiter.destroy();
    });

    it("interleaved A/B/A/B calls maintain fully independent per-tenant counters", async () => {
      // This is the core per-tenant isolation proof: drive the limiter with
      // interleaved calls from two different tenant IDs in the pattern
      // A, B, A, B, A, B … and assert that each tenant's token count
      // decrements independently — exhausting A never borrows from B and
      // vice versa.
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60, // 1 token/sec
        burstCapacity: 3,
      });
      const A = "interleaved-tenant-a";
      const B = "interleaved-tenant-b";

      // Interleaved pattern: A, B, A, B, A, B
      // Each tenant sees 3 calls. With burst=3 every call should resolve
      // immediately; neither tenant's bucket should affect the other.
      const resolvedA: number[] = [];
      const resolvedB: number[] = [];

      // Call 1-A
      await limiter.acquire(A);
      resolvedA.push(Date.now());
      // Call 1-B
      await limiter.acquire(B);
      resolvedB.push(Date.now());
      // Call 2-A
      await limiter.acquire(A);
      resolvedA.push(Date.now());
      // Call 2-B
      await limiter.acquire(B);
      resolvedB.push(Date.now());
      // Call 3-A — uses the last of A's burst tokens
      await limiter.acquire(A);
      resolvedA.push(Date.now());
      // Call 3-B — uses the last of B's burst tokens
      await limiter.acquire(B);
      resolvedB.push(Date.now());

      // All six calls resolved without any timer advance — purely from burst.
      expect(resolvedA).toHaveLength(3);
      expect(resolvedB).toHaveLength(3);

      // Both buckets are now exhausted.
      expect(limiter.getAvailableTokens(A)).toBeLessThan(1);
      expect(limiter.getAvailableTokens(B)).toBeLessThan(1);

      // Now issue one more call to each. Both must be queued independently.
      let aExtra = false;
      let bExtra = false;
      const pendingA = limiter.acquire(A).then(() => {
        aExtra = true;
      });
      const pendingB = limiter.acquire(B).then(() => {
        bExtra = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(aExtra).toBe(false);
      expect(bExtra).toBe(false);
      expect(limiter.getQueueLength(A)).toBe(1);
      expect(limiter.getQueueLength(B)).toBe(1);

      // Advance time to refill exactly one token for each tenant (1 token = 1000 ms
      // at 60/min) plus a little buffer for the drain interval.
      await vi.advanceTimersByTimeAsync(1100);

      expect(aExtra).toBe(true);
      expect(bExtra).toBe(true);
      expect(limiter.getQueueLength(A)).toBe(0);
      expect(limiter.getQueueLength(B)).toBe(0);

      await Promise.all([pendingA, pendingB]);
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Window reset — tokens refill after full window elapses
  // -------------------------------------------------------------------------

  describe("window reset behavior", () => {
    it("tokens fully refill after a complete rate window has elapsed", async () => {
      // Configure 60/min (1 token/sec) with burst=3.
      // Exhaust all burst tokens, then advance a full minute (60 000 ms).
      // The bucket must be back at burstCapacity (capped) so a new burst
      // of requests can all resolve immediately without queuing.
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60,
        burstCapacity: 3,
      });
      const tenant = "window-reset-tenant";

      // Drain all 3 burst tokens.
      await limiter.acquire(tenant);
      await limiter.acquire(tenant);
      await limiter.acquire(tenant);
      expect(limiter.getAvailableTokens(tenant)).toBeLessThan(1);

      // Advance by one full minute — the bucket must fully refill, capped
      // at burstCapacity (3), not at ratePerMinute (60).
      await vi.advanceTimersByTimeAsync(60_000);

      // After the window the bucket should be replenished to burstCapacity.
      expect(limiter.getAvailableTokens(tenant)).toBeGreaterThanOrEqual(3);
      // getAvailableTokens applies refill lazily; it must be capped at burst.
      expect(limiter.getAvailableTokens(tenant)).toBeLessThanOrEqual(3);

      // All three new acquisitions must resolve immediately (no queuing).
      let resolvedCount = 0;
      const p1 = limiter.acquire(tenant).then(() => resolvedCount++);
      const p2 = limiter.acquire(tenant).then(() => resolvedCount++);
      const p3 = limiter.acquire(tenant).then(() => resolvedCount++);

      await Promise.resolve();
      await Promise.resolve();
      // All should have resolved without any additional timer advance.
      await Promise.all([p1, p2, p3]);
      expect(resolvedCount).toBe(3);
      // Queue must still be empty — none were held back.
      expect(limiter.getQueueLength(tenant)).toBe(0);

      limiter.destroy();
    });

    it("partial window refill grants only the proportional fraction of tokens", async () => {
      // At 60/min (1 token/sec, burst=2) advancing 500 ms should add ~0.5
      // tokens, which is not enough to immediately satisfy a new acquire.
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60, // 1 token/sec
        burstCapacity: 2,
      });
      const tenant = "partial-window-tenant";

      // Drain the bucket completely.
      await limiter.acquire(tenant);
      await limiter.acquire(tenant);
      expect(limiter.getAvailableTokens(tenant)).toBeLessThan(1);

      // Advance only half a token's worth of time.
      await vi.advanceTimersByTimeAsync(500);

      // Less than 1 full token has refilled — the next acquire should queue.
      let partialResolved = false;
      const pending = limiter.acquire(tenant).then(() => {
        partialResolved = true;
      });
      await Promise.resolve();
      expect(partialResolved).toBe(false);
      expect(limiter.getQueueLength(tenant)).toBe(1);

      // Now advance to 1100ms total to let drain loop fire and deliver the token
      await vi.advanceTimersByTimeAsync(1100);
      expect(partialResolved).toBe(true);

      await pending;
      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Burst-then-idle recovery
  // -------------------------------------------------------------------------

  describe("burst-then-idle recovery", () => {
    it("after exhausting burst capacity, idling long enough restores full burst", async () => {
      // Pattern: exhaust all burst tokens → idle until fully refilled →
      // burst again. This proves the token bucket truly resets after idle
      // time, so a tenant that was noisy, then quiets down, can burst freely
      // again later without being permanently penalized.
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60, // 1 token/sec
        burstCapacity: 4,
      });
      const tenant = "burst-idle-recovery-tenant";

      // --- First burst: consume all 4 tokens immediately ---
      await limiter.acquire(tenant);
      await limiter.acquire(tenant);
      await limiter.acquire(tenant);
      await limiter.acquire(tenant);
      expect(limiter.getAvailableTokens(tenant)).toBeLessThan(1);

      // Verify the 5th request queues (no idle yet).
      let fifthResolved = false;
      const pendingFifth = limiter.acquire(tenant).then(() => {
        fifthResolved = true;
      });
      await Promise.resolve();
      expect(fifthResolved).toBe(false);

      // Drain the queue so we're back to a clean state for the idle window.
      await vi.advanceTimersByTimeAsync(1100); // refills 1 token → drains queue
      expect(fifthResolved).toBe(true);
      await pendingFifth;

      // --- Idle period: advance enough time to fully refill burst (4 tokens
      //     at 1/sec = 4000 ms), capped by burstCapacity ---
      await vi.advanceTimersByTimeAsync(4000);

      expect(limiter.getAvailableTokens(tenant)).toBeGreaterThanOrEqual(4);
      expect(limiter.getAvailableTokens(tenant)).toBeLessThanOrEqual(4);

      // --- Second burst: all 4 tokens available again immediately ---
      let secondBurstCount = 0;
      const burst2 = [
        limiter.acquire(tenant).then(() => secondBurstCount++),
        limiter.acquire(tenant).then(() => secondBurstCount++),
        limiter.acquire(tenant).then(() => secondBurstCount++),
        limiter.acquire(tenant).then(() => secondBurstCount++),
      ];
      // None of these should require a timer advance — they must resolve
      // from the refilled bucket.
      await Promise.all(burst2);
      expect(secondBurstCount).toBe(4);
      expect(limiter.getQueueLength(tenant)).toBe(0);

      limiter.destroy();
    });

    it("a second burst after idle does not starve other tenants that were not idle", async () => {
      // Tenant A bursts, idles, then bursts again.
      // Tenant B makes steady non-bursting calls throughout.
      // Tenant A's recovery must not borrow from or delay Tenant B.
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60,
        burstCapacity: 3,
      });
      const A = "burst-idle-a";
      const B = "burst-idle-b";

      // A drains its bucket.
      await limiter.acquire(A);
      await limiter.acquire(A);
      await limiter.acquire(A);

      // B uses one token — still has 2 left.
      await limiter.acquire(B);
      expect(limiter.getAvailableTokens(B)).toBeGreaterThanOrEqual(2);

      // A idles and refills.
      await vi.advanceTimersByTimeAsync(4000);
      expect(limiter.getAvailableTokens(A)).toBeGreaterThanOrEqual(3);
      expect(limiter.getAvailableTokens(A)).toBeLessThanOrEqual(3);

      // B's tokens also naturally refill (it only used 1, now back at 3).
      expect(limiter.getAvailableTokens(B)).toBeGreaterThanOrEqual(3);
      expect(limiter.getAvailableTokens(B)).toBeLessThanOrEqual(3);

      // A bursts again — must not affect B's available tokens.
      await limiter.acquire(A);
      await limiter.acquire(A);
      await limiter.acquire(A);

      // B's bucket is untouched by A's second burst.
      expect(limiter.getAvailableTokens(B)).toBeGreaterThanOrEqual(3);
      expect(limiter.getQueueLength(A)).toBe(0);
      expect(limiter.getQueueLength(B)).toBe(0);

      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Per-tenant overrides — the documented extension point
  // -------------------------------------------------------------------------

  describe("per-tenant overrides", () => {
    it("setTenantOverride changes the effective config for that tenant only", () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      limiter.setTenantOverride("vip-tenant", {
        ratePerMinute: 1000,
        burstCapacity: 100,
      });

      expect(limiter.getConfigForTenant("vip-tenant")).toEqual({
        ratePerMinute: 1000,
        burstCapacity: 100,
      });
      expect(limiter.getConfigForTenant("regular-tenant")).toEqual({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      limiter.destroy();
    });

    it("clearTenantOverride reverts a tenant back to the default config", async () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      limiter.setTenantOverride("temp-tenant", {
        ratePerMinute: 5,
        burstCapacity: 1,
      });
      expect(limiter.getConfigForTenant("temp-tenant").burstCapacity).toBe(1);

      limiter.clearTenantOverride("temp-tenant");
      expect(limiter.getConfigForTenant("temp-tenant")).toEqual({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      limiter.destroy();
    });

    it("a lowered override clamps existing tokens down to the new burst capacity", async () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });
      const tenant = "shrinking-tenant";

      // Touch the bucket so it's created with the default 20-token capacity.
      expect(limiter.getAvailableTokens(tenant)).toBe(20);

      limiter.setTenantOverride(tenant, { ratePerMinute: 100, burstCapacity: 3 });
      expect(limiter.getAvailableTokens(tenant)).toBeLessThanOrEqual(3);

      limiter.destroy();
    });

    it("cache invalidation on override update: raised override allows higher throughput", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60,
        burstCapacity: 2,
      });
      const tenant = "vip-upgrade-tenant";

      await limiter.acquire(tenant);
      await limiter.acquire(tenant);
      expect(limiter.getAvailableTokens(tenant)).toBeLessThan(1);

      limiter.setTenantOverride(tenant, { ratePerMinute: 240, burstCapacity: 10 });
      const newConfig = limiter.getConfigForTenant(tenant);
      expect(newConfig.ratePerMinute).toBe(240);
      expect(newConfig.burstCapacity).toBe(10);

      // At 240/min, that's 4 tokens/sec, so 500ms gives ~2 tokens
      await vi.advanceTimersByTimeAsync(500);
      expect(limiter.getAvailableTokens(tenant)).toBeGreaterThan(1);

      limiter.destroy();
    });

    it("override-absent falls back to default limit for unconfigured tenants", () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      const config = limiter.getConfigForTenant("unregistered-tenant");
      expect(config.ratePerMinute).toBe(100);
      expect(config.burstCapacity).toBe(20);

      limiter.destroy();
    });

    it("clearTenantOverride invalidates cache and restores default throughput", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60,
        burstCapacity: 5,
      });
      const tenant = "downgrade-tenant";

      limiter.setTenantOverride(tenant, { ratePerMinute: 240, burstCapacity: 10 });
      expect(limiter.getAvailableTokens(tenant)).toBe(10);

      limiter.clearTenantOverride(tenant);
      const restoredConfig = limiter.getConfigForTenant(tenant);
      expect(restoredConfig.ratePerMinute).toBe(60);
      expect(restoredConfig.burstCapacity).toBe(5);

      limiter.destroy();
    });

    it("multiple tenants can have independent overrides without interference", async () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      limiter.setTenantOverride("vip-a", { ratePerMinute: 1000, burstCapacity: 100 });
      limiter.setTenantOverride("vip-b", { ratePerMinute: 500, burstCapacity: 50 });

      expect(limiter.getConfigForTenant("vip-a")).toEqual({
        ratePerMinute: 1000,
        burstCapacity: 100,
      });
      expect(limiter.getConfigForTenant("vip-b")).toEqual({
        ratePerMinute: 500,
        burstCapacity: 50,
      });
      expect(limiter.getConfigForTenant("regular")).toEqual({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      limiter.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  describe("metrics", () => {
    it("does NOT increment queued/rate_limited metrics while under budget", async () => {
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 100,
        burstCapacity: 20,
      });

      await limiter.acquire("metrics-tenant-ok");
      await limiter.acquire("metrics-tenant-ok");

      const queuedMetric = await webhookDeliveryQueuedTotal.get();
      const rateLimitedMetric = await webhookDeliveryRateLimitedTotal.get();
      expect(
        queuedMetric.values.some((v) => v.labels.tenant_id === "metrics-tenant-ok")
      ).toBe(false);
      expect(
        rateLimitedMetric.values.some((v) => v.labels.tenant_id === "metrics-tenant-ok")
      ).toBe(false);

      limiter.destroy();
    });

    it("increments webhook_delivery_queued_total and webhook_delivery_rate_limited_total exactly once per over-budget acquisition", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60,
        burstCapacity: 1,
      });
      const tenant = "metrics-tenant-overflow";

      await limiter.acquire(tenant); // consumes the only token, no metric yet

      const pending = limiter.acquire(tenant); // over budget -> queued + metrics incremented synchronously
      await Promise.resolve();

      const queuedMetric = await webhookDeliveryQueuedTotal.get();
      const rateLimitedMetric = await webhookDeliveryRateLimitedTotal.get();
      const queuedEntry = queuedMetric.values.find((v) => v.labels.tenant_id === tenant);
      const rateLimitedEntry = rateLimitedMetric.values.find(
        (v) => v.labels.tenant_id === tenant
      );

      expect(queuedEntry?.value).toBe(1);
      expect(rateLimitedEntry?.value).toBe(1);

      await vi.advanceTimersByTimeAsync(1100);
      await pending;

      limiter.destroy();
    });

    it("uses separate metric label values per tenant", async () => {
      vi.useFakeTimers();
      const limiter = new TenantWebhookRateLimiter({
        ratePerMinute: 60,
        burstCapacity: 1,
      });

      await limiter.acquire("tenant-x");
      const p1 = limiter.acquire("tenant-x"); // over budget

      await limiter.acquire("tenant-y");
      const p2 = limiter.acquire("tenant-y"); // over budget

      await Promise.resolve();

      const queuedMetric = await webhookDeliveryQueuedTotal.get();
      const xEntry = queuedMetric.values.find((v) => v.labels.tenant_id === "tenant-x");
      const yEntry = queuedMetric.values.find((v) => v.labels.tenant_id === "tenant-y");
      expect(xEntry?.value).toBe(1);
      expect(yEntry?.value).toBe(1);

      await vi.advanceTimersByTimeAsync(1100);
      await Promise.all([p1, p2]);
      limiter.destroy();
    });
  });
});
