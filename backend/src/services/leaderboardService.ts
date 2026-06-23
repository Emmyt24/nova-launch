import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { eventBus } from "./eventBus";

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
 * Leaderboard event names published by other services:
 *   "burn.created"   — a BurnRecord was inserted  (payload: { tokenId })
 *   "burn.executed"  — a burn transaction confirmed on-chain
 *   "token.created"  — a Token was created         (payload: { tokenId })
 *   "token.deployed" — a batch token deploy confirmed on-chain
 *
 * Call `eventBus.publish("burn.created", { tokenId })` from the burn handler,
 * and `eventBus.publish("token.created", { tokenId })` from the token handler.
 */
function onBurnEvent(): void {
  // A burn affects burn-volume, burn-count, and unique-burner leaderboards.
  invalidateCacheByType("most-burned");
  invalidateCacheByType("most-active");
  invalidateCacheByType("most-burners");
  scheduleLeaderboardBroadcast(["most-burned", "most-active", "most-burners"]);
}

function onTokenCreatedEvent(): void {
  // A new token affects the newest and largest-supply leaderboards.
  invalidateCacheByType("newest");
  invalidateCacheByType("largest-supply");
  scheduleLeaderboardBroadcast(["newest", "largest-supply"]);
}

eventBus.subscribe<{ tokenId?: string }>("burn.created", onBurnEvent);
eventBus.subscribe("burn.executed", onBurnEvent);
eventBus.subscribe<{ tokenId?: string }>("token.created", onTokenCreatedEvent);
eventBus.subscribe("token.deployed", onTokenCreatedEvent);

// ---------------------------------------------------------------------------
// Real-time leaderboard subscription support (issue #1377)
//
// The GraphQL `leaderboardUpdated` subscription is a thin eventBus consumer
// (see graphql/resolvers.ts) over this topic. Re-computing and publishing the
// full top-100 ranking on every single burn would be wasteful under burst
// traffic, so updates are debounced to at most one push per (type, period)
// every DEBOUNCE_MS, and only for combinations that currently have a
// connected subscriber.
// ---------------------------------------------------------------------------

export const LEADERBOARD_UPDATED_TOPIC = "leaderboard.updated";

export type LeaderboardKind =
  | "most-burned"
  | "most-active"
  | "most-burners"
  | "newest"
  | "largest-supply";

export interface LeaderboardUpdatedPayload {
  type: LeaderboardKind;
  period: TimePeriod;
  entries: LeaderboardToken[];
  updatedAt: string;
}

const DEBOUNCE_MS = 5000;
const TOP_N = 100;

const LEADERBOARD_FETCHERS: Record<
  LeaderboardKind,
  (period: TimePeriod) => Promise<LeaderboardResponse>
> = {
  "most-burned": (period) => getMostBurnedLeaderboard(period, 1, TOP_N),
  "most-active": (period) => getMostActiveLeaderboard(period, 1, TOP_N),
  "most-burners": (period) => getMostBurnersLeaderboard(period, 1, TOP_N),
  newest: () => getNewestTokensLeaderboard(1, TOP_N),
  "largest-supply": () => getLargestSupplyLeaderboard(1, TOP_N),
};

/** Active (type, period) combinations with at least one connected GraphQL subscriber. */
const activeSubscriptions = new Map<string, number>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function subscriptionKey(type: LeaderboardKind, period: TimePeriod): string {
  return `${type}:${period}`;
}

/**
 * Register a connected `leaderboardUpdated` subscriber so burst events know
 * which (type, period) combinations are worth recomputing. Returns an
 * unsubscribe callback to call when the client disconnects.
 */
export function registerLeaderboardSubscriber(
  type: LeaderboardKind,
  period: TimePeriod
): () => void {
  const key = subscriptionKey(type, period);
  activeSubscriptions.set(key, (activeSubscriptions.get(key) ?? 0) + 1);

  return () => {
    const count = activeSubscriptions.get(key) ?? 0;
    if (count <= 1) {
      activeSubscriptions.delete(key);
    } else {
      activeSubscriptions.set(key, count - 1);
    }
  };
}

function broadcastLeaderboard(type: LeaderboardKind, period: TimePeriod): void {
  LEADERBOARD_FETCHERS[type](period)
    .then((response) => {
      const payload: LeaderboardUpdatedPayload = {
        type,
        period,
        entries: response.data,
        updatedAt: response.updatedAt,
      };
      return eventBus.publish(LEADERBOARD_UPDATED_TOPIC, payload);
    })
    .catch((err) =>
      console.error(
        `[leaderboard] real-time broadcast failed for ${type}:${period}:`,
        err
      )
    );
}

/** Debounce a broadcast for one (type, period) key — coalesces bursts into a single push. */
function scheduleBroadcast(type: LeaderboardKind, period: TimePeriod): void {
  const key = subscriptionKey(type, period);
  if (debounceTimers.has(key)) return; // already scheduled within this window

  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    broadcastLeaderboard(type, period);
  }, DEBOUNCE_MS);

  debounceTimers.set(key, timer);
}

/** Schedule a debounced broadcast for every actively-subscribed (type, period) pair of the given kinds. */
function scheduleLeaderboardBroadcast(affectedTypes: LeaderboardKind[]): void {
  for (const key of activeSubscriptions.keys()) {
    const separatorIndex = key.lastIndexOf(":");
    const type = key.slice(0, separatorIndex) as LeaderboardKind;
    const period = key.slice(separatorIndex + 1) as TimePeriod;
    if (affectedTypes.includes(type)) {
      scheduleBroadcast(type, period);
    }
  }
}

/** Test-only: clear pending subscriptions/timers so tests don't leak state across files. */
export function resetLeaderboardSubscriptionsForTests(): void {
  activeSubscriptions.clear();
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
}

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

export async function getMostBurnedLeaderboard(
  period: TimePeriod = TimePeriod.D7,
  page: number = 1,
  limit: number = 10
): Promise<LeaderboardResponse> {
  const cacheKey = getCacheKey("most-burned", period, page, limit);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const dateFilter = getDateFilter(period);
  const skip = (page - 1) * limit;

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
    .groupBy({
      by: ["tokenId"],
      where: whereClause,
    })
    .then((r) => r.length);

  const tokenIds = burnsByToken.map((b) => b.tokenId);
  const tokens = await prisma.token.findMany({
    where: { id: { in: tokenIds } },
  });

  const tokenMap = new Map(tokens.map((t) => [t.id, t]));

  const data: LeaderboardToken[] = burnsByToken.map((burn, index) => {
    const token = tokenMap.get(burn.tokenId)!;
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
      metric: (burn._sum.amount || BigInt(0)).toString(),
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

export async function getMostActiveLeaderboard(
  period: TimePeriod = TimePeriod.D7,
  page: number = 1,
  limit: number = 10
): Promise<LeaderboardResponse> {
  const cacheKey = getCacheKey("most-active", period, page, limit);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const dateFilter = getDateFilter(period);
  const skip = (page - 1) * limit;

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
    .groupBy({
      by: ["tokenId"],
      where: whereClause,
    })
    .then((r) => r.length);

  const tokenIds = burnsByToken.map((b) => b.tokenId);
  const tokens = await prisma.token.findMany({
    where: { id: { in: tokenIds } },
  });

  const tokenMap = new Map(tokens.map((t) => [t.id, t]));

  const data: LeaderboardToken[] = burnsByToken.map((burn, index) => {
    const token = tokenMap.get(burn.tokenId)!;
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
      metric: burn._count.id.toString(),
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
