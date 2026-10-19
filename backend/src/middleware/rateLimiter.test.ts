import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { Request, Response, NextFunction } from "express";
import {
  createRateLimiter,
  incrementSlidingWindow,
  resolveKey,
  globalRateLimiter,
  webhookRateLimiter,
} from "./rateLimiter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock Redis client */
function mockRedis(overrides: Partial<Record<string, Mock>> = {}) {
  const pipelineInstance = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([
      [null, 0], // zremrangebyscore
      [null, 1], // zadd
      [null, 1], // zcard  ← count returned here
      [null, 1], // expire
    ]),
  };

  return {
    pipeline: vi.fn().mockReturnValue(pipelineInstance),
    on: vi.fn(),
    _pipeline: pipelineInstance,
    ...overrides,
  } as any;
}

/** Build a minimal mock Express Request */
function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
    ...overrides,
  } as any;
}

/** Build a mock Express Response that captures headers and status */
function mockRes() {
  const headers: Record<string, any> = {};
  let statusCode = 200;
  let body: any;

  const res: any = {
    headers,
    setHeader: vi.fn((k: string, v: any) => {
      headers[k] = v;
    }),
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn((b: any) => {
      body = b;
      return res;
    }),
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// resolveKey
// ---------------------------------------------------------------------------

describe("resolveKey", () => {
  it("uses IP address when no user is attached", () => {
    const req = mockReq({ ip: "1.2.3.4" });
    expect(resolveKey(req, "rl")).toBe("rl:ip:1.2.3.4");
  });

  it("uses wallet address when user is authenticated", () => {
    const req = mockReq({ user: { walletAddress: "GABC123" } } as any);
    expect(resolveKey(req, "rl")).toBe("rl:wallet:GABC123");
  });

  it("falls back to socket.remoteAddress when req.ip is undefined", () => {
    const req = mockReq({ ip: undefined, socket: { remoteAddress: "5.6.7.8" } as any });
    expect(resolveKey(req, "rl")).toBe("rl:ip:5.6.7.8");
  });

  it("uses 'unknown' when neither ip nor socket address is available", () => {
    const req = mockReq({ ip: undefined, socket: undefined as any });
    expect(resolveKey(req, "rl")).toBe("rl:ip:unknown");
  });

  it("respects custom key prefix", () => {
    const req = mockReq({ ip: "9.9.9.9" });
    expect(resolveKey(req, "custom:prefix")).toBe("custom:prefix:ip:9.9.9.9");
  });
});

// ---------------------------------------------------------------------------
// incrementSlidingWindow
// ---------------------------------------------------------------------------

describe("incrementSlidingWindow", () => {
  it("calls the correct Redis pipeline commands", async () => {
    const redis = mockRedis();
    await incrementSlidingWindow(redis, "test:key", 60000);

    const p = redis._pipeline;
    expect(p.zremrangebyscore).toHaveBeenCalledOnce();
    expect(p.zadd).toHaveBeenCalledOnce();
    expect(p.zcard).toHaveBeenCalledOnce();
    expect(p.expire).toHaveBeenCalledOnce();
    expect(p.exec).toHaveBeenCalledOnce();
  });

  it("returns the zcard result (count)", async () => {
    const redis = mockRedis();
    redis._pipeline.exec.mockResolvedValue([
      [null, 2], // zremrangebyscore
      [null, 1], // zadd
      [null, 5], // zcard ← 5 requests in window
      [null, 1], // expire
    ]);
    const count = await incrementSlidingWindow(redis, "test:key", 60000);
    expect(count).toBe(5);
  });

  it("prunes entries older than the window", async () => {
    const redis = mockRedis();
    const before = Date.now();
    await incrementSlidingWindow(redis, "test:key", 60000);
    const after = Date.now();

    // zremrangebyscore(key, "-inf", windowStart) — windowStart is arg index 2
    const [, , windowStart] = redis._pipeline.zremrangebyscore.mock.calls[0];
    expect(Number(windowStart)).toBeGreaterThanOrEqual(before - 60000);
    expect(Number(windowStart)).toBeLessThanOrEqual(after - 60000 + 1);
  });

  it("sets TTL slightly longer than the window", async () => {
    const redis = mockRedis();
    await incrementSlidingWindow(redis, "test:key", 60000);

    const [, ttl] = redis._pipeline.expire.mock.calls[0];
    // windowMs=60000 → expireSeconds = ceil(60000/1000)+1 = 61
    expect(ttl).toBe(61);
  });

  it("falls back to 1 when exec returns null results", async () => {
    const redis = mockRedis();
    redis._pipeline.exec.mockResolvedValue(null);
    const count = await incrementSlidingWindow(redis, "test:key", 60000);
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createRateLimiter — happy path
// ---------------------------------------------------------------------------

describe("createRateLimiter — allows requests under the limit", () => {
  it("calls next() when count is within limit", async () => {
    const redis = mockRedis();
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const next = vi.fn();

    await middleware(mockReq(), mockRes(), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("sets X-RateLimit-Limit header", async () => {
    const redis = mockRedis();
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const res = mockRes();

    await middleware(mockReq(), res, vi.fn());

    expect(res.headers["X-RateLimit-Limit"]).toBe(10);
  });

  it("sets X-RateLimit-Remaining header", async () => {
    const redis = mockRedis(); // count = 1
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const res = mockRes();

    await middleware(mockReq(), res, vi.fn());

    expect(res.headers["X-RateLimit-Remaining"]).toBe(9);
  });

  it("sets X-RateLimit-Reset header as a future Unix timestamp", async () => {
    const redis = mockRedis();
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const res = mockRes();
    const before = Math.floor(Date.now() / 1000);

    await middleware(mockReq(), res, vi.fn());

    const reset = res.headers["X-RateLimit-Reset"];
    expect(reset).toBeGreaterThanOrEqual(before + 60);
  });
});

// ---------------------------------------------------------------------------
// createRateLimiter — rate limit exceeded
// ---------------------------------------------------------------------------

describe("createRateLimiter — blocks requests over the limit", () => {
  function makeOverLimitRedis(count: number) {
    const redis = mockRedis();
    redis._pipeline.exec.mockResolvedValue([
      [null, 0],
      [null, 1],
      [null, count],
      [null, 1],
    ]);
    return redis;
  }

  it("responds with 429 when count exceeds max", async () => {
    const redis = makeOverLimitRedis(11);
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const res = mockRes();
    const next = vi.fn();

    await middleware(mockReq(), res, next);

    expect(res.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();
  });

  it("includes default error message in 429 body", async () => {
    const redis = makeOverLimitRedis(11);
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const res = mockRes();

    await middleware(mockReq(), res, vi.fn());

    expect(res.body.error.message).toContain("Too many requests");
  });

  it("uses custom message when provided", async () => {
    const redis = makeOverLimitRedis(11);
    const middleware = createRateLimiter(redis, {
      windowMs: 60000,
      max: 10,
      message: "Custom limit message",
    });
    const res = mockRes();

    await middleware(mockReq(), res, vi.fn());

    expect(res.body.error.message).toBe("Custom limit message");
  });

  it("sets Retry-After header on 429", async () => {
    const redis = makeOverLimitRedis(11);
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const res = mockRes();

    await middleware(mockReq(), res, vi.fn());

    expect(res.headers["Retry-After"]).toBeGreaterThan(0);
  });

  it("sets X-RateLimit-Remaining to 0 when over limit", async () => {
    const redis = makeOverLimitRedis(15);
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const res = mockRes();

    await middleware(mockReq(), res, vi.fn());

    expect(res.headers["X-RateLimit-Remaining"]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createRateLimiter — Redis failure (fail-open)
// ---------------------------------------------------------------------------

describe("createRateLimiter — Redis unavailable (fail-open)", () => {
  it("calls next() when Redis pipeline throws", async () => {
    const redis = mockRedis();
    redis._pipeline.exec.mockRejectedValue(new Error("ECONNREFUSED"));
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const next = vi.fn();

    await middleware(mockReq(), mockRes(), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("does not set rate-limit headers when Redis is down", async () => {
    const redis = mockRedis();
    redis._pipeline.exec.mockRejectedValue(new Error("timeout"));
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const failRes = mockRes();

    await middleware(mockReq(), failRes, vi.fn());

    // Headers should not be set because we bailed out early
    expect(failRes.headers["X-RateLimit-Limit"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Key prefix isolation
// ---------------------------------------------------------------------------

describe("createRateLimiter — key prefix", () => {
  it("uses the configured keyPrefix in the Redis key", async () => {
    const redis = mockRedis();
    const middleware = createRateLimiter(redis, {
      windowMs: 60000,
      max: 10,
      keyPrefix: "rl:webhook",
    });

    await middleware(mockReq({ ip: "1.2.3.4" }), mockRes(), vi.fn());

    const [key] = redis._pipeline.zremrangebyscore.mock.calls[0];
    expect(key).toContain("rl:webhook");
    expect(key).toContain("1.2.3.4");
  });
});

// ---------------------------------------------------------------------------
// Authenticated vs anonymous key isolation
// ---------------------------------------------------------------------------

describe("createRateLimiter — key isolation", () => {
  it("uses wallet address key for authenticated requests", async () => {
    const redis = mockRedis();
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const req = mockReq({ user: { walletAddress: "GWALLET" } } as any);

    await middleware(req, mockRes(), vi.fn());

    const [key] = redis._pipeline.zremrangebyscore.mock.calls[0];
    expect(key).toContain("wallet:GWALLET");
  });

  it("uses IP key for anonymous requests", async () => {
    const redis = mockRedis();
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });

    await middleware(mockReq({ ip: "10.0.0.1" }), mockRes(), vi.fn());

    const [key] = redis._pipeline.zremrangebyscore.mock.calls[0];
    expect(key).toContain("ip:10.0.0.1");
  });

  it("different IPs get different keys", async () => {
    const redis = mockRedis();
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });

    await middleware(mockReq({ ip: "1.1.1.1" }), mockRes(), vi.fn());
    await middleware(mockReq({ ip: "2.2.2.2" }), mockRes(), vi.fn());

    const key1 = redis._pipeline.zremrangebyscore.mock.calls[0][0];
    const key2 = redis._pipeline.zremrangebyscore.mock.calls[1][0];
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// Boundary conditions
// ---------------------------------------------------------------------------

describe("createRateLimiter — boundary conditions", () => {
  it("allows exactly max requests (count === max)", async () => {
    const redis = mockRedis();
    redis._pipeline.exec.mockResolvedValue([
      [null, 0],
      [null, 1],
      [null, 10], // exactly at limit
      [null, 1],
    ]);
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const next = vi.fn();

    await middleware(mockReq(), mockRes(), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("blocks at count === max + 1", async () => {
    const redis = mockRedis();
    redis._pipeline.exec.mockResolvedValue([
      [null, 0],
      [null, 1],
      [null, 11], // one over
      [null, 1],
    ]);
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 10 });
    const next = vi.fn();

    await middleware(mockReq(), mockRes(), next);

    expect(next).not.toHaveBeenCalled();
  });

  it("handles max=1 correctly", async () => {
    const redis = mockRedis(); // count = 1
    const middleware = createRateLimiter(redis, { windowMs: 60000, max: 1 });
    const next = vi.fn();

    await middleware(mockReq(), mockRes(), next);

    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// globalRateLimiter and webhookRateLimiter smoke tests
// ---------------------------------------------------------------------------

describe("globalRateLimiter", () => {
  it("is a function (Express middleware)", () => {
    expect(typeof globalRateLimiter).toBe("function");
  });
});

describe("webhookRateLimiter", () => {
  it("is a function (Express middleware)", () => {
    expect(typeof webhookRateLimiter).toBe("function");
  });
});
