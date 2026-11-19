/**
 * Tests for Webhook Retry Configuration with Exponential Backoff (#845)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeDelay,
  isRetryable,
  WebhookRetryService,
  DEFAULT_RETRY_CONFIG,
  AttemptResult,
} from "../services/webhookRetry";

// ---------------------------------------------------------------------------
// Environment parsing
// ---------------------------------------------------------------------------

describe("environment configuration parsing", () => {
  const ENV_KEYS = [
    "WEBHOOK_MAX_ATTEMPTS",
    "WEBHOOK_BASE_DELAY_MS",
    "WEBHOOK_MAX_DELAY_MS",
    "WEBHOOK_BACKOFF_MULTIPLIER",
  ] as const;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.resetModules();
  });

  const restoreEnv = () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  };

  /** Re-import the module so module-level defaults are re-evaluated. */
  const loadConfig = async () => {
    vi.resetModules();
    const mod = await import("../services/webhookRetry");
    return mod.DEFAULT_RETRY_CONFIG;
  };

  it("uses defaults when env vars are unset", async () => {
    const cfg = await loadConfig();
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.baseDelayMs).toBe(1000);
    expect(cfg.maxDelayMs).toBe(30_000);
    expect(cfg.backoffMultiplier).toBe(2);
    restoreEnv();
  });

  it("falls back to defaults for non-numeric values", async () => {
    process.env.WEBHOOK_MAX_ATTEMPTS = "abc";
    process.env.WEBHOOK_BASE_DELAY_MS = "abc";
    process.env.WEBHOOK_MAX_DELAY_MS = "abc";
    process.env.WEBHOOK_BACKOFF_MULTIPLIER = "abc";

    const cfg = await loadConfig();
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.baseDelayMs).toBe(1000);
    expect(cfg.maxDelayMs).toBe(30_000);
    expect(cfg.backoffMultiplier).toBe(2);
    restoreEnv();
  });

  it("falls back to defaults for zero values", async () => {
    process.env.WEBHOOK_MAX_ATTEMPTS = "0";
    process.env.WEBHOOK_BASE_DELAY_MS = "0";
    process.env.WEBHOOK_MAX_DELAY_MS = "0";
    process.env.WEBHOOK_BACKOFF_MULTIPLIER = "0";

    const cfg = await loadConfig();
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.baseDelayMs).toBe(1000);
    expect(cfg.maxDelayMs).toBe(30_000);
    expect(cfg.backoffMultiplier).toBe(2);
    restoreEnv();
  });

  it("falls back to defaults for negative values", async () => {
    process.env.WEBHOOK_MAX_ATTEMPTS = "-5";
    process.env.WEBHOOK_BASE_DELAY_MS = "-1000";
    process.env.WEBHOOK_MAX_DELAY_MS = "-30000";
    process.env.WEBHOOK_BACKOFF_MULTIPLIER = "-2";

    const cfg = await loadConfig();
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.baseDelayMs).toBe(1000);
    expect(cfg.maxDelayMs).toBe(30_000);
    expect(cfg.backoffMultiplier).toBe(2);
    restoreEnv();
  });

  it("accepts valid positive integer values", async () => {
    process.env.WEBHOOK_MAX_ATTEMPTS = "5";
    process.env.WEBHOOK_BASE_DELAY_MS = "500";
    process.env.WEBHOOK_MAX_DELAY_MS = "10000";
    process.env.WEBHOOK_BACKOFF_MULTIPLIER = "3";

    const cfg = await loadConfig();
    expect(cfg.maxAttempts).toBe(5);
    expect(cfg.baseDelayMs).toBe(500);
    expect(cfg.maxDelayMs).toBe(10_000);
    expect(cfg.backoffMultiplier).toBe(3);
    restoreEnv();
  });

  it("ensures baseDelayMs <= maxDelayMs when base exceeds max", async () => {
    process.env.WEBHOOK_BASE_DELAY_MS = "60000";
    process.env.WEBHOOK_MAX_DELAY_MS = "1000";

    const cfg = await loadConfig();
    expect(cfg.baseDelayMs).toBeLessThanOrEqual(cfg.maxDelayMs);
    restoreEnv();
  });
});

// ---------------------------------------------------------------------------
// computeDelay
// ---------------------------------------------------------------------------

describe("computeDelay", () => {
  const base = { baseDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30_000, jitter: false };

  it("returns baseDelayMs for attempt 1", () => {
    expect(computeDelay(1, base)).toBe(1000);
  });

  it("doubles on each attempt", () => {
    expect(computeDelay(2, base)).toBe(2000);
    expect(computeDelay(3, base)).toBe(4000);
    expect(computeDelay(4, base)).toBe(8000);
  });

  it("caps at maxDelayMs", () => {
    expect(computeDelay(10, base)).toBe(30_000);
  });

  it("applies jitter within ±25% of capped delay", () => {
    const cfg = { ...base, jitter: true };
    for (let i = 0; i < 50; i++) {
      const delay = computeDelay(1, cfg);
      expect(delay).toBeGreaterThanOrEqual(750);  // 1000 * 0.75
      expect(delay).toBeLessThanOrEqual(1250);    // 1000 * 1.25
    }
  });

  it("never returns a negative delay", () => {
    const cfg = { baseDelayMs: 0, backoffMultiplier: 2, maxDelayMs: 0, jitter: true };
    expect(computeDelay(1, cfg)).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// isRetryable
// ---------------------------------------------------------------------------

describe("isRetryable", () => {
  const nonRetryable = DEFAULT_RETRY_CONFIG.nonRetryableStatuses;

  it("returns true for null (network error)", () => {
    expect(isRetryable(null, nonRetryable)).toBe(true);
  });

  it("returns true for 500 (server error)", () => {
    expect(isRetryable(500, nonRetryable)).toBe(true);
  });

  it("returns true for 503", () => {
    expect(isRetryable(503, nonRetryable)).toBe(true);
  });

  it("returns false for 400", () => {
    expect(isRetryable(400, nonRetryable)).toBe(false);
  });

  it("returns false for 401", () => {
    expect(isRetryable(401, nonRetryable)).toBe(false);
  });

  it("returns false for 404", () => {
    expect(isRetryable(404, nonRetryable)).toBe(false);
  });

  it("returns false for 422", () => {
    expect(isRetryable(422, nonRetryable)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WebhookRetryService
// ---------------------------------------------------------------------------

/** Instant delay for tests */
const noDelay = () => Promise.resolve();

describe("WebhookRetryService", () => {
  describe("successful delivery on first attempt", () => {
    it("returns success=true with attempts=1", async () => {
      const svc = new WebhookRetryService({ maxAttempts: 3 }, noDelay);
      const fn = vi.fn<[number], Promise<AttemptResult>>().mockResolvedValue({
        success: true,
        statusCode: 200,
        error: null,
      });

      const result = await svc.execute(fn);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.lastStatusCode).toBe(200);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry on transient failure", () => {
    it("retries and succeeds on second attempt", async () => {
      const svc = new WebhookRetryService({ maxAttempts: 3 }, noDelay);
      const fn = vi
        .fn<[number], Promise<AttemptResult>>()
        .mockResolvedValueOnce({ success: false, statusCode: 503, error: "unavailable" })
        .mockResolvedValueOnce({ success: true, statusCode: 200, error: null });

      const result = await svc.execute(fn);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("exhausts all attempts and returns failure", async () => {
      const svc = new WebhookRetryService({ maxAttempts: 3 }, noDelay);
      const fn = vi.fn<[number], Promise<AttemptResult>>().mockResolvedValue({
        success: false,
        statusCode: 500,
        error: "server error",
      });

      const result = await svc.execute(fn);

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe("non-retryable status codes", () => {
    it("stops immediately on 400", async () => {
      const svc = new WebhookRetryService({ maxAttempts: 5 }, noDelay);
      const fn = vi.fn<[number], Promise<AttemptResult>>().mockResolvedValue({
        success: false,
        statusCode: 400,
        error: "bad request",
      });

      const result = await svc.execute(fn);

      expect(result.success).toBe(false);
      expect(fn).toHaveBeenCalledTimes(1); // no retries
    });

    it("stops immediately on 404", async () => {
      const svc = new WebhookRetryService({ maxAttempts: 5 }, noDelay);
      const fn = vi.fn<[number], Promise<AttemptResult>>().mockResolvedValue({
        success: false,
        statusCode: 404,
        error: "not found",
      });

      const result = await svc.execute(fn);

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("delay is called between retries", () => {
    it("calls delayFn (maxAttempts - 1) times on full exhaustion", async () => {
      const delayFn = vi.fn().mockResolvedValue(undefined);
      const svc = new WebhookRetryService({ maxAttempts: 4 }, delayFn);
      const fn = vi.fn<[number], Promise<AttemptResult>>().mockResolvedValue({
        success: false,
        statusCode: 500,
        error: "err",
      });

      await svc.execute(fn);

      // delay called between attempts 1→2, 2→3, 3→4 = 3 times
      expect(delayFn).toHaveBeenCalledTimes(3);
    });

    it("does not call delayFn after the last attempt", async () => {
      const delayFn = vi.fn().mockResolvedValue(undefined);
      const svc = new WebhookRetryService({ maxAttempts: 2 }, delayFn);
      const fn = vi.fn<[number], Promise<AttemptResult>>().mockResolvedValue({
        success: false,
        statusCode: 500,
        error: "err",
      });

      await svc.execute(fn);

      expect(delayFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("network errors (null status)", () => {
    it("retries on null statusCode", async () => {
      const svc = new WebhookRetryService({ maxAttempts: 3 }, noDelay);
      const fn = vi
        .fn<[number], Promise<AttemptResult>>()
        .mockResolvedValueOnce({ success: false, statusCode: null, error: "ECONNREFUSED" })
        .mockResolvedValueOnce({ success: true, statusCode: 200, error: null });

      const result = await svc.execute(fn);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });
  });

  describe("getConfig", () => {
    it("returns the resolved config", () => {
      const svc = new WebhookRetryService({ maxAttempts: 7, jitter: false });
      const cfg = svc.getConfig();
      expect(cfg.maxAttempts).toBe(7);
      expect(cfg.jitter).toBe(false);
    });
  });

  describe("custom backoff multiplier", () => {
    it("passes attempt number to attemptFn", async () => {
      const svc = new WebhookRetryService({ maxAttempts: 3 }, noDelay);
      const attempts: number[] = [];
      const fn = vi.fn<[number], Promise<AttemptResult>>().mockImplementation(
        async (n) => {
          attempts.push(n);
          return { success: false, statusCode: 500, error: "err" };
        }
      );

      await svc.execute(fn);

      expect(attempts).toEqual([1, 2, 3]);
    });
  });
});
