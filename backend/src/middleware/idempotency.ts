import { Request, Response, NextFunction } from "express";
import type Redis from "ioredis";
import { BadRequestError } from "../lib/errors";

export const IDEMPOTENCY_HEADER = "idempotency-key";

/** Default window in which the same key returns the cached result. */
export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 h

/** Maximum length accepted for an idempotency key. */
const MAX_KEY_LENGTH = 255;

interface StoredResult {
  statusCode: number;
  body: unknown;
  createdAt: number;
}

/**
 * Common interface implemented by both in-memory and Redis-backed stores.
 */
export interface IIdempotencyStore {
  get(key: string): StoredResult | undefined | Promise<StoredResult | undefined>;
  complete(key: string, statusCode: number, body: unknown): void | Promise<void>;
  isInFlight(key: string): boolean | Promise<boolean>;
  markInFlight(key: string): boolean | Promise<boolean>;
  clearInFlight(key: string): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  purgeExpired(): void | Promise<void>;
  readonly size: number | Promise<number>;
}

/**
 * In-process idempotency store (suitable for single-process deployments).
 * Swap out for a Redis-backed store in multi-replica environments.
 */
export class IdempotencyStore implements IIdempotencyStore {
  private readonly store = new Map<string, StoredResult>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly windowMs: number = DEFAULT_IDEMPOTENCY_WINDOW_MS) {}

  get(key: string): StoredResult | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.windowMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  /** @deprecated Use complete() instead. Kept for backwards compatibility. */
  set(key: string, statusCode: number, body: unknown): void {
    this.store.set(key, { statusCode, body, createdAt: Date.now() });
    this.inFlight.delete(key);
  }

  complete(key: string, statusCode: number, body: unknown): void {
    this.store.set(key, { statusCode, body, createdAt: Date.now() });
    this.inFlight.delete(key);
  }

  isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  markInFlight(key: string): boolean {
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return true;
  }

  clearInFlight(key: string): void {
    this.inFlight.delete(key);
  }

  delete(key: string): void {
    this.store.delete(key);
    this.inFlight.delete(key);
  }

  /** Remove all expired entries (call periodically to prevent unbounded growth). */
  purgeExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (now - v.createdAt > this.windowMs) {
        this.store.delete(k);
      }
    }
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Redis-backed idempotency store for multi-replica deployments.
 * Uses SETNX for atomic in-flight lock acquisition.
 */
export class RedisIdempotencyStore implements IIdempotencyStore {
  private readonly IN_FLIGHT_PREFIX = "idm:inflight:";
  private readonly RESULT_PREFIX = "idm:result:";
  private readonly ttlSeconds: number;

  constructor(
    private readonly redis: Redis,
    private readonly windowMs: number = DEFAULT_IDEMPOTENCY_WINDOW_MS,
  ) {
    this.ttlSeconds = Math.ceil(windowMs / 1000);
  }

  async get(key: string): Promise<StoredResult | undefined> {
    const raw = await this.redis.get(this.RESULT_PREFIX + key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredResult;
    } catch {
      return undefined;
    }
  }

  async complete(key: string, statusCode: number, body: unknown): Promise<void> {
    const value = JSON.stringify({ statusCode, body, createdAt: Date.now() });
    await this.redis.set(this.RESULT_PREFIX + key, value, "EX", this.ttlSeconds);
    await this.redis.del(this.IN_FLIGHT_PREFIX + key);
  }

  async isInFlight(key: string): Promise<boolean> {
    const val = await this.redis.exists(this.IN_FLIGHT_PREFIX + key);
    return val === 1;
  }

  /**
   * Atomically acquires an in-flight lock using SETNX.
   * Returns true if the lock was acquired (key was not already in-flight).
   */
  async markInFlight(key: string): Promise<boolean> {
    // SETNX: set if not exists; EX for safety expiry (same as result window)
    const result = await this.redis.set(
      this.IN_FLIGHT_PREFIX + key,
      "1",
      "EX",
      this.ttlSeconds,
      "NX",
    );
    // SET with NX returns "OK" on success, null if key already existed
    return result === "OK";
  }

  async clearInFlight(key: string): Promise<void> {
    await this.redis.del(this.IN_FLIGHT_PREFIX + key);
  }

  async delete(key: string): Promise<void> {
    await Promise.all([
      this.redis.del(this.RESULT_PREFIX + key),
      this.redis.del(this.IN_FLIGHT_PREFIX + key),
    ]);
  }

  async purgeExpired(): Promise<void> {
    // Redis TTL handles expiry automatically; nothing to do here.
  }

  get size(): number {
    // Size is not cheaply available from Redis; return 0 as sentinel.
    return 0;
  }
}

/** Singleton store used by the default middleware. */
export const idempotencyStore = new IdempotencyStore();

// Purge expired keys every hour.
setInterval(() => idempotencyStore.purgeExpired(), 60 * 60 * 1000).unref();

/**
 * Express middleware that deduplicates POST requests using an Idempotency-Key header.
 *
 * Contract:
 *  - Clients include `Idempotency-Key: <uuid>` on creation requests.
 *  - If the key has a COMPLETED result within `windowMs`, the original response is
 *    returned immediately with status 200 and `Idempotency-Status: replayed`.
 *  - If the key is IN-FLIGHT (original request still processing), returns 409 with
 *    `{ status: 'PROCESSING', requestId: '<key>' }` and `Idempotency-Status: processing`.
 *  - If the key is absent, the request is passed through unmodified.
 *  - Keys longer than MAX_KEY_LENGTH or containing non-printable characters are rejected 400.
 *
 * @param store   IIdempotencyStore instance (defaults to the module-level singleton)
 */
export function createIdempotencyMiddleware(
  store: IIdempotencyStore = idempotencyStore,
) {
  return function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const rawKey = req.headers[IDEMPOTENCY_HEADER];

    // No key → pass through
    if (!rawKey) {
      return next();
    }

    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // Validate key
    if (key.length > MAX_KEY_LENGTH || !/^[\x20-\x7E]+$/.test(key)) {
      const err = new BadRequestError(
        `Idempotency-Key must be 1-${MAX_KEY_LENGTH} printable ASCII characters`,
      );
      res.status(err.httpStatus).json(err.toHttpResponse());
      return;
    }

    // Async handler to support both sync and async stores
    const handle = async (): Promise<void> => {
      // Check for completed result first
      const stored = await store.get(key);
      if (stored) {
        res.setHeader(IDEMPOTENCY_HEADER, key);
        res.setHeader("Idempotency-Status", "replayed");
        res.status(stored.statusCode).json(stored.body);
        return;
      }

      // Atomically mark as in-flight; returns true if lock acquired, false if already in-flight
      const acquired = await store.markInFlight(key);
      if (!acquired) {
        res.setHeader(IDEMPOTENCY_HEADER, key);
        res.setHeader("Idempotency-Status", "processing");
        res.status(409).json({ status: "PROCESSING", requestId: key });
        return;
      }

      // Intercept res.json to capture the response for future replays
      const originalJson = res.json.bind(res) as (body: unknown) => Response;
      res.json = (body: unknown): Response => {
        // Only cache successful (2xx) responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          void store.complete(key, res.statusCode, body);
        } else {
          void store.clearInFlight(key);
        }
        return originalJson(body);
      };

      next();
    };

    handle().catch(next);
  };
}

/** Pre-built middleware instance using the default store and window. */
export const idempotencyMiddleware = createIdempotencyMiddleware();
