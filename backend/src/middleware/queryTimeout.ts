import { Request, Response, NextFunction } from "express";
import { AppError, ErrorCode } from "../lib/errors";

export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

// Symbol used to stash the per-request timeout on res.locals
const QUERY_TIMEOUT_KEY = "queryTimeoutMs";

export class QueryTimeoutError extends AppError {
  constructor(timeoutMs: number, operation?: string) {
    super({
      code: ErrorCode.DATABASE_ERROR,
      message: operation
        ? `Database query timed out after ${timeoutMs}ms (${operation})`
        : `Database query timed out after ${timeoutMs}ms`,
      details: { timeoutMs, operation },
    });
    this.name = "QueryTimeoutError";
  }
}

/**
 * Attach a query timeout (ms) to res.locals so downstream handlers can read it.
 * Use createQueryTimeoutMiddleware() for the global default and
 * withQueryTimeout() for per-route overrides.
 */
export function createQueryTimeoutMiddleware(timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS) {
  return function queryTimeoutMiddleware(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    res.locals[QUERY_TIMEOUT_KEY] = timeoutMs;
    next();
  };
}

/**
 * Per-route override — shorter alias intended for use inline in route definitions:
 *
 *   router.get("/heavy", withQueryTimeout(120_000), handler)
 */
export function withQueryTimeout(timeoutMs: number) {
  return createQueryTimeoutMiddleware(timeoutMs);
}

/**
 * Read the effective query timeout for the current request.
 * Falls back to DEFAULT_QUERY_TIMEOUT_MS when the middleware was not mounted.
 */
export function getQueryTimeoutMs(res: Response): number {
  const stored = res.locals[QUERY_TIMEOUT_KEY];
  return typeof stored === "number" && stored > 0 ? stored : DEFAULT_QUERY_TIMEOUT_MS;
}

/**
 * Race an async DB operation against a timeout.
 * Throws QueryTimeoutError if the operation does not settle in time.
 *
 * @param operation  async function that runs the DB query
 * @param timeoutMs  milliseconds before the timeout fires
 * @param label      optional label included in the error message
 */
export async function withQueryTimeoutRace<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label?: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new QueryTimeoutError(timeoutMs, label));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([operation(), timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
