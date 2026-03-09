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

describe('Consistency Checker - Randomized Traces', () => {
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

  function generateRandomCampaign(campaignId: number) {
    const statuses = ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'];
    const targetAmount = BigInt(Math.floor(Math.random() * 10000000));
    const currentAmount = BigInt(
      Math.floor(Math.random() * Number(targetAmount))
    );
    const executionCount = Math.floor(Math.random() * 100);

    return {
      campaignId,
      status: statuses[Math.floor(Math.random() * statuses.length)],
      currentAmount,
      executionCount,
      targetAmount,
    };
  }

  it('verifies consistency with random single campaign', async () => {
    const campaign = generateRandomCampaign(1);
    mockCampaigns.set(1, campaign);

    const diffs = await checker.checkCampaign(1, campaign);
    expect(diffs).toHaveLength(0);
  });

  it('verifies consistency with 10 random campaigns', async () => {
    const campaigns = [];

    for (let i = 1; i <= 10; i++) {
      const campaign = generateRandomCampaign(i);
      mockCampaigns.set(i, campaign);
      campaigns.push(campaign);
    }

    const result = await checker.checkMultipleCampaigns(campaigns);
    expect(result.consistent).toBe(true);
    expect(result.totalChecked).toBe(10);
  });

  it('detects drift in random execution trace', async () => {
    const backendCampaign = generateRandomCampaign(1);
    mockCampaigns.set(1, backendCampaign);

    // Simulate drift by modifying on-chain state
    const onChainState = {
      ...backendCampaign,
      currentAmount: backendCampaign.currentAmount + BigInt(1000),
    };

    const diffs = await checker.checkCampaign(1, onChainState);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs[0].field).toBe('currentAmount');
  });

  it('handles random execution sequences', async () => {
    const campaignId = 1;
    let currentAmount = BigInt(0);
    let executionCount = 0;
    const targetAmount = BigInt(1000000);

    // Simulate random executions
    const numExecutions = Math.floor(Math.random() * 20) + 1;
    for (let i = 0; i < numExecutions; i++) {
      const amount = BigInt(Math.floor(Math.random() * 50000));
      currentAmount += amount;
      executionCount++;
    }

    mockCampaigns.set(campaignId, {
      campaignId,
      status: 'ACTIVE',
      currentAmount,
      executionCount,
      targetAmount,
    });

    const onChainState = {
      campaignId,
      status: 'ACTIVE',
      currentAmount,
      executionCount,
      targetAmount,
    };

    const diffs = await checker.checkCampaign(campaignId, onChainState);
    expect(diffs).toHaveLength(0);
  });

  it('stress test with 100 random campaigns', async () => {
    const campaigns = [];

    for (let i = 1; i <= 100; i++) {
      const campaign = generateRandomCampaign(i);
      mockCampaigns.set(i, campaign);
      campaigns.push(campaign);
    }

    const result = await checker.checkMultipleCampaigns(campaigns);
    expect(result.consistent).toBe(true);
    expect(result.totalChecked).toBe(100);
  });

  it('detects multiple random drifts', async () => {
    const campaigns = [];

    for (let i = 1; i <= 5; i++) {
      const backendCampaign = generateRandomCampaign(i);
      mockCampaigns.set(i, backendCampaign);

      // Introduce drift in some campaigns
      const onChainCampaign = {
        ...backendCampaign,
        currentAmount:
          i % 2 === 0
            ? backendCampaign.currentAmount + BigInt(1000)
            : backendCampaign.currentAmount,
      };

      campaigns.push(onChainCampaign);
    }

    const result = await checker.checkMultipleCampaigns(campaigns);
    expect(result.consistent).toBe(false);
    expect(result.diffs.length).toBeGreaterThan(0);
  });
});
