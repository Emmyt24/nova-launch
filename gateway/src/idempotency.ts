/**
 * Idempotency-Key propagation middleware for the API Gateway.
 *
 * Every mutating request (POST/PUT/PATCH/DELETE) that reaches the backend is
 * expected to carry an `Idempotency-Key` header so the backend idempotency
 * store (backend/src/middleware/idempotency.ts) can deduplicate retries. That
 * store keys *strictly* on the header value: two requests are treated as the
 * same logical operation only if they present the exact same key string.
 *
 * Clients SHOULD supply their own `Idempotency-Key`. When they do, it is
 * forwarded untouched. When they do not, this middleware synthesises one as a
 * best-effort fallback.
 *
 * Derivation of the fallback key
 * ------------------------------
 * The fallback key is a deterministic hash of stable request attributes:
 *
 *   sha256( METHOD "\n" PATH "\n" CALLER_IDENTITY "\n" NORMALIZED_BODY )
 *
 * rendered in UUID string shape so downstream consumers that expect a
 * UUID-formatted key keep working.
 *
 *   - METHOD           uppercased HTTP method
 *   - PATH             req.path (no query string)
 *   - CALLER_IDENTITY  req.user.userId → req.user.walletAddress → the raw
 *                      Authorization header → req.ip → "" (first non-empty).
 *                      This middleware runs before per-route auth, so the
 *                      Authorization header is normally what identifies the
 *                      caller; req.user is used when an upstream layer has
 *                      already populated it.
 *   - NORMALIZED_BODY  req.body serialised with recursively sorted object keys
 *                      so logically-equal bodies hash the same regardless of
 *                      property order. Empty/absent/unparsed bodies contribute
 *                      an empty string.
 *
 * Because the derivation contains no per-request randomness, a genuine retry of
 * the same logical operation — same method, path, caller and body, with no
 * client-supplied key on either attempt — produces the *same* synthesised key,
 * so the backend recognises it as a duplicate. Two structurally different
 * requests still produce different keys.
 *
 * This is a fallback, NOT a substitute for clients sending their own key.
 * Clients whose retries legitimately change the body, or that send non-JSON
 * payloads, must supply an explicit `Idempotency-Key` header to get reliable
 * deduplication.
 */

import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Recursively sort object keys so that logically-identical values serialise to
 * an identical string regardless of the order their properties were sent in.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(source[key]);
        return acc;
      }, {});
  }
  return value;
}

/** Serialise a request body to a stable string for hashing. */
function normalizeBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(canonicalize(body));
  } catch {
    // Circular / non-serialisable body — contribute nothing rather than throw.
    return "";
  }
}

/** First stable identifier we have for the calling principal. */
function callerIdentity(req: Request): string {
  const user = (
    req as Request & {
      user?: { userId?: string; walletAddress?: string };
    }
  ).user;
  const authHeader = req.headers.authorization;
  return (
    user?.userId ||
    user?.walletAddress ||
    (typeof authHeader === "string" ? authHeader : "") ||
    req.ip ||
    ""
  );
}

/** Format the first 16 bytes of a hex digest as a UUID-shaped string. */
function toUuidShape(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Derive a deterministic Idempotency-Key from stable request attributes so that
 * genuine retries of the same logical operation synthesise the same key. See
 * the module comment for the full derivation.
 */
export function deriveIdempotencyKey(req: Request): string {
  const canonicalRequest = [
    req.method.toUpperCase(),
    req.path,
    callerIdentity(req),
    normalizeBody((req as Request & { body?: unknown }).body),
  ].join("\n");

  const digest = crypto
    .createHash("sha256")
    .update(canonicalRequest)
    .digest("hex");

  return toUuidShape(digest);
}

export function createIdempotencyMiddleware() {
  return function idempotencyMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction
  ): void {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }

    const existingKey = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];

    if (existingKey) {
      next();
      return;
    }

    req.headers[IDEMPOTENCY_HEADER.toLowerCase()] = deriveIdempotencyKey(req);

    next();
  };
}
