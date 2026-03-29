import { PrismaClient, StreamStatus } from "@prisma/client";

const prisma = new PrismaClient();

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
