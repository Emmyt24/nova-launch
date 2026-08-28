import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimitMiddleware } from "./rate-limit.middleware";
import { Request, Response } from "express";
import { AUTH_CONSTANTS } from "./auth.constants";

function mockRes(): Partial<Response> & {
  headers: Record<string, any>;
  statusCode?: number;
  body?: any;
} {
  const headers: Record<string, any> = {};
  let statusCode = 200;
  let resolvedBody: any;

  const res: any = {
    headers,
    setHeader: vi.fn((key: string, value: any) => {
      headers[key] = value;
    }),
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn((body: any) => {
      resolvedBody = body;
      return res;
    }),
    get statusCode() {
      return statusCode;
    },
    get body() {
      return resolvedBody;
    },
  };
  return res;
}

function mockReq(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    ip: "127.0.0.1",
    path: "/api/data",
    user: undefined,
    ...overrides,
  } as any;
}

describe("RateLimitMiddleware", () => {
  let middleware: RateLimitMiddleware;

  beforeEach(() => {
    middleware = new RateLimitMiddleware();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should call next() for first request", () => {
    const next = vi.fn();
    middleware.use(mockReq() as any, mockRes() as any, next);
    expect(next).toHaveBeenCalled();
  });

  it("should set rate limit headers", () => {
    const next = vi.fn();
    const res = mockRes();
    middleware.use(mockReq() as any, res as any, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      "X-RateLimit-Limit",
      expect.any(Number)
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-RateLimit-Remaining",
      expect.any(Number)
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "X-RateLimit-Reset",
      expect.any(Number)
    );
  });

  it("should block after exceeding rate limit on auth endpoints", () => {
    const next = vi.fn();
    const req = mockReq({ path: "/auth/login" });
    const max = AUTH_CONSTANTS.RATE_LIMIT_AUTH_MAX;

    for (let i = 0; i <= max; i++) {
      next.mockClear();
      const res = mockRes();
      middleware.use(req as any, res as any, next);
    }

    // The last call should have been blocked
    expect(next).not.toHaveBeenCalled();
  });

  it("should use wallet address as key when authenticated", () => {
    const next = vi.fn();
    const req = mockReq({ user: { walletAddress: "GTEST" } as any });
    middleware.use(req as any, mockRes() as any, next);

    // Different IP, same wallet — should count as same bucket
    const req2 = mockReq({
      ip: "10.0.0.1",
      user: { walletAddress: "GTEST" } as any,
    });
    const res2 = mockRes();
    middleware.use(req2 as any, res2 as any, next);

    const remaining = res2.headers["X-RateLimit-Remaining"];
    expect(remaining).toBeLessThan(AUTH_CONSTANTS.RATE_LIMIT_MAX_REQUESTS - 1);
  });

  it("should evict stale entries via purgeExpired", () => {
    const next = vi.fn();
    const originalNow = Date.now;

    // Add a key at time 0
    Date.now = () => 1_000_000;
    middleware.use(mockReq({ ip: "192.168.1.1" }) as any, mockRes() as any, next);
    expect(middleware.getStoreSize()).toBe(1);

    // Move time forward past the window and trigger purge
    Date.now = () => 1_000_000 + AUTH_CONSTANTS.RATE_LIMIT_WINDOW_MS + 1000;
    middleware.purgeExpired();
    expect(middleware.getStoreSize()).toBe(0);

    Date.now = originalNow;
  });

  it("should keep active entries after purgeExpired", () => {
    const next = vi.fn();
    const originalNow = Date.now;

    // Add two keys at time 0
    Date.now = () => 1_000_000;
    middleware.use(mockReq({ ip: "192.168.1.1" }) as any, mockRes() as any, next);
    middleware.use(mockReq({ ip: "192.168.1.2" }) as any, mockRes() as any, next);
    expect(middleware.getStoreSize()).toBe(2);

    // Move time forward but only past the window for the first key
    Date.now = () => 1_000_000 + AUTH_CONSTANTS.RATE_LIMIT_WINDOW_MS + 1000;
    // Add a fresh request for the second key so it stays active
    middleware.use(mockReq({ ip: "192.168.1.2" }) as any, mockRes() as any, next);

    middleware.purgeExpired();
    // First key should be evicted, second key should remain
    expect(middleware.getStoreSize()).toBe(1);

    Date.now = originalNow;
  });
});
