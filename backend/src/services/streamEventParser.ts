import { PrismaClient, StreamStatus } from '@prisma/client';
import { StreamCreatedEvent, StreamClaimedEvent, StreamCancelledEvent, StreamMetadataUpdatedEvent } from '../types/stream';

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
  }

  async parseCancelledEvent(event: StreamCancelledEvent): Promise<void> {
    await this.prisma.stream.update({
      where: { streamId: event.streamId },
      data: {
        status: StreamStatus.CANCELLED,
        cancelledAt: event.timestamp,
      },
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
}
