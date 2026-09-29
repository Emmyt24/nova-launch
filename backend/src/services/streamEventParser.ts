import { PrismaClient, StreamStatus, StreamWithdrawalType } from '@prisma/client';
import { StreamCreatedEvent, StreamClaimedEvent, StreamCancelledEvent, StreamMetadataUpdatedEvent } from '../types/stream';

/**
 * @file streamEventParser.ts
 *
 * Parses on-chain stream lifecycle events (created / claimed / cancelled /
 * metadata_updated) and projects them into the `Stream` Prisma model.
 *
 * ## Relationship to off-chain stream metadata
 *
 * There is a **second, similarly-named concept** in this codebase:
 * `PaymentStreamMetadata` (managed by `streamMetadataService.ts`). It is
 * entirely separate from the `Stream` projection built here:
 *
 * - **This file** (`streamEventParser.ts`) maintains the **on-chain stream
 *   projection** — financial terms (amount, creator, recipient, status) derived
 *   from contract events. The `streamId` here is the token-factory contract's
 *   streaming-module stream id.
 *
 * - **`streamMetadataService.ts`** manages **off-chain, descriptive metadata**
 *   (title, description, tags) for the same streams, stored in the
 *   `PaymentStreamMetadata` Prisma model. It is a distinct feature from this
 *   Vaults ingestion pipeline and must not be confused with it.
 *
 * See `streamMetadataService.ts` for a full explanation of the distinction and
 * the authorization model for off-chain metadata updates.
 */

export class StreamEventParser {
  constructor(private prisma: PrismaClient) {}

  async parseCreatedEvent(event: StreamCreatedEvent): Promise<void> {
    await this.prisma.stream.upsert({
      where: { streamId: event.streamId },
      create: {
        streamId: event.streamId,
        creator: event.creator,
        recipient: event.recipient,
        amount: BigInt(event.amount),
        metadata: event.metadata,
        status: StreamStatus.CREATED,
        txHash: event.txHash,
        createdAt: event.timestamp,
      },
      update: {}, // no-op on replay — creation fields are immutable
    });
  }

  async parseClaimedEvent(event: StreamClaimedEvent): Promise<void> {
    await this.prisma.stream.update({
      where: { streamId: event.streamId },
      data: {
        status: StreamStatus.CLAIMED,
        claimedAt: event.timestamp,
      },
    });
    await this.recordWithdrawal({
      streamId: event.streamId,
      transactionType: StreamWithdrawalType.CLAIMED,
      amount: event.amount,
      recipient: event.recipient,
      txHash: event.txHash,
      timestamp: event.timestamp,
    });
  }

  async parseCancelledEvent(event: StreamCancelledEvent): Promise<void> {
    await this.prisma.stream.update({
      where: { streamId: event.streamId },
      data: {
        status: StreamStatus.CANCELLED,
        cancelledAt: event.timestamp,
      },
    });
    // The cancelling party (creator) receives the refund of the remaining balance.
    await this.recordWithdrawal({
      streamId: event.streamId,
      transactionType: StreamWithdrawalType.CANCELLED,
      amount: event.refundAmount,
      recipient: event.creator,
      txHash: event.txHash,
      timestamp: event.timestamp,
    });
  }

  /**
   * Persist a single withdrawal transaction. Idempotent on replay: the same
   * (streamId, txHash, transactionType) is never stored twice.
   */
  private async recordWithdrawal(withdrawal: {
    streamId: number;
    transactionType: StreamWithdrawalType;
    amount: string;
    recipient: string;
    txHash: string;
    timestamp: Date;
  }): Promise<void> {
    await this.prisma.streamWithdrawal.upsert({
      where: {
        streamId_txHash_transactionType: {
          streamId: withdrawal.streamId,
          txHash: withdrawal.txHash,
          transactionType: withdrawal.transactionType,
        },
      },
      create: {
        streamId: withdrawal.streamId,
        transactionType: withdrawal.transactionType,
        amount: BigInt(withdrawal.amount),
        recipient: withdrawal.recipient,
        txHash: withdrawal.txHash,
        timestamp: withdrawal.timestamp,
      },
      update: {}, // no-op on replay — withdrawal records are immutable
    });
  }

  async parseMetadataUpdatedEvent(event: StreamMetadataUpdatedEvent): Promise<void> {
    // Update stream metadata while preserving financial terms
    // Financial terms (amount, creator, recipient) are immutable and not updated
    await this.prisma.stream.update({
      where: { streamId: event.streamId },
      data: {
        metadata: event.metadata || null,
      },
    });
  }

  async parseEvent(
    event: StreamCreatedEvent | StreamClaimedEvent | StreamCancelledEvent | StreamMetadataUpdatedEvent
  ): Promise<void> {
    switch (event.type) {
      case 'created':
        await this.parseCreatedEvent(event);
        break;
      case 'claimed':
        await this.parseClaimedEvent(event);
        break;
      case 'cancelled':
        await this.parseCancelledEvent(event);
        break;
      case 'metadata_updated':
        await this.parseMetadataUpdatedEvent(event);
        break;
    }
  }

  /**
   * Process events in timestamp order for chronological correctness.
   */
  async processEventsInChronologicalOrder(
    events: Array<
      StreamCreatedEvent | StreamClaimedEvent | StreamCancelledEvent | StreamMetadataUpdatedEvent
    >
  ): Promise<void> {
    const sorted = [...events].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );

    for (const event of sorted) {
      await this.parseEvent(event);
    }
  }
}
