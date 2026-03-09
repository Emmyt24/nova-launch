import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';

// Mock Prisma
const mockCampaigns = new Map();

const mockPrisma = {
  campaign: {
    findUnique: vi.fn(async ({ where }) =>
      mockCampaigns.get(where.campaignId) || null
    ),
  },
};

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrisma),
}));

describe('Campaign Consistency Checker', () => {
  let checker: any;

  beforeAll(async () => {
    const { CampaignConsistencyChecker } = await import(
      '../services/campaignConsistencyChecker'
    );
    checker = new CampaignConsistencyChecker();
  });

  beforeEach(() => {
    mockCampaigns.clear();
    vi.clearAllMocks();
  });

  it('detects no diffs when backend matches on-chain', async () => {
    mockCampaigns.set(1, {
      campaignId: 1,
      status: 'ACTIVE',
      currentAmount: BigInt(100000),
      executionCount: 2,
      targetAmount: BigInt(1000000),
    });

    const onChainState = {
      campaignId: 1,
      status: 'ACTIVE',
      currentAmount: BigInt(100000),
      executionCount: 2,
      targetAmount: BigInt(1000000),
    };

    const diffs = await checker.checkCampaign(1, onChainState);
    expect(diffs).toHaveLength(0);
  });

  it('detects status mismatch', async () => {
    mockCampaigns.set(1, {
      campaignId: 1,
      status: 'ACTIVE',
      currentAmount: BigInt(100000),
      executionCount: 2,
      targetAmount: BigInt(1000000),
    });

    const onChainState = {
      campaignId: 1,
      status: 'PAUSED',
      currentAmount: BigInt(100000),
      executionCount: 2,
      targetAmount: BigInt(1000000),
    };

    const diffs = await checker.checkCampaign(1, onChainState);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe('status');
    expect(diffs[0].backendValue).toBe('ACTIVE');
    expect(diffs[0].onChainValue).toBe('PAUSED');
  });

  it('detects currentAmount mismatch', async () => {
    mockCampaigns.set(1, {
      campaignId: 1,
      status: 'ACTIVE',
      currentAmount: BigInt(100000),
      executionCount: 2,
      targetAmount: BigInt(1000000),
    });

    const onChainState = {
      campaignId: 1,
      status: 'ACTIVE',
      currentAmount: BigInt(150000),
      executionCount: 2,
      targetAmount: BigInt(1000000),
    };

    const diffs = await checker.checkCampaign(1, onChainState);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe('currentAmount');
    expect(diffs[0].backendValue).toBe('100000');
    expect(diffs[0].onChainValue).toBe('150000');
  });

  it('detects executionCount mismatch', async () => {
    mockCampaigns.set(1, {
      campaignId: 1,
      status: 'ACTIVE',
      currentAmount: BigInt(100000),
      executionCount: 2,
      targetAmount: BigInt(1000000),
    });

    const onChainState = {
      campaignId: 1,
      status: 'ACTIVE',
      currentAmount: BigInt(100000),
      executionCount: 3,
      targetAmount: BigInt(1000000),
    };

    const diffs = await checker.checkCampaign(1, onChainState);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe('executionCount');
    expect(diffs[0].backendValue).toBe(2);
    expect(diffs[0].onChainValue).toBe(3);
  });

  it('detects multiple mismatches', async () => {
    mockCampaigns.set(1, {
      campaignId: 1,
      status: 'ACTIVE',
      currentAmount: BigInt(100000),
      executionCount: 2,
      targetAmount: BigInt(1000000),
    });

    const onChainState = {
      campaignId: 1,
      status: 'PAUSED',
      currentAmount: BigInt(150000),
      executionCount: 3,
      targetAmount: BigInt(1000000),
    };

    const diffs = await checker.checkCampaign(1, onChainState);
    expect(diffs).toHaveLength(3);
    expect(diffs.map((d) => d.field)).toContain('status');
    expect(diffs.map((d) => d.field)).toContain('currentAmount');
    expect(diffs.map((d) => d.field)).toContain('executionCount');
  });

  it('detects missing campaign in backend', async () => {
    const onChainState = {
      campaignId: 999,
      status: 'ACTIVE',
      currentAmount: BigInt(100000),
      executionCount: 2,
      targetAmount: BigInt(1000000),
    };

    const diffs = await checker.checkCampaign(999, onChainState);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe('existence');
    expect(diffs[0].backendValue).toBe(null);
    expect(diffs[0].onChainValue).toBe('exists');
  });

  it('checks multiple campaigns', async () => {
    mockCampaigns.set(1, {
      campaignId: 1,
      status: 'ACTIVE',
      currentAmount: BigInt(100000),
      executionCount: 2,
      targetAmount: BigInt(1000000),
    });

    mockCampaigns.set(2, {
      campaignId: 2,
      status: 'COMPLETED',
      currentAmount: BigInt(500000),
      executionCount: 5,
      targetAmount: BigInt(500000),
    });

    const onChainStates = [
      {
        campaignId: 1,
        status: 'ACTIVE',
        currentAmount: BigInt(100000),
        executionCount: 2,
        targetAmount: BigInt(1000000),
      },
      {
        campaignId: 2,
        status: 'COMPLETED',
        currentAmount: BigInt(500000),
        executionCount: 5,
        targetAmount: BigInt(500000),
      },
    ];

    const result = await checker.checkMultipleCampaigns(onChainStates);
    expect(result.consistent).toBe(true);
    expect(result.totalChecked).toBe(2);
    expect(result.diffs).toHaveLength(0);
  });

  it('formats diffs for display', async () => {
    const diffs = [
      {
        campaignId: 1,
        field: 'status',
        backendValue: 'ACTIVE',
        onChainValue: 'PAUSED',
      },
      {
        campaignId: 1,
        field: 'currentAmount',
        backendValue: '100000',
        onChainValue: '150000',
      },
    ];

    const formatted = checker.formatDiffs(diffs);
    expect(formatted).toContain('❌ Found 2 inconsistencies');
    expect(formatted).toContain('Campaign 1 - status');
    expect(formatted).toContain('Backend:  ACTIVE');
    expect(formatted).toContain('On-chain: PAUSED');
  });

  it('formats empty diffs', async () => {
    const formatted = checker.formatDiffs([]);
    expect(formatted).toBe('✅ No inconsistencies found');
  });
});
