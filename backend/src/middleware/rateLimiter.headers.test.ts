/**
 * Tests for issue #2188 — rate limit headers on API responses.
 *
 * Covers:
 *  - Standard RateLimit-Limit / Remaining / Reset / Policy headers
 *  - Legacy X-RateLimit-* headers are still emitted
 *  - Retry-After and a structured body on 429
 *  - Redis-unavailable behaviour in fail-open and fail-closed modes
 *  - The express-rate-limit configuration used by the v1 router
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import rateLimit from "express-rate-limit";
import type { Request } from "express";
import {
  createRateLimiter,
  resolveRedisFailureMode,
  setRateLimitHeaders,
} from "./rateLimiter";
import { sendError } from "../utils/response";
import { ErrorCode } from "../lib/errors";

function redisWithCount(count: number) {
  const pipeline = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([[null, 0], [null, 1], [null, count], [null, 1]]),
  };
  return { pipeline: vi.fn().mockReturnValue(pipeline) } as any;
}

function unavailableRedis() {
  const pipeline = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
  };
  return { pipeline: vi.fn().mockReturnValue(pipeline) } as any;
}

function mockReq(): Request {
  return { ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" }, headers: {} } as any;
}

function mockRes() {
  const res: any = {
    headers: {} as Record<string, unknown>,
    statusCode: 200,
    body: undefined as any,
    setHeader: vi.fn((k: string, v: unknown) => { res.headers[k] = v; }),
    status: vi.fn((code: number) => { res.statusCode = code; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
  };
  return res;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("setRateLimitHeaders", () => {
  it("writes standard and legacy headers", () => {
    const res = mockRes();
    const nowSeconds = Math.floor(Date.now() / 1000);
    setRateLimitHeaders(res, { limit: 100, remaining: 42, resetSeconds: 900, windowMs: 900_000 });

    expect(res.headers["RateLimit-Limit"]).toBe(100);
    expect(res.headers["RateLimit-Remaining"]).toBe(42);
    expect(res.headers["RateLimit-Reset"]).toBe(900);
    expect(res.headers["RateLimit-Policy"]).toBe("100;w=900");
    expect(res.headers["X-RateLimit-Limit"]).toBe(100);
    expect(res.headers["X-RateLimit-Remaining"]).toBe(42);
    expect(res.headers["X-RateLimit-Reset"]).toBeGreaterThanOrEqual(nowSeconds + 900);
  });
});

describe("createRateLimiter — headers under the limit", () => {
  it("sets RateLimit-* headers and calls next()", async () => {
    const res = mockRes();
    const next = vi.fn();
    await createRateLimiter(redisWithCount(3), { windowMs: 60_000, max: 10 })(mockReq(), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headers["RateLimit-Limit"]).toBe(10);
    expect(res.headers["RateLimit-Remaining"]).toBe(7);
    expect(res.headers["RateLimit-Reset"]).toBe(60);
    expect(res.headers["RateLimit-Policy"]).toBe("10;w=60");
    expect(res.headers).not.toHaveProperty("Retry-After");
  });

  it("rounds sub-second windows up to one second", async () => {
    const res = mockRes();
    await createRateLimiter(redisWithCount(1), { windowMs: 250, max: 5 })(mockReq(), res, vi.fn());
    expect(res.headers["RateLimit-Reset"]).toBe(1);
  });
});

describe("createRateLimiter — 429", () => {
  it("sets Retry-After and RateLimit-Remaining: 0", async () => {
    const res = mockRes();
    const next = vi.fn();
    await createRateLimiter(redisWithCount(11), { windowMs: 60_000, max: 10 })(mockReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe(60);
    expect(res.headers["RateLimit-Remaining"]).toBe(0);
  });

  it("returns a structured RATE_LIMITED error body", async () => {
    const res = mockRes();
    await createRateLimiter(redisWithCount(11), { windowMs: 60_000, max: 10, message: "Slow down" })(
      mockReq(),
      res,
      vi.fn()
    );

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.body.error.message).toBe("Slow down");
    expect(res.body.error.details).toEqual({ limit: 10, windowMs: 60_000, retryAfter: 60 });
  });
});

describe("createRateLimiter — Redis unavailable", () => {
  it("fails open by default without quota headers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = mockRes();
    const next = vi.fn();
    await createRateLimiter(unavailableRedis(), { windowMs: 60_000, max: 10 })(mockReq(), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headers).not.toHaveProperty("RateLimit-Limit");
    expect(res.headers).not.toHaveProperty("Retry-After");
  });

  it("fails closed with 503 + Retry-After when configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = mockRes();
    const next = vi.fn();
    await createRateLimiter(unavailableRedis(), {
      windowMs: 60_000,
      max: 10,
      redisFailureMode: "closed",
    })(mockReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe(60);
    expect(res.body.error.code).toBe("RATE_LIMIT_UNAVAILABLE");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fail-closed"), expect.any(Object));
  });

  it("reads the failure mode from RATE_LIMIT_REDIS_FAILURE_MODE", async () => {
    vi.stubEnv("RATE_LIMIT_REDIS_FAILURE_MODE", "closed");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = mockRes();
    await createRateLimiter(unavailableRedis(), { windowMs: 60_000, max: 10 })(mockReq(), res, vi.fn());
    expect(res.statusCode).toBe(503);
  });
});

describe("resolveRedisFailureMode", () => {
  it.each([
    [undefined, "open"],
    ["open", "open"],
    ["closed", "closed"],
    [" CLOSED ", "closed"],
    ["typo", "open"],
  ])("%s → %s", (input, expected) => {
    expect(resolveRedisFailureMode(input)).toBe(expected);
  });
});

describe("express-rate-limit configuration (v1 router)", () => {
  function buildApp(limit: number) {
    const app = express();
    app.use(
      rateLimit({
        windowMs: 60_000,
        max: limit,
        standardHeaders: "draft-6",
        legacyHeaders: true,
        handler: (_req, res, _next, options) => {
          sendError(res, options.statusCode, ErrorCode.RATE_LIMITED, "Too many requests", {
            limit: options.limit,
            windowMs: options.windowMs,
          });
        },
      })
    );
    app.get("/x", (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("emits standard and legacy headers on success", async () => {
    const res = await request(buildApp(5)).get("/x");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe("5");
    expect(res.headers["ratelimit-remaining"]).toBe("4");
    expect(res.headers["ratelimit-reset"]).toBeDefined();
    expect(res.headers["x-ratelimit-limit"]).toBe("5");
  });

  it("returns 429 with Retry-After and a structured body once exhausted", async () => {
    const app = buildApp(1);
    await request(app).get("/x");
    const res = await request(app).get("/x");

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBe("0");
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });
});
