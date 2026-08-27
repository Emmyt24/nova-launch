import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app";
import { GatewayEnv } from "../config";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SECRET = "test-gateway-secret";

const ENV: GatewayEnv = {
  PORT: 4000,
  BACKEND_URL: "http://backend:3001",
  JWT_SECRET: SECRET,
  REDIS_URL: "redis://localhost:6379",
  ALLOWED_ORIGINS: ["http://localhost:5173"],
  NODE_ENV: "test",
};

/** Mock Redis that always returns count=1 (well under any limit). */
function mockRedis() {
  const pipeline = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zadd:             vi.fn().mockReturnThis(),
    zcard:            vi.fn().mockReturnThis(),
    expire:           vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([[null, 0], [null, 1], [null, 1], [null, 1]]),
  };
  return { pipeline: vi.fn().mockReturnValue(pipeline), on: vi.fn(), _pipeline: pipeline } as any;
}

function validToken(payload: object = { userId: "u1" }) {
  return jwt.sign(payload, SECRET);
}

// ── Health endpoints ──────────────────────────────────────────────────────────

describe("GET /health", () => {
  const app = createApp({ env: ENV, redis: mockRedis() });

  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("api-gateway");
  });

  it("does not require authentication", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});

describe("GET /health/live", () => {
  const app = createApp({ env: ENV, redis: mockRedis() });

  it("returns 200", async () => {
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
  });
});

describe("GET /health/ready", () => {
  const app = createApp({ env: ENV, redis: mockRedis() });

  it("returns 200", async () => {
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
  });
});

// ── Authentication ────────────────────────────────────────────────────────────

describe("Authentication middleware", () => {
  // We don't have a real backend, so proxy calls will 502.
  // We only care about the auth layer (401 vs not-401).
  const app = createApp({ env: ENV, redis: mockRedis() });

  it("allows unauthenticated access to /api/tokens (requiresAuth: false)", async () => {
    const res = await request(app).get("/api/tokens");
    expect(res.status).not.toBe(401);
  });

  it("returns 401 for /api/admin without a token", async () => {
    const res = await request(app).get("/api/admin");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid token on a protected route (/api/admin)", async () => {
    const res = await request(app)
      .get("/api/admin")
      .set("Authorization", "Bearer invalid.token");
    expect(res.status).toBe(401);
  });

  it("passes auth with a valid token (proxy may 502 — that's fine)", async () => {
    const res = await request(app)
      .get("/api/tokens")
      .set("Authorization", `Bearer ${validToken()}`);
    // Auth passed; proxy to non-existent backend → 502 or ECONNREFUSED → 502
    expect(res.status).not.toBe(401);
  });
});

// ── Per-route requiresAuth flag matrix ───────────────────────────────────────

describe("Per-route requiresAuth flag", () => {
  const app = createApp({ env: ENV, redis: mockRedis() });

  // requiresAuth: false — reachable without a token
  it("allows unauthenticated GET /api/leaderboard (requiresAuth: false)", async () => {
    const res = await request(app).get("/api/leaderboard");
    expect(res.status).not.toBe(401);
  });

  it("allows unauthenticated GET /api/search (requiresAuth: false)", async () => {
    const res = await request(app).get("/api/search");
    expect(res.status).not.toBe(401);
  });

  // requiresAuth: false — also works with a valid token
  it("accepts a valid token on a public route (/api/tokens)", async () => {
    const res = await request(app)
      .get("/api/tokens")
      .set("Authorization", `Bearer ${validToken()}`);
    expect(res.status).not.toBe(401);
  });

  // requiresAuth: true — rejects without a token
  it("rejects unauthenticated GET /api/governance (requiresAuth: true)", async () => {
    const res = await request(app).get("/api/governance");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated GET /api/webhooks (requiresAuth: true)", async () => {
    const res = await request(app).get("/api/webhooks");
    expect(res.status).toBe(401);
  });

  // requiresAuth: true — passes with a valid token
  it("allows authenticated GET /api/admin (requiresAuth: true)", async () => {
    const res = await request(app)
      .get("/api/admin")
      .set("Authorization", `Bearer ${validToken()}`);
    expect(res.status).not.toBe(401);
  });
});

// ── CORS ──────────────────────────────────────────────────────────────────────

describe("CORS", () => {
  const app = createApp({ env: ENV, redis: mockRedis() });

  it("allows requests from an allowed origin", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("does not set ACAO header for a disallowed origin", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "http://evil.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

// ── 404 fallback ──────────────────────────────────────────────────────────────

describe("404 fallback", () => {
  const app = createApp({ env: ENV, redis: mockRedis() });

  it("returns 404 for unknown routes", async () => {
    const res = await request(app)
      .get("/unknown-path")
      .set("Authorization", `Bearer ${validToken()}`);
    expect(res.status).toBe(404);
  });
});

// ── Rate limiting headers ─────────────────────────────────────────────────────

describe("Rate limiting headers", () => {
  it("sets X-RateLimit-Limit on proxied routes", async () => {
    const redis = mockRedis();
    const app = createApp({ env: ENV, redis });

    const res = await request(app)
      .get("/api/tokens")
      .set("Authorization", `Bearer ${validToken()}`);

    // Header is set by rate limiter before proxy runs
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
  });

  it("sets X-RateLimit-Remaining on proxied routes", async () => {
    const redis = mockRedis();
    const app = createApp({ env: ENV, redis });

    const res = await request(app)
      .get("/api/tokens")
      .set("Authorization", `Bearer ${validToken()}`);

    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
  });
});

// ── validateGatewayEnv ────────────────────────────────────────────────────────

describe("validateGatewayEnv", () => {
  it("throws when JWT_SECRET is missing in production", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "";

    const { validateGatewayEnv } = await import("../config");
    expect(() => validateGatewayEnv()).toThrow("JWT_SECRET");

    process.env.NODE_ENV = original;
  });

  it("returns defaults in development", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.JWT_SECRET;

    const { validateGatewayEnv } = await import("../config");
    const env = validateGatewayEnv();
    expect(env.JWT_SECRET).toBeTruthy();
    expect(env.PORT).toBeGreaterThan(0);
  });
});
