/**
 * Cross-Environment Consistency Tests for StreamProjectionService Reconciliation
 *
 * Verifies that after reconciliation the stream projection is identical
 * regardless of whether events arrived in order or out-of-order. All DB
 * interaction uses a mocked Prisma client (no real DB required).
 *
 * Sequences under test:
 *   A. created → claimed           (happy path)
 *   B. created → cancelled         (cancellation path)
 *   C. out-of-order: claimed arrives before created (buffered, then flushed)
 */

import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import { StreamStatus } from '@prisma/client';

// ── In-memory Prisma mock ─────────────────────────────────────────────────────

type StreamRow = {
  id: string;
  streamId: number;
  creator: string;
  recipient: string;
  amount: bigint;
  metadata?: string | null;
  status: StreamStatus;
  txHash: string;
  createdAt: Date;
  claimedAt?: Date | null;
  cancelledAt?: Date | null;
};

const streamStore = new Map<number, StreamRow>();

const mockPrisma = {
  streamWithdrawal: {
    upsert: vi.fn(async () => ({})),
  },
  stream: {
    upsert: vi.fn(async ({ where, create }: any) => {
      if (!streamStore.has(where.streamId)) {
        const row: StreamRow = { id: `mock-${where.streamId}`, ...create };
        streamStore.set(where.streamId, row);
      }
      return streamStore.get(where.streamId)!;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = streamStore.get(where.streamId);
      if (!row) throw new Error(`Stream ${where.streamId} not found`);
      Object.assign(row, data);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) =>
      streamStore.get(where.streamId) ?? null
    ),
  },
};

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrisma),
  StreamStatus: {
    CREATED: 'CREATED',
    CLAIMED: 'CLAIMED',
    CANCELLED: 'CANCELLED',
  },
}));

// ── Deterministic shuffle (Fisher-Yates with fixed seed) ──────────────────────

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const copy = [...arr];
  let s = seed;
  const rand = () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ── Buffered reconciler (handles out-of-order events) ────────────────────────
//
// Wraps StreamEventParser with a buffer so that a claimed/cancelled event
// arriving before its corresponding created event is held until the created
// event arrives, at which point the buffer is flushed.

import type { StreamCreatedEvent, StreamClaimedEvent, StreamCancelledEvent } from '../types/stream';

type AnyStreamEvent = StreamCreatedEvent | StreamClaimedEvent | StreamCancelledEvent;

class BufferedStreamReconciler {
  private buffer: Map<number, AnyStreamEvent[]> = new Map();
  private parser: any;

  constructor(parser: any) {
    this.parser = parser;
  }

  async process(event: AnyStreamEvent): Promise<void> {
    if (event.type === 'created') {
      await this.parser.parseCreatedEvent(event as StreamCreatedEvent);
      // Flush any buffered events for this streamId
      const buffered = this.buffer.get(event.streamId);
      if (buffered) {
        this.buffer.delete(event.streamId);
        for (const pending of buffered) {
          await this.parser.parseEvent(pending);
        }
      }
    } else {
      try {
        await this.parser.parseEvent(event);
      } catch {
        // Predecessor not yet written — buffer for later
        const q = this.buffer.get(event.streamId) ?? [];
        q.push(event);
        this.buffer.set(event.streamId, q);
      }
    }
  }

  pendingBufferSize(): number {
    let total = 0;
    for (const q of this.buffer.values()) total += q.length;
    return total;
  }
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T01:00:00Z');
const T2 = new Date('2026-01-01T02:00:00Z');

const CREATOR = 'GCREATOR_CONSISTENCY_TEST';
const RECIPIENT = 'GRECIPIENT_CONSISTENCY_TEST';

function makeCreatedEvent(streamId: number): StreamCreatedEvent {
  return {
    type: 'created',
    streamId,
    creator: CREATOR,
    recipient: RECIPIENT,
    amount: '1000000000',
    hasMetadata: false,
    txHash: `tx-created-${streamId}`,
    timestamp: T0,
  };
}

function makeClaimedEvent(streamId: number): StreamClaimedEvent {
  return {
    type: 'claimed',
    streamId,
    recipient: RECIPIENT,
    amount: '1000000000',
    txHash: `tx-claimed-${streamId}`,
    timestamp: T1,
  };
}

function makeCancelledEvent(streamId: number): StreamCancelledEvent {
  return {
    type: 'cancelled',
    streamId,
    creator: CREATOR,
    refundAmount: '1000000000',
    txHash: `tx-cancelled-${streamId}`,
    timestamp: T2,
  };
}

// Three event sequences as arrays of events.
const SEQUENCE_A: AnyStreamEvent[] = [makeCreatedEvent(1), makeClaimedEvent(1)];
const SEQUENCE_B: AnyStreamEvent[] = [makeCreatedEvent(2), makeCancelledEvent(2)];
const SEQUENCE_C: AnyStreamEvent[] = [makeClaimedEvent(3), makeCreatedEvent(3)]; // out-of-order

// ── Test suite ────────────────────────────────────────────────────────────────

describe('StreamProjectionService — Cross-Environment Consistency', () => {
  let StreamEventParser: any;

  beforeAll(async () => {
    ({ StreamEventParser } = await import('../services/streamEventParser'));
  });

  beforeEach(() => {
    streamStore.clear();
    vi.clearAllMocks();
  });

  // ── Sequence A: created → claimed ───────────────────────────────────────

  describe('Sequence A: created → claimed lifecycle', () => {
    it('in-order sequence produces CLAIMED projection', async () => {
      const parser = new StreamEventParser(mockPrisma);
      await parser.processEventsInChronologicalOrder(SEQUENCE_A);

      const row = streamStore.get(1);
      expect(row).toBeDefined();
      expect(row!.status).toBe(StreamStatus.CLAIMED);
      expect(row!.streamId).toBe(1);
      expect(row!.creator).toBe(CREATOR);
      expect(row!.recipient).toBe(RECIPIENT);
      expect(row!.claimedAt).toEqual(T1);
    });

    it('shuffled sequence produces identical projection to in-order', async () => {
      const parser = new StreamEventParser(mockPrisma);
      const shuffled = seededShuffle(SEQUENCE_A, 42);
      await parser.processEventsInChronologicalOrder(shuffled);

      const row = streamStore.get(1);
      expect(row).toBeDefined();
      expect(row!.status).toBe(StreamStatus.CLAIMED);
      expect(row!.claimedAt).toEqual(T1);
      expect(row!.amount.toString()).toBe('1000000000');
    });

    it('in-order and shuffled produce deep-equal projection state', async () => {
      // Run ordered
      const parser1 = new StreamEventParser(mockPrisma);
      await parser1.processEventsInChronologicalOrder(SEQUENCE_A);
      const orderedState = { ...streamStore.get(1) };

      // Reset and run shuffled
      streamStore.clear();
      vi.clearAllMocks();

      const parser2 = new StreamEventParser(mockPrisma);
      const shuffled = seededShuffle(SEQUENCE_A, 1337);
      await parser2.processEventsInChronologicalOrder(shuffled);
      const shuffledState = { ...streamStore.get(1) };

      expect(shuffledState).toEqual(orderedState);
    });
  });

  // ── Sequence B: created → cancelled ────────────────────────────────────

  describe('Sequence B: created → cancelled lifecycle', () => {
    it('in-order sequence produces CANCELLED projection', async () => {
      const parser = new StreamEventParser(mockPrisma);
      await parser.processEventsInChronologicalOrder(SEQUENCE_B);

      const row = streamStore.get(2);
      expect(row).toBeDefined();
      expect(row!.status).toBe(StreamStatus.CANCELLED);
      expect(row!.cancelledAt).toEqual(T2);
    });

    it('shuffled sequence produces identical projection to in-order', async () => {
      const parser = new StreamEventParser(mockPrisma);
      const shuffled = seededShuffle(SEQUENCE_B, 99);
      await parser.processEventsInChronologicalOrder(shuffled);

      const row = streamStore.get(2);
      expect(row!.status).toBe(StreamStatus.CANCELLED);
      expect(row!.cancelledAt).toEqual(T2);
    });

    it('in-order and shuffled produce deep-equal projection state', async () => {
      const parser1 = new StreamEventParser(mockPrisma);
      await parser1.processEventsInChronologicalOrder(SEQUENCE_B);
      const orderedState = { ...streamStore.get(2) };

      streamStore.clear();
      vi.clearAllMocks();

      const parser2 = new StreamEventParser(mockPrisma);
      await parser2.processEventsInChronologicalOrder(seededShuffle(SEQUENCE_B, 7));
      const shuffledState = { ...streamStore.get(2) };

      expect(shuffledState).toEqual(orderedState);
    });
  });

  // ── Sequence C: out-of-order claimed-before-created (buffering) ─────────

  describe('Sequence C: out-of-order claimed-before-created', () => {
    it('claimed event is buffered when stream does not exist yet', async () => {
      const parser = new StreamEventParser(mockPrisma);
      const reconciler = new BufferedStreamReconciler(parser);

      // Process claimed first — stream does not exist, must buffer
      await reconciler.process(makeClaimedEvent(3));
      expect(streamStore.has(3)).toBe(false);
      expect(reconciler.pendingBufferSize()).toBe(1);
    });

    it('buffer is flushed and final state is CLAIMED when created arrives', async () => {
      const parser = new StreamEventParser(mockPrisma);
      const reconciler = new BufferedStreamReconciler(parser);

      // Out-of-order: claimed arrives first
      await reconciler.process(makeClaimedEvent(3));
      expect(reconciler.pendingBufferSize()).toBe(1);

      // Created arrives — buffer flushes automatically
      await reconciler.process(makeCreatedEvent(3));
      expect(reconciler.pendingBufferSize()).toBe(0);

      const row = streamStore.get(3);
      expect(row).toBeDefined();
      expect(row!.status).toBe(StreamStatus.CLAIMED);
      expect(row!.claimedAt).toEqual(T1);
    });

    it('out-of-order and in-order sequences produce deep-equal projections', async () => {
      // --- In-order (uses processEventsInChronologicalOrder to sort) ---
      const parserA = new StreamEventParser(mockPrisma);
      await parserA.processEventsInChronologicalOrder([
        makeCreatedEvent(10),
        makeClaimedEvent(10),
      ]);
      const orderedState = { ...streamStore.get(10) };

      streamStore.clear();
      vi.clearAllMocks();

      // --- Out-of-order (claimed before created) via buffered reconciler ---
      const parserB = new StreamEventParser(mockPrisma);
      const reconciler = new BufferedStreamReconciler(parserB);
      // Process in reverse: claimed first, then created
      await reconciler.process(makeClaimedEvent(10));
      await reconciler.process(makeCreatedEvent(10));
      const outOfOrderState = { ...streamStore.get(10) };

      expect(outOfOrderState).toEqual(orderedState);
    });
  });

  // ── All three sequences together ────────────────────────────────────────

  describe('all three sequences produce consistent state in a combined run', () => {
    it('processes all sequence pairs in parallel with no cross-contamination', async () => {
      const combined: AnyStreamEvent[] = [
        ...SEQUENCE_A,  // streamId 1
        ...SEQUENCE_B,  // streamId 2
        // Sequence C is out-of-order and tested separately via reconciler
      ];
      const shuffled = seededShuffle(combined, 2026);

      const parser = new StreamEventParser(mockPrisma);
      await parser.processEventsInChronologicalOrder(shuffled);

      expect(streamStore.get(1)!.status).toBe(StreamStatus.CLAIMED);
      expect(streamStore.get(2)!.status).toBe(StreamStatus.CANCELLED);
    });

    it('final states match when sequences run ordered vs shuffled', async () => {
      const ordered: AnyStreamEvent[] = [...SEQUENCE_A, ...SEQUENCE_B];

      // Ordered run
      const parser1 = new StreamEventParser(mockPrisma);
      await parser1.processEventsInChronologicalOrder(ordered);
      const s1 = { ...streamStore.get(1) };
      const s2 = { ...streamStore.get(2) };

      streamStore.clear();
      vi.clearAllMocks();

      // Shuffled run
      const parser2 = new StreamEventParser(mockPrisma);
      await parser2.processEventsInChronologicalOrder(seededShuffle(ordered, 555));
      const s1shuffled = { ...streamStore.get(1) };
      const s2shuffled = { ...streamStore.get(2) };

      expect(s1shuffled).toEqual(s1);
      expect(s2shuffled).toEqual(s2);
    });
  });
});
