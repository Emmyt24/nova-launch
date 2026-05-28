/**
 * Chaos Test: Redis Failover and Reconnection Behaviour (#1078)
 *
 * Scenarios verified:
 *   R1  Cache reads fall back to the source when Redis is unavailable
 *   R2  Rate limiting fails safe (allows requests) during a Redis outage
 *   R3  Normal operation resumes after Redis reconnects
 *   R4  Errors are logged without crashing the process
 *
 * The test is fully self-contained: Redis is mocked so no live instance is
 * needed. The fail-safe behaviour is documented inline.
 *
 * Fail-safe policy (documented):
 *   - Cache miss on Redis error → fall through to source (stale-on-error)
 *   - Rate limiter on Redis error → fail open (allow the request)
 *   - Both behaviours are logged at ERROR level for observability
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal Redis-backed cache (mirrors CacheService but with Redis)
// ---------------------------------------------------------------------------

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: "EX", ttl: number): Promise<"OK" | null>;
  isAvailable: boolean;
}

function makeRedis(available = true): RedisLike {
  const store = new Map<string, string>();
  return {
    isAvailable: available,
    async get(key) {
      if (!this.isAvailable) throw new Error("Redis connection refused");
      return store.get(key) ?? null;
    },
    async set(key, value) {
      if (!this.isAvailable) throw new Error("Redis connection refused");
      store.set(key, value);
      return "OK";
    },
  };
}

/** Source-of-truth fetch (simulates a DB call). */
async function fetchFromSource(key: string): Promise<string> {
  return `source:${key}`;
}

/**
 * Cache-aside read with Redis.
 * On Redis error: logs and falls through to source (fail-safe).
 */
async function cachedRead(
  redis: RedisLike,
  key: string,
  logger: { error: (...a: unknown[]) => void }
): Promise<{ value: string; fromCache: boolean }> {
  try {
    const cached = await redis.get(key);
    if (cached !== null) return { value: cached, fromCache: true };
  } catch (err) {
    logger.error("[Cache] Redis unavailable, falling back to source:", (err as Error).message);
  }
  const value = await fetchFromSource(key);
  // Best-effort write-back (ignore errors)
  try {
    await redis.set(key, value, "EX", 60);
  } catch {
    // intentionally swallowed — write-back is best-effort
  }
  return { value, fromCache: false };
}

// ---------------------------------------------------------------------------
// Minimal sliding-window rate limiter backed by Redis
// ---------------------------------------------------------------------------

/**
 * Rate-limit check backed by Redis sorted sets.
 * On Redis error: fails open (allows the request) and logs.
 */
async function rateLimitCheck(
  redis: RedisLike,
  key: string,
  max: number,
  logger: { error: (...a: unknown[]) => void }
): Promise<{ allowed: boolean; failedOpen: boolean }> {
  try {
    if (!redis.isAvailable) throw new Error("Redis connection refused");
    // Simplified counter for test purposes
    const raw = await redis.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= max) return { allowed: false, failedOpen: false };
    await redis.set(key, String(count + 1), "EX", 60);
    return { allowed: true, failedOpen: false };
  } catch (err) {
    logger.error("[RateLimiter] Redis unavailable, failing open:", (err as Error).message);
    return { allowed: true, failedOpen: true };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Chaos: Redis Failover and Reconnection Behaviour", () => {
  let logger: { error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    logger = { error: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── R1: Cache falls back to source ──────────────────────────────────────

  it("R1a: cache hit returns value from Redis when available", async () => {
    const redis = makeRedis(true);
    await redis.set("token:abc", "cached-value", "EX", 60);

    const result = await cachedRead(redis, "token:abc", logger);

    expect(result.value).toBe("cached-value");
    expect(result.fromCache).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("R1b: cache miss falls through to source when Redis is down", async () => {
    const redis = makeRedis(false);

    const result = await cachedRead(redis, "token:xyz", logger);

    expect(result.value).toBe("source:token:xyz");
    expect(result.fromCache).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      "[Cache] Redis unavailable, falling back to source:",
      expect.any(String)
    );
  });

  it("R1c: cache miss falls through to source on Redis error (not just unavailable)", async () => {
    const redis = makeRedis(true);
    vi.spyOn(redis, "get").mockRejectedValueOnce(new Error("ECONNRESET"));

    const result = await cachedRead(redis, "token:err", logger);

    expect(result.value).toBe("source:token:err");
    expect(result.fromCache).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  // ── R2: Rate limiter fails safe ──────────────────────────────────────────

  it("R2a: rate limiter allows requests when Redis is down (fail open)", async () => {
    const redis = makeRedis(false);

    const result = await rateLimitCheck(redis, "ip:1.2.3.4", 5, logger);

    expect(result.allowed).toBe(true);
    expect(result.failedOpen).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "[RateLimiter] Redis unavailable, failing open:",
      expect.any(String)
    );
  });

  it("R2b: rate limiter enforces budget when Redis is healthy", async () => {
    const redis = makeRedis(true);
    const key = "ip:10.0.0.1";
    const max = 3;

    for (let i = 0; i < max; i++) {
      const r = await rateLimitCheck(redis, key, max, logger);
      expect(r.allowed).toBe(true);
      expect(r.failedOpen).toBe(false);
    }

    const overflow = await rateLimitCheck(redis, key, max, logger);
    expect(overflow.allowed).toBe(false);
    expect(overflow.failedOpen).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  // ── R3: Normal operation resumes after reconnection ──────────────────────

  it("R3: normal operation resumes after Redis reconnects", async () => {
    const redis = makeRedis(false);

    // Phase 1: Redis is down — cache falls back to source
    const r1 = await cachedRead(redis, "token:reconnect", logger);
    expect(r1.fromCache).toBe(false);

    // Phase 2: Redis comes back
    redis.isAvailable = true;

    // First read after reconnect: cache is cold, falls through to source and writes back
    const r2 = await cachedRead(redis, "token:reconnect", logger);
    expect(r2.fromCache).toBe(false);
    expect(r2.value).toBe("source:token:reconnect");

    // Second read: now served from cache
    const r3 = await cachedRead(redis, "token:reconnect", logger);
    expect(r3.fromCache).toBe(true);
    expect(r3.value).toBe("source:token:reconnect");
  });

  it("R3b: rate limiter resumes enforcement after Redis reconnects", async () => {
    const redis = makeRedis(false);
    const key = "ip:reconnect";
    const max = 2;

    // Phase 1: Redis down — all requests fail open
    const r1 = await rateLimitCheck(redis, key, max, logger);
    expect(r1.failedOpen).toBe(true);

    // Phase 2: Redis back
    redis.isAvailable = true;

    const r2 = await rateLimitCheck(redis, key, max, logger);
    expect(r2.allowed).toBe(true);
    expect(r2.failedOpen).toBe(false);
  });

  // ── R4: Errors are logged without crashing ───────────────────────────────

  it("R4a: cache errors are logged and do not throw", async () => {
    const redis = makeRedis(false);

    await expect(cachedRead(redis, "any-key", logger)).resolves.toBeDefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("R4b: rate-limiter errors are logged and do not throw", async () => {
    const redis = makeRedis(false);

    await expect(
      rateLimitCheck(redis, "any-key", 10, logger)
    ).resolves.toBeDefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("R4c: multiple consecutive Redis errors are each logged individually", async () => {
    const redis = makeRedis(false);

    await cachedRead(redis, "k1", logger);
    await cachedRead(redis, "k2", logger);
    await rateLimitCheck(redis, "k3", 5, logger);

    expect(logger.error).toHaveBeenCalledTimes(3);
  });
});
