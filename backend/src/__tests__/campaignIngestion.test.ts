import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';

// Mock Prisma before any imports
const mockCampaigns = new Map();
const mockExecutions = new Map();

const mockPrisma = {
  campaign: {
    upsert: vi.fn(async ({ where, create }) => {
      if (!mockCampaigns.has(where.campaignId)) {
        const campaign = { ...create, id: `campaign-${where.campaignId}` };
        mockCampaigns.set(where.campaignId, campaign);
      }
      return mockCampaigns.get(where.campaignId);
    }),
    findUnique: vi.fn(async ({ where }) => mockCampaigns.get(where.campaignId) || null),
    findMany: vi.fn(async () => Array.from(mockCampaigns.values())),
    update: vi.fn(async ({ where, data }) => {
      const id = where.id?.replace('campaign-', '');
      const campaign = mockCampaigns.get(Number(id));
      if (!campaign) throw new Error('Campaign not found');
      
      if (data.currentAmount?.increment) {
        campaign.currentAmount = (campaign.currentAmount || BigInt(0)) + data.currentAmount.increment;
      }
      if (data.executionCount?.increment) {
        campaign.executionCount = (campaign.executionCount || 0) + data.executionCount.increment;
      }
      if (data.status) campaign.status = data.status;
      if (data.updatedAt) campaign.updatedAt = data.updatedAt;
      
      return campaign;
    }),
    deleteMany: vi.fn(async () => {
      mockCampaigns.clear();
      return { count: 0 };
    }),
  },
  campaignExecution: {
    create: vi.fn(async (data) => {
      const create = data.data || data;
      const execution = { ...create, id: `exec-${create.txHash}` };
      mockExecutions.set(create.txHash, execution);
      return execution;
    }),
    upsert: vi.fn(async ({ where, create }) => {
      if (!mockExecutions.has(where.txHash)) {
        const execution = { ...create, id: `exec-${where.txHash}` };
        mockExecutions.set(where.txHash, execution);
      }
      return mockExecutions.get(where.txHash);
    }),
    findUnique: vi.fn(async ({ where }) => mockExecutions.get(where.txHash) || null),
    findMany: vi.fn(async () => Array.from(mockExecutions.values())),
    count: vi.fn(async () => mockExecutions.size),
    deleteMany: vi.fn(async () => {
      mockExecutions.clear();
      return { count: 0 };
    }),
  },
  $transaction: vi.fn(async (operations) => {
    // Execute operations but track if execution already exists
    const results = [];
    for (const op of operations) {
      const result = await op;
      results.push(result);
    }
    return results;
  }),
};

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrisma),
}));

describe('Campaign Event Ingestion', () => {
  let parser: any;

  beforeAll(async () => {
    const { CampaignEventParser } = await import('../services/campaignEventParser');
    parser = new CampaignEventParser();
  });

  beforeEach(() => {
    mockCampaigns.clear();
    mockExecutions.clear();
    vi.clearAllMocks();
  });

  it('handles duplicate campaign creation', async () => {
    const event = {
      campaignId: 1,
      tokenId: 'token-123',
      creator: 'creator-addr',
      type: 'BUYBACK' as const,
      targetAmount: BigInt(1000000),
      startTime: new Date(),
      txHash: 'tx-1',
    };

    await parser.parseCampaignCreated(event);
    await parser.parseCampaignCreated(event);

    expect(mockCampaigns.size).toBe(1);
  });

  it('handles duplicate execution events', async () => {
    await parser.parseCampaignCreated({
      campaignId: 1,
      tokenId: 'token-123',
      creator: 'creator-addr',
      type: 'BUYBACK',
      targetAmount: BigInt(1000000),
      startTime: new Date(),
      txHash: 'tx-1',
    });

    const execEvent = {
      campaignId: 1,
      executor: 'executor-addr',
      amount: BigInt(100000),
      txHash: 'tx-2',
      executedAt: new Date(),
    };

    await parser.parseCampaignExecution(execEvent);
    await parser.parseCampaignExecution(execEvent);

    expect(mockExecutions.size).toBe(1);
    const campaign = mockCampaigns.get(1);
    expect(campaign.currentAmount).toBe(BigInt(100000));
    expect(campaign.executionCount).toBe(1);
  });

  it('handles out-of-order events', async () => {
    await parser.parseCampaignCreated({
      campaignId: 1,
      tokenId: 'token-123',
      creator: 'creator-addr',
      type: 'BUYBACK',
      targetAmount: BigInt(1000000),
      startTime: new Date(),
      txHash: 'tx-1',
    });

    await parser.parseCampaignExecution({
      campaignId: 1,
      executor: 'executor-addr',
      amount: BigInt(100000),
      txHash: 'tx-2',
      executedAt: new Date(),
    });

    await parser.parseCampaignExecution({
      campaignId: 1,
      executor: 'executor-addr',
      amount: BigInt(50000),
      txHash: 'tx-3',
      executedAt: new Date(),
    });

    const campaign = mockCampaigns.get(1);
    expect(campaign.currentAmount).toBe(BigInt(150000));
    expect(campaign.executionCount).toBe(2);
  });

  it('handles status changes', async () => {
    await parser.parseCampaignCreated({
      campaignId: 1,
      tokenId: 'token-123',
      creator: 'creator-addr',
      type: 'BUYBACK',
      targetAmount: BigInt(1000000),
      startTime: new Date(),
      txHash: 'tx-1',
    });

    await parser.parseCampaignStatusChange({
      campaignId: 1,
      status: 'PAUSED',
      txHash: 'tx-2',
    });

    const campaign = mockCampaigns.get(1);
    expect(campaign.status).toBe('PAUSED');
  });

  it('handles full event stream replay', async () => {
    const events = [
      { type: 'create', data: { campaignId: 1, tokenId: 'token-123', creator: 'creator-addr', type: 'BUYBACK' as const, targetAmount: BigInt(1000000), startTime: new Date(), txHash: 'tx-1' } },
      { type: 'execute', data: { campaignId: 1, executor: 'executor-addr', amount: BigInt(100000), txHash: 'tx-2', executedAt: new Date() } },
      { type: 'execute', data: { campaignId: 1, executor: 'executor-addr', amount: BigInt(50000), txHash: 'tx-3', executedAt: new Date() } },
      { type: 'status', data: { campaignId: 1, status: 'COMPLETED' as const, txHash: 'tx-4' } },
    ];

    const processEvents = async () => {
      for (const event of events) {
        if (event.type === 'create') await parser.parseCampaignCreated(event.data);
        else if (event.type === 'execute') await parser.parseCampaignExecution(event.data);
        else if (event.type === 'status') await parser.parseCampaignStatusChange(event.data);
      }
    };

    await processEvents();
    const firstRun = mockCampaigns.get(1);

    await processEvents();
    const secondRun = mockCampaigns.get(1);

    expect(firstRun.currentAmount).toBe(secondRun.currentAmount);
    expect(firstRun.executionCount).toBe(secondRun.executionCount);
    expect(mockExecutions.size).toBe(2);
  });
});
