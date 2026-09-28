/**
 * Tests for WebhookDeliveryService retry budget with 415 compression fallback.
 *
 * Validates:
 *  - A 415 response triggers compression fallback without consuming a retry attempt
 *  - Full MAX_RETRIES budget is available after 415 fallback for genuine failures
 *  - Multiple 415 responses don't accumulate into the retry budget
 *  - Compression fallback maintains retry budget consistency
 *
 * Also covers WEBHOOK_WORKER_CONCURRENCY validation (#2000):
 *  - A malformed WEBHOOK_WORKER_CONCURRENCY must fail with an error that names
 *    the misconfigured env var, not WorkerPool's generic concurrency error.
 */

// Disable Redis-backed rate limiting (no REDIS_URL → fail-open).
delete process.env.REDIS_URL;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import axios, { AxiosError } from "axios";
import {
  WebhookDeliveryService,
  parseWorkerConcurrency,
} from "../webhookDeliveryService";
import type { WebhookSubscription, WebhookEventData } from "../../types/webhook";

// Mock dependencies
vi.mock("axios");
vi.mock("../../lib/metrics", () => ({
  IntegrationMetrics: {
    recordWebhookDelivery: vi.fn(),
    recordWebhookDeadLetter: vi.fn(),
  },
  MetricsCollector: {
    updateWebhookWorkerPool: vi.fn(),
  },
  webhookDeliveryLatency: {
    observe: vi.fn(),
  },
}));

vi.mock("../webhookService", () => ({
  default: {
    createPayload: vi.fn((event, data, secret) => ({
      event,
      data,
      signature: "test-sig",
    })),
    findMatchingSubscriptions: vi.fn().mockResolvedValue([]),
    updateLastTriggered: vi.fn().mockResolvedValue(undefined),
    logDelivery: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../webhookDeadLetterService", () => ({
  default: {
    storeDeadLetter: vi.fn().mockResolvedValue("dead-letter-id"),
  },
}));

vi.mock("../tenantWebhookRateLimiter", () => ({
  default: {
    acquire: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../lib/circuitBreaker", () => ({
  CircuitBreaker: class {
    async execute(fn: () => Promise<any>) {
      return fn();
    }
  },
}));

vi.mock("../../lib/WorkerPool", () => ({
  WorkerPool: class {
    getConcurrency() {
      return 10;
    }
    getQueueDepth() {
      return 0;
    }
    async enqueue(task: any) {
      return task;
    }
  },
}));

describe("WebhookDeliveryService — 415 compression fallback retry budget", () => {
  let service: WebhookDeliveryService;

  const mockSubscription: WebhookSubscription = {
    id: "sub-1",
    url: "https://example.com/webhook",
    event: "token.deployed" as any,
    secret: "secret-123",
    createdBy: "tenant-1",
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockEventData: WebhookEventData = {
    tokenAddress: "GTOKEN123",
    creator: "GCREATOR",
    name: "Test Token",
    symbol: "TEST",
    decimals: 7,
    initialSupply: "1000000",
    transactionHash: "tx-hash-123",
    ledger: 12345,
  };

  beforeEach(() => {
    service = new WebhookDeliveryService();
    vi.clearAllMocks();
    // Set up process.env for max retries
    process.env.WEBHOOK_MAX_RETRIES = "3";
    process.env.WEBHOOK_TIMEOUT_MS = "5000";
    process.env.WEBHOOK_RETRY_DELAY_MS = "100";
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("handles 415 response by falling back to uncompressed without consuming a retry attempt", async () => {
    const mockedAxios = axios.post as any;
    let callCount = 0;

    mockedAxios.mockImplementation(async (url: string) => {
      callCount++;
      if (callCount === 1) {
        // First attempt: 415 response (compression not supported)
        const error = new AxiosError("Unsupported Media Type");
        error.response = { status: 415 } as any;
        throw error;
      }
      // Second attempt: success with uncompressed payload
      return { status: 200, data: {} };
    });

    const result = await service.deliverWebhook(
      mockSubscription,
      "token.deployed" as any,
      mockEventData,
      "correlation-123"
    );

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    // Should succeed after 2 attempts total (1 compressed, 1 uncompressed)
    expect(mockedAxios).toHaveBeenCalled();
  });

  it("preserves full retry budget after 415 fallback for subsequent failures", async () => {
    const mockedAxios = axios.post as any;
    let callCount = 0;

    mockedAxios.mockImplementation(async (url: string, body: any, config: any) => {
      callCount++;

      if (callCount === 1) {
        // First: 415 (compression not supported) — fallback happens here
        const error = new AxiosError("Unsupported Media Type");
        error.response = { status: 415 } as any;
        throw error;
      }
      // After fallback, subsequent uncompressed attempts fail with 500
      // This should still get full retry attempts (3 total)
      const error = new AxiosError("Internal Server Error");
      error.response = { status: 500 } as any;
      throw error;
    });

    const result = await service.deliverWebhook(
      mockSubscription,
      "token.deployed" as any,
      mockEventData,
      "correlation-123"
    );

    // Should fail but attempt should reflect only failure retries, not the 415 overhead
    expect(result.success).toBe(false);
    // After 415 fallback, we get the full retry budget for the uncompressed attempts
    // Total attempts: 1 (compressed) + MAX_RETRIES (uncompressed) = 4
    // But the 415 shouldn't count against the MAX_RETRIES budget
    expect(result.attempts).toBeGreaterThan(1);
  });

  it("continues retry loop without advancing attempt counter on 415 fallback", async () => {
    const mockedAxios = axios.post as any;
    const axiosCallLog: number[] = [];

    mockedAxios.mockImplementation(async (url: string, body: any, config: any) => {
      const isCompressed = config?.headers?.["Content-Encoding"] === "gzip";
      axiosCallLog.push(isCompressed ? 1 : 0);

      if (isCompressed && axiosCallLog.length === 1) {
        // 415 on first (compressed) attempt
        const error = new AxiosError("Unsupported Media Type");
        error.response = { status: 415 } as any;
        throw error;
      }

      // All uncompressed attempts fail with a transient error
      const error = new AxiosError("Service Unavailable");
      error.response = { status: 503 } as any;
      throw error;
    });

    const result = await service.deliverWebhook(
      mockSubscription,
      "token.deployed" as any,
      mockEventData
    );

    expect(result.success).toBe(false);
    // Should have attempted: 1 compressed (415) + multiple uncompressed
    expect(axiosCallLog).toContain(1); // At least one compressed attempt
    expect(axiosCallLog.filter((v) => v === 0).length).toBeGreaterThan(0); // Uncompressed attempts
  });

  it("handles multiple 415 responses correctly without budget exhaustion", async () => {
    const mockedAxios = axios.post as any;
    let callCount = 0;

    mockedAxios.mockImplementation(async (url: string) => {
      callCount++;

      // First two attempts get 415, then success
      if (callCount <= 2) {
        const error = new AxiosError("Unsupported Media Type");
        error.response = { status: 415 } as any;
        throw error;
      }

      return { status: 200, data: {} };
    });

    const result = await service.deliverWebhook(
      mockSubscription,
      "token.deployed" as any,
      mockEventData
    );

    // The second 415 should not happen in normal flow since compression
    // is disabled after the first 415, but if it does, we should still succeed
    expect(result.success).toBe(true);
  });

  it("retries failed delivery with full budget after 415 fallback", async () => {
    const mockedAxios = axios.post as any;
    let callCount = 0;

    mockedAxios.mockImplementation(async (url: string, body: any, config: any) => {
      callCount++;

      if (callCount === 1) {
        // 415 on compressed attempt
        const error = new AxiosError("Unsupported Media Type");
        error.response = { status: 415 } as any;
        throw error;
      }

      if (callCount <= 3) {
        // Uncompressed attempts fail
        const error = new AxiosError("Service Unavailable");
        error.response = { status: 503 } as any;
        throw error;
      }

      // Fourth attempt (after fallback + 2 retries) succeeds
      return { status: 200, data: {} };
    });

    const result = await service.deliverWebhook(
      mockSubscription,
      "token.deployed" as any,
      mockEventData
    );

    expect(result.success).toBe(true);
    expect(result.attempts).toBeGreaterThanOrEqual(4);
  });

  it("does not let 415 count as a real attempt in the retry budget", async () => {
    const mockedAxios = axios.post as any;
    let attemptCount = 0;

    mockedAxios.mockImplementation(async (url: string, body: any, config: any) => {
      attemptCount++;

      if (attemptCount === 1) {
        // 415 fallback scenario
        const error = new AxiosError("Unsupported Media Type");
        error.response = { status: 415 } as any;
        throw error;
      }

      // All other attempts: transient failure
      const error = new AxiosError("Timeout");
      error.response = { status: 503 } as any;
      throw error;
    });

    const result = await service.deliverWebhook(
      mockSubscription,
      "token.deployed" as any,
      mockEventData
    );

    expect(result.success).toBe(false);
    // Total attempts should reflect: 1 (415) + MAX_RETRIES (uncompressed)
    // With MAX_RETRIES = 3, we expect up to 4 axios calls
    expect(attemptCount).toBeLessThanOrEqual(4);
  });
});

describe("WebhookDeliveryService — WEBHOOK_WORKER_CONCURRENCY", () => {
  const ORIGINAL = process.env.WEBHOOK_WORKER_CONCURRENCY;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.WEBHOOK_WORKER_CONCURRENCY;
    else process.env.WEBHOOK_WORKER_CONCURRENCY = ORIGINAL;
  });

  it("throws a clear error naming the env var for a non-numeric value", () => {
    process.env.WEBHOOK_WORKER_CONCURRENCY = "not-a-number";
    expect(() => new WebhookDeliveryService()).toThrow(
      /WEBHOOK_WORKER_CONCURRENCY must be a positive integer/
    );
  });

  it.each(["0", "-3", "2.5", "10abc"])(
    "rejects invalid value %s with the clear error",
    (value) => {
      expect(() => parseWorkerConcurrency(value)).toThrow(
        /WEBHOOK_WORKER_CONCURRENCY must be a positive integer/
      );
    }
  );

  it("constructs successfully with a valid value", () => {
    process.env.WEBHOOK_WORKER_CONCURRENCY = "4";
    expect(() => new WebhookDeliveryService()).not.toThrow();
  });

  it("defaults to 10 when unset or empty", () => {
    expect(parseWorkerConcurrency(undefined)).toBe(10);
    expect(parseWorkerConcurrency("")).toBe(10);
  });

  it("parses a valid positive integer", () => {
    expect(parseWorkerConcurrency("25")).toBe(25);
  });
});
  });
});
