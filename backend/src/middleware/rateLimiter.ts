import { Request, Response, NextFunction } from "express";
import Redis from "ioredis";
import { createRedisClient, getRedis } from "../lib/redis";
import { sendError } from "../utils/response";
import { ErrorCode } from "../lib/errors";

/**
 * What to do when Redis cannot be reached:
 *  - "open"   – allow the request without enforcement (default; availability first)
 *  - "closed" – reject with 503 + Retry-After (protection first)
 */
export type RedisFailureMode = "open" | "closed";

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
  /** Behaviour when Redis is unavailable. Defaults to RATE_LIMIT_REDIS_FAILURE_MODE, then "open". */
  redisFailureMode?: RedisFailureMode;
}

/**
 * Resolve the Redis failure mode from the environment. Unknown values fall
 * back to "open" so a typo never locks clients out.
 */
export function resolveRedisFailureMode(
  value: string | undefined = process.env.RATE_LIMIT_REDIS_FAILURE_MODE
): RedisFailureMode {
  return value?.trim().toLowerCase() === "closed" ? "closed" : "open";
}

export interface RateLimitState {
  limit: number;
  remaining: number;
  /** Seconds until the window resets */
  resetSeconds: number;
  windowMs: number;
}

/**
 * Write rate-limit headers (#2188).
 *
 * Standard (IETF draft-ietf-httpapi-ratelimit-headers):
 *   RateLimit-Limit     – configured maximum per window
 *   RateLimit-Remaining – requests left in the current window
 *   RateLimit-Reset     – seconds until the window resets
 *   RateLimit-Policy    – "<limit>;w=<window seconds>"
 *
 * Legacy (kept for existing clients):
 *   X-RateLimit-Limit / X-RateLimit-Remaining
 *   X-RateLimit-Reset   – Unix timestamp (seconds) when the window resets
 */
export function setRateLimitHeaders(res: Response, state: RateLimitState): void {
  const windowSeconds = Math.ceil(state.windowMs / 1000);

  res.setHeader("RateLimit-Limit", state.limit);
  res.setHeader("RateLimit-Remaining", state.remaining);
  res.setHeader("RateLimit-Reset", state.resetSeconds);
  res.setHeader("RateLimit-Policy", `${state.limit};w=${windowSeconds}`);

  res.setHeader("X-RateLimit-Limit", state.limit);
  res.setHeader("X-RateLimit-Remaining", state.remaining);
  res.setHeader("X-RateLimit-Reset", Math.floor(Date.now() / 1000) + state.resetSeconds);
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
 * When Redis is unavailable the middleware fails open by default (allows the
 * request without quota headers) to avoid taking down the API due to a cache
 * outage. Set `redisFailureMode: "closed"` (or RATE_LIMIT_REDIS_FAILURE_MODE=closed)
 * to reject with 503 + Retry-After instead.
 *
 * Rate-limit headers are set on every enforced response — see
 * `setRateLimitHeaders`. A 429 also carries `Retry-After` (seconds).
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
  const redisFailureMode = config.redisFailureMode ?? resolveRedisFailureMode();
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  return async function rateLimiterMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const key = resolveKey(req, keyPrefix);

    let count: number;
    try {
      count = await incrementSlidingWindow(redis, key, windowMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      if (redisFailureMode === "closed") {
        // Protection first: refuse the request rather than serve it unmetered.
        console.warn("[RateLimiter] Redis unavailable; rejecting request (fail-closed)", {
          error: reason,
          keyPrefix,
        });
        res.setHeader("Retry-After", windowSeconds);
        sendError(res, 503, "RATE_LIMIT_UNAVAILABLE", "Rate limiting is temporarily unavailable, please retry later.", {
          retryAfter: windowSeconds,
        });
        return;
      }

      // Redis unavailable — fail open, but make the degraded protection visible.
      // Quota headers are omitted because the remaining quota is unknown.
      console.warn("[RateLimiter] Redis unavailable; allowing request without rate-limit enforcement", {
        error: reason,
        keyPrefix,
      });
      next();
      return;
    }

    const remaining = Math.max(0, max - count);

    // A sliding window frees capacity gradually; the full window length is the
    // upper bound on when the quota is fully restored.
    setRateLimitHeaders(res, {
      limit: max,
      remaining,
      resetSeconds: windowSeconds,
      windowMs,
    });

    if (count > max) {
      res.setHeader("Retry-After", windowSeconds);
      sendError(res, 429, ErrorCode.RATE_LIMITED, message, {
        limit: max,
        windowMs,
        retryAfter: windowSeconds,
      });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Pre-configured limiters (drop-in replacements for the express-rate-limit ones)
// ---------------------------------------------------------------------------

const WINDOW_MS = (() => {
  const parsed = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000");
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Invalid RATE_LIMIT_WINDOW_MS: "${process.env.RATE_LIMIT_WINDOW_MS}" is not a valid integer`
    );
  }
  return parsed;
})();

const MAX_REQUESTS = (() => {
  const parsed = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100");
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Invalid RATE_LIMIT_MAX_REQUESTS: "${process.env.RATE_LIMIT_MAX_REQUESTS}" is not a valid integer`
    );
  }
  return parsed;
})();

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
    sendError(res, 401, ErrorCode.UNAUTHORIZED, "Authentication required");
    return;
  }

  createRateLimiter(getRedis(), {
    windowMs: WINDOW_MS,
    max: 10,
    message: "You have exceeded the rate limit for webhook mutations. Please try again later.",
    keyPrefix: "rl:webhook:user",
  })(req, res, next);
}
