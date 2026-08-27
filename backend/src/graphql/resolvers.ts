/**
 * GraphQL resolvers.
 *
 * All resolvers are read-only (Query only). BigInt values from Prisma are
 * converted to strings before returning so JSON serialisation is lossless.
 *
 * Pagination: `limit` is capped at 100; `offset` defaults to 0.
 */

import { GraphQLError } from "graphql";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { eventBus, EventBus } from "../services/eventBus";

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

/** Log the real error server-side and throw a sanitized client-facing error. */
function handleDbError(resolver: string, err: unknown): never {
  logger.error(`GraphQL resolver error in ${resolver}`, {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  throw new GraphQLError("Internal server error");
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
  proposalVoteCast: "governance.proposal.voteCast",
  vaultMatured: "vault.matured",
} as const;

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

export interface ProposalVoteCastPayload extends TenantScopedPayload {
  proposalId: number;
  tokenAddress: string;
  voter: string;
  support: boolean;
  weight: string | bigint;
  votesFor: string | bigint;
  votesAgainst: string | bigint;
  reason?: string | null;
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
 */
export function eventBusAsyncIterator<T>(
  topic: string,
  filter: (payload: T) => boolean,
  bus: EventBus = eventBus
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
      try {
        const row = await prisma.token.findUnique({
          where: { address: args.address },
        });
        return row ? bigintToString(row) : null;
      } catch (err) {
        handleDbError("token", err);
      }
    },

    /** List tokens, optionally filtered by creator. */
    async tokens(
      _: unknown,
      args: { creator?: string; limit?: number; offset?: number }
    ) {
      try {
        const rows = await prisma.token.findMany({
          where: args.creator ? { creator: args.creator } : undefined,
          orderBy: { createdAt: "desc" },
          ...paginate(args),
        });
        return bigintToString(rows);
      } catch (err) {
        handleDbError("tokens", err);
      }
    },

    // ── Stream ──────────────────────────────────────────────────────────────

    /** Fetch a single stream by its on-chain streamId. */
    async stream(_: unknown, args: { streamId: number }) {
      try {
        const row = await prisma.stream.findUnique({
          where: { streamId: args.streamId },
        });
        return row ? bigintToString(row) : null;
      } catch (err) {
        handleDbError("stream", err);
      }
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
      try {
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
      } catch (err) {
        handleDbError("streams", err);
      }
    },

    // ── Governance ──────────────────────────────────────────────────────────

    /** Fetch a single proposal by its on-chain proposalId. */
    async proposal(_: unknown, args: { proposalId: number }) {
      try {
        const row = await prisma.proposal.findUnique({
          where: { proposalId: args.proposalId },
        });
        return row ? bigintToString(row) : null;
      } catch (err) {
        handleDbError("proposal", err);
      }
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
      try {
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
      } catch (err) {
        handleDbError("proposals", err);
      }
    },

    /**
     * Current FIFO execution queue: queued proposals ordered by queue time.
     *
     * Proposals of the same `proposalType` execute in the order they were
     * queued (FIFO); different types are independent. The returned list is
     * ordered by `createdAt` ascending so the array index is the execution
     * position within each type. Optionally narrowed to one `proposalType`.
     */
    async governanceQueue(_: unknown, args: { proposalType?: string }) {
      try {
        const where: Record<string, unknown> = { status: "QUEUED" };
        if (args.proposalType) where.proposalType = args.proposalType;

        const rows = await prisma.proposal.findMany({
          where,
          orderBy: { createdAt: "asc" },
        });
        return bigintToString(rows);
      } catch (err) {
        handleDbError("governanceQueue", err);
      }
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

    proposalVoteCast: {
      subscribe: (
        _root: unknown,
        args: { proposalId?: number | null },
        ctx: SubscriptionContext
      ) =>
        eventBusAsyncIterator<ProposalVoteCastPayload>(
          SUBSCRIPTION_TOPICS.proposalVoteCast,
          (p) =>
            tenantOwnsEvent(ctx, p) &&
            (args.proposalId == null || p.proposalId === args.proposalId)
        ),
      resolve: (payload: ProposalVoteCastPayload) => bigintToString(payload),
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
  },

  // ── Field resolvers (nested relations) ────────────────────────────────────

  Token: {
    /** Lazy-load burn records for a token. */
    async burnRecords(
      parent: { id: string },
      args: { limit?: number; offset?: number }
    ) {
      try {
        const rows = await prisma.burnRecord.findMany({
          where: { tokenId: parent.id },
          orderBy: { timestamp: "desc" },
          ...paginate(args),
        });
        return bigintToString(rows);
      } catch (err) {
        handleDbError("burnRecords", err);
      }
    },
  },

  Proposal: {
    /** Lazy-load votes for a proposal. */
    async votes(
      parent: { id: string },
      args: { limit?: number; offset?: number }
    ) {
      try {
        const rows = await prisma.vote.findMany({
          where: { proposalId: parent.id },
          orderBy: { timestamp: "desc" },
          ...paginate(args),
        });
        return bigintToString(rows);
      } catch (err) {
        handleDbError("votes", err);
      }
    },

    /**
     * 0-based position of this proposal in the FIFO execution queue for its
     * type. Computed as the number of QUEUED proposals of the same
     * `proposalType` queued before it. Returns null unless the proposal is
     * itself QUEUED.
     */
    async queuePosition(parent: {
      status: string;
      proposalType: string;
      createdAt: Date | string;
    }) {
      try {
        if (parent.status !== "QUEUED") return null;
        const ahead = await prisma.proposal.count({
          where: {
            status: "QUEUED",
            proposalType: parent.proposalType as any,
            createdAt: { lt: new Date(parent.createdAt) },
          },
        });
        return ahead;
      } catch (err) {
        handleDbError("queuePosition", err);
      }
    },
  },
};
