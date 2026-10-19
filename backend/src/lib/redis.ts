import Redis from "ioredis";

/**
 * Shared Redis client helper.
 *
 * Extracted from `middleware/rateLimiter.ts` so other modules (e.g. the
 * leaderboard sorted-set cache) can reuse the exact same client-creation
 * and lazy-singleton conventions instead of re-inventing connection
 * handling. The rate limiter re-exports `createRedisClient` from here for
 * backwards compatibility.
 */

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
    console.error("[Redis] connection error:", err.message);
  });
  return client;
}

/** Lazily-initialised shared Redis client (one per process). */
let _redis: Redis | null = null;

/**
 * Returns the shared, lazily-initialised Redis client instance.
 *
 * Callers should always handle connection failures (e.g. via try/catch
 * around the command itself) — this helper does not guarantee the client
 * is connected, only that a single instance is reused across modules.
 */
export function getRedis(): Redis {
  if (!_redis) _redis = createRedisClient();
  return _redis;
}

/** Gracefully closes the shared Redis client, if one was created. */
export async function closeRedis(): Promise<void> {
  const client = _redis;
  _redis = null;
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

/**
 * Test-only helper to reset the shared client singleton so tests can swap
 * in a mock or re-create the client with different env vars.
 */
export function __resetRedisForTests(): void {
  _redis = null;
}
