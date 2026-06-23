import { Request, Response, NextFunction } from "express";
import Redis from "ioredis";
import { Counter } from "prom-client";
import { register } from "../lib/metrics";

/**
 * Configuration for a rate limit rule.
 */
export interface RateLimitConfig {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum requests allowed per window */
  max: number;
  /** Message sent when limit is exceeded */
  message?: string;
  /** Key prefix for Redis namespacing */
  keyPrefix?: string;
}

/**
 * Creates a Redis client from environment variables.
 * Falls back to localhost:6379 if REDIS_URL is not set.
 */
export function createRedisClient(): Redis {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const client = new Redis(url, {
    // Fail fast on connection errors rather than blocking requests
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  client.on("error", (err) => {
    // Log but don't crash — fallback logic handles unavailability
    console.error("[RateLimiter] Redis error:", err.message);
  });
  return client;
}

/**
 * Sliding-window counter using Redis ZADD / ZREMRANGEBYSCORE.
 *
 * Each request is recorded as a member with score = timestamp (ms).
 * Old entries outside the window are pruned on every check.
 * The key expires automatically after the window to avoid stale data.
 *
 * @returns number of requests in the current window (after recording this one)
 */
export async function incrementSlidingWindow(
  redis: Redis,
  key: string,
  windowMs: number
): Promise<number> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const expireSeconds = Math.ceil(windowMs / 1000) + 1;

  // Atomic pipeline: prune old entries, add current, count, set TTL
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, "-inf", windowStart);
  pipeline.zadd(key, now, `${now}-${Math.random()}`);
  pipeline.zcard(key);
  pipeline.expire(key, expireSeconds);

  const results = await pipeline.exec();
  // zcard result is at index 2
  const count = (results?.[2]?.[1] as number) ?? 1;
  return count;
}

/**
 * Extracts the real client IP respecting proxy configuration.
 * Checks X-Forwarded-For, X-Real-IP, and falls back to direct connection.
 * Honors TRUSTED_PROXY_IPS environment variable (comma-separated).
 */
export function extractClientIP(req: Request): string {
  const trustedProxies = new Set(
    (process.env.TRUSTED_PROXY_IPS || "")
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean)
  );

  const directIP = req.socket?.remoteAddress ?? req.ip ?? "unknown";

  // If no proxies are trusted, return direct connection IP
  if (trustedProxies.size === 0) {
    return directIP;
  }

  // If direct connection is not a trusted proxy, return it
  if (!trustedProxies.has(directIP)) {
    return directIP;
  }

  // Check X-Forwarded-For (rightmost IP is most recent proxy, leftmost is client)
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (xForwardedFor) {
    const ips = Array.isArray(xForwardedFor)
      ? xForwardedFor[0].split(",")
      : xForwardedFor.split(",");
    const clientIP = ips[0]?.trim();
    if (clientIP) return clientIP;
  }

  // Check X-Real-IP as fallback
  const xRealIP = req.headers["x-real-ip"];
  if (xRealIP) {
    return Array.isArray(xRealIP) ? xRealIP[0] : xRealIP;
  }

  return directIP;
}

/**
 * Builds the rate-limit key for a request.
 * Uses authenticated wallet address when available, otherwise uses extracted IP.
 */
export function resolveKey(req: Request, prefix: string): string {
  const user = (req as any).user;
  if (user?.walletAddress) return `${prefix}:wallet:${user.walletAddress}`;
  const ip = extractClientIP(req);
  return `${prefix}:ip:${ip}`;
}

// ---------------------------------------------------------------------------
// Max-min fairness scheduler (issue #1378)
//
// The Redis sliding window above caps each key's own budget, but it doesn't
// protect keys from each other: under burst traffic, a single high-volume IP
// can still get every one of its requests serviced before a quiet IP sharing
// the same worker gets a turn, since both are simply allowed through as fast
// as Redis confirms they're under budget.
//
// This governor tracks aggregate request volume across all keys in a short
// rolling window. Once that aggregate exceeds configured capacity, any key
// consuming more than an equal (max-min) share of that capacity is delayed
// by a small, fixed penalty before being passed to `next()` — giving quieter
// keys a chance to be serviced first. A key is never delayed more than
// `MAX_CONSECUTIVE_PENALTIES` times in a row, so a persistently noisy key
// still can't starve itself out indefinitely once it backs off.
// ---------------------------------------------------------------------------

/** Rolling window (ms) used to measure aggregate load and per-key share. */
const FAIRNESS_WINDOW_MS = parseInt(
  process.env.RATE_LIMITER_FAIRNESS_WINDOW_MS || "1000"
);

/** Aggregate requests/window above which fairness enforcement kicks in. */
const FAIRNESS_CAPACITY = parseInt(
  process.env.RATE_LIMITER_FAIRNESS_CAPACITY || "50"
);

/** Delay (ms) applied to a request exceeding its fair share. Kept small so
 *  the median request — which is rarely over-share — sees ~0ms impact,
 *  comfortably under the 10ms median-latency budget. */
const FAIRNESS_PENALTY_MS = parseInt(
  process.env.RATE_LIMITER_FAIRNESS_PENALTY_MS || "5"
);

/** A key is never penalized more than this many times in a row. */
const MAX_CONSECUTIVE_PENALTIES = 3;

export const fairnessPenaltyCounter = new Counter({
  name: "rate_limiter_fairness_penalty_applied_total",
  help: "Requests delayed by the rate limiter's max-min fairness scheduler (rateLimiter.fairness_penalty_applied)",
  labelNames: ["key_prefix"],
  registers: [register],
});

interface FairnessWindow {
  windowStart: number;
  /** Requests observed this window, per key. */
  counts: Map<string, number>;
}

let fairnessWindow: FairnessWindow = { windowStart: Date.now(), counts: new Map() };

/** Consecutive times a key has been penalized; reset once it gets a pass. */
const consecutivePenalties = new Map<string, number>();

function rotateFairnessWindow(now: number): void {
  if (now - fairnessWindow.windowStart >= FAIRNESS_WINDOW_MS) {
    fairnessWindow = { windowStart: now, counts: new Map() };
  }
}

/**
 * Record this request against the current fairness window and decide
 * whether it should be delayed to protect other keys' fair share.
 *
 * Max-min fairness target: once aggregate load exceeds capacity, each active
 * key is entitled to at least `capacity / activeKeyCount` of it. A key over
 * that share is delayed — unless it's already been delayed
 * `MAX_CONSECUTIVE_PENALTIES` times in a row, in which case it gets a pass.
 */
export function applyFairness(key: string): { delayed: boolean; delayMs: number } {
  const now = Date.now();
  rotateFairnessWindow(now);

  const keyCount = (fairnessWindow.counts.get(key) ?? 0) + 1;
  fairnessWindow.counts.set(key, keyCount);

  const aggregate = Array.from(fairnessWindow.counts.values()).reduce(
    (sum, c) => sum + c,
    0
  );
  if (aggregate <= FAIRNESS_CAPACITY) {
    consecutivePenalties.delete(key);
    return { delayed: false, delayMs: 0 };
  }

  const fairShare = FAIRNESS_CAPACITY / fairnessWindow.counts.size;
  const priorPenalties = consecutivePenalties.get(key) ?? 0;

  if (keyCount > fairShare && priorPenalties < MAX_CONSECUTIVE_PENALTIES) {
    consecutivePenalties.set(key, priorPenalties + 1);
    return { delayed: true, delayMs: FAIRNESS_PENALTY_MS };
  }

  consecutivePenalties.delete(key);
  return { delayed: false, delayMs: 0 };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test-only: reset fairness state so tests don't leak between files. */
export function resetFairnessStateForTests(): void {
  fairnessWindow = { windowStart: Date.now(), counts: new Map() };
  consecutivePenalties.clear();
}

/**
 * Creates an Express rate-limiting middleware backed by Redis.
 *
 * When Redis is unavailable the middleware fails open (allows the request)
 * to avoid taking down the API due to a cache outage.
 *
 * Standard rate-limit response headers are set on every response:
 *   X-RateLimit-Limit     – configured maximum
 *   X-RateLimit-Remaining – requests left in the current window
 *   X-RateLimit-Reset     – Unix timestamp (seconds) when the window resets
 *
 * @param redis  Shared Redis client instance
 * @param config Rate-limit configuration
 */
export function createRateLimiter(redis: Redis, config: RateLimitConfig) {
  const {
    windowMs,
    max,
    message = "Too many requests, please try again later.",
    keyPrefix = "rl",
  } = config;

  return async function rateLimiterMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const key = resolveKey(req, keyPrefix);
    const resetAt = Math.ceil((Date.now() + windowMs) / 1000);

    let count: number;
    try {
      count = await incrementSlidingWindow(redis, key, windowMs);
    } catch {
      // Redis unavailable — fail open
      next();
      return;
    }

    const remaining = Math.max(0, max - count);

    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetAt);

    if (count > max) {
      res.setHeader("Retry-After", resetAt - Math.floor(Date.now() / 1000));
      res.status(429).json({ error: message });
      return;
    }

    const fairness = applyFairness(key);
    if (fairness.delayed) {
      fairnessPenaltyCounter.inc({ key_prefix: keyPrefix });
      await delay(fairness.delayMs);
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Pre-configured limiters (drop-in replacements for the express-rate-limit ones)
// ---------------------------------------------------------------------------

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"); // 15 min
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100");

/** Lazily-initialised shared Redis client */
let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) _redis = createRedisClient();
  return _redis;
}

/**
 * Global rate limiter for all API endpoints.
 * 100 requests per 15-minute window per IP / wallet.
 */
export function globalRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  createRateLimiter(getRedis(), {
    windowMs: WINDOW_MS,
    max: MAX_REQUESTS,
    message: "Too many requests from this IP, please try again later.",
    keyPrefix: "rl:global",
  })(req, res, next);
}

/**
 * Stricter rate limiter for webhook subscription endpoints.
 * 20 requests per 15-minute window.
 */
export function webhookRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  createRateLimiter(getRedis(), {
    windowMs: WINDOW_MS,
    max: 20,
    message: "Too many webhook operations, please try again later.",
    keyPrefix: "rl:webhook",
  })(req, res, next);
}

/**
 * Per-user rate limiter for webhook subscription mutations (create/update/delete).
 * 10 requests per 15-minute window per authenticated user.
 * Requires authentication and only applies to wallet-based rate limiting.
 */
export function webhookUserRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const user = (req as any).user;
  if (!user?.walletAddress) {
    return res.status(401).json({ error: "Authentication required" });
  }

  createRateLimiter(getRedis(), {
    windowMs: WINDOW_MS,
    max: 10,
    message: "You have exceeded the rate limit for webhook mutations. Please try again later.",
    keyPrefix: "rl:webhook:user",
  })(req, res, next);
}
