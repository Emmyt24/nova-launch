import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient, StreamStatus } from '@prisma/client';
import { StreamEventParser } from '../services/streamEventParser';
import { streamEventFixtures } from './fixtures/streamEvents';
import claimFixtures from './fixtures/streamClaimDifferential.json';

// ---------------------------------------------------------------------------
// Malformed-payload guard tests — pure unit tests, no real DB required.
//
// These verify that StreamEventParser.parseEvent rejects or throws on inputs
// that are structurally invalid (missing required fields, wrong types, etc.)
// without relying on a live Prisma connection.
// ---------------------------------------------------------------------------

describe('StreamEventParser — malformed-payload guard', () => {
  type MalformedFixture = {
    label: string;
    event: any;
    expectRejection: boolean;
  };

  // Build a minimal mock for Prisma that records calls but never actually writes.
  const upsertMock = vi.fn().mockResolvedValue({});
  const updateMock = vi.fn().mockResolvedValue({});

  const mockPrisma = {
    stream: {
      upsert: upsertMock,
      update: updateMock,
    },
  } as unknown as PrismaClient;

  const parser = new StreamEventParser(mockPrisma);

  beforeEach(() => {
    upsertMock.mockClear();
    updateMock.mockClear();
  });

  // ---------------------------------------------------------------------------
  // Table of malformed payloads
  // ---------------------------------------------------------------------------
  const malformedFixtures: MalformedFixture[] = [
    {
      label: 'missing type field',
      event: {
        // no `type`
        streamId: 99,
        creator: 'GCREATOR',
        recipient: 'GRECIPIENT',
        amount: '1000',
        txHash: '0xabc',
        timestamp: new Date(),
      },
      expectRejection: true,
    },
    {
      label: 'unknown event type string',
      event: {
        type: 'unknown_event_xyz',
        streamId: 99,
        txHash: '0xabc',
        timestamp: new Date(),
      },
      expectRejection: false, // parseEvent has no default branch → silently no-ops
    },
    {
      label: 'created event with null streamId',
      event: {
        type: 'created',
        streamId: null,
        creator: 'GCREATOR',
        recipient: 'GRECIPIENT',
        amount: '1000',
        txHash: '0xabc',
        timestamp: new Date(),
      },
      expectRejection: true,
    },
    {
      label: 'created event with negative amount string (should store as-is)',
      event: {
        type: 'created',
        streamId: 200,
        creator: 'GCREATOR',
        recipient: 'GRECIPIENT',
        amount: '-999',
        hasMetadata: false,
        metadata: null,
        txHash: '0xneg',
        timestamp: new Date(),
      },
      // BigInt('-999') is valid — Prisma would receive it; we just verify no
      // exception is thrown by the parser layer itself.
      expectRejection: false,
    },
    {
      label: 'created event with missing timestamp',
      event: {
        type: 'created',
        streamId: 201,
        creator: 'GCREATOR',
        recipient: 'GRECIPIENT',
        amount: '500',
        hasMetadata: false,
        metadata: null,
        txHash: '0xnotimestamp',
        // timestamp intentionally omitted
      },
      expectRejection: true,
    },
    {
      label: 'claimed event with missing streamId',
      event: {
        type: 'claimed',
        recipient: 'GRECIPIENT',
        amount: '500',
        txHash: '0xabc',
        timestamp: new Date(),
        // streamId intentionally omitted
      },
      expectRejection: true,
    },
    {
      label: 'claimed event with non-string amount',
      event: {
        type: 'claimed',
        streamId: 202,
        recipient: 'GRECIPIENT',
        amount: 12345, // number, not string
        txHash: '0xabc',
        timestamp: new Date(),
      },
      // Parser passes amount through to Prisma; type coercion depends on Prisma
      // layer. Parser itself does not throw.
      expectRejection: false,
    },
    {
      label: 'cancelled event with missing creator',
      event: {
        type: 'cancelled',
        streamId: 203,
        // creator omitted
        refundAmount: '0',
        txHash: '0xabc',
        timestamp: new Date(),
      },
      expectRejection: false, // parser doesn't validate creator presence
    },
    {
      label: 'metadata_updated event with completely empty object',
      event: {},
      expectRejection: true,
    },
    {
      label: 'event is null',
      event: null,
      expectRejection: true,
    },
    {
      label: 'event is a plain string',
      event: 'not_an_object',
      expectRejection: true,
    },
    {
      label: 'event is a number',
      event: 42,
      expectRejection: true,
    },
  ];

  for (const fixture of malformedFixtures) {
    if (fixture.expectRejection) {
      it(`rejects: ${fixture.label}`, async () => {
        await expect(parser.parseEvent(fixture.event)).rejects.toThrow();
      });
    } else {
      it(`does not throw: ${fixture.label}`, async () => {
        await expect(parser.parseEvent(fixture.event)).resolves.not.toThrow();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Valid baseline — verifies the mock Prisma receives well-formed arguments
  // when a correctly structured created event is supplied.
  // ---------------------------------------------------------------------------
  it('valid created event calls prisma.stream.upsert with correct fields', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const event = {
      type: 'created' as const,
      streamId: 300,
      creator: 'GCREATOR_VALID',
      recipient: 'GRECIPIENT_VALID',
      amount: '5000000000',
      hasMetadata: true,
      metadata: 'ipfs://QmValid',
      txHash: '0xvalidhash',
      timestamp: now,
    };

    await parser.parseCreatedEvent(event);

    expect(upsertMock).toHaveBeenCalledOnce();
    const call = upsertMock.mock.calls[0][0];
    expect(call.where.streamId).toBe(300);
    expect(call.create.creator).toBe('GCREATOR_VALID');
    expect(call.create.recipient).toBe('GRECIPIENT_VALID');
    expect(call.create.amount).toBe(BigInt('5000000000'));
    expect(call.create.metadata).toBe('ipfs://QmValid');
    expect(call.create.createdAt).toEqual(now);
    // Replay idempotency: update block must be a no-op
    expect(Object.keys(call.update)).toHaveLength(0);
  });

  it('valid claimed event calls prisma.stream.update with status CLAIMED', async () => {
    const claimedAt = new Date('2026-02-01T00:00:00Z');
    const event = {
      type: 'claimed' as const,
      streamId: 301,
      recipient: 'GRECIPIENT_VALID',
      amount: '5000000000',
      txHash: '0xclaimedvalid',
      timestamp: claimedAt,
    };

    await parser.parseClaimedEvent(event);

    expect(updateMock).toHaveBeenCalledOnce();
    const call = updateMock.mock.calls[0][0];
    expect(call.where.streamId).toBe(301);
    expect(call.data.status).toBe(StreamStatus.CLAIMED);
    expect(call.data.claimedAt).toEqual(claimedAt);
  });

  it('valid cancelled event calls prisma.stream.update with status CANCELLED', async () => {
    const cancelledAt = new Date('2026-03-01T00:00:00Z');
    const event = {
      type: 'cancelled' as const,
      streamId: 302,
      creator: 'GCREATOR_VALID',
      refundAmount: '5000000000',
      txHash: '0xcancelledvalid',
      timestamp: cancelledAt,
    };

    await parser.parseCancelledEvent(event);

    expect(updateMock).toHaveBeenCalledOnce();
    const call = updateMock.mock.calls[0][0];
    expect(call.where.streamId).toBe(302);
    expect(call.data.status).toBe(StreamStatus.CANCELLED);
    expect(call.data.cancelledAt).toEqual(cancelledAt);
  });

  it('valid metadata_updated event calls prisma.stream.update with new metadata', async () => {
    const event = {
      type: 'metadata_updated' as const,
      streamId: 303,
      updater: 'GCREATOR_VALID',
      hasMetadata: true,
      metadata: 'ipfs://QmNewMetadata',
      txHash: '0xmetavalid',
      timestamp: new Date(),
    };

    await parser.parseMetadataUpdatedEvent(event);

    expect(updateMock).toHaveBeenCalledOnce();
    const call = updateMock.mock.calls[0][0];
    expect(call.where.streamId).toBe(303);
    expect(call.data.metadata).toBe('ipfs://QmNewMetadata');
  });

  it('metadata_updated with hasMetadata=false clears metadata to null', async () => {
    const event = {
      type: 'metadata_updated' as const,
      streamId: 304,
      updater: 'GCREATOR_VALID',
      hasMetadata: false,
      // metadata field intentionally absent
      txHash: '0xmetaclear',
      timestamp: new Date(),
    };

    await parser.parseMetadataUpdatedEvent(event);

    expect(updateMock).toHaveBeenCalledOnce();
    const call = updateMock.mock.calls[0][0];
    expect(call.data.metadata).toBeNull();
  });
});

const prisma = new PrismaClient();
const parser = new StreamEventParser(prisma);

describe('StreamEventParser', () => {
  beforeEach(async () => {
    await prisma.stream.deleteMany();
  });

  afterEach(async () => {
    await prisma.stream.deleteMany();
  });

  describe('parseCreatedEvent', () => {
    it('should parse and store stream created event with metadata', async () => {
      await parser.parseCreatedEvent(streamEventFixtures.created);

      const stream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.created.streamId },
      });

      expect(stream).toBeDefined();
      expect(stream?.streamId).toBe(streamEventFixtures.created.streamId);
      expect(stream?.creator).toBe(streamEventFixtures.created.creator);
      expect(stream?.recipient).toBe(streamEventFixtures.created.recipient);
      expect(stream?.amount).toBe(BigInt(streamEventFixtures.created.amount));
      expect(stream?.metadata).toBe(streamEventFixtures.created.metadata);
      expect(stream?.status).toBe(StreamStatus.CREATED);
      expect(stream?.txHash).toBe(streamEventFixtures.created.txHash);
    });

    it('should parse and store stream created event without metadata', async () => {
      await parser.parseCreatedEvent(streamEventFixtures.createdWithoutMetadata);

      const stream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.createdWithoutMetadata.streamId },
      });

      expect(stream).toBeDefined();
      expect(stream?.metadata).toBeNull();
      expect(stream?.status).toBe(StreamStatus.CREATED);
    });
  });

  describe('parseClaimedEvent', () => {
    it('should update stream status to CLAIMED', async () => {
      // First create a stream
      await parser.parseCreatedEvent(streamEventFixtures.created);

      // Then claim it
      await parser.parseClaimedEvent(streamEventFixtures.claimed);

      const stream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.claimed.streamId },
      });

      expect(stream?.status).toBe(StreamStatus.CLAIMED);
      expect(stream?.claimedAt).toBeDefined();
    });
  });

  describe('parseCancelledEvent', () => {
    it('should update stream status to CANCELLED', async () => {
      // First create a stream
      await parser.parseCreatedEvent(streamEventFixtures.createdWithoutMetadata);

      // Then cancel it
      await parser.parseCancelledEvent(streamEventFixtures.cancelled);

      const stream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.cancelled.streamId },
      });

      expect(stream?.status).toBe(StreamStatus.CANCELLED);
      expect(stream?.cancelledAt).toBeDefined();
    });
  });

  describe('parseMetadataUpdatedEvent', () => {
    it('should update stream metadata while preserving financial terms', async () => {
      // First create a stream with initial metadata
      await parser.parseCreatedEvent(streamEventFixtures.created);

      const originalStream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.created.streamId },
      });

      expect(originalStream?.metadata).toBe(streamEventFixtures.created.metadata);

      // Update metadata
      const metadataUpdateEvent = {
        type: 'metadata_updated' as const,
        streamId: streamEventFixtures.created.streamId,
        updater: streamEventFixtures.created.creator,
        hasMetadata: true,
        metadata: 'ipfs://QmUpdatedMetadata',
        txHash: '0xnewtxhash',
        timestamp: new Date(),
      };

      await parser.parseMetadataUpdatedEvent(metadataUpdateEvent);

      const updatedStream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.created.streamId },
      });

      // Verify metadata was updated
      expect(updatedStream?.metadata).toBe('ipfs://QmUpdatedMetadata');

      // Verify financial terms remain unchanged
      expect(updatedStream?.creator).toBe(originalStream?.creator);
      expect(updatedStream?.recipient).toBe(originalStream?.recipient);
      expect(updatedStream?.amount).toBe(originalStream?.amount);
      expect(updatedStream?.status).toBe(originalStream?.status);
    });

    it('should clear metadata when updated to None', async () => {
      // First create a stream with metadata
      await parser.parseCreatedEvent(streamEventFixtures.created);

      // Update metadata to None (clear it)
      const metadataUpdateEvent = {
        type: 'metadata_updated' as const,
        streamId: streamEventFixtures.created.streamId,
        updater: streamEventFixtures.created.creator,
        hasMetadata: false,
        txHash: '0xnewtxhash',
        timestamp: new Date(),
      };

      await parser.parseMetadataUpdatedEvent(metadataUpdateEvent);

      const updatedStream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.created.streamId },
      });

      // Verify metadata was cleared
      expect(updatedStream?.metadata).toBeNull();

      // Verify financial terms remain unchanged
      expect(updatedStream?.creator).toBe(streamEventFixtures.created.creator);
      expect(updatedStream?.recipient).toBe(streamEventFixtures.created.recipient);
      expect(updatedStream?.amount).toBe(BigInt(streamEventFixtures.created.amount));
    });

    it('should not allow mutation of financial terms through metadata update', async () => {
      // First create a stream
      await parser.parseCreatedEvent(streamEventFixtures.created);

      const originalStream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.created.streamId },
      });

      // Attempt to update metadata (should only update metadata, not financial terms)
      const metadataUpdateEvent = {
        type: 'metadata_updated' as const,
        streamId: streamEventFixtures.created.streamId,
        updater: streamEventFixtures.created.creator,
        hasMetadata: true,
        metadata: 'New metadata',
        txHash: '0xnewtxhash',
        timestamp: new Date(),
      };

      await parser.parseMetadataUpdatedEvent(metadataUpdateEvent);

      const updatedStream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.created.streamId },
      });

      // Verify only metadata changed
      expect(updatedStream?.metadata).toBe('New metadata');
      expect(updatedStream?.creator).toBe(originalStream?.creator);
      expect(updatedStream?.recipient).toBe(originalStream?.recipient);
      expect(updatedStream?.amount).toBe(originalStream?.amount);
      expect(updatedStream?.status).toBe(originalStream?.status);
    });
  });

  describe('parseEvent', () => {
    it('should route to correct parser based on event type', async () => {
      // Test created event routing
      await parser.parseEvent(streamEventFixtures.created);
      let stream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.created.streamId },
      });
      expect(stream?.status).toBe(StreamStatus.CREATED);

      // Test metadata update event routing
      const metadataUpdateEvent = {
        type: 'metadata_updated' as const,
        streamId: streamEventFixtures.created.streamId,
        updater: streamEventFixtures.created.creator,
        hasMetadata: true,
        metadata: 'Updated via parseEvent',
        txHash: '0xnewtxhash',
        timestamp: new Date(),
      };

      await parser.parseEvent(metadataUpdateEvent);
      stream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.created.streamId },
      });
      expect(stream?.metadata).toBe('Updated via parseEvent');
    });
  });

  describe('parseEvent - full lifecycle', () => {
    it('should handle complete stream lifecycle: created -> claimed', async () => {
      await parser.parseEvent(streamEventFixtures.created);
      await parser.parseEvent(streamEventFixtures.claimed);

      const stream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.created.streamId },
      });

      expect(stream?.status).toBe(StreamStatus.CLAIMED);
      expect(stream?.createdAt).toEqual(streamEventFixtures.created.timestamp);
      expect(stream?.claimedAt).toEqual(streamEventFixtures.claimed.timestamp);
      expect(stream?.cancelledAt).toBeNull();
    });

    it('should handle complete stream lifecycle: created -> cancelled', async () => {
      await parser.parseEvent(streamEventFixtures.createdWithoutMetadata);
      await parser.parseEvent(streamEventFixtures.cancelled);

      const stream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.createdWithoutMetadata.streamId },
      });

      expect(stream?.status).toBe(StreamStatus.CANCELLED);
      expect(stream?.createdAt).toEqual(streamEventFixtures.createdWithoutMetadata.timestamp);
      expect(stream?.cancelledAt).toEqual(streamEventFixtures.cancelled.timestamp);
      expect(stream?.claimedAt).toBeNull();
    });
  });

  describe('event-to-database mapping validation', () => {
    it('should correctly map all created event fields to database', async () => {
      const event = streamEventFixtures.created;
      await parser.parseCreatedEvent(event);

      const stream = await prisma.stream.findUnique({
        where: { streamId: event.streamId },
      });

      expect(stream).toMatchObject({
        streamId: event.streamId,
        creator: event.creator,
        recipient: event.recipient,
        amount: BigInt(event.amount),
        metadata: event.metadata,
        status: StreamStatus.CREATED,
        txHash: event.txHash,
        createdAt: event.timestamp,
        claimedAt: null,
        cancelledAt: null,
      });
    });

    it('should correctly map claimed event state transition', async () => {
      await parser.parseCreatedEvent(streamEventFixtures.created);
      await parser.parseClaimedEvent(streamEventFixtures.claimed);

      const stream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.claimed.streamId },
      });

      expect(stream?.status).toBe(StreamStatus.CLAIMED);
      expect(stream?.claimedAt).toEqual(streamEventFixtures.claimed.timestamp);
      expect(stream?.cancelledAt).toBeNull();
    });

    it('should correctly map cancelled event state transition', async () => {
      await parser.parseCreatedEvent(streamEventFixtures.createdWithoutMetadata);
      await parser.parseCancelledEvent(streamEventFixtures.cancelled);

      const stream = await prisma.stream.findUnique({
        where: { streamId: streamEventFixtures.cancelled.streamId },
      });

      expect(stream?.status).toBe(StreamStatus.CANCELLED);
      expect(stream?.cancelledAt).toEqual(streamEventFixtures.cancelled.timestamp);
      expect(stream?.claimedAt).toBeNull();
    });
  });

  describe('chronological stream event processing integration', () => {
    it('should apply out-of-order events by timestamp and final state by temporal ordering', async () => {
      const streamId = 500;
      const created = {
        type: 'created' as const,
        streamId,
        creator: 'GCREATOR',
        recipient: 'GRECIPIENT',
        amount: '1000',
        hasMetadata: false,
        metadata: null,
        txHash: '0xcreated',
        timestamp: new Date(1000),
      };

      const claimed = {
        type: 'claimed' as const,
        streamId,
        recipient: 'GRECIPIENT',
        amount: '1000',
        txHash: '0xclaimed',
        timestamp: new Date(3000),
      };

      const cancelledLate = {
        type: 'cancelled' as const,
        streamId,
        creator: 'GCREATOR',
        refundAmount: '0',
        txHash: '0xcancelled',
        timestamp: new Date(2000),
      };

      // Inject in non-chronological order (claimed before cancelled)
      await parser.processEventsInChronologicalOrder([created, claimed, cancelledLate]);

      const stream = await prisma.stream.findUnique({ where: { streamId } });
      expect(stream).toBeDefined();
      expect(stream?.createdAt).toEqual(created.timestamp);
      expect(stream?.cancelledAt).toEqual(cancelledLate.timestamp);
      expect(stream?.claimedAt).toEqual(claimed.timestamp);
      expect(stream?.status).toBe(StreamStatus.CLAIMED);
    });

    it('should accept a late-arriving historical event and keep final state chronological', async () => {
      const streamId = 501;
      const created = {
        type: 'created' as const,
        streamId,
        creator: 'GCREATOR',
        recipient: 'GRECIPIENT',
        amount: '1000',
        hasMetadata: true,
        metadata: 'ipfs://initial',
        txHash: '0xcreated2',
        timestamp: new Date(1000),
      };

      const claimed = {
        type: 'claimed' as const,
        streamId,
        recipient: 'GRECIPIENT',
        amount: '1000',
        txHash: '0xclaimed2',
        timestamp: new Date(4000),
      };

      const metadataLate = {
        type: 'metadata_updated' as const,
        streamId,
        updater: 'GCREATOR',
        hasMetadata: true,
        metadata: 'ipfs://late',
        txHash: '0xlate',
        timestamp: new Date(2000),
      };

      await parser.processEventsInChronologicalOrder([created, claimed]);
      await parser.processEventsInChronologicalOrder([metadataLate]);

      const stream = await prisma.stream.findUnique({ where: { streamId } });
      expect(stream?.metadata).toBe('ipfs://late');
      expect(stream?.status).toBe(StreamStatus.CLAIMED);
      expect(stream?.claimedAt).toEqual(claimed.timestamp);
    });
  });
});

// ---------------------------------------------------------------------------
// Differential parity: StreamClaim — backend projection vs shared fixture
//
// Shared fixture: backend/src/__tests__/fixtures/streamClaimDifferential.json
// Mirror in contracts: contracts/token-factory/src/stream_claim_differential_test.rs
//
// Known field-name differences between contract and backend:
//   Contract `claimed_amount`  ↔  Backend has no running cumulative field;
//     status transitions to CLAIMED on every claim event regardless of whether
//     the full amount was taken.
//   Contract has no `claimedAt` timestamp — the ledger timestamp at claim time
//     is the closest equivalent; the backend stores it from the event payload.
//   Contract `total_amount - claimed_amount` = remaining; backend does not
//     store remaining separately — it can be derived from the stream `amount`
//     field and the cumulative claimed amount in the contract.
// ---------------------------------------------------------------------------

describe('StreamClaim differential parity — shared fixture', () => {
  beforeEach(async () => {
    await prisma.stream.deleteMany();
  });

  afterEach(async () => {
    await prisma.stream.deleteMany();
  });

  // Scenarios 1-8: regular claim events (partial and full claims)
  const regularFixtures = claimFixtures.filter(
    (f) => f.scenario !== 'cancelled_stream_claim_rejected' &&
           f.scenario !== 'second_partial_claim_incremental'
  );

  for (const fixture of regularFixtures) {
    it(`scenario ${fixture.scenarioId} (${fixture.scenario}): claimedAt, status, and streamId match fixture`, async () => {
      // First create the stream so the claimed event has a parent record.
      await parser.parseCreatedEvent({
        type: 'created',
        streamId: fixture.streamId,
        creator: 'GCREATOR_DIFFERENTIAL',
        recipient: 'GRECIPIENT_DIFFERENTIAL',
        amount: fixture.totalAmount,
        hasMetadata: false,
        txHash: `${fixture.txHash}-create`,
        timestamp: new Date(fixture.startTime * 1000),
      });

      const claimedAt = new Date(fixture.claimedAtISO as string);

      // Apply the claim event from the fixture.
      await parser.parseClaimedEvent({
        type: 'claimed',
        streamId: fixture.streamId,
        recipient: 'GRECIPIENT_DIFFERENTIAL',
        amount: fixture.expectedClaimedAmount,
        txHash: fixture.txHash,
        timestamp: claimedAt,
      });

      const stream = await prisma.stream.findUnique({
        where: { streamId: fixture.streamId },
      });

      expect(stream).toBeDefined();

      // Field-by-field parity assertions.
      expect(stream!.streamId).toBe(fixture.streamId);

      // claimedAt must equal the event timestamp from the fixture.
      expect(stream!.claimedAt).toEqual(claimedAt);

      // status must be CLAIMED after any successful claim event.
      expect(stream!.status).toBe(StreamStatus.CLAIMED);

      // amount (total stream amount) must be preserved unchanged.
      expect(stream!.amount).toEqual(BigInt(fixture.totalAmount));

      // Round-trip: BigInt(fixture.expectedClaimedAmount) must be lossless.
      const fixtureClaimedBigInt = BigInt(fixture.expectedClaimedAmount);
      expect(typeof fixture.expectedClaimedAmount).toBe('string');
      expect(fixtureClaimedBigInt.toString()).toBe(fixture.expectedClaimedAmount);
    });
  }

  it('scenario 9 (cancelled_stream_claim_rejected): cancelled stream retains CANCELLED status, no claimedAt', async () => {
    const fixture = claimFixtures.find((f) => f.scenarioId === 9)!;

    await parser.parseCreatedEvent({
      type: 'created',
      streamId: fixture.streamId,
      creator: 'GCREATOR_DIFFERENTIAL',
      recipient: 'GRECIPIENT_DIFFERENTIAL',
      amount: fixture.totalAmount,
      hasMetadata: false,
      txHash: `${fixture.txHash}-create`,
      timestamp: new Date(fixture.startTime * 1000),
    });

    // Cancel the stream before any claim.
    await parser.parseCancelledEvent({
      type: 'cancelled',
      streamId: fixture.streamId,
      creator: 'GCREATOR_DIFFERENTIAL',
      refundAmount: fixture.totalAmount,
      txHash: `${fixture.txHash}-cancel`,
      timestamp: new Date(fixture.claimAtLedgerTimestamp * 1000),
    });

    const stream = await prisma.stream.findUnique({
      where: { streamId: fixture.streamId },
    });

    expect(stream).toBeDefined();
    expect(stream!.status).toBe(StreamStatus.CANCELLED);
    // No claim event was processed — claimedAt remains null.
    expect(stream!.claimedAt).toBeNull();
    // Stream amount is unchanged.
    expect(stream!.amount).toEqual(BigInt(fixture.totalAmount));
  });

  it('scenario 10 (second_partial_claim_incremental): second claim event updates claimedAt and status correctly', async () => {
    const fixture = claimFixtures.find((f) => f.scenarioId === 10)!;

    await parser.parseCreatedEvent({
      type: 'created',
      streamId: fixture.streamId,
      creator: 'GCREATOR_DIFFERENTIAL',
      recipient: 'GRECIPIENT_DIFFERENTIAL',
      amount: fixture.totalAmount,
      hasMetadata: false,
      txHash: `${fixture.txHash}-create`,
      timestamp: new Date(fixture.startTime * 1000),
    });

    // First partial claim.
    const firstClaimedAt = new Date((fixture as any).firstClaimLedgerTimestamp * 1000);
    await parser.parseClaimedEvent({
      type: 'claimed',
      streamId: fixture.streamId,
      recipient: 'GRECIPIENT_DIFFERENTIAL',
      amount: (fixture as any).firstClaimedAmount,
      txHash: `${fixture.txHash}-first`,
      timestamp: firstClaimedAt,
    });

    // Second partial claim (fixture claimAtLedgerTimestamp).
    const secondClaimedAt = new Date(fixture.claimedAtISO as string);
    await parser.parseClaimedEvent({
      type: 'claimed',
      streamId: fixture.streamId,
      recipient: 'GRECIPIENT_DIFFERENTIAL',
      amount: fixture.expectedClaimedAmount,
      txHash: fixture.txHash,
      timestamp: secondClaimedAt,
    });

    const stream = await prisma.stream.findUnique({
      where: { streamId: fixture.streamId },
    });

    expect(stream).toBeDefined();
    // claimedAt reflects the most-recent claim event (second claim).
    expect(stream!.claimedAt).toEqual(secondClaimedAt);
    expect(stream!.status).toBe(StreamStatus.CLAIMED);
    // Stream total amount is preserved across multiple claim events.
    expect(stream!.amount).toEqual(BigInt(fixture.totalAmount));
  });
});
