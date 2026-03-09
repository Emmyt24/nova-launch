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

describe('Consistency Checker - Fixture Scenarios', () => {
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

  describe('Fixture: Single Campaign Lifecycle', () => {
    it('verifies consistency after creation', async () => {
      mockCampaigns.set(1, {
        campaignId: 1,
        status: 'ACTIVE',
        currentAmount: BigInt(0),
        executionCount: 0,
        targetAmount: BigInt(1000000),
      });

      const onChainState = {
        campaignId: 1,
        status: 'ACTIVE',
        currentAmount: BigInt(0),
        executionCount: 0,
        targetAmount: BigInt(1000000),
      };

      const diffs = await checker.checkCampaign(1, onChainState);
      expect(diffs).toHaveLength(0);
    });

    it('verifies consistency after executions', async () => {
      mockCampaigns.set(1, {
        campaignId: 1,
        status: 'ACTIVE',
        currentAmount: BigInt(300000),
        executionCount: 3,
        targetAmount: BigInt(1000000),
      });

      const onChainState = {
        campaignId: 1,
        status: 'ACTIVE',
        currentAmount: BigInt(300000),
        executionCount: 3,
        targetAmount: BigInt(1000000),
      };

      const diffs = await checker.checkCampaign(1, onChainState);
      expect(diffs).toHaveLength(0);
    });

    it('verifies consistency after completion', async () => {
      mockCampaigns.set(1, {
        campaignId: 1,
        status: 'COMPLETED',
        currentAmount: BigInt(1000000),
        executionCount: 10,
        targetAmount: BigInt(1000000),
      });

      const onChainState = {
        campaignId: 1,
        status: 'COMPLETED',
        currentAmount: BigInt(1000000),
        executionCount: 10,
        targetAmount: BigInt(1000000),
      };

      const diffs = await checker.checkCampaign(1, onChainState);
      expect(diffs).toHaveLength(0);
    });
  });

  describe('Fixture: Multiple Concurrent Campaigns', () => {
    it('verifies consistency across multiple campaigns', async () => {
      mockCampaigns.set(1, {
        campaignId: 1,
        status: 'ACTIVE',
        currentAmount: BigInt(250000),
        executionCount: 5,
        targetAmount: BigInt(1000000),
      });

      mockCampaigns.set(2, {
        campaignId: 2,
        status: 'PAUSED',
        currentAmount: BigInt(100000),
        executionCount: 2,
        targetAmount: BigInt(500000),
      });

      mockCampaigns.set(3, {
        campaignId: 3,
        status: 'COMPLETED',
        currentAmount: BigInt(750000),
        executionCount: 15,
        targetAmount: BigInt(750000),
      });

      const onChainStates = [
        {
          campaignId: 1,
          status: 'ACTIVE',
          currentAmount: BigInt(250000),
          executionCount: 5,
          targetAmount: BigInt(1000000),
        },
        {
          campaignId: 2,
          status: 'PAUSED',
          currentAmount: BigInt(100000),
          executionCount: 2,
          targetAmount: BigInt(500000),
        },
        {
          campaignId: 3,
          status: 'COMPLETED',
          currentAmount: BigInt(750000),
          executionCount: 15,
          targetAmount: BigInt(750000),
        },
      ];

      const result = await checker.checkMultipleCampaigns(onChainStates);
      expect(result.consistent).toBe(true);
      expect(result.totalChecked).toBe(3);
      expect(result.diffs).toHaveLength(0);
    });
  });

  describe('Fixture: Edge Cases', () => {
    it('handles zero-amount campaign', async () => {
      mockCampaigns.set(1, {
        campaignId: 1,
        status: 'ACTIVE',
        currentAmount: BigInt(0),
        executionCount: 0,
        targetAmount: BigInt(0),
      });

      const onChainState = {
        campaignId: 1,
        status: 'ACTIVE',
        currentAmount: BigInt(0),
        executionCount: 0,
        targetAmount: BigInt(0),
      };

      const diffs = await checker.checkCampaign(1, onChainState);
      expect(diffs).toHaveLength(0);
    });

    it('handles large amounts', async () => {
      const largeAmount = BigInt('999999999999999999');

      mockCampaigns.set(1, {
        campaignId: 1,
        status: 'ACTIVE',
        currentAmount: largeAmount,
        executionCount: 1000,
        targetAmount: largeAmount,
      });

      const onChainState = {
        campaignId: 1,
        status: 'ACTIVE',
        currentAmount: largeAmount,
        executionCount: 1000,
        targetAmount: largeAmount,
      };

      const diffs = await checker.checkCampaign(1, onChainState);
      expect(diffs).toHaveLength(0);
    });
  });
});
