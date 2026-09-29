/**
 * Database connection pooling layer for Nova Launch backend.
 *
 * Wraps the Prisma singleton with:
 *  - Explicit pool configuration surfaced via environment variables
 *  - A lightweight health-check that runs a `SELECT 1` probe
 *  - Pool stats snapshot for the /health/ready endpoint
 *  - Graceful shutdown helper
 *
 * All Prisma-level CRUD helpers are re-exported unchanged so existing
 * callers don't need to be updated.
 *
 * Pool tuning env vars (all optional, sensible defaults provided):
 *   DATABASE_URL              – full connection string (required in production)
 *   DB_POOL_MAX              – max connections in the pool          (default 10)
 *   DB_POOL_MIN              – min idle connections                 (default 2)
 *   DB_CONNECT_TIMEOUT_MS    – connection acquisition timeout ms    (default 5000)
 *   DB_IDLE_TIMEOUT_MS       – idle connection eviction timeout ms  (default 30000)
 *
 * DB_POOL_MAX and DB_CONNECT_TIMEOUT_MS genuinely configure the real Prisma
 * pool: lib/prisma.ts appends them to DATABASE_URL as `connection_limit` and
 * `pool_timeout` (seconds) before constructing the PrismaClient. Any of those
 * parameters already present on DATABASE_URL take precedence. When unset,
 * Prisma's own defaults apply (the defaults above are only what
 * getPoolConfig() reports). DB_POOL_MIN and DB_IDLE_TIMEOUT_MS have no Prisma
 * connection-string equivalent and are informational only.
 *
 * Security notes (OWASP DB hardening):
 *  - Connection string is read from env only; never hard-coded.
 *  - Query parameters are always passed as bound values (Prisma handles this).
 *  - Pool size is capped to prevent resource exhaustion.
 *  - Health-check uses a read-only probe (`SELECT 1`) with a short timeout.
 */

import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Pool configuration
// ---------------------------------------------------------------------------

export interface PoolConfig {
  /** Maximum number of connections in the pool. */
  max: number;
  /** Minimum number of idle connections kept alive. */
  min: number;
  /** Milliseconds to wait for a connection before throwing. */
  connectTimeoutMs: number;
  /** Milliseconds before an idle connection is evicted. */
  idleTimeoutMs: number;
}

/** Resolved pool configuration (reads from env, falls back to safe defaults). */
export function getPoolConfig(): PoolConfig {
  return {
    max: parseInt(process.env.DB_POOL_MAX ?? "10", 10),
    min: parseInt(process.env.DB_POOL_MIN ?? "2", 10),
    connectTimeoutMs: parseInt(process.env.DB_CONNECT_TIMEOUT_MS ?? "5000", 10),
    idleTimeoutMs: parseInt(process.env.DB_IDLE_TIMEOUT_MS ?? "30000", 10),
  };
}

// ---------------------------------------------------------------------------
// Pool stats
// ---------------------------------------------------------------------------

export interface PoolStats {
  /** Resolved pool configuration in use. */
  config: PoolConfig;
  /** ISO timestamp of the last successful health-check probe. */
  lastHealthCheck: string | null;
  /** Whether the last health-check succeeded. */
  healthy: boolean;
}

let _lastHealthCheck: string | null = null;
let _healthy = false;

/** Returns a snapshot of current pool stats. */
export function getPoolStats(): PoolStats {
  return {
    config: getPoolConfig(),
    lastHealthCheck: _lastHealthCheck,
    healthy: _healthy,
  };
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export interface HealthCheckResult {
  healthy: boolean;
  /** Round-trip latency in milliseconds. */
  latencyMs: number;
  error?: string;
}

/**
 * Runs a lightweight `SELECT 1` probe against the database.
 *
 * This is the single source of truth for the Prisma `SELECT 1` health probe.
 * The probe in `lib/health/health.service.ts` delegates here so the two
 * implementations cannot drift (timeout defaults, error message formats).
 *
 * Updates the internal pool stats on every call so that
 * `getPoolStats()` always reflects the latest state.
 *
 * @param timeoutMs  Maximum ms to wait for the probe (default: 5 000).
 */
export async function checkDatabaseHealth(
  timeoutMs = 5_000
): Promise<HealthCheckResult> {
  const start = Date.now();

  try {
    // Race the probe against a timeout so a hung DB doesn't block the caller.
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Health check timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);

    const latencyMs = Date.now() - start;
    _lastHealthCheck = new Date().toISOString();
    _healthy = true;

    return { healthy: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    _lastHealthCheck = new Date().toISOString();
    _healthy = false;

    return {
      healthy: false,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Disconnects the Prisma client cleanly.
 * Call this in your process `SIGTERM` / `SIGINT` handler.
 */
export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}

// ---------------------------------------------------------------------------
// Token utilities
// ---------------------------------------------------------------------------

export async function createToken(data: {
  address: string;
  creator: string;
  name: string;
  symbol: string;
  decimals?: number;
  totalSupply: bigint;
  initialSupply: bigint;
  metadataUri?: string;
}) {
  return prisma.token.create({ data });
}

export async function getTokenByAddress(address: string) {
  return prisma.token.findUnique({ where: { address } });
}

export async function updateTokenBurnStats(tokenId: string, amount: bigint) {
  return prisma.token.update({
    where: { id: tokenId },
    data: {
      totalBurned: { increment: amount },
      burnCount: { increment: 1 },
    },
  });
}

// ---------------------------------------------------------------------------
// BurnRecord utilities
// ---------------------------------------------------------------------------

export async function createBurnRecord(data: {
  tokenId: string;
  from: string;
  amount: bigint;
  burnedBy: string;
  isAdminBurn?: boolean;
  txHash: string;
}) {
  return prisma.burnRecord.create({ data });
}

export async function getBurnHistory(
  tokenId: string,
  options: { skip?: number; take?: number } = {}
) {
  return prisma.burnRecord.findMany({
    where: { tokenId },
    orderBy: { timestamp: "desc" },
    skip: options.skip ?? 0,
    take: options.take ?? 20,
  });
}

// ---------------------------------------------------------------------------
// User utilities
// ---------------------------------------------------------------------------

export async function upsertUser(address: string) {
  return prisma.user.upsert({
    where: { address },
    update: { lastActive: new Date() },
    create: { address },
  });
}

// ---------------------------------------------------------------------------
// Analytics utilities
// ---------------------------------------------------------------------------

export async function upsertDailyAnalytics(
  tokenId: string,
  date: Date,
  burnAmount: bigint,
  uniqueBurners: number
) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);

  return prisma.analytics.upsert({
    where: { tokenId_date: { tokenId, date: dayStart } },
    update: {
      burnVolume: { increment: burnAmount },
      burnCount: { increment: 1 },
      uniqueBurners,
    },
    create: {
      tokenId,
      date: dayStart,
      burnVolume: burnAmount,
      burnCount: 1,
      uniqueBurners,
    },
  });
}

// ---------------------------------------------------------------------------
// Legacy connection test (kept for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `checkDatabaseHealth` instead. Kept as a thin wrapper so
 * existing call sites keep working while there is a single probe implementation.
 */
export async function testConnection(): Promise<boolean> {
  const result = await checkDatabaseHealth();
  return result.healthy;
}
