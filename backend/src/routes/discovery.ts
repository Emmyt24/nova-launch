/**
 * GET /api/discover/tokens
 *
 * Public token discovery endpoint.  No tenant context required.
 * Tokens marked isPublic=false are always excluded.
 *
 * Supports:
 *   - Full-text search via PostgreSQL tsvector (name + symbol)
 *   - Category, network, hasMetadata filters
 *   - Pagination (limit / offset)
 *   - Sort by deployedAt | burnCount | totalSupply | trending
 *     trending score = burnCount × 0.4 + holderProxy × 0.6
 *     (holderProxy = ln(1 + totalSupply) normalised over 30-day window,
 *      a cheap on-DB approximation until a real holder-count column lands)
 *
 * Results are cached in-process for 5 minutes.
 *
 * Aggregation consistency & timeout budget (#1617):
 *   Each sort mode fans out into two or three DB reads (page query + count,
 *   or an id lookup + page query + count for full-text search). Those reads
 *   run inside a single REPEATABLE READ transaction so every fan-out call
 *   sees the same snapshot of the Token table — a write landing between the
 *   page query and the count query can no longer produce a total that
 *   disagrees with the page it's counting. The snapshot instant is returned
 *   as `asOf` on the response.
 *   The transaction as a whole is bounded by an aggregation timeout budget
 *   (DISCOVERY_AGGREGATION_TIMEOUT_MS, default 5000ms) so one slow dependency
 *   can't block the response indefinitely. On timeout the route degrades
 *   explicitly — HTTP 503 with code AGGREGATION_TIMEOUT — rather than hanging.
 *
 * PATCH /api/tokens/:address/visibility
 *
 * Owner-only endpoint to toggle isPublic on a token.
 * Authentication: X-Tenant-ID header or Bearer JWT (tenant = creator).
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { tenantMiddleware, type TenantRequest } from "../middleware/tenancy";
import { successResponse, errorResponse } from "../utils/response";
import { createRateLimiter, createRedisClient } from "../middleware/rateLimiter";

const router = Router();

// ---------------------------------------------------------------------------
// In-process cache (5-minute TTL)
// ---------------------------------------------------------------------------
const DISCOVERY_CACHE_TTL = 5 * 60 * 1000;
const discoveryCache = new Map<string, { data: unknown; ts: number }>();

function cacheGet<T>(key: string): T | null {
  const entry = discoveryCache.get(key);
  if (entry && Date.now() - entry.ts < DISCOVERY_CACHE_TTL) return entry.data as T;
  discoveryCache.delete(key);
  return null;
}

function cacheSet(key: string, data: unknown) {
  discoveryCache.set(key, { data, ts: Date.now() });
  if (discoveryCache.size > 200) {
    // Evict the oldest entry to cap memory usage.
    const oldest = [...discoveryCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0][0];
    discoveryCache.delete(oldest);
  }
}

/** Exposed for tests only */
export function clearDiscoveryCache() {
  discoveryCache.clear();
}

// ---------------------------------------------------------------------------
// Aggregation timeout budget
// ---------------------------------------------------------------------------
const DEFAULT_AGGREGATION_TIMEOUT_MS = 5000;

function aggregationTimeoutMs(): number {
  const raw = process.env.DISCOVERY_AGGREGATION_TIMEOUT_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGGREGATION_TIMEOUT_MS;
}

export class AggregationTimeoutError extends Error {
  constructor(ms: number) {
    super(`Discovery aggregation exceeded its ${ms}ms timeout budget`);
    this.name = "AggregationTimeoutError";
  }
}

/**
 * Races `promise` against the aggregation timeout budget. The underlying
 * query isn't cancelled on timeout (Prisma/Postgres don't expose that here),
 * but the caller stops waiting and the client gets an explicit degraded
 * response instead of hanging indefinitely.
 */
function withTimeoutBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AggregationTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Rate limiter — discovery is public so we apply a tighter limit to prevent
// scraping: 60 requests / 15 min per IP.
// ---------------------------------------------------------------------------
let _redis: ReturnType<typeof createRedisClient> | null = null;
function getRedis() {
  if (!_redis) _redis = createRedisClient();
  return _redis;
}

function discoveryRateLimiter(req: Request, res: Response, next: () => void) {
  createRateLimiter(getRedis(), {
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: "Too many discovery requests. Please try again later.",
    keyPrefix: "rl:discovery",
  })(req, res, next);
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const VALID_SORT = ["deployedAt", "burnCount", "totalSupply", "trending"] as const;
const VALID_NETWORK = ["testnet", "mainnet"] as const;
const VALID_CATEGORY = ["DEFI", "COMMUNITY", "CREATOR", "UTILITY", "OTHER"] as const;

const discoveryQuerySchema = z.object({
  q:           z.string().max(100).optional(),
  category:    z.enum(VALID_CATEGORY).optional(),
  network:     z.enum(VALID_NETWORK).optional(),
  hasMetadata: z.enum(["true", "false"]).optional(),
  sortBy:      z.enum(VALID_SORT).default("deployedAt"),
  sortOrder:   z.enum(["asc", "desc"]).default("desc"),
  limit:       z.string().regex(/^\d+$/).default("20"),
  offset:      z.string().regex(/^\d+$/).default("0"),
});

// ---------------------------------------------------------------------------
// Trending sort: raw SQL so we can compute the score inside Postgres.
//
// score = (burnCount * 0.4) + (ln(1 + totalSupply) * 0.6)
// We normalise over tokens deployed in the last 30 days.
// ---------------------------------------------------------------------------
const TRENDING_SQL = `
  SELECT
    t.id, t.address, t.creator, t.name, t.symbol, t.decimals,
    t."totalSupply"::text, t."initialSupply"::text,
    t."totalBurned"::text, t."burnCount",
    t."metadataUri", t."isPublic", t.category, t.network,
    t."createdAt", t."updatedAt",
    (t."burnCount" * 0.4 + ln(1 + t."totalSupply"::float8) * 0.6) AS _score
  FROM "Token" t
  WHERE t."isPublic" = true
    AND ($1::text IS NULL OR to_tsvector('english', t.name || ' ' || t.symbol) @@ plainto_tsquery('english', $1))
    AND ($2::text IS NULL OR t.category = $2::"TokenCategory")
    AND ($3::text IS NULL OR t.network = $3)
    AND ($4::boolean IS NULL OR ($4 = true AND t."metadataUri" IS NOT NULL) OR ($4 = false AND t."metadataUri" IS NULL))
    AND t."createdAt" >= NOW() - INTERVAL '30 days'
  ORDER BY _score DESC
  LIMIT $5 OFFSET $6
`;

const TRENDING_COUNT_SQL = `
  SELECT COUNT(*)::int AS cnt
  FROM "Token" t
  WHERE t."isPublic" = true
    AND ($1::text IS NULL OR to_tsvector('english', t.name || ' ' || t.symbol) @@ plainto_tsquery('english', $1))
    AND ($2::text IS NULL OR t.category = $2::"TokenCategory")
    AND ($3::text IS NULL OR t.network = $3)
    AND ($4::boolean IS NULL OR ($4 = true AND t."metadataUri" IS NOT NULL) OR ($4 = false AND t."metadataUri" IS NULL))
    AND t."createdAt" >= NOW() - INTERVAL '30 days'
`;

// ---------------------------------------------------------------------------
// GET /api/discover/tokens
// ---------------------------------------------------------------------------
router.get("/tokens", discoveryRateLimiter, async (req: Request, res: Response) => {
  const parsed = discoveryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(
      errorResponse({ code: "VALIDATION_ERROR", message: "Invalid query parameters", details: parsed.error.issues })
    );
  }

  const { q, category, network, hasMetadata, sortBy, sortOrder, limit: limitStr, offset: offsetStr } = parsed.data;
  const limit  = Math.min(parseInt(limitStr), 100);
  const offset = parseInt(offsetStr);

  const cacheKey = JSON.stringify({ q, category, network, hasMetadata, sortBy, sortOrder, limit, offset });
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached as object, cached: true });

  // Snapshot instant shared across every fan-out call in this request so the
  // page query, count query (and id lookup, for FTS) are all "consistent
  // as-of" the same moment rather than each observing a different DB state.
  const snapshotAt = new Date();
  const timeoutMs = aggregationTimeoutMs();
  const REPEATABLE_READ = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead };

  try {
    let tokens: unknown[];
    let total: number;

    if (sortBy === "trending") {
      const hasMetadataBool = hasMetadata === "true" ? true : hasMetadata === "false" ? false : null;
      const [rows, countRows] = await withTimeoutBudget(
        prisma.$transaction(
          [
            prisma.$queryRawUnsafe<any[]>(TRENDING_SQL, q ?? null, category ?? null, network ?? null, hasMetadataBool, limit, offset),
            prisma.$queryRawUnsafe<{ cnt: number }[]>(TRENDING_COUNT_SQL, q ?? null, category ?? null, network ?? null, hasMetadataBool),
          ],
          REPEATABLE_READ
        ),
        timeoutMs
      );
      tokens = rows.map(({ _score, ...r }) => r); // strip internal score
      total  = countRows[0]?.cnt ?? 0;
    } else if (q) {
      // Full-text search: look up matching ids, then page + count against
      // that id list. All three reads share one snapshot so a concurrent
      // visibility change or delete can't produce an inconsistent page/total.
      const { fetchedTokens, count, ids } = await withTimeoutBudget(
        prisma.$transaction(async (tx) => {
          const idRows = await tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM "Token"
             WHERE "isPublic" = true
               AND to_tsvector('english', name || ' ' || symbol) @@ plainto_tsquery('english', $1)
               ${category  ? `AND category = '${category}'::"TokenCategory"` : ""}
               ${network   ? `AND network  = '${network}'` : ""}
               ${hasMetadata === "true"  ? `AND "metadataUri" IS NOT NULL` : ""}
               ${hasMetadata === "false" ? `AND "metadataUri" IS NULL` : ""}`,
            q
          );
          const ids = idRows.map((r) => r.id);
          if (ids.length === 0) {
            return { fetchedTokens: [] as any[], count: 0, ids };
          }
          const orderBy = buildOrderBy(sortBy, sortOrder);
          const [fetchedTokens, count] = await Promise.all([
            tx.token.findMany({ where: { id: { in: ids } }, orderBy, take: limit, skip: offset, select: TOKEN_SELECT }),
            tx.token.count({ where: { id: { in: ids } } }),
          ]);
          return { fetchedTokens, count, ids };
        }, REPEATABLE_READ),
        timeoutMs
      );

      if (ids.length === 0) {
        return res.json(successResponse({ tokens: [], total: 0, limit, offset, asOf: snapshotAt.toISOString() }));
      }
      tokens = serializeTokens(fetchedTokens);
      total  = count;
      const response = successResponse({ tokens, total, limit, offset, asOf: snapshotAt.toISOString() });
      cacheSet(cacheKey, response);
      return res.json(response);
    } else {
      // No FTS — pure Prisma filtering
      const where: Record<string, unknown> = { isPublic: true };
      if (category)            where.category    = category;
      if (network)             where.network     = network;
      if (hasMetadata === "true")  where.metadataUri = { not: null };
      if (hasMetadata === "false") where.metadataUri = null;

      const orderBy = buildOrderBy(sortBy, sortOrder);
      const [fetchedTokens, count] = await withTimeoutBudget(
        prisma.$transaction(
          [
            prisma.token.findMany({ where, orderBy, take: limit, skip: offset, select: TOKEN_SELECT }),
            prisma.token.count({ where }),
          ],
          REPEATABLE_READ
        ),
        timeoutMs
      );
      tokens = serializeTokens(fetchedTokens);
      total  = count;
    }

    const response = successResponse({ tokens, total, limit, offset, asOf: snapshotAt.toISOString() });
    cacheSet(cacheKey, response);
    return res.json(response);
  } catch (err) {
    if (err instanceof AggregationTimeoutError) {
      // Documented graceful degradation: we stop waiting on the slow
      // dependency and tell the client explicitly rather than hanging.
      console.error("[discovery] aggregation timeout:", err.message);
      return res.status(503).json(errorResponse({
        code: "AGGREGATION_TIMEOUT",
        message: "Discovery aggregation exceeded its time budget and was degraded rather than left to hang. Please retry.",
      }));
    }
    console.error("[discovery] GET /tokens error:", err);
    return res.status(500).json(errorResponse({ code: "INTERNAL_ERROR", message: "Discovery query failed" }));
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_SELECT = {
  id: true, address: true, creator: true, name: true, symbol: true,
  decimals: true, totalSupply: true, initialSupply: true,
  totalBurned: true, burnCount: true, metadataUri: true,
  isPublic: true, category: true, network: true,
  createdAt: true, updatedAt: true,
} as const;

function buildOrderBy(sortBy: string, sortOrder: "asc" | "desc") {
  switch (sortBy) {
    case "burnCount":    return { burnCount:   sortOrder };
    case "totalSupply":  return { totalSupply: sortOrder };
    default:             return { createdAt:   sortOrder }; // deployedAt
  }
}

function serializeTokens(tokens: any[]) {
  return tokens.map((t) => ({
    ...t,
    totalSupply:   t.totalSupply.toString(),
    initialSupply: t.initialSupply.toString(),
    totalBurned:   t.totalBurned.toString(),
  }));
}

// ---------------------------------------------------------------------------
// PATCH /api/tokens/:address/visibility  (mounted on the tokens router in index.ts)
// Exported so the tokens router can mount it without circular deps.
// ---------------------------------------------------------------------------
export const visibilityRouter = Router();

visibilityRouter.patch(
  "/:address/visibility",
  tenantMiddleware({ required: true }),
  async (req: TenantRequest & Request, res: Response) => {
    const { address } = req.params;
    const tenantId = req.tenant!.id;

    const bodySchema = z.object({ isPublic: z.boolean() });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(
        errorResponse({ code: "VALIDATION_ERROR", message: "isPublic (boolean) is required" })
      );
    }

    try {
      const token = await prisma.token.findUnique({ where: { address }, select: { id: true, creator: true } });
      if (!token) {
        return res.status(404).json(errorResponse({ code: "NOT_FOUND", message: "Token not found" }));
      }
      if (token.creator !== tenantId) {
        return res.status(403).json(errorResponse({ code: "FORBIDDEN", message: "Only the token creator can change visibility" }));
      }

      const updated = await prisma.token.update({
        where: { address },
        data:  { isPublic: parsed.data.isPublic },
        select: { address: true, isPublic: true },
      });

      // Invalidate discovery cache entries that might surface this token
      clearDiscoveryCache();

      return res.json(successResponse(updated));
    } catch (err) {
      console.error("[discovery] PATCH visibility error:", err);
      return res.status(500).json(errorResponse({ code: "INTERNAL_ERROR", message: "Failed to update visibility" }));
    }
  }
);

export default router;
