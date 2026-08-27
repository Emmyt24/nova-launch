import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { eventBus } from "./eventBus";
import {
  SortedSetBoard,
  SortedSetMember as SortedSetMemberInput,
  ensureMember,
  getSortedSetStatus,
  incrementScore,
  readTopFromSortedSet,
  warmSortedSet,
} from "../lib/leaderboardSortedSetCache";

export enum TimePeriod {
  H24 = "24h",
  D7 = "7d",
  D30 = "30d",
  ALL = "all",
}

export interface LeaderboardToken {
  rank: number;
  token: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
    totalBurned: string;
    burnCount: number;
    metadataUri: string | null;
    createdAt: string;
  };
  metric: string;
  change?: number;
}

export interface LeaderboardResponse {
  success: boolean;
  data: LeaderboardToken[];
  period: TimePeriod;
  updatedAt: string;
  pagination: {
    page: number;
    limit: number;
    total: number;
  };
}

interface CacheEntry {
  data: LeaderboardResponse;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
/** Safety-net TTL — entries are also evicted by event-driven invalidation. */
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const MAX_SORTED_SET_SCORE = BigInt(Number.MAX_SAFE_INTEGER);

/** Redis scores are numbers, so cap BigInt amounts instead of converting silently. */
export function toSafeSortedSetScore(value: bigint | string | null | undefined): number {
  const amount = BigInt(value ?? 0);
  if (amount > MAX_SORTED_SET_SCORE) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(amount);
}

function getCacheKey(
  type: string,
  period: TimePeriod,
  page: number,
  limit: number
): string {
  return `${type}:${period}:${page}:${limit}`;
}

function getFromCache(key: string): LeaderboardResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }

  return entry.data;
}

function setCache(key: string, data: LeaderboardResponse): void {
  cache.set(key, { data, timestamp: Date.now() });
}

/**
 * Invalidate all cache entries whose key starts with `type:`.
 * Scoped to the affected leaderboard — does not flush unrelated boards.
 */
function invalidateCacheByType(type: string): void {
  const prefix = `${type}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Event-driven cache invalidation
// ---------------------------------------------------------------------------

/**
 * Real events actually published elsewhere in the codebase:
 *   "token.burned"   — a BurnRecord was inserted, published from
 *                       TokenEventParser.handleBurn (services/tokenEventParser.ts),
 *                       the real on-chain burn ingestion path used by
 *                       stellarEventListener.ts.
 *   "token.deployed" — a Token was created, published from
 *                       batchTokenDeployService.ts.
 *
 * NOTE: this used to subscribe to aspirational "burn.created" /
 * "token.created" events that were never actually published anywhere in
 * the codebase (only referenced in this doc comment) — that wiring was
 * dead code. It has been replaced with the real event names above.
 *
 * For "most-burned" / "most-active" (see leaderboardSortedSetCache.ts for
 * the scoping rationale), the handlers below incrementally update the
 * Redis sorted set via ZINCRBY/ZADD instead of just invalidating the
 * in-memory cache — this is the core of the issue's "sorted set strategy
 * instead of full recomputation" ask. The in-memory Map cache is still
 * invalidated too, since "newest" / "largest-supply" / "most-burners"
 * keep the original full-recompute + TTL-cache approach and a new token
 * or burn can affect those as well.
 */

interface TokenBurnedPayload {
  tokenId: string;
  tokenAddress?: string;
  amount: string;
  isAdminBurn?: boolean;
}

interface TokenDeployedPayload {
  tokenId: string;
  address?: string;
}

/** Time periods that get their own sorted set per board (mirrors TimePeriod). */
const SORTED_SET_PERIODS: TimePeriod[] = [
  TimePeriod.H24,
  TimePeriod.D7,
  TimePeriod.D30,
  TimePeriod.ALL,
];

eventBus.subscribe<TokenBurnedPayload>("token.burned", async (event) => {
  const { tokenId, amount } = event.payload;
  if (!tokenId) return;

  const delta = toSafeSortedSetScore(amount);

  // A burn affects burn-volume, burn-count, and unique-burner leaderboards.
  invalidateCacheByType("most-burned");
  invalidateCacheByType("most-active");
  invalidateCacheByType("most-burners");

  // Incrementally update the Redis sorted sets for the rank-style boards.
  // Best-effort: failures are logged inside incrementScore/ensureMember and
  // simply mean the next read falls back to full recomputation.
  await Promise.all(
    SORTED_SET_PERIODS.flatMap((period) => [
      incrementScore("most-burned", period, tokenId, delta),
      incrementScore("most-active", period, tokenId, 1),
    ])
  );
});

eventBus.subscribe<TokenDeployedPayload>("token.deployed", async (event) => {
  const { tokenId } = event.payload;

  // A new token affects the newest and largest-supply leaderboards.
  invalidateCacheByType("newest");
  invalidateCacheByType("largest-supply");

  if (!tokenId) return;

  // Seed the new token into the sorted sets at score 0 (ZADD NX) so it
  // appears immediately once it starts accumulating burns, without
  // waiting for the next full recompute/warm cycle.
  await Promise.all(
    SORTED_SET_PERIODS.flatMap((period) => [
      ensureMember("most-burned", period, tokenId),
      ensureMember("most-active", period, tokenId),
    ])
  );
});

function getDateFilter(period: TimePeriod): Date | null {
  if (period === TimePeriod.ALL) return null;

  const now = new Date();
  switch (period) {
    case TimePeriod.H24:
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case TimePeriod.D7:
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case TimePeriod.D30:
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    default:
      return null;
  }
}

/** Builds the public `LeaderboardToken[]` shape from tokenIds + their scores, in rank order. */
function buildRankedData(
  orderedTokenIds: string[],
  scoreByTokenId: Map<string, string>,
  tokenMap: Map<string, { id: string; address: string; name: string; symbol: string; decimals: number; totalSupply: bigint; totalBurned: bigint; burnCount: number; metadataUri: string | null; createdAt: Date }>,
  skip: number
): LeaderboardToken[] {
  const data: LeaderboardToken[] = [];
  orderedTokenIds.forEach((tokenId, index) => {
    const token = tokenMap.get(tokenId);
    if (!token) return; // token deleted/unknown — skip rather than crash
    data.push({
      rank: skip + index + 1,
      token: {
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        totalSupply: token.totalSupply.toString(),
        totalBurned: token.totalBurned.toString(),
        burnCount: token.burnCount,
        metadataUri: token.metadataUri,
        createdAt: token.createdAt.toISOString(),
      },
      metric: scoreByTokenId.get(tokenId) ?? "0",
    });
  });
  return data;
}

/**
 * Full Prisma recompute for the "most-burned" board (sum of burn amounts
 * per token). Used both as the direct path (when called standalone) and
 * as the fallback/warm source for the sorted-set path below.
 */
async function recomputeMostBurned(
  period: TimePeriod,
  skip: number,
  limit: number
): Promise<{ data: LeaderboardToken[]; total: number; allScores: SortedSetMemberInput[] }> {
  const dateFilter = getDateFilter(period);
  const whereClause = dateFilter ? { timestamp: { gte: dateFilter } } : {};

  const burnsByToken = await prisma.burnRecord.groupBy({
    by: ["tokenId"],
    where: whereClause,
    _sum: { amount: true },
    orderBy: { _sum: { amount: "desc" } },
    skip,
    take: limit,
  });

  const total = await prisma.burnRecord
    .groupBy({ by: ["tokenId"], where: whereClause })
    .then((r) => r.length);

  const tokenIds = burnsByToken.map((b) => b.tokenId);
  const tokens = await prisma.token.findMany({ where: { id: { in: tokenIds } } });
  const tokenMap = new Map(tokens.map((t) => [t.id, t]));

  const scoreByTokenId = new Map(
    burnsByToken.map((b) => [b.tokenId, (b._sum.amount || BigInt(0)).toString()])
  );

  const data = buildRankedData(tokenIds, scoreByTokenId, tokenMap, skip);

  // Warm the sorted set with the scores we already fetched for this page.
  // This is a partial (page-sized) warm rather than a full-table warm to
  // avoid an extra unbounded query on every cold-start read — subsequent
  // pages naturally warm further ranges as they are requested, and any
  // gaps are self-healing since a miss just falls back to recompute again.
  const allScores: SortedSetMemberInput[] = burnsByToken.map((b) => ({
    tokenId: b.tokenId,
    score: toSafeSortedSetScore(b._sum.amount),
  }));

  return { data, total, allScores };
}

/**
 * Full Prisma recompute for the "most-active" board (count of burn
 * transactions per token).
 */
async function recomputeMostActive(
  period: TimePeriod,
  skip: number,
  limit: number
): Promise<{ data: LeaderboardToken[]; total: number; allScores: SortedSetMemberInput[] }> {
  const dateFilter = getDateFilter(period);
  const whereClause = dateFilter ? { timestamp: { gte: dateFilter } } : {};

  const burnsByToken = await prisma.burnRecord.groupBy({
    by: ["tokenId"],
    where: whereClause,
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    skip,
    take: limit,
  });

  const total = await prisma.burnRecord
    .groupBy({ by: ["tokenId"], where: whereClause })
    .then((r) => r.length);

  const tokenIds = burnsByToken.map((b) => b.tokenId);
  const tokens = await prisma.token.findMany({ where: { id: { in: tokenIds } } });
  const tokenMap = new Map(tokens.map((t) => [t.id, t]));

  const scoreByTokenId = new Map(
    burnsByToken.map((b) => [b.tokenId, b._count.id.toString()])
  );

  const data = buildRankedData(tokenIds, scoreByTokenId, tokenMap, skip);

  // Partial (page-sized) warm — see recomputeMostBurned for rationale.
  const allScores: SortedSetMemberInput[] = burnsByToken.map((b) => ({
    tokenId: b.tokenId,
    score: b._count.id,
  }));

  return { data, total, allScores };
}

/**
 * Shared incremental-read-with-fallback flow for a sorted-set-backed board.
 *
 *  1. Try reading the top page directly out of Redis (ZREVRANGE).
 *  2. On cold-start (key missing) or Redis failure, fall back to the full
 *     Prisma recompute, then warm the sorted set from that authoritative
 *     result so subsequent reads can use the fast incremental path.
 */
async function getRankedLeaderboard(
  board: SortedSetBoard,
  period: TimePeriod,
  page: number,
  limit: number,
  recompute: (
    period: TimePeriod,
    skip: number,
    limit: number
  ) => Promise<{ data: LeaderboardToken[]; total: number; allScores: SortedSetMemberInput[] }>
): Promise<LeaderboardResponse> {
  const cacheKey = getCacheKey(board, period, page, limit);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const skip = (page - 1) * limit;

  const sortedSetResult = await readTopFromSortedSet(board, period, skip, limit);

  let data: LeaderboardToken[];
  let total: number;

  if (sortedSetResult) {
    // Fast path: sorted set was warm — hydrate token metadata for this page only.
    const tokenIds = sortedSetResult.members.map((m) => m.tokenId);
    const tokens = await prisma.token.findMany({ where: { id: { in: tokenIds } } });
    const tokenMap = new Map(tokens.map((t) => [t.id, t]));
    const scoreByTokenId = new Map(
      sortedSetResult.members.map((m) => [m.tokenId, m.score.toString()])
    );
    data = buildRankedData(tokenIds, scoreByTokenId, tokenMap, skip);
    total = sortedSetResult.total;
  } else {
    // Fallback path: cold start or Redis failure — full recompute, then warm.
    const recomputed = await recompute(period, skip, limit);
    data = recomputed.data;
    total = recomputed.total;
    // Best-effort warm; failures are logged inside warmSortedSet and do not
    // affect the response being returned to the caller.
    void warmSortedSet(board, period, recomputed.allScores);
  }

  const response: LeaderboardResponse = {
    success: true,
    data,
    period,
    updatedAt: new Date().toISOString(),
    pagination: { page, limit, total },
  };

  setCache(cacheKey, response);
  return response;
}

export async function getMostBurnedLeaderboard(
  period: TimePeriod = TimePeriod.D7,
  page: number = 1,
  limit: number = 10
): Promise<LeaderboardResponse> {
  return getRankedLeaderboard("most-burned", period, page, limit, recomputeMostBurned);
}

export async function getMostActiveLeaderboard(
  period: TimePeriod = TimePeriod.D7,
  page: number = 1,
  limit: number = 10
): Promise<LeaderboardResponse> {
  return getRankedLeaderboard("most-active", period, page, limit, recomputeMostActive);
}

export async function getNewestTokensLeaderboard(
  page: number = 1,
  limit: number = 10
): Promise<LeaderboardResponse> {
  const cacheKey = getCacheKey("newest", TimePeriod.ALL, page, limit);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const skip = (page - 1) * limit;

  const [tokens, total] = await Promise.all([
    prisma.token.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.token.count(),
  ]);

  const data: LeaderboardToken[] = tokens.map((token, index) => ({
    rank: skip + index + 1,
    token: {
      address: token.address,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      totalSupply: token.totalSupply.toString(),
      totalBurned: token.totalBurned.toString(),
      burnCount: token.burnCount,
      metadataUri: token.metadataUri,
      createdAt: token.createdAt.toISOString(),
    },
    metric: token.createdAt.toISOString(),
  }));

  const response: LeaderboardResponse = {
    success: true,
    data,
    period: TimePeriod.ALL,
    updatedAt: new Date().toISOString(),
    pagination: { page, limit, total },
  };

  setCache(cacheKey, response);
  return response;
}

export async function getLargestSupplyLeaderboard(
  page: number = 1,
  limit: number = 10
): Promise<LeaderboardResponse> {
  const cacheKey = getCacheKey("largest-supply", TimePeriod.ALL, page, limit);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const skip = (page - 1) * limit;

  const [tokens, total] = await Promise.all([
    prisma.token.findMany({
      orderBy: { totalSupply: "desc" },
      skip,
      take: limit,
    }),
    prisma.token.count(),
  ]);

  const data: LeaderboardToken[] = tokens.map((token, index) => ({
    rank: skip + index + 1,
    token: {
      address: token.address,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      totalSupply: token.totalSupply.toString(),
      totalBurned: token.totalBurned.toString(),
      burnCount: token.burnCount,
      metadataUri: token.metadataUri,
      createdAt: token.createdAt.toISOString(),
    },
    metric: token.totalSupply.toString(),
  }));

  const response: LeaderboardResponse = {
    success: true,
    data,
    period: TimePeriod.ALL,
    updatedAt: new Date().toISOString(),
    pagination: { page, limit, total },
  };

  setCache(cacheKey, response);
  return response;
}

export async function getMostBurnersLeaderboard(
  period: TimePeriod = TimePeriod.D7,
  page: number = 1,
  limit: number = 10
): Promise<LeaderboardResponse> {
  const cacheKey = getCacheKey("most-burners", period, page, limit);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const dateFilter = getDateFilter(period);
  const skip = (page - 1) * limit;

  const whereClause = dateFilter ? { timestamp: { gte: dateFilter } } : {};

  // Get unique burners per token
  const result = await prisma.$queryRaw<
    Array<{ tokenId: string; uniqueBurners: bigint }>
  >`
    SELECT "tokenId", COUNT(DISTINCT "from") as "uniqueBurners"
    FROM "BurnRecord"
    ${dateFilter ? Prisma.sql`WHERE "timestamp" >= ${dateFilter}` : Prisma.empty}
    GROUP BY "tokenId"
    ORDER BY "uniqueBurners" DESC
    LIMIT ${limit}
    OFFSET ${skip}
  `;

  const totalResult = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT "tokenId") as count
    FROM "BurnRecord"
    ${dateFilter ? Prisma.sql`WHERE "timestamp" >= ${dateFilter}` : Prisma.empty}
  `;

  const total = Number(totalResult[0]?.count || 0);

  const tokenIds = result.map((r) => r.tokenId);
  const tokens = await prisma.token.findMany({
    where: { id: { in: tokenIds } },
  });

  const tokenMap = new Map(tokens.map((t) => [t.id, t]));

  const data: LeaderboardToken[] = result.map((item, index) => {
    const token = tokenMap.get(item.tokenId)!;
    return {
      rank: skip + index + 1,
      token: {
        address: token.address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        totalSupply: token.totalSupply.toString(),
        totalBurned: token.totalBurned.toString(),
        burnCount: token.burnCount,
        metadataUri: token.metadataUri,
        createdAt: token.createdAt.toISOString(),
      },
      metric: item.uniqueBurners.toString(),
    };
  });

  const response: LeaderboardResponse = {
    success: true,
    data,
    period,
    updatedAt: new Date().toISOString(),
    pagination: { page, limit, total },
  };

  setCache(cacheKey, response);
  return response;
}

export function clearCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Cache health / status (for GET /api/leaderboard/cache-status)
// ---------------------------------------------------------------------------

export const SORTED_SET_BOARDS: SortedSetBoard[] = ["most-burned", "most-active"];

export interface BoardCacheStatus {
  board: SortedSetBoard;
  period: TimePeriod;
  /** Whether Redis responded to the health probe for this board/period. */
  redisReachable: boolean;
  /** Whether the sorted set has been warmed (populated) for this board/period. */
  warm: boolean;
  /** Set to "fallback" when reads currently rely on full recomputation. */
  mode: "sorted-set" | "fallback";
  error?: string;
}

export interface LeaderboardCacheStatusResponse {
  /** Overall Redis reachability across all probed sorted sets. */
  redisReachable: boolean;
  /** In-memory Map cache size (entries across all leaderboard types). */
  inMemoryCacheEntries: number;
  /** Per board/period sorted-set status. */
  boards: BoardCacheStatus[];
  checkedAt: string;
}

/**
 * Health-monitoring snapshot of the sorted-set cache. Used by
 * GET /api/leaderboard/cache-status.
 *
 * Reports, per (board, period): whether Redis is reachable, whether the
 * sorted set is warm (populated) or the board is currently operating in
 * full-recompute fallback mode, plus an overall summary.
 */
export async function getCacheStatus(): Promise<LeaderboardCacheStatusResponse> {
  const checks = await Promise.all(
    SORTED_SET_BOARDS.flatMap((board) =>
      SORTED_SET_PERIODS.map(async (period) => {
        const status = await getSortedSetStatus(board, period);
        const result: BoardCacheStatus = {
          board,
          period,
          redisReachable: status.reachable,
          warm: status.warm,
          mode: status.reachable && status.warm ? "sorted-set" : "fallback",
          error: status.error,
        };
        return result;
      })
    )
  );

  return {
    redisReachable: checks.every((c) => c.redisReachable),
    inMemoryCacheEntries: cache.size,
    boards: checks,
    checkedAt: new Date().toISOString(),
  };
}
