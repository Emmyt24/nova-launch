/**
 * Unified Search API
 *
 * Provides full-text search across tokens and proposals in a single request.
 * Each entity type is queried in parallel and results are returned under
 * separate keys so clients can render them independently.
 *
 * Security:
 * - All inputs are validated with Zod before reaching the database.
 * - `limit` is capped at 20 per entity type to prevent DoS via large result sets.
 * - No raw SQL; all queries go through Prisma's typed API.
 *
 * Performance:
 * - Both entity queries run in parallel via Promise.all.
 * - Results are cached in-memory for CACHE_TTL ms (keyed by query string).
 * - Slow queries (>200 ms) are logged as warnings.
 *
 * GET /api/search?q=<term>&types=tokens,proposals&limit=10
 */

import { Router, Request, Response } from "express";
import { performance } from "perf_hooks";
import { prisma } from "../lib/prisma";
import { z } from "zod";

const router = Router();

// ─── Validation ───────────────────────────────────────────────────────────────

const ENTITY_TYPES = ["tokens", "proposals"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const searchSchema = z.object({
  /** Full-text search term (required, 1–100 chars). */
  q: z.string().min(1).max(100),
  /**
   * Comma-separated list of entity types to search.
   * Defaults to all types when omitted.
   */
  types: z
    .string()
    .optional()
    .transform((val) => {
      if (!val) return [...ENTITY_TYPES] as EntityType[];
      return val
        .split(",")
        .map((t) => t.trim())
        .filter((t): t is EntityType =>
          (ENTITY_TYPES as readonly string[]).includes(t)
        );
    }),
  /** Max results per entity type (1–20, default 10). */
  limit: z
    .string()
    .regex(/^\d+$/)
    .default("10")
    .transform((v) => Math.min(Math.max(parseInt(v, 10), 1), 20)),
});

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL = 30_000; // 30 seconds
const MAX_CACHE_SIZE = 200;
const cache = new Map<string, { data: SearchResponse; ts: number }>();

function fromCache(key: string): SearchResponse | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  cache.delete(key);
  return null;
}

function toCache(key: string, data: SearchResponse): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    // Evict the oldest entry.
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    cache.delete(oldest[0]);
  }
  cache.set(key, { data, ts: Date.now() });
}

/** Clears the in-memory cache. Exposed for testing only. */
export function clearSearchCache(): void {
  cache.clear();
}

// ─── Response types ───────────────────────────────────────────────────────────

interface TokenHit {
  type: "token";
  id: string;
  address: string;
  name: string;
  symbol: string;
  creator: string;
  totalSupply: string;
  createdAt: string;
}

interface ProposalHit {
  type: "proposal";
  id: string;
  proposalId: number;
  title: string;
  proposer: string;
  status: string;
  createdAt: string;
}

interface SearchResponse {
  success: true;
  query: string;
  tokens: TokenHit[];
  proposals: ProposalHit[];
  totals: { tokens: number; proposals: number };
  cached?: boolean;
}

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * GET /api/search
 *
 * Query params:
 *   q       - Search term (required)
 *   types   - Comma-separated entity types: tokens,proposals (default: all)
 *   limit   - Max results per type, 1–20 (default: 10)
 */
router.get("/", async (req: Request, res: Response) => {
  // Validate input.
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: "Invalid parameters",
      details: parsed.error.issues,
    });
  }

  const { q, types, limit } = parsed.data;

  // Cache lookup.
  const cacheKey = JSON.stringify({ q, types: [...types].sort(), limit });
  const cached = fromCache(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const start = performance.now();

    // Run all requested entity searches in parallel.
    const [tokenResults, proposalResults] = await Promise.all([
      types.includes("tokens") ? searchTokens(q, limit) : { hits: [], total: 0 },
      types.includes("proposals") ? searchProposals(q, limit) : { hits: [], total: 0 },
    ]);

    const elapsed = performance.now() - start;
    if (elapsed > 200) {
      console.warn(`[PERF] Unified search for "${q}" took ${elapsed.toFixed(1)}ms`);
    }

    const response: SearchResponse = {
      success: true,
      query: q,
      tokens: tokenResults.hits as TokenHit[],
      proposals: proposalResults.hits as ProposalHit[],
      totals: {
        tokens: tokenResults.total,
        proposals: proposalResults.total,
      },
    };

    toCache(cacheKey, response);
    return res.json(response);
  } catch (error) {
    console.error("[search] error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ─── Entity search helpers ────────────────────────────────────────────────────

async function searchTokens(q: string, limit: number) {
  const where = {
    OR: [
      { name: { contains: q, mode: "insensitive" as const } },
      { symbol: { contains: q, mode: "insensitive" as const } },
      { address: { contains: q, mode: "insensitive" as const } },
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.token.findMany({
      where,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        address: true,
        name: true,
        symbol: true,
        creator: true,
        totalSupply: true,
        createdAt: true,
      },
    }),
    prisma.token.count({ where }),
  ]);

  const hits: TokenHit[] = rows.map((r) => ({
    type: "token",
    id: r.id,
    address: r.address,
    name: r.name,
    symbol: r.symbol,
    creator: r.creator,
    totalSupply: r.totalSupply.toString(),
    createdAt: r.createdAt.toISOString(),
  }));

  return { hits, total };
}

async function searchProposals(q: string, limit: number) {
  const where = {
    OR: [
      { title: { contains: q, mode: "insensitive" as const } },
      { description: { contains: q, mode: "insensitive" as const } },
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.proposal.findMany({
      where,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        proposalId: true,
        title: true,
        proposer: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.proposal.count({ where }),
  ]);

  const hits: ProposalHit[] = rows.map((r) => ({
    type: "proposal",
    id: r.id,
    proposalId: r.proposalId,
    title: r.title,
    proposer: r.proposer,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  }));

  return { hits, total };
}

export default router;
