import { Request, Response, NextFunction } from "express";
import Redis from "ioredis";
import { createRedisClient, getRedis } from "../lib/redis";

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

// `createRedisClient` now lives in `../lib/redis` so other modules (e.g. the
// leaderboard sorted-set cache) can share the exact same client-creation
// convention. Re-exported here for backwards compatibility with existing
// imports of `middleware/rateLimiter`.
export { createRedisClient };

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

    next();
  };
}

// ---------------------------------------------------------------------------
// Pre-configured limiters (drop-in replacements for the express-rate-limit ones)
// ---------------------------------------------------------------------------

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"); // 15 min
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100");

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
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  createRateLimiter(getRedis(), {
    windowMs: WINDOW_MS,
    max: 10,
    message: "You have exceeded the rate limit for webhook mutations. Please try again later.",
    keyPrefix: "rl:webhook:user",
  })(req, res, next);
}
