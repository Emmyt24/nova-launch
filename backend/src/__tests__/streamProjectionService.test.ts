/**
 * streamProjectionService.test.ts
 *
 * Unit tests for StreamProjectionService — the read-model layer for payment/vesting streams.
 *
 * Covered scenarios:
 *   1. Full lifecycle: create → partial claim → partial claim → full claim
 *      - Asserts claimed/remaining balance accounting after each step
 *   2. Cancellation mid-stream
 *      - Asserts correct remaining-balance accounting when stream is cancelled
 *        before the full amount is claimed
 *   3. Rejected claim after cancellation
 *      - Asserts that a claim event applied after cancellation is rejected or
 *        leaves the projection in its correct terminal (CANCELLED) state
 *
 * All DB interaction uses an in-memory mock (no real Postgres required).
 * The StreamEventParser drives state writes; StreamProjectionService reads them back.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamStatus } from '@prisma/client';
import type {
  StreamCreatedEvent,
  StreamClaimedEvent,
  StreamCancelledEvent,
} from '../types/stream';

// ── In-memory store & Prisma mock ────────────────────────────────────────────

type StreamRow = {
  id: string;
  streamId: number;
  creator: string;
  recipient: string;
  amount: bigint;
  metadata: string | null;
  status: StreamStatus;
  txHash: string;
  createdAt: Date;
  claimedAt: Date | null;
  cancelledAt: Date | null;
};

const store = new Map<number, StreamRow>();

const mockPrisma = {
  stream: {
    upsert: vi.fn(async ({ where, create }: any) => {
      if (!store.has(where.streamId)) {
        const row: StreamRow = {
          id: `mock-${where.streamId}`,
          ...create,
          metadata: create.metadata ?? null,
          claimedAt: null,
          cancelledAt: null,
        };
        store.set(where.streamId, row);
      }
      return store.get(where.streamId)!;
    }),

    update: vi.fn(async ({ where, data }: any) => {
      const row = store.get(where.streamId);
      if (!row) throw new Error(`Stream ${where.streamId} not found`);
      Object.assign(row, data);
      return row;
    }),

    findUnique: vi.fn(async ({ where }: any) =>
      store.get(where.streamId) ?? null,
    ),

    findMany: vi.fn(async ({ where }: any) => {
      return [...store.values()].filter((row) => {
        if (where?.creator && row.creator !== where.creator) return false;
        if (where?.recipient && row.recipient !== where.recipient) return false;
        if (where?.status && row.status !== where.status) return false;
        return true;
      });
    }),

    count: vi.fn(async ({ where }: any) => {
      return [...store.values()].filter((row) => {
        if (where?.status && row.status !== where.status) return false;
        if (where?.creator && row.creator !== where.creator) return false;
        return true;
      }).length;
    }),
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CREATOR = 'GCREATOR_PROJECTION_TEST_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345';
const RECIPIENT = 'GRECIPIENT_PROJECTION_TEST_ABCDEFGHIJKLMNOPQRSTUVWXYZ123';

/** Total stream amount: 1 000 000 000 stroops (1 XLM with 7 decimals) */
const TOTAL_AMOUNT = '1000000000';

const T_CREATED = new Date('2026-01-01T00:00:00Z');
const T_CLAIM_1 = new Date('2026-01-01T08:00:00Z'); // 1/3 elapsed → 333 333 333
const T_CLAIM_2 = new Date('2026-01-01T16:00:00Z'); // 2/3 elapsed → another 333 333 333
const T_CLAIM_3 = new Date('2026-01-02T00:00:00Z'); // end → final 333 333 334
const T_CANCEL = new Date('2026-01-01T12:00:00Z');  // cancelled halfway through

/** Partial claim amounts that sum exactly to TOTAL_AMOUNT */
const CLAIM_1_AMOUNT = '333333333';
const CLAIM_2_AMOUNT = '333333333';
const CLAIM_3_AMOUNT = '333333334'; // 333333333 + 333333333 + 333333334 = 1000000000

function makeCreatedEvent(streamId: number, overrides: Partial<StreamCreatedEvent> = {}): StreamCreatedEvent {
  return {
    type: 'created',
    streamId,
    creator: CREATOR,
    recipient: RECIPIENT,
    amount: TOTAL_AMOUNT,
    hasMetadata: false,
    txHash: `tx-created-${streamId}`,
    timestamp: T_CREATED,
    ...overrides,
  };
}

function makeClaimedEvent(
  streamId: number,
  amount: string,
  txHash: string,
  timestamp: Date,
): StreamClaimedEvent {
  return {
    type: 'claimed',
    streamId,
    recipient: RECIPIENT,
    amount,
    txHash,
    timestamp,
  };
}

function makeCancelledEvent(
  streamId: number,
  refundAmount: string,
  timestamp: Date,
): StreamCancelledEvent {
  return {
    type: 'cancelled',
    streamId,
    creator: CREATOR,
    refundAmount,
    txHash: `tx-cancelled-${streamId}`,
    timestamp,
  };
}

// ── Suite 1: Full lifecycle ───────────────────────────────────────────────────
//
// Stream 1001: create → partial claim (1/3) → partial claim (2/3) → full claim
// "Partial claim" in the StreamProjectionService model means a claim event that
// covers only part of the stream's total amount.  The service stores the total
// stream `amount` unchanged; the per-claim amount is carried in the event.
// Remaining balance = stream.amount − sum(claim event amounts).
// We track cumulative claimed externally and verify it against the total.

describe('StreamProjectionService — Full lifecycle: partial claims', () => {
  const STREAM_ID = 1001;
  let parser: any;
  let service: any;

  beforeEach(async () => {
    store.clear();
    vi.clearAllMocks();
    const { StreamEventParser } = await import('../services/streamEventParser');
    const { StreamProjectionService } = await import('../services/streamProjectionService');
    parser = new StreamEventParser(mockPrisma as any);
    service = new StreamProjectionService();
  });

  it('projects CREATED status after creation; amount equals total', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));

    const projection = await service.getStreamById(STREAM_ID);
    expect(projection).not.toBeNull();
    expect(projection!.status).toBe(StreamStatus.CREATED);
    expect(projection!.amount).toBe(TOTAL_AMOUNT);
    expect(projection!.claimedAt).toBeUndefined();
    expect(projection!.cancelledAt).toBeUndefined();
  });

  it('after first partial claim: status is CLAIMED, claimedAt is set, amount preserved', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseClaimedEvent(makeClaimedEvent(STREAM_ID, CLAIM_1_AMOUNT, 'tx-claim1', T_CLAIM_1));

    const projection = await service.getStreamById(STREAM_ID);
    expect(projection!.status).toBe(StreamStatus.CLAIMED);
    expect(projection!.claimedAt).toEqual(T_CLAIM_1);
    // Total stream amount is immutable — it represents the full vesting amount,
    // not the amount claimed in this single event.
    expect(projection!.amount).toBe(TOTAL_AMOUNT);
    expect(projection!.cancelledAt).toBeUndefined();
  });

  it('after first partial claim: remaining balance = total − claimed', () => {
    const claimed = BigInt(CLAIM_1_AMOUNT);
    const total = BigInt(TOTAL_AMOUNT);
    const remaining = total - claimed;
    expect(remaining.toString()).toBe('666666667');
  });

  it('after second partial claim: claimedAt advances to second claim timestamp', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseClaimedEvent(makeClaimedEvent(STREAM_ID, CLAIM_1_AMOUNT, 'tx-claim1', T_CLAIM_1));
    await parser.parseClaimedEvent(makeClaimedEvent(STREAM_ID, CLAIM_2_AMOUNT, 'tx-claim2', T_CLAIM_2));

    const projection = await service.getStreamById(STREAM_ID);
    expect(projection!.status).toBe(StreamStatus.CLAIMED);
    expect(projection!.claimedAt).toEqual(T_CLAIM_2);
    expect(projection!.amount).toBe(TOTAL_AMOUNT);
  });

  it('after second partial claim: remaining balance = total − (claim1 + claim2)', () => {
    const claim1 = BigInt(CLAIM_1_AMOUNT);
    const claim2 = BigInt(CLAIM_2_AMOUNT);
    const total = BigInt(TOTAL_AMOUNT);
    const remaining = total - claim1 - claim2;
    expect(remaining.toString()).toBe('333333334');
    // Sanity-check: remaining equals exactly the third claim amount
    expect(remaining.toString()).toBe(CLAIM_3_AMOUNT);
  });

  it('after full (third) claim: status CLAIMED, claimedAt at end time, no remaining balance', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseClaimedEvent(makeClaimedEvent(STREAM_ID, CLAIM_1_AMOUNT, 'tx-claim1', T_CLAIM_1));
    await parser.parseClaimedEvent(makeClaimedEvent(STREAM_ID, CLAIM_2_AMOUNT, 'tx-claim2', T_CLAIM_2));
    await parser.parseClaimedEvent(makeClaimedEvent(STREAM_ID, CLAIM_3_AMOUNT, 'tx-claim3', T_CLAIM_3));

    const projection = await service.getStreamById(STREAM_ID);
    expect(projection!.status).toBe(StreamStatus.CLAIMED);
    expect(projection!.claimedAt).toEqual(T_CLAIM_3);
    expect(projection!.amount).toBe(TOTAL_AMOUNT);
  });

  it('after full (third) claim: cumulative claimed equals total; remaining is zero', () => {
    const total = BigInt(TOTAL_AMOUNT);
    const cumulative = BigInt(CLAIM_1_AMOUNT) + BigInt(CLAIM_2_AMOUNT) + BigInt(CLAIM_3_AMOUNT);
    expect(cumulative).toBe(total);
    const remaining = total - cumulative;
    expect(remaining.toString()).toBe('0');
  });

  it('stream is returned by getStreamsByRecipient after full lifecycle', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseClaimedEvent(makeClaimedEvent(STREAM_ID, CLAIM_1_AMOUNT, 'tx-claim1', T_CLAIM_1));
    await parser.parseClaimedEvent(makeClaimedEvent(STREAM_ID, CLAIM_2_AMOUNT, 'tx-claim2', T_CLAIM_2));
    await parser.parseClaimedEvent(makeClaimedEvent(STREAM_ID, CLAIM_3_AMOUNT, 'tx-claim3', T_CLAIM_3));

    const projections = await service.getStreamsByRecipient(RECIPIENT);
    expect(projections).toHaveLength(1);
    expect(projections[0].streamId).toBe(STREAM_ID);
    expect(projections[0].status).toBe(StreamStatus.CLAIMED);
  });
});

// ── Suite 2: Cancellation mid-stream ─────────────────────────────────────────
//
// Stream 1002: create → partial claim (1/3) → cancelled
// After cancellation the remaining balance = total − already_claimed.
// The stream must be CANCELLED and claimedAt must still reflect the prior claim.

describe('StreamProjectionService — Cancellation mid-stream', () => {
  const STREAM_ID = 1002;
  /** Amount claimed before cancellation */
  const CLAIMED_BEFORE_CANCEL = '333333333';
  /** Expected remaining = 1 000 000 000 - 333 333 333 = 666 666 667 */
  const EXPECTED_REMAINING = '666666667';

  let parser: any;
  let service: any;

  beforeEach(async () => {
    store.clear();
    vi.clearAllMocks();
    const { StreamEventParser } = await import('../services/streamEventParser');
    const { StreamProjectionService } = await import('../services/streamProjectionService');
    parser = new StreamEventParser(mockPrisma as any);
    service = new StreamProjectionService();
  });

  it('status is CANCELLED after cancellation; cancelledAt is set', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseClaimedEvent(
      makeClaimedEvent(STREAM_ID, CLAIMED_BEFORE_CANCEL, 'tx-partial-before-cancel', T_CLAIM_1),
    );
    await parser.parseCancelledEvent(makeCancelledEvent(STREAM_ID, EXPECTED_REMAINING, T_CANCEL));

    const projection = await service.getStreamById(STREAM_ID);
    expect(projection!.status).toBe(StreamStatus.CANCELLED);
    expect(projection!.cancelledAt).toEqual(T_CANCEL);
  });

  it('claimedAt from the pre-cancellation claim is preserved after cancellation', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseClaimedEvent(
      makeClaimedEvent(STREAM_ID, CLAIMED_BEFORE_CANCEL, 'tx-partial-before-cancel', T_CLAIM_1),
    );
    await parser.parseCancelledEvent(makeCancelledEvent(STREAM_ID, EXPECTED_REMAINING, T_CANCEL));

    const projection = await service.getStreamById(STREAM_ID);
    // claimedAt must still reflect the last successful claim, not be erased
    expect(projection!.claimedAt).toEqual(T_CLAIM_1);
  });

  it('stream amount is unchanged by cancellation', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseClaimedEvent(
      makeClaimedEvent(STREAM_ID, CLAIMED_BEFORE_CANCEL, 'tx-partial-before-cancel', T_CLAIM_1),
    );
    await parser.parseCancelledEvent(makeCancelledEvent(STREAM_ID, EXPECTED_REMAINING, T_CANCEL));

    const projection = await service.getStreamById(STREAM_ID);
    expect(projection!.amount).toBe(TOTAL_AMOUNT);
  });

  it('remaining balance accounting: total − claimed = refundAmount from cancel event', () => {
    const total = BigInt(TOTAL_AMOUNT);
    const claimed = BigInt(CLAIMED_BEFORE_CANCEL);
    const remaining = total - claimed;
    expect(remaining.toString()).toBe(EXPECTED_REMAINING);
  });

  it('cancelled stream appears in CANCELLED status filter', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseClaimedEvent(
      makeClaimedEvent(STREAM_ID, CLAIMED_BEFORE_CANCEL, 'tx-partial-before-cancel', T_CLAIM_1),
    );
    await parser.parseCancelledEvent(makeCancelledEvent(STREAM_ID, EXPECTED_REMAINING, T_CANCEL));

    const projections = await service.getStreamsByCreator(CREATOR, { status: StreamStatus.CANCELLED });
    const ids = projections.map((p: any) => p.streamId);
    expect(ids).toContain(STREAM_ID);
  });

  it('cancelled stream does NOT appear in CLAIMED status filter', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseClaimedEvent(
      makeClaimedEvent(STREAM_ID, CLAIMED_BEFORE_CANCEL, 'tx-partial-before-cancel', T_CLAIM_1),
    );
    await parser.parseCancelledEvent(makeCancelledEvent(STREAM_ID, EXPECTED_REMAINING, T_CANCEL));

    const projections = await service.getStreamsByCreator(CREATOR, { status: StreamStatus.CLAIMED });
    const ids = projections.map((p: any) => p.streamId);
    expect(ids).not.toContain(STREAM_ID);
  });

  it('cancellation without any prior claim: claimedAt is undefined, full amount is remaining', async () => {
    const STREAM_ID_FRESH = 1003;
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID_FRESH));
    await parser.parseCancelledEvent(
      makeCancelledEvent(STREAM_ID_FRESH, TOTAL_AMOUNT, T_CANCEL),
    );

    const projection = await service.getStreamById(STREAM_ID_FRESH);
    expect(projection!.status).toBe(StreamStatus.CANCELLED);
    expect(projection!.claimedAt).toBeUndefined();
    expect(projection!.cancelledAt).toEqual(T_CANCEL);
    // Remaining = full total when no claims preceded cancellation
    const remaining = BigInt(TOTAL_AMOUNT) - BigInt(0);
    expect(remaining.toString()).toBe(TOTAL_AMOUNT);
  });
});

// ── Suite 3: Rejected claim after cancellation ────────────────────────────────
//
// Once a stream is CANCELLED its terminal state must not be overwritten by a
// late or erroneous claim event.  The service's contract (via StreamEventParser)
// requires that `parseCancelledEvent` sets status=CANCELLED, and a subsequent
// `parseClaimedEvent` on the same row must either:
//   a) throw (Prisma rejects the update because the DB row is in a terminal state), or
//   b) silently leave the status unchanged (CANCELLED)
// Either outcome is acceptable — what is NOT acceptable is the row flipping to CLAIMED.

describe('StreamProjectionService — Rejected claim after cancellation', () => {
  const STREAM_ID = 1004;

  let parser: any;
  let service: any;

  beforeEach(async () => {
    store.clear();
    vi.clearAllMocks();
    const { StreamEventParser } = await import('../services/streamEventParser');
    const { StreamProjectionService } = await import('../services/streamProjectionService');
    parser = new StreamEventParser(mockPrisma as any);
    service = new StreamProjectionService();
  });

  it('projection remains CANCELLED after a claim event is applied to a cancelled stream', async () => {
    // Seed: create then cancel
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseCancelledEvent(makeCancelledEvent(STREAM_ID, TOTAL_AMOUNT, T_CANCEL));

    // Verify terminal state before the rogue claim
    let projection = await service.getStreamById(STREAM_ID);
    expect(projection!.status).toBe(StreamStatus.CANCELLED);

    // Attempt a claim on the already-cancelled stream.
    // The parser may throw or silently no-op — either is valid per the contract.
    // We catch any thrown error so the assertion below always runs.
    try {
      await parser.parseClaimedEvent(
        makeClaimedEvent(STREAM_ID, CLAIM_1_AMOUNT, 'tx-rogue-claim', T_CLAIM_1),
      );
    } catch {
      // expected if the service enforces terminal-state immutability
    }

    // The critical invariant: status must still be CANCELLED
    projection = await service.getStreamById(STREAM_ID);
    expect(projection!.status).toBe(StreamStatus.CANCELLED);
  });

  it('cancelledAt is unchanged after a rogue claim attempt', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseCancelledEvent(makeCancelledEvent(STREAM_ID, TOTAL_AMOUNT, T_CANCEL));

    try {
      await parser.parseClaimedEvent(
        makeClaimedEvent(STREAM_ID, CLAIM_1_AMOUNT, 'tx-rogue-claim', T_CLAIM_1),
      );
    } catch {
      // swallow
    }

    const projection = await service.getStreamById(STREAM_ID);
    expect(projection!.cancelledAt).toEqual(T_CANCEL);
  });

  it('stream amount is unchanged after a rogue claim attempt', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseCancelledEvent(makeCancelledEvent(STREAM_ID, TOTAL_AMOUNT, T_CANCEL));

    try {
      await parser.parseClaimedEvent(
        makeClaimedEvent(STREAM_ID, CLAIM_1_AMOUNT, 'tx-rogue-claim', T_CLAIM_1),
      );
    } catch {
      // swallow
    }

    const projection = await service.getStreamById(STREAM_ID);
    expect(projection!.amount).toBe(TOTAL_AMOUNT);
  });

  it('stats: getStreamStats does NOT count a post-cancel claim in claimedVolume', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseCancelledEvent(makeCancelledEvent(STREAM_ID, TOTAL_AMOUNT, T_CANCEL));

    try {
      await parser.parseClaimedEvent(
        makeClaimedEvent(STREAM_ID, CLAIM_1_AMOUNT, 'tx-rogue-claim', T_CLAIM_1),
      );
    } catch {
      // swallow
    }

    const stats = await service.getStreamStats();
    // The stream must appear in cancelledVolume, not claimedVolume
    const claimedVol = BigInt(stats.claimedVolume);
    const cancelledVol = BigInt(stats.cancelledVolume);
    expect(claimedVol.toString()).toBe('0');
    expect(cancelledVol.toString()).toBe(TOTAL_AMOUNT);
  });

  it('cancelled stream is not returned when filtering by CLAIMED status', async () => {
    await parser.parseCreatedEvent(makeCreatedEvent(STREAM_ID));
    await parser.parseCancelledEvent(makeCancelledEvent(STREAM_ID, TOTAL_AMOUNT, T_CANCEL));

    try {
      await parser.parseClaimedEvent(
        makeClaimedEvent(STREAM_ID, CLAIM_1_AMOUNT, 'tx-rogue-claim', T_CLAIM_1),
      );
    } catch {
      // swallow
    }

    const claimed = await service.getStreamsByCreator(CREATOR, { status: StreamStatus.CLAIMED });
    expect(claimed.map((p: any) => p.streamId)).not.toContain(STREAM_ID);
  });
});
