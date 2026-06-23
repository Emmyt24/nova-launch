/**
 * GraphQL resolvers.
 *
 * All resolvers are read-only (Query only). BigInt values from Prisma are
 * converted to strings before returning so JSON serialisation is lossless.
 *
 * Pagination: `limit` is capped at 100; `offset` defaults to 0.
 */

import { prisma } from "../lib/prisma";
import { eventBus, EventBus } from "../services/eventBus";
import {
  LEADERBOARD_UPDATED_TOPIC,
  TimePeriod,
  registerLeaderboardSubscriber,
  type LeaderboardKind,
  type LeaderboardUpdatedPayload,
} from "../services/leaderboardService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_LIMIT = 100;

function paginate(args: { limit?: number | null; offset?: number | null }) {
  return {
    take: Math.min(args.limit ?? 20, MAX_LIMIT),
    skip: args.offset ?? 0,
  };
}

/** Recursively convert BigInt values to strings for JSON safety. */
export function bigintToString<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return obj.toString() as unknown as T;
  if (Array.isArray(obj)) return obj.map(bigintToString) as unknown as T;
  if (typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        k,
        bigintToString(v),
      ])
    ) as T;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Subscription infrastructure
// ---------------------------------------------------------------------------

/**
 * eventBus topic names backing each GraphQL subscription field.
 *
 * Subscriptions only *consume* these topics — production of the events lives in
 * the domain services / event listeners that already own the eventBus.
 */
export const SUBSCRIPTION_TOPICS = {
  tokenDeployed: "token.deployed",
  burnExecuted: "burn.executed",
  proposalStatusChanged: "governance.proposal.statusChanged",
  vaultMatured: "vault.matured",
  leaderboardUpdated: LEADERBOARD_UPDATED_TOPIC,
} as const;

/** GraphQL `LeaderboardType` enum value <-> the leaderboardService's internal kind string. */
const LEADERBOARD_TYPE_TO_KIND: Record<string, LeaderboardKind> = {
  MOST_BURNED: "most-burned",
  MOST_ACTIVE: "most-active",
  NEWEST: "newest",
  LARGEST_SUPPLY: "largest-supply",
  MOST_BURNERS: "most-burners",
};

const KIND_TO_LEADERBOARD_TYPE: Record<LeaderboardKind, string> =
  Object.fromEntries(
    Object.entries(LEADERBOARD_TYPE_TO_KIND).map(([gqlType, kind]) => [
      kind,
      gqlType,
    ])
  ) as Record<LeaderboardKind, string>;

/**
 * Context attached to a subscription operation. `tenant` is resolved from the
 * connection JWT during the graphql-ws `connection_init` handshake (see
 * graphql/index.ts). It is undefined only for unauthenticated connections,
 * which never receive any events.
 */
export interface SubscriptionContext {
  tenant?: { id: string; name?: string };
}

/** Shared shape: every event payload carries the owning token's creator so the
 *  bus stream can be tenant scoped consistently with the REST/Query layer
 *  (where `tenant.id === creator`). */
interface TenantScopedPayload {
  creatorAddress: string;
}

export interface TokenDeployedPayload extends TenantScopedPayload {
  tokenAddress: string;
  name: string;
  symbol: string;
  totalSupply: string | bigint;
  txHash: string;
  timestamp: string;
}

export interface BurnExecutedPayload extends TenantScopedPayload {
  tokenAddress: string;
  amount: string | bigint;
  burnedBy: string;
  isAdminBurn: boolean;
  txHash: string;
  timestamp: string;
}

export interface ProposalStatusChangedPayload extends TenantScopedPayload {
  proposalId: number;
  tokenAddress: string;
  status: string;
  previousStatus?: string | null;
  txHash: string;
  timestamp: string;
}

export interface VaultMaturedPayload extends TenantScopedPayload {
  vaultId: number;
  recipientAddress: string;
  amount: string | bigint;
  txHash: string;
  timestamp: string;
}

/**
 * Tenant scope check. An event belongs to a subscriber's tenant when the
 * event's creator address equals the tenant id — the same rule the REST token
 * routes enforce (`where.creator = tenantId`). Connections without a resolved
 * tenant receive nothing.
 */
function tenantOwnsEvent(
  ctx: SubscriptionContext | undefined,
  payload: TenantScopedPayload
): boolean {
  if (!ctx?.tenant?.id) return false;
  return payload.creatorAddress === ctx.tenant.id;
}

/**
 * Bridge an eventBus topic to a GraphQL `AsyncIterableIterator`.
 *
 * Each delivered payload must pass `filter` — used for both tenant scoping and
 * the per-subscription argument filters. The underlying bus subscription is
 * torn down automatically when the consumer stops iterating (client disconnect
 * or `unsubscribe`), preventing handler leaks.
 *
 * `bus` is injectable so resolvers can be unit tested against a fresh EventBus.
 * `onClose` runs once when the consumer disconnects — used by subscriptions
 * that need extra teardown beyond the bus subscription itself (e.g.
 * `leaderboardUpdated` deregistering its (type, period) interest).
 */
export function eventBusAsyncIterator<T>(
  topic: string,
  filter: (payload: T) => boolean,
  bus: EventBus = eventBus,
  onClose?: () => void
): AsyncIterableIterator<T> {
  const queue: T[] = [];
  const pending: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const subscription = bus.subscribe<T>(topic, (event) => {
    if (closed) return;
    if (!filter(event.payload)) return;
    const next = pending.shift();
    if (next) {
      next({ value: event.payload, done: false });
    } else {
      queue.push(event.payload);
    }
  });

  function close(): void {
    if (closed) return;
    closed = true;
    subscription.unsubscribe();
    onClose?.();
    while (pending.length) {
      pending.shift()!({ value: undefined as never, done: true });
    }
  }

  return {
    next(): Promise<IteratorResult<T>> {
      if (queue.length) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      if (closed) {
        return Promise.resolve({ value: undefined as never, done: true });
      }
      return new Promise((resolve) => pending.push(resolve));
    },
    return(): Promise<IteratorResult<T>> {
      close();
      return Promise.resolve({ value: undefined as never, done: true });
    },
    throw(err?: unknown): Promise<IteratorResult<T>> {
      close();
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

export const resolvers = {
  Query: {
    // ── Token ───────────────────────────────────────────────────────────────

    /** Fetch a single token by its on-chain address. */
    async token(_: unknown, args: { address: string }) {
      const row = await prisma.token.findUnique({
        where: { address: args.address },
      });
      return row ? bigintToString(row) : null;
    },

    /** List tokens, optionally filtered by creator. */
    async tokens(
      _: unknown,
      args: { creator?: string; limit?: number; offset?: number }
    ) {
      const rows = await prisma.token.findMany({
        where: args.creator ? { creator: args.creator } : undefined,
        orderBy: { createdAt: "desc" },
        ...paginate(args),
      });
      return bigintToString(rows);
    },

    // ── Stream ──────────────────────────────────────────────────────────────

    /** Fetch a single stream by its on-chain streamId. */
    async stream(_: unknown, args: { streamId: number }) {
      const row = await prisma.stream.findUnique({
        where: { streamId: args.streamId },
      });
      return row ? bigintToString(row) : null;
    },

    /** List streams with optional creator / recipient / status filters. */
    async streams(
      _: unknown,
      args: {
        creator?: string;
        recipient?: string;
        status?: string;
        limit?: number;
        offset?: number;
      }
    ) {
      const where: Record<string, unknown> = {};
      if (args.creator) where.creator = args.creator;
      if (args.recipient) where.recipient = args.recipient;
      if (args.status) where.status = args.status;

      const rows = await prisma.stream.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...paginate(args),
      });
      return bigintToString(rows);
    },

    // ── Governance ──────────────────────────────────────────────────────────

    /** Fetch a single proposal by its on-chain proposalId. */
    async proposal(_: unknown, args: { proposalId: number }) {
      const row = await prisma.proposal.findUnique({
        where: { proposalId: args.proposalId },
      });
      return row ? bigintToString(row) : null;
    },

    /** List proposals with optional filters. */
    async proposals(
      _: unknown,
      args: {
        tokenId?: string;
        proposer?: string;
        status?: string;
        proposalType?: string;
        limit?: number;
        offset?: number;
      }
    ) {
      const where: Record<string, unknown> = {};
      if (args.tokenId) where.tokenId = args.tokenId;
      if (args.proposer) where.proposer = args.proposer;
      if (args.status) where.status = args.status;
      if (args.proposalType) where.proposalType = args.proposalType;

      const rows = await prisma.proposal.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...paginate(args),
      });
      return bigintToString(rows);
    },

    // ── Campaign ─────────────────────────────────────────────────────────────

    /** Fetch a single campaign by its on-chain campaignId. */
    async campaign(_: unknown, args: { campaignId: number }) {
      const row = await prisma.campaign.findUnique({
        where: { campaignId: args.campaignId },
      });
      return row ? bigintToString(row) : null;
    },

    /** List campaigns with optional filters. */
    async campaigns(
      _: unknown,
      args: {
        tokenId?: string;
        creator?: string;
        status?: string;
        type?: string;
        limit?: number;
        offset?: number;
      }
    ) {
      const where: Record<string, unknown> = {};
      if (args.tokenId) where.tokenId = args.tokenId;
      if (args.creator) where.creator = args.creator;
      if (args.status) where.status = args.status;
      if (args.type) where.type = args.type;

      const rows = await prisma.campaign.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...paginate(args),
      });
      return bigintToString(rows);
    },
  },

  // ── Subscriptions (real-time events via eventBus) ─────────────────────────
  //
  // Each field exposes a `subscribe` returning an AsyncIterable backed by the
  // eventBus, and a `resolve` that maps the raw payload to the GraphQL shape
  // (BigInt → String for JSON safety). Filters combine tenant scoping with the
  // optional per-subscription argument.

  Subscription: {
    tokenDeployed: {
      subscribe: (
        _root: unknown,
        args: { creatorAddress?: string | null },
        ctx: SubscriptionContext
      ) =>
        eventBusAsyncIterator<TokenDeployedPayload>(
          SUBSCRIPTION_TOPICS.tokenDeployed,
          (p) =>
            tenantOwnsEvent(ctx, p) &&
            (!args.creatorAddress || p.creatorAddress === args.creatorAddress)
        ),
      resolve: (payload: TokenDeployedPayload) => bigintToString(payload),
    },

    burnExecuted: {
      subscribe: (
        _root: unknown,
        args: { tokenAddress?: string | null },
        ctx: SubscriptionContext
      ) =>
        eventBusAsyncIterator<BurnExecutedPayload>(
          SUBSCRIPTION_TOPICS.burnExecuted,
          (p) =>
            tenantOwnsEvent(ctx, p) &&
            (!args.tokenAddress || p.tokenAddress === args.tokenAddress)
        ),
      resolve: (payload: BurnExecutedPayload) => bigintToString(payload),
    },

    proposalStatusChanged: {
      subscribe: (
        _root: unknown,
        args: { tokenAddress?: string | null },
        ctx: SubscriptionContext
      ) =>
        eventBusAsyncIterator<ProposalStatusChangedPayload>(
          SUBSCRIPTION_TOPICS.proposalStatusChanged,
          (p) =>
            tenantOwnsEvent(ctx, p) &&
            (!args.tokenAddress || p.tokenAddress === args.tokenAddress)
        ),
      resolve: (payload: ProposalStatusChangedPayload) =>
        bigintToString(payload),
    },

    vaultMatured: {
      subscribe: (
        _root: unknown,
        args: { recipientAddress?: string | null },
        ctx: SubscriptionContext
      ) =>
        eventBusAsyncIterator<VaultMaturedPayload>(
          SUBSCRIPTION_TOPICS.vaultMatured,
          (p) =>
            tenantOwnsEvent(ctx, p) &&
            (!args.recipientAddress ||
              p.recipientAddress === args.recipientAddress)
        ),
      resolve: (payload: VaultMaturedPayload) => bigintToString(payload),
    },

    // Leaderboard ranking is global, not tenant-scoped — every connected
    // client sees the same top-100 list, debounced upstream by
    // leaderboardService (see scheduleLeaderboardBroadcast).
    leaderboardUpdated: {
      subscribe: (
        _root: unknown,
        args: { type?: string | null; period?: string | null }
      ) => {
        const kind = LEADERBOARD_TYPE_TO_KIND[args.type ?? "MOST_BURNED"];
        const period = (args.period ?? "7d") as TimePeriod;
        const unregister = registerLeaderboardSubscriber(kind, period);

        return eventBusAsyncIterator<LeaderboardUpdatedPayload>(
          SUBSCRIPTION_TOPICS.leaderboardUpdated,
          (p) => p.type === kind && p.period === period,
          eventBus,
          unregister
        );
      },
      resolve: (payload: LeaderboardUpdatedPayload) => ({
        type: KIND_TO_LEADERBOARD_TYPE[payload.type],
        period: payload.period,
        updatedAt: payload.updatedAt,
        entries: payload.entries.map((entry) => ({
          rank: entry.rank,
          tokenAddress: entry.token.address,
          tokenName: entry.token.name,
          tokenSymbol: entry.token.symbol,
          metric: entry.metric,
        })),
      }),
    },
  },

  // ── Field resolvers (nested relations) ────────────────────────────────────

  Token: {
    /** Lazy-load burn records for a token. */
    async burnRecords(
      parent: { id: string },
      args: { limit?: number; offset?: number }
    ) {
      const rows = await prisma.burnRecord.findMany({
        where: { tokenId: parent.id },
        orderBy: { timestamp: "desc" },
        ...paginate(args),
      });
      return bigintToString(rows);
    },
  },

  Proposal: {
    /** Lazy-load votes for a proposal. */
    async votes(
      parent: { id: string },
      args: { limit?: number; offset?: number }
    ) {
      const rows = await prisma.vote.findMany({
        where: { proposalId: parent.id },
        orderBy: { timestamp: "desc" },
        ...paginate(args),
      });
      return bigintToString(rows);
    },
  },
};
