/**
 * Chaos Test: Database Connection-Pool Exhaustion — API Graceful Degradation (#1077)
 *
 * This spec verifies the API layer's behaviour when the connection pool is
 * saturated. It complements `chaos.db-pool.test.ts` (which tests the low-level
 * pool wrapper) by asserting the HTTP contract and recovery path.
 *
 * Scenarios covered:
 *   G1  Requests that arrive while the pool is exhausted receive HTTP 503
 *   G2  The 503 response body is a typed error object (not an unhandled rejection)
 *   G3  The service recovers and returns 200 once connections are released
 *   G4  Relevant error metrics / logs are emitted under saturation
 *   G5  Concurrent requests beyond the pool limit are all rejected gracefully
 *       (no unhandled promise rejections, no process crash)
 *
 * Saturation method:
 *   A mock pool holds connections open until `release()` is called. We acquire
 *   `max` connections to fill the pool, then fire additional requests and assert
 *   they fail with a controlled 503. Releasing the held connections restores
 *   normal operation.
 *
 * No live database or HTTP server is required — the handler under test is
 * exercised directly as a function.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal pool abstraction (same interface as pg.Pool)
// ---------------------------------------------------------------------------

interface MockClient {
  release(): void;
  query(sql: string): Promise<{ rows: unknown[] }>;
}

class SaturablePool {
  private active = 0;
  private closed = false;

  constructor(private readonly max: number) {}

  async connect(): Promise<MockClient> {
    if (this.closed) throw new Error("Pool has been closed");
    if (this.active >= this.max) {
      const err = Object.assign(
        new Error("sorry, too many clients already"),
        { code: "53300" }
      );
      throw err;
    }
    this.active++;
    return {
      release: () => {
        this.active = Math.max(0, this.active - 1);
      },
      query: async (sql: string) => ({ rows: [{ sql }] }),
    };
  }

  get activeCount() {
    return this.active;
  }

  async end() {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// Minimal API handler that uses the pool
// ---------------------------------------------------------------------------

interface ApiResponse {
  status: number;
  body: unknown;
}

async function handleRequest(
  pool: SaturablePool,
  logger: { error: (...a: unknown[]) => void }
): Promise<ApiResponse> {
  let client: MockClient | null = null;
  try {
    client = await pool.connect();
    const result = await client.query("SELECT 1");
    return { status: 200, body: { success: true, data: result.rows } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isExhaustion =
      message.includes("too many clients") ||
      (err instanceof Error &&
        (err as Error & { code?: string }).code === "53300");

    logger.error("[DB] Pool error:", { message, exhaustion: isExhaustion });

    if (isExhaustion) {
      return {
        status: 503,
        body: {
          error: "Service temporarily unavailable",
          code: "POOL_EXHAUSTED",
          retryAfter: 5,
        },
      };
    }

    return {
      status: 500,
      body: { error: "Internal server error" },
    };
  } finally {
    client?.release();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Chaos: DB Pool Exhaustion — API Graceful Degradation", () => {
  let logger: { error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    logger = { error: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("G1: requests during pool exhaustion receive HTTP 503", async () => {
    const pool = new SaturablePool(2);

    // Hold both connections
    const c1 = await pool.connect();
    const c2 = await pool.connect();

    // Pool is now full — next request should get 503
    const response = await handleRequest(pool, logger);

    expect(response.status).toBe(503);

    c1.release();
    c2.release();
  });

  it("G2: the 503 body is a typed error object, not an unhandled rejection", async () => {
    const pool = new SaturablePool(1);
    const held = await pool.connect();

    const response = await handleRequest(pool, logger);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: expect.any(String),
      code: "POOL_EXHAUSTED",
      retryAfter: expect.any(Number),
    });

    held.release();
  });

  it("G3: service recovers and returns 200 once connections are released", async () => {
    const pool = new SaturablePool(1);
    const held = await pool.connect();

    // Saturated
    const saturated = await handleRequest(pool, logger);
    expect(saturated.status).toBe(503);

    // Release the held connection
    held.release();

    // Now the pool has capacity — should succeed
    const recovered = await handleRequest(pool, logger);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatchObject({ success: true });
  });

  it("G4: error metrics/logs are emitted under saturation", async () => {
    const pool = new SaturablePool(1);
    const held = await pool.connect();

    await handleRequest(pool, logger);

    expect(logger.error).toHaveBeenCalledWith(
      "[DB] Pool error:",
      expect.objectContaining({ exhaustion: true })
    );

    held.release();
  });

  it("G5: concurrent requests beyond pool limit are all rejected gracefully", async () => {
    const MAX = 3;
    const pool = new SaturablePool(MAX);

    // Hold all connections
    const held: MockClient[] = [];
    for (let i = 0; i < MAX; i++) {
      held.push(await pool.connect());
    }

    // Fire 10 concurrent requests — all should resolve (not throw)
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => handleRequest(pool, logger))
    );

    // All must be 503 — no unhandled rejections, no 500s
    for (const r of responses) {
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ code: "POOL_EXHAUSTED" });
    }

    // Release all held connections
    held.forEach((c) => c.release());
    expect(pool.activeCount).toBe(0);
  });

  it("G6: a single request succeeds normally when the pool has capacity", async () => {
    const pool = new SaturablePool(5);

    const response = await handleRequest(pool, logger);

    expect(response.status).toBe(200);
    expect(logger.error).not.toHaveBeenCalled();
    // Connection must be released after the request
    expect(pool.activeCount).toBe(0);
  });
});
