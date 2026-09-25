/**
 * Event Replay Idempotency — Regression Test Suite
 *
 * Feeds recorded event sequences through the ingestion parsers and asserts
 * that final projections are correct, idempotent, and stable under duplicates
 * and out-of-order delivery.
 *
 * All suites use in-memory mocks — no live database required.
 *
 * Suites:
 *   1. Fixture integrity          — structural checks on fixture data (no parser)
 *   2. Token lifecycle replay     — TokenEventParser idempotency
 *   3. Stream lifecycle replay    — StreamEventParser idempotency
 *   4. Campaign lifecycle replay  — CampaignEventParser idempotency
 *
 * Idempotency invariants verified:
 *   I1  Replaying the full sequence twice yields identical final state
 *   I2  Duplicate events in a batch do not drift counters or amounts
 *   I3  Replaying a creation event after later events does not overwrite state
 *   I4  Out-of-order delivery is handled gracefully (skip or no-op)
 *   I5  Status terminal states are stable under replay
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  tokenLifecycleReplaySequence,
} from './fixtures/contractEvents';
import {
  governanceLifecycleReplaySequence,
} from './fixtures/governanceEvents';

// Hoist mock so module-level `new PrismaClient()` in campaignEventParser picks it up.
// StreamStatus enum is re-exported so StreamEventParser can use it.
let _mockPrismaInstance: ReturnType<typeof createMockPrisma> | null = null;

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => _mockPrismaInstance),
  StreamStatus: { CREATED: 'CREATED', CLAIMED: 'CLAIMED', CANCELLED: 'CANCELLED' },
}));

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fixture integrity (no parser, no DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fixture integrity — token lifecycle sequence', () => {
  it('is ordered by ledger', () => {
    const ledgers = tokenLifecycleReplaySequence.map(e => e.ledger);
    for (let i = 1; i < ledgers.length; i++) {
      expect(ledgers[i]).toBeGreaterThanOrEqual(ledgers[i - 1]);
    }
  });

  it('has unique transaction hashes', () => {
    const hashes = tokenLifecycleReplaySequence.map(e => e.transaction_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('has unique paging tokens', () => {
    const tokens = tokenLifecycleReplaySequence.map(e => e.paging_token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('starts with a tok_reg event', () => {
    expect(tokenLifecycleReplaySequence[0].topic[0]).toBe('tok_reg');
  });

  it('contains at least one burn event', () => {
    const burnTopics = tokenLifecycleReplaySequence
      .map(e => e.topic[0])
      .filter(t => t === 'tok_burn' || t === 'adm_burn');
    expect(burnTopics.length).toBeGreaterThan(0);
  });
});

describe('Fixture integrity — governance lifecycle sequence', () => {
  it('is ordered by ledger', () => {
    const ledgers = governanceLifecycleReplaySequence.map(e => e.ledger);
    for (let i = 1; i < ledgers.length; i++) {
      expect(ledgers[i]).toBeGreaterThanOrEqual(ledgers[i - 1]);
    }
  });

  it('has unique transaction hashes', () => {
    const hashes = governanceLifecycleReplaySequence.map(e => e.transaction_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('starts with a proposal creation event', () => {
    expect(governanceLifecycleReplaySequence[0].topic[0]).toMatch(/prop_create/);
  });

  it('contains at least one vote event', () => {
    const voteEvents = governanceLifecycleReplaySequence.filter(e =>
      e.topic[0].includes('vote'),
    );
    expect(voteEvents.length).toBeGreaterThan(0);
  });

  it('ends with an execution or status event', () => {
    const last = governanceLifecycleReplaySequence[governanceLifecycleReplaySequence.length - 1];
    expect(last.topic[0]).toMatch(/exec|status|prop_exec|prop_status/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared mock Prisma factory
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal in-memory store that mirrors the Prisma models used by the parsers. */
function createMockPrisma() {
  const tokens   = new Map<string, any>();   // keyed by address
  const burns    = new Map<string, any>();   // keyed by txHash
  const streams  = new Map<number, any>();   // keyed by streamId
  const campaigns = new Map<number, any>();  // keyed by campaignId
  const executions = new Map<string, any>(); // keyed by txHash

  return {
    _tokens: tokens,
    _burns: burns,
    _streams: streams,
    _campaigns: campaigns,
    _executions: executions,

    token: {
      upsert: vi.fn(async ({ where, create }: any) => {
        if (!tokens.has(where.address)) tokens.set(where.address, { id: where.address, ...create });
        return tokens.get(where.address);
      }),
      findUnique: vi.fn(async ({ where }: any) => tokens.get(where.address) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const t = tokens.get(where.id ?? where.address);
        if (!t) throw new Error('token not found');
        if (data.totalBurned?.increment) t.totalBurned = (t.totalBurned ?? 0n) + data.totalBurned.increment;
        if (data.burnCount?.increment)   t.burnCount   = (t.burnCount   ?? 0)  + 1;
        if (data.totalSupply?.decrement) t.totalSupply = (t.totalSupply ?? 0n) - data.totalSupply.decrement;
        if (data.metadataUri !== undefined) t.metadataUri = data.metadataUri;
        return t;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const t = tokens.get(where.address);
        if (t && data.metadataUri !== undefined) t.metadataUri = data.metadataUri;
        return { count: t ? 1 : 0 };
      }),
    },

    burnRecord: {
      findUnique: vi.fn(async ({ where }: any) => burns.get(where.txHash) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const rec = { ...data };
        burns.set(data.txHash, rec);
        return rec;
      }),
    },

    streamWithdrawal: {
      upsert: vi.fn(async () => ({})),
    },
    stream: {
      upsert: vi.fn(async ({ where, create }: any) => {
        if (!streams.has(where.streamId)) streams.set(where.streamId, { ...create });
        return streams.get(where.streamId);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const s = streams.get(where.streamId);
        if (!s) throw new Error('stream not found');
        Object.assign(s, data);
        return s;
      }),
      findUnique: vi.fn(async ({ where }: any) => streams.get(where.streamId) ?? null),
    },

    campaign: {
      upsert: vi.fn(async ({ where, create }: any) => {
        if (!campaigns.has(where.campaignId)) {
          campaigns.set(where.campaignId, { id: `c-${where.campaignId}`, ...create });
        }
        return campaigns.get(where.campaignId);
      }),
      findUnique: vi.fn(async ({ where }: any) => campaigns.get(where.campaignId) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const id = Number(String(where.id).replace('c-', ''));
        const c = campaigns.get(id);
        if (!c) throw new Error('campaign not found');
        if (data.currentAmount?.increment) c.currentAmount = (c.currentAmount ?? 0n) + data.currentAmount.increment;
        if (data.executionCount?.increment) c.executionCount = (c.executionCount ?? 0) + 1;
        if (data.status) c.status = data.status;
        if (data.completedAt) c.completedAt = data.completedAt;
        if (data.cancelledAt) c.cancelledAt = data.cancelledAt;
        if (data.pausedAt) c.pausedAt = data.pausedAt;
        return c;
      }),
    },

    campaignExecution: {
      findUnique: vi.fn(async ({ where }: any) => executions.get(where.txHash) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const rec = { ...data };
        executions.set(data.txHash, rec);
        return rec;
      }),
    },

    $transaction: vi.fn(async (ops: Promise<any>[]) => {
      const results = [];
      for (const op of ops) results.push(await op);
      return results;
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Token lifecycle replay
// ─────────────────────────────────────────────────────────────────────────────

describe('Token lifecycle replay', () => {
  const TOKEN   = 'CREPLAY_TOKEN_001';
  const CREATOR = 'GREPLAY_CREATOR_001';
  const HOLDER  = 'GREPLAY_HOLDER_001';
  const TX_CREATE     = 'tx-replay-tok-create-001';
  const TX_SELF_BURN  = 'tx-replay-tok-burn-001';
  const TX_ADMIN_BURN = 'tx-replay-adm-burn-001';

  const sequence = [
    { type: 'tok_reg' as const, tokenAddress: TOKEN, transactionHash: TX_CREATE, ledger: 2000,
      creator: CREATOR, name: 'Replay Token', symbol: 'RPL', decimals: 7, initialSupply: '1000000000000' },
    { type: 'tok_burn' as const, tokenAddress: TOKEN, transactionHash: TX_SELF_BURN, ledger: 2001,
      from: HOLDER, burner: HOLDER, amount: '100000000' },
    { type: 'adm_burn' as const, tokenAddress: TOKEN, transactionHash: TX_ADMIN_BURN, ledger: 2002,
      from: HOLDER, admin: CREATOR, amount: '200000000' },
  ];

  let prisma: ReturnType<typeof createMockPrisma>;
  let parser: any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    _mockPrismaInstance = prisma;
    const { TokenEventParser } = await import('../services/tokenEventParser');
    parser = new TokenEventParser(prisma as any);
  });

  it('produces correct final projection after full sequence', async () => {
    for (const event of sequence) await parser.parseEvent(event);

    const token = prisma._tokens.get(TOKEN)!;
    expect(token.initialSupply).toBe(BigInt('1000000000000'));
    expect(token.totalBurned).toBe(BigInt('300000000'));
    expect(token.burnCount).toBe(2);
    expect(token.totalSupply).toBe(BigInt('1000000000000') - BigInt('300000000'));
  });

  // I1 — replaying the full sequence twice yields identical final state
  it('I1: replaying the full sequence twice yields the same state', async () => {
    for (const event of sequence) await parser.parseEvent(event);
    for (const event of sequence) await parser.parseEvent(event);

    const token = prisma._tokens.get(TOKEN)!;
    expect(token.burnCount).toBe(2);
    expect(token.totalBurned).toBe(BigInt('300000000'));
    expect(prisma._burns.size).toBe(2);
  });

  // I2 — duplicate events in a batch do not drift
  it('I2: duplicate events in the same batch do not drift', async () => {
    const withDuplicates = [...sequence, sequence[1], sequence[2]];
    for (const event of withDuplicates) await parser.parseEvent(event);

    const token = prisma._tokens.get(TOKEN)!;
    expect(token.burnCount).toBe(2);
    expect(token.totalBurned).toBe(BigInt('300000000'));
  });

  // I4 — out-of-order: burn before create is skipped safely
  it('I4: burn before create is skipped, then applied after create', async () => {
    await parser.parseEvent(sequence[1]); // self-burn — no token yet, should skip
    await parser.parseEvent(sequence[0]); // create
    await parser.parseEvent(sequence[1]); // replay burn — token now exists

    const token = prisma._tokens.get(TOKEN)!;
    expect(token.burnCount).toBe(1);
    expect(token.totalBurned).toBe(BigInt('100000000'));
  });

  // I3 — replaying create after burns does not overwrite burn state
  it('I3: replaying create after burns does not reset burn counters', async () => {
    for (const event of sequence) await parser.parseEvent(event);
    await parser.parseEvent(sequence[0]); // replay create

    const token = prisma._tokens.get(TOKEN)!;
    expect(token.burnCount).toBe(2);
    expect(token.totalBurned).toBe(BigInt('300000000'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Stream lifecycle replay
// ─────────────────────────────────────────────────────────────────────────────

describe('Stream lifecycle replay', () => {
  const STREAM_ID = 9001;
  const CREATOR   = 'GREPLAY_VAULT_CREATOR_001';
  const RECIPIENT = 'GREPLAY_VAULT_RECIPIENT_001';

  const createdEvent = {
    type: 'created' as const,
    streamId: STREAM_ID,
    creator: CREATOR,
    recipient: RECIPIENT,
    amount: '5000000000',
    hasMetadata: false,
    txHash: 'tx-replay-vault-create-001',
    timestamp: new Date('2026-03-10T10:00:00Z'),
  };

  const claimedEvent = {
    type: 'claimed' as const,
    streamId: STREAM_ID,
    recipient: RECIPIENT,
    amount: '5000000000',
    txHash: 'tx-replay-vault-claim-001',
    timestamp: new Date('2026-03-10T12:00:00Z'),
  };

  const cancelledEvent = {
    type: 'cancelled' as const,
    streamId: STREAM_ID,
    creator: CREATOR,
    refundAmount: '5000000000',
    txHash: 'tx-replay-vault-cancel-001',
    timestamp: new Date('2026-03-10T11:00:00Z'),
  };

  let prisma: ReturnType<typeof createMockPrisma>;
  let parser: any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    _mockPrismaInstance = prisma;
    const { StreamEventParser } = await import('../services/streamEventParser');
    parser = new StreamEventParser(prisma as any);
  });

  it('projects create → claim correctly', async () => {
    await parser.parseEvent(createdEvent);
    await parser.parseEvent(claimedEvent);

    const stream = prisma._streams.get(STREAM_ID)!;
    expect(stream.status).toBe('CLAIMED');
    expect(stream.creator).toBe(CREATOR);
    expect(stream.amount).toBe(BigInt('5000000000'));
  });

  // I3 — replaying create after claim does not overwrite status
  it('I3: replaying create does not overwrite claimed status', async () => {
    await parser.parseEvent(createdEvent);
    await parser.parseEvent(claimedEvent);
    await parser.parseEvent(createdEvent); // replay create

    const stream = prisma._streams.get(STREAM_ID)!;
    expect(stream.status).toBe('CLAIMED');
  });

  // I1 — full sequence replay is stable
  it('I1: replaying the full sequence twice yields the same state', async () => {
    for (const e of [createdEvent, claimedEvent]) await parser.parseEvent(e);
    for (const e of [createdEvent, claimedEvent]) await parser.parseEvent(e);

    const stream = prisma._streams.get(STREAM_ID)!;
    expect(stream.status).toBe('CLAIMED');
  });

  it('handles create → cancel lifecycle', async () => {
    await parser.parseEvent(createdEvent);
    await parser.parseEvent(cancelledEvent);

    const stream = prisma._streams.get(STREAM_ID)!;
    expect(stream.status).toBe('CANCELLED');
  });

  // I5 — terminal state stable under replay
  it('I5: replaying cancel event does not change a CANCELLED stream', async () => {
    await parser.parseEvent(createdEvent);
    await parser.parseEvent(cancelledEvent);
    await parser.parseEvent(cancelledEvent); // replay

    const stream = prisma._streams.get(STREAM_ID)!;
    expect(stream.status).toBe('CANCELLED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Campaign lifecycle replay
// ─────────────────────────────────────────────────────────────────────────────

describe('Campaign lifecycle replay', () => {
  const CAMPAIGN_ID = 7001;
  const TOKEN_ID    = 'CREPLAY_CAMPAIGN_TOKEN_001';
  const CREATOR     = 'GREPLAY_CAMPAIGN_CREATOR_001';
  const EXECUTOR    = 'GREPLAY_CAMPAIGN_EXECUTOR_001';

  const campaignCreated = {
    campaignId: CAMPAIGN_ID,
    tokenId: TOKEN_ID,
    creator: CREATOR,
    type: 'BUYBACK' as const,
    targetAmount: BigInt('10000000000'),
    startTime: new Date('2026-03-10T00:00:00Z'),
    txHash: 'tx-replay-camp-create-001',
  };

  const exec1 = {
    campaignId: CAMPAIGN_ID,
    executor: EXECUTOR,
    amount: BigInt('1000000000'),
    txHash: 'tx-replay-camp-exec-001',
    executedAt: new Date('2026-03-10T01:00:00Z'),
  };

  const exec2 = {
    campaignId: CAMPAIGN_ID,
    executor: EXECUTOR,
    amount: BigInt('2000000000'),
    txHash: 'tx-replay-camp-exec-002',
    executedAt: new Date('2026-03-10T02:00:00Z'),
  };

  let prisma: ReturnType<typeof createMockPrisma>;
  let parser: any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    _mockPrismaInstance = prisma;
    vi.resetModules();
    const { CampaignEventParser } = await import('../services/campaignEventParser');
    parser = new CampaignEventParser();
  });

  it('projects create → two executions correctly', async () => {
    await parser.parseCampaignCreated(campaignCreated);
    await parser.parseCampaignExecution(exec1);
    await parser.parseCampaignExecution(exec2);

    const campaign = prisma._campaigns.get(CAMPAIGN_ID)!;
    expect(campaign.executionCount).toBe(2);
    expect(campaign.currentAmount).toBe(BigInt('3000000000'));
  });

  // I2 — replaying executions does not double-count
  it('I2: replaying executions does not double-count', async () => {
    await parser.parseCampaignCreated(campaignCreated);
    await parser.parseCampaignExecution(exec1);
    await parser.parseCampaignExecution(exec2);
    await parser.parseCampaignExecution(exec1); // replay
    await parser.parseCampaignExecution(exec2); // replay

    const campaign = prisma._campaigns.get(CAMPAIGN_ID)!;
    expect(campaign.executionCount).toBe(2);
    expect(campaign.currentAmount).toBe(BigInt('3000000000'));
  });

  // I3 — replaying create does not reset execution counts
  it('I3: replaying create does not reset execution counts', async () => {
    await parser.parseCampaignCreated(campaignCreated);
    await parser.parseCampaignExecution(exec1);
    await parser.parseCampaignCreated(campaignCreated); // replay create

    const campaign = prisma._campaigns.get(CAMPAIGN_ID)!;
    expect(campaign.executionCount).toBe(1);
    expect(campaign.currentAmount).toBe(BigInt('1000000000'));
  });

  // I5 — COMPLETED status is stable under replay
  it('I5: status transition to COMPLETED is stable under replay', async () => {
    await parser.parseCampaignCreated(campaignCreated);
    await parser.parseCampaignStatusChange({ campaignId: CAMPAIGN_ID, status: 'COMPLETED', txHash: 'tx-status-001' });
    await parser.parseCampaignStatusChange({ campaignId: CAMPAIGN_ID, status: 'COMPLETED', txHash: 'tx-status-001' });

    const campaign = prisma._campaigns.get(CAMPAIGN_ID)!;
    expect(campaign.status).toBe('COMPLETED');
  });

  // I1 — full sequence replay is stable
  it('I1: replaying the full sequence twice yields the same state', async () => {
    const fullSequence = async () => {
      await parser.parseCampaignCreated(campaignCreated);
      await parser.parseCampaignExecution(exec1);
      await parser.parseCampaignExecution(exec2);
    };
    await fullSequence();
    await fullSequence();

    const campaign = prisma._campaigns.get(CAMPAIGN_ID)!;
    expect(campaign.executionCount).toBe(2);
    expect(campaign.currentAmount).toBe(BigInt('3000000000'));
    expect(prisma._executions.size).toBe(2);
  });
});
