/**
 * API Gateway — Express application factory.
 *
 * Responsibilities:
 *   1. Security headers (helmet)
 *   2. CORS with allowlist
 *   3. JWT authentication (skips public paths)
 *   4. Per-route Redis-backed sliding-window rate limiting
 *   5. Reverse proxy to the backend service
 *
 * The app is exported separately from the HTTP server so tests can import it
 * without binding a port.
 */

import express, { Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";
import Redis from "ioredis";

import { GatewayEnv } from "./config";
import { createAuthMiddleware } from "./auth";
import { createIdempotencyMiddleware } from "./idempotency";
import { createRateLimiter, createRedisClient } from "./rateLimiter";
import { ROUTES, RATE_LIMIT_TIERS, RateLimitTier } from "./routes";

export interface GatewayDeps {
  env: GatewayEnv;
  /** Optionally inject a Redis client (useful in tests). */
  redis?: Redis;
}

export function createApp({ env, redis: injectedRedis }: GatewayDeps) {
  const app = express();

  // ── Security headers ────────────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS ────────────────────────────────────────────────────────────────────
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || env.ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error("Not allowed by CORS"));
      },
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
      maxAge: 86400,
    })
  );

  // ── Health (no auth, no rate limit) ─────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "api-gateway", uptime: process.uptime() });
  });
  app.get("/health/live",  (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", (_req, res) => res.json({ status: "ok" }));

  // ── Authentication (applied per-route based on requiresAuth flag) ───────────
  const authMiddleware = createAuthMiddleware(env.JWT_SECRET);

  // ── Idempotency key propagation ──────────────────────────────────────────────
  app.use(createIdempotencyMiddleware());

  // ── Rate limiting + proxy per route ─────────────────────────────────────────
  const redis = injectedRedis ?? createRedisClient(env.REDIS_URL);

  // Cache one limiter per tier to avoid creating duplicate Redis pipelines
  const limiterCache = new Map<RateLimitTier, ReturnType<typeof createRateLimiter>>();
  function getLimiter(tier: RateLimitTier) {
    if (!limiterCache.has(tier)) {
      limiterCache.set(
        tier,
        createRateLimiter(redis, { ...RATE_LIMIT_TIERS[tier], keyPrefix: `gw:rl:${tier}` })
      );
    }
    return limiterCache.get(tier)!;
  }

  const proxy = createProxyMiddleware({
    target: env.BACKEND_URL,
    changeOrigin: true,
    on: {
      error: (_err, _req, res) => {
        (res as Response).status(502).json({ error: "Bad gateway" });
      },
    },
  });

  for (const route of ROUTES) {
    if (route.requiresAuth) {
      app.use(route.prefix, authMiddleware, getLimiter(route.tier), proxy);
    } else {
      app.use(route.prefix, getLimiter(route.tier), proxy);
    }
  }

  // ── 404 fallback ─────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
