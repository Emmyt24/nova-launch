import { PrismaClient, StreamStatus, StreamWithdrawalType } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Read model for a single stream, derived from the `Stream` table.
 *
 * This is the projection that `streamReconciliation.ts` treats as the
 * "expected" side of its comparison: reconciliation reads these rows and
 * checks them against a second source of truth (the on-chain / event-derived
 * state) to detect divergence. See `streamReconciliation.ts` for the exact
 * definition of "divergence" and how it is reported.
 */
export interface StreamProjection {
  id: string;
  streamId: number;
  creator: string;
  recipient: string;
  amount: string; // BigInt serialized as string
  metadata?: string;
  status: StreamStatus;
  txHash: string;
  createdAt: Date;
  claimedAt?: Date;
  cancelledAt?: Date;
}

export interface StreamStats {
  totalStreams: number;
  activeStreams: number;
  claimedVolume: string;
  cancelledVolume: string;
}

export interface StreamListOptions {
  status?: StreamStatus;
  limit?: number;
  offset?: number;
}

export interface StreamKeysetOptions {
  status?: StreamStatus;
  /** Last `streamId` seen on the previous page; omit for the first page. */
  cursor?: number;
  limit?: number;
}

export interface StreamKeysetPage {
  streams: StreamProjection[];
  nextCursor: number | null;
  hasMore: boolean;
}

export interface StreamWithdrawalRecord {
  id: string;
  streamId: number;
  transactionType: StreamWithdrawalType;
  amount: string; // BigInt serialized as string
  recipient: string;
  txHash: string;
  timestamp: Date;
}

/** Hard upper bound on page size for keyset-paginated stream listings. */
const MAX_KEYSET_PAGE_SIZE = 50;

/**
 * Builds the `Stream` read projection from the persisted `Stream` table.
 *
 * This service is the projection-building half of the stream read path: it
 * maps stored rows into the `StreamProjection` shape consumed by API handlers
 * and clients. It does not verify that the stored rows match on-chain state.
 *
 * That verification is deliberately a separate concern, implemented in
 * `streamReconciliation.ts`. Reconciliation reads the projection produced
 * here and compares it against a second source of truth (the on-chain /
 * event-derived stream state); when the two disagree it publishes a
 * `"stream.divergence_detected"` event (see `streamDivergenceAlerting.ts`).
 * The two files are kept separate so that projection reads stay cheap and
 * side-effect free, while reconciliation can run on its own schedule and
 * emit alerts without coupling alerting logic into every read.
 *
 * Deliberate exception: reconciliation only covers streams that have been
 * indexed into the `Stream` table. Streams that exist on-chain but have not
 * yet been projected here are out of scope for divergence detection, since
 * there is no projection row to compare against.
 */
export class StreamProjectionService {
  async getStreamById(streamId: number): Promise<StreamProjection | null> {
    const stream = await prisma.stream.findUnique({ where: { streamId } });
    return stream ? this.buildProjection(stream) : null;
  }

  async getStreamsByCreator(
    creator: string,
    opts: StreamListOptions = {}
  ): Promise<StreamProjection[]> {
    const { status, limit = 50, offset = 0 } = opts;
    const streams = await prisma.stream.findMany({
      where: { creator, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });
    return streams.map((s) => this.buildProjection(s));
  }

  async getStreamsByRecipient(
    recipient: string,
    opts: StreamListOptions = {}
  ): Promise<StreamProjection[]> {
    const { status, limit = 50, offset = 0 } = opts;
    const streams = await prisma.stream.findMany({
      where: { recipient, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });
    return streams.map((s) => this.buildProjection(s));
  }

  /**
   * Keyset-paginated listing of streams created by `creator`, ordered by
   * `streamId` ascending. `streamId` is monotonically increasing and unique
   * across the whole projection, so it doubles as a stable cursor: unlike
   * offset pagination, a stream inserted between two page fetches can never
   * cause this method to skip or duplicate a row on the next page, because
   * each page resumes strictly after the last `streamId` it returned.
   *
   * Mirrors the on-chain `list_streams_paginated` keyset cursor exposed by
   * the token-factory contract (`(created_ledger, stream_id)`), using
   * `streamId` alone since it is already a total order for this projection.
   */
  async getStreamsByCreatorKeyset(
    creator: string,
    opts: StreamKeysetOptions = {}
  ): Promise<StreamKeysetPage> {
    const { status, cursor, limit = MAX_KEYSET_PAGE_SIZE } = opts;
    const pageSize = Math.min(Math.max(limit, 1), MAX_KEYSET_PAGE_SIZE);

    const streams = await prisma.stream.findMany({
      where: {
        creator,
        ...(status ? { status } : {}),
        ...(cursor !== undefined ? { streamId: { gt: cursor } } : {}),
      },
      orderBy: { streamId: "asc" },
      take: pageSize + 1,
    });

    const hasMore = streams.length > pageSize;
    const page = hasMore ? streams.slice(0, pageSize) : streams;
    const nextCursor = hasMore ? page[page.length - 1].streamId : null;

    return {
      streams: page.map((s) => this.buildProjection(s)),
      nextCursor,
      hasMore,
    };
  }

  /**
   * All recorded withdrawal transactions for a stream, most recent first.
   * Ties on timestamp are broken by txHash so ordering is deterministic.
   */
  async getWithdrawalsByStreamId(
    streamId: number,
    opts: { transactionType?: StreamWithdrawalType } = {}
  ): Promise<StreamWithdrawalRecord[]> {
    const rows = await prisma.streamWithdrawal.findMany({
      where: {
        streamId,
        ...(opts.transactionType ? { transactionType: opts.transactionType } : {}),
      },
      orderBy: [{ timestamp: "desc" }, { txHash: "desc" }],
    });
    return rows.map((w) => ({
      id: w.id,
      streamId: w.streamId,
      transactionType: w.transactionType,
      amount: w.amount.toString(),
      recipient: w.recipient,
      txHash: w.txHash,
      timestamp: w.timestamp,
    }));
  }

  async getStreamStats(address?: string): Promise<StreamStats> {
    const where: any = address
      ? { OR: [{ creator: address }, { recipient: address }] }
      : {};

    const [totalStreams, activeStreams, claimedStreams, cancelledStreams] =
      await Promise.all([
        prisma.stream.count({ where }),
        prisma.stream.count({ where: { ...where, status: StreamStatus.CREATED } }),
        prisma.stream.findMany({ where: { ...where, status: StreamStatus.CLAIMED } }),
        prisma.stream.findMany({ where: { ...where, status: StreamStatus.CANCELLED } }),
      ]);

    return {
      totalStreams,
      activeStreams,
      claimedVolume: claimedStreams
        .reduce((sum, s) => sum + s.amount, BigInt(0))
        .toString(),
      cancelledVolume: cancelledStreams
        .reduce((sum, s) => sum + s.amount, BigInt(0))
        .toString(),
    };
  }

  private buildProjection(stream: any): StreamProjection {
    return {
      id: stream.id,
      streamId: stream.streamId,
      creator: stream.creator,
      recipient: stream.recipient,
      amount: stream.amount.toString(),
      metadata: stream.metadata ?? undefined,
      status: stream.status,
      txHash: stream.txHash,
      createdAt: stream.createdAt,
      claimedAt: stream.claimedAt ?? undefined,
      cancelledAt: stream.cancelledAt ?? undefined,
    };
  }
}

export const streamProjectionService = new StreamProjectionService();
