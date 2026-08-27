import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventReplayService } from '../services/eventReplayService';
import { EventCursorStore } from '../services/eventCursorStore';

// ──────────────────────────────────────────────────────
// Shared mutable state — projection stores (the target tables)
// ──────────────────────────────────────────────────────

const tokenStore = new Map<string, any>();
const burnStore = new Map<string, any>();
const streamStore = new Map<number, any>();
let _mockPrisma: any;

function clearProjectionStores() {
  tokenStore.clear();
  burnStore.clear();
  streamStore.clear();
}

function snapshotProjections() {
  return JSON.stringify({
    tokens: Array.from(tokenStore.entries()).sort(),
    burns: Array.from(burnStore.entries()).sort(),
    streams: Array.from(streamStore.entries()).sort(),
  });
}

// ──────────────────────────────────────────────────────
// Mock Prisma factory
// ──────────────────────────────────────────────────────

function buildMockPrisma() {
  const integrationState = {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async () => ({})),
  };

  const id = (addr: string) => addr;

  return {
    integrationState,
    token: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.address;
        const existing = tokenStore.get(key);
        if (existing) {
          // Merge idempotent updates (increment/decrement)
          if (data.totalBurned?.increment) existing.totalBurned += data.totalBurned.increment;
          if (data.burnCount?.increment) existing.burnCount += data.burnCount.increment;
          if (data.totalSupply?.decrement) existing.totalSupply -= data.totalSupply.decrement;
          return existing;
        }
        const entry = { id: key, ...create };
        tokenStore.set(key, entry);
        return entry;
      }),
      findUnique: vi.fn(async ({ where }: any) => tokenStore.get(where.address ?? where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const existing = tokenStore.get(where.id ?? where.address);
        if (!existing) throw new Error('token not found');
        if (data.totalBurned?.increment) existing.totalBurned = (existing.totalBurned ?? 0n) + data.totalBurned.increment;
        if (data.burnCount?.increment) existing.burnCount = (existing.burnCount ?? 0) + data.burnCount.increment;
        if (data.totalSupply?.decrement) existing.totalSupply = (existing.totalSupply ?? 0n) - data.totalSupply.decrement;
        if (data.metadataUri !== undefined && data.metadataUri !== null) existing.metadataUri = data.metadataUri;
        return existing;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const t = tokenStore.get(where.address);
        if (t && data.metadataUri !== undefined && data.metadataUri !== null) t.metadataUri = data.metadataUri;
        return { count: t ? 1 : 0 };
      }),
      deleteMany: vi.fn(),
    },
    burnRecord: {
      findUnique: vi.fn(async ({ where }: any) => burnStore.get(where.txHash) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const rec = { ...data };
        burnStore.set(data.txHash, rec);
        return rec;
      }),
    },
    stream: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.streamId;
        if (streamStore.has(key)) {
          const existing = streamStore.get(key);
          Object.assign(existing, update);
          return existing;
        }
        const entry = { ...create, ...where };
        streamStore.set(key, entry);
        return entry;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const existing = streamStore.get(where.streamId);
        if (!existing) throw new Error('stream not found');
        Object.assign(existing, data);
        return existing;
      }),
      findUnique: vi.fn(async ({ where }: any) => streamStore.get(where.streamId) ?? null),
    },
    proposal: {
      upsert: vi.fn(async ({ where, create }: any) => {
        const key = where.id;
        if (!proposalStore) {
          const p = { ...create, ...where };
          return p;
        }
        return proposalStore.get(key) || { ...create, ...where };
      }),
      findUnique: vi.fn(async () => null),
    },
    vote: { deleteMany: vi.fn(), createMany: vi.fn() },
    campaign: { upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    campaignExecution: { create: vi.fn(), findUnique: vi.fn() },
    campaignAuditTrail: { create: vi.fn() },
    $transaction: vi.fn(async (ops: Promise<any>[]) => Promise.all(ops)),
  };
}

// ──────────────────────────────────────────────────────
// Mock parser implementations (simulate real parser behavior)
// ──────────────────────────────────────────────────────

function createTokenParserMock(prisma: any) {
  return {
    parseEvent: vi.fn(async (event: any) => {
      const topic = event.topic?.[0];
      if (topic === 'tok_reg') {
        await prisma.token.upsert({
          where: { address: event.tokenAddress },
          create: {
            address: event.tokenAddress,
            creator: event.creator ?? '',
            name: event.name ?? '',
            symbol: event.symbol ?? '',
            decimals: event.decimals ?? 7,
            totalSupply: BigInt(event.initialSupply ?? '0'),
            initialSupply: BigInt(event.initialSupply ?? '0'),
          },
          update: {},
        });
      } else if (topic === 'tok_burn' || topic === 'adm_burn') {
        const existing = await prisma.burnRecord.findUnique({
          where: { txHash: event.transaction_hash },
        });
        if (existing) return;

        const amount = BigInt(event.amount ?? '0');
        await prisma.token.update({
          where: { address: event.tokenAddress },
          data: {
            totalBurned: { increment: amount },
            burnCount: { increment: 1 },
            totalSupply: { decrement: amount },
          },
        });

        await prisma.burnRecord.create({
          data: {
            txHash: event.transaction_hash,
            tokenAddress: event.tokenAddress,
            from: event.from,
            amount,
            isAdminBurn: topic === 'adm_burn',
          },
        });
      }
    }),
  };
}

function createStreamParserMock(prisma: any) {
  return {
    parseEvent: vi.fn(async (event: any) => {
      const type = event.type;
      if (type === 'created') {
        await prisma.stream.upsert({
          where: { streamId: event.streamId },
          create: {
            streamId: event.streamId,
            creator: event.creator,
            recipient: event.recipient,
            amount: BigInt(event.amount),
            metadata: event.metadata,
            status: 'CREATED',
            txHash: event.transaction_hash,
            createdAt: event.timestamp,
          },
          update: {},
        });
      } else if (type === 'claimed') {
        await prisma.stream.update({
          where: { streamId: event.streamId },
          data: { status: 'CLAIMED', claimedAt: event.timestamp },
        });
      } else if (type === 'cancelled') {
        await prisma.stream.update({
          where: { streamId: event.streamId },
          data: { status: 'CANCELLED', cancelledAt: event.timestamp },
        });
      }
    }),
  };
}

// ──────────────────────────────────────────────────────
// Module mocks
// ──────────────────────────────────────────────────────

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));

vi.mock('../services/tokenEventParser', () => ({
  TokenEventParser: vi.fn(() => createTokenParserMock(_mockPrisma)),
}));

vi.mock('../services/streamEventParser', () => ({
  StreamEventParser: vi.fn(() => createStreamParserMock(_mockPrisma)),
}));

vi.mock('../services/governanceEventParser', () => ({
  GovernanceEventParser: vi.fn(() => ({
    parseEvent: vi.fn(async () => {}),
  })),
}));

vi.mock('../services/vaultEventParser', () => ({
  parseVaultCreatedEvent: vi.fn(),
  parseVaultClaimedEvent: vi.fn(),
  parseVaultCancelledEvent: vi.fn(),
  parseVaultMetadataUpdatedEvent: vi.fn(),
}));

// ──────────────────────────────────────────────────────
// Fixture event stream
// ──────────────────────────────────────────────────────

const MOCK_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const TOKEN_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCD4';

const FIXTURE_EVENTS = [
  {
    type: 'contract',
    ledger: 1000,
    ledger_close_time: '2024-01-01T00:00:00Z',
    contract_id: MOCK_CONTRACT_ID,
    id: '1000-1',
    paging_token: '1000-1',
    topic: ['tok_reg'],
    value: { xdr: 'AAAADwAAAAA=' },
    in_successful_contract_call: true,
    transaction_hash: 'tx-tok-reg-001',
    tokenAddress: TOKEN_ADDRESS,
    creator: 'GCREATOR',
    name: 'TestToken',
    symbol: 'TST',
    decimals: 7,
    initialSupply: '1000000000000',
  },
  {
    type: 'contract',
    ledger: 1001,
    ledger_close_time: '2024-01-01T00:01:00Z',
    contract_id: MOCK_CONTRACT_ID,
    id: '1001-1',
    paging_token: '1001-1',
    topic: ['tok_burn'],
    value: { xdr: 'AAAADwAAAAA=' },
    in_successful_contract_call: true,
    transaction_hash: 'tx-burn-001',
    tokenAddress: TOKEN_ADDRESS,
    from: 'GHOLDER',
    burner: 'GHOLDER',
    amount: '100000000',
  },
  {
    type: 'contract',
    ledger: 1002,
    ledger_close_time: '2024-01-01T00:02:00Z',
    contract_id: MOCK_CONTRACT_ID,
    id: '1002-1',
    paging_token: '1002-1',
    topic: ['adm_burn'],
    value: { xdr: 'AAAADwAAAAA=' },
    in_successful_contract_call: true,
    transaction_hash: 'tx-admin-burn-001',
    tokenAddress: TOKEN_ADDRESS,
    from: 'GHOLDER',
    admin: 'GADMIN',
    amount: '200000000',
  },
  {
    type: 'contract',
    ledger: 1003,
    ledger_close_time: '2024-01-01T00:03:00Z',
    contract_id: MOCK_CONTRACT_ID,
    id: '1003-1',
    paging_token: '1003-1',
    topic: ['stream_create'],
    value: { xdr: 'AAAADwAAAAA=' },
    in_successful_contract_call: true,
    transaction_hash: 'tx-stream-001',
    streamId: 9001,
    creator: 'GCREATOR',
    recipient: 'GRECIPIENT',
    amount: '5000000000',
    metadata: null,
    timestamp: new Date('2024-01-01T00:03:00Z'),
    type: 'created',
  },
];

// ──────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────

describe('EventReplayService idempotency', () => {
  beforeEach(() => {
    clearProjectionStores();
    _mockPrisma = buildMockPrisma();

    const axios = require('axios');
    axios.default.get.mockResolvedValue({
      data: { _embedded: { records: FIXTURE_EVENTS } },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('double-replay produces byte-identical projection state', async () => {
    const service = new EventReplayService(_mockPrisma);

    // First replay
    const first = await service.replay({ batchSize: 100 });
    expect(first.eventsProcessed).toBe(4);
    expect(first.errors).toHaveLength(0);
    const snapshot1 = snapshotProjections();

    // Second replay of the same range
    const second = await service.replay({ batchSize: 100 });
    expect(second.eventsProcessed).toBe(4);
    expect(second.errors).toHaveLength(0);
    const snapshot2 = snapshotProjections();

    expect(snapshot1).toBe(snapshot2);
  });

  it('already-applied event in the middle of the range is skipped (no double-count)', async () => {
    const service = new EventReplayService(_mockPrisma);

    // First replay
    const first = await service.replay({ batchSize: 100 });
    expect(first.eventsProcessed).toBe(4);
    const snapshotAfterClean = snapshotProjections();

    // Pre-seed an already-applied burn at index 1 (tok_burn)
    burnStore.set('tx-burn-001', { txHash: 'tx-burn-001', from: 'GHOLDER', amount: 100000000n });

    // Second replay with an already-applied event in the middle
    const second = await service.replay({ batchSize: 100 });
    expect(second.eventsProcessed).toBe(4);
    const snapshotAfterReseed = snapshotProjections();

    // State must still be identical to clean replay
    expect(snapshotAfterReseed).toBe(snapshotAfterClean);
  });

  it('mid-range partial failure leaves a resumable, non-corrupted state', async () => {
    let callCount = 0;
    const tokenParser = createTokenParserMock(_mockPrisma);
    (tokenParser.parseEvent as any).mockImplementation(async (event: any) => {
      callCount++;
      // Fail on the second event (tok_burn at ledger 1001)
      if (event.topic?.[0] === 'tok_burn' && callCount === 2) {
        throw new Error('Simulated parse failure at ledger 1001');
      }
      // Otherwise use normal implementation
      return createTokenParserMock(_mockPrisma).parseEvent(event);
    });

    const streamParser = createStreamParserMock(_mockPrisma);

    const axios = require('axios');
    axios.default.get.mockResolvedValue({
      data: { _embedded: { records: FIXTURE_EVENTS } },
    });

    // Need to re-mock with the custom parser
    vi.doMock('../services/tokenEventParser', () => ({
      TokenEventParser: vi.fn(() => tokenParser),
    }));
    vi.doMock('../services/streamEventParser', () => ({
      StreamEventParser: vi.fn(() => streamParser),
    }));

    const service = new EventReplayService(_mockPrisma);

    // First replay: partial failure mid-range
    const first = await service.replay({ batchSize: 100 });
    expect(first.errors).toHaveLength(1);
    expect(first.errors.some((e: any) => e.error.includes('Simulated parse failure'))).toBe(true);
    expect(first.eventsSkipped).toBe(1);
    const snapshotAfterFailure = snapshotProjections();

    // State should be resumable: token exists, but only one burn was applied
    expect(tokenStore.size).toBe(1);
    expect(burnStore.size).toBe(1); // adm_burn succeeded, tok_burn failed

    // Second replay: retry with all events succeeding
    callCount = 0;
    (tokenParser.parseEvent as any).mockImplementation(async (event: any) => {
      return createTokenParserMock(_mockPrisma).parseEvent(event);
    });

    // Re-import to pick up the new mock
    vi.resetModules();
    const retryService = new EventReplayService(_mockPrisma);

    const second = await retryService.replay({ batchSize: 100 });
    expect(second.errors).toHaveLength(0);
    expect(second.eventsProcessed).toBe(4);
    const snapshotAfterRetry = snapshotProjections();

    // Final state must be identical to a clean replay
    const cleanService = new EventReplayService(buildMockPrisma());
    await cleanService.replay({ batchSize: 100 });
    const snapshotClean = snapshotProjections();

    expect(snapshotAfterRetry).toBe(snapshotClean);
  });
});
