/**
 * Raw PostgreSQL access layer — `backend/src/database/db.ts`
 *
 * This module wraps a raw `pg.Pool` and exposes three helpers:
 *   - `query(text, params)` — execute a parameterized SQL query
 *   - `getClient()` — acquire a `PoolClient` for multi-statement transactions
 *   - `closePool()` — drain and close the pool (used in tests / graceful shutdown)
 *
 * ## Why two database layers exist
 *
 * The backend has **two independent database access layers** that coexist by
 * design, each serving a different purpose:
 *
 * | Layer | File | Technology | When to use |
 * |-------|------|------------|-------------|
 * | Raw pg | `backend/src/database/db.ts` ← you are here | `pg.Pool` | Direct SQL, bulk operations, raw-transaction control |
 * | Prisma ORM | `backend/src/lib/db.ts` | Prisma singleton | All new feature code; type-safe CRUD helpers |
 *
 * ### Default for new code: use `backend/src/lib/db.ts` (Prisma)
 *
 * `backend/src/lib/db.ts` is the **default layer for new code**. It wraps the
 * Prisma singleton (`lib/prisma.ts`) and re-exports typed CRUD helpers such as
 * `createToken`, `createBurnRecord`, `upsertUser`, and `upsertDailyAnalytics`.
 * Prisma handles parameterization, type safety, and connection pooling
 * automatically. Prefer it for all application-level reads and writes.
 *
 * ### Deliberate exceptions: subsystems that use this raw-pg layer
 *
 * A handful of subsystems intentionally bypass Prisma and use this raw-pg pool
 * because they need capabilities that Prisma's query engine does not expose:
 *
 * - **`webhookDeadLetterService.ts`** — uses `query()` for bulk dead-letter
 *   inserts and transactional batch processing where explicit `BEGIN`/`COMMIT`
 *   via `getClient()` gives finer control over error isolation per batch row.
 *
 * - **`database/schema.sql`** — DDL-level schema bootstrap that runs outside
 *   Prisma migrations (legacy tables pre-dating the Prisma migration history).
 *
 * If you are adding a new subsystem that requires raw SQL (e.g. `COPY`,
 * advisory locks, `LISTEN`/`NOTIFY`, or full-text-search-specific syntax),
 * use this layer. Otherwise, default to `backend/src/lib/db.ts`.
 *
 * ## Cross-reference
 * See `backend/src/lib/db.ts` for the Prisma-based layer, pool stats, and the
 * `checkDatabaseHealth()` health-check surface used by `/health/ready`.
 */

import { Pool, PoolClient } from "pg";
import dotenv from "dotenv";

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number.parseInt(process.env.DB_PORT || "5432", 10),
  database: process.env.DB_NAME || "nova_launch",
  user: process.env.DB_USER || "user",
  password: process.env.DB_PASSWORD || "password",
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on("error", (err: unknown) => {
  console.error("Unexpected database error:", toSafeErrorSummary(err));
});

function isPoolExhaustionError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? ((error as { code: string }).code as string)
      : "";

  return (
    code === "53300" ||
    message.includes("too many clients already") ||
    message.includes("remaining connection slots are reserved") ||
    message.includes("connection pool exhausted") ||
    message.includes("timeout exceeded when trying to connect") ||
    message.includes("sorry, too many clients already")
  );
}

function toSafeErrorSummary(error: unknown): {
  message: string;
  code?: string;
} {
  if (error instanceof Error) {
    const summary: { message: string; code?: string } = {
      message: error.message,
    };

    const maybeCode = (error as Error & { code?: unknown }).code;
    if (typeof maybeCode === "string" && maybeCode.length > 0) {
      summary.code = maybeCode;
    }

    return summary;
  }

  return {
    message: String(error),
  };
}

function normalizeDatabaseError(
  error: unknown,
  operation: "query" | "getClient"
): Error {
  if (isPoolExhaustionError(error)) {
    return new Error(`Database connection pool exhausted during ${operation}`);
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(`Database ${operation} failed`);
}

export const query = async (text: string, params?: any[]) => {
  const start = Date.now();

  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log("Executed database query", {
      duration,
      rows: res.rowCount,
    });
    return res;
  } catch (error) {
    const safeError = normalizeDatabaseError(error, "query");
    console.error("Database query error:", toSafeErrorSummary(safeError));
    throw safeError;
  }
};

export const getClient = async (): Promise<PoolClient> => {
  try {
    return await pool.connect();
  } catch (error) {
    const safeError = normalizeDatabaseError(error, "getClient");
    console.error(
      "Database client acquisition failed:",
      toSafeErrorSummary(safeError)
    );
    throw safeError;
  }
};

export const closePool = async () => {
  await pool.end();
};

export default { query, getClient, closePool };
