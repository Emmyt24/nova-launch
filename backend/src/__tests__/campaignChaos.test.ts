import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import { ChaosEngine } from '../services/chaosEngine';

// Mock Prisma
const mockCampaigns = new Map();
const mockExecutions = new Map();
const mockOutageActive = { value: false };

const mockPrisma = {
  campaign: {
    upsert: vi.fn(async ({ where, create }) => {
      if (mockOutageActive.value) throw new Error('Backend outage');
      if (!mockCampaigns.has(where.campaignId)) {
        const campaign = { ...create, id: `campaign-${where.campaignId}` };
        mockCampaigns.set(where.campaignId, campaign);
      }
      return mockCampaigns.get(where.campaignId);
    }),
    findUnique: vi.fn(async ({ where }) => {
      if (mockOutageActive.value) throw new Error('Backend outage');
      return mockCampaigns.get(where.campaignId) || null;
    }),
    update: vi.fn(async ({ where, data }) => {
      if (mockOutageActive.value) throw new Error('Backend outage');
      const id = where.id?.replace('campaign-', '');
      const campaign = mockCampaigns.get(Number(id));
      if (!campaign) throw new Error('Campaign not found');

      if (data.currentAmount?.increment) {
        campaign.currentAmount =
          (campaign.currentAmount || BigInt(0)) + data.currentAmount.increment;
      }
      if (data.executionCount?.increment) {
        campaign.executionCount = (campaign.executionCount || 0) + 1;
      }

      return campaign;
    }),
  },
  campaignExecution: {
    create: vi.fn(async (data) => {
      if (mockOutageActive.value) throw new Error('Backend outage');
      const create = data.data || data;
      const execution = { ...create, id: `exec-${create.txHash}` };
      mockExecutions.set(create.txHash, execution);
      return execution;
    }),
    findUnique: vi.fn(async ({ where }) => {
      if (mockOutageActive.value) throw new Error('Backend outage');
      return mockExecutions.get(where.txHash) || null;
    }),
  },
  $transaction: vi.fn(async (operations) => {
    if (mockOutageActive.value) throw new Error('Backend outage');
    const results = [];
    for (const op of operations) {
      results.push(await op);
    }
    return results;
  }),
};

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrisma),
}));

describe('Campaign Chaos Testing', () => {
  let parser: any;
  let chaosEngine: ChaosEngine;

  beforeAll(async () => {
    const { CampaignEventParser } = await import(
      '../services/campaignEventParser'
    );
    parser = new CampaignEventParser();
  });

  beforeEach(() => {
    mockCampaigns.clear();
    mockExecutions.clear();
    mockOutageActive.value = false;
    vi.clearAllMocks();
  });

  describe('Interleaved Concurrent Campaigns', () => {
    it('handles 5 campaigns with interleaved executions', async () => {
      const seed = 12345;
      chaosEngine = new ChaosEngine(seed);

      const scenario = {
        seed,
        campaigns: 5,
        executionsPerCampaign: 10,
        faults: [],
      };

      const events = chaosEngine.generateInterleavedEvents(scenario);

      // Separate creates and executions
      const creates = events.filter((e) => e.type === 'create');
      const executions = events.filter((e) => e.type === 'execute');

      // Process creates first
      for (const event of creates) {
        await parser.parseCampaignCreated({
          campaignId: event.campaignId,
          tokenId: `token-${event.campaignId}`,
          creator: 'creator-addr',
          type: 'BUYBACK',
          targetAmount: BigInt(1000000),
          startTime: new Date(event.timestamp),
          txHash: `tx-create-${event.campaignId}`,
        });
      }

      // Then process executions in interleaved order
      for (const event of executions) {
        await parser.parseCampaignExecution({
          campaignId: event.campaignId,
          executor: 'executor-addr',
          amount: event.amount,
          txHash: `tx-exec-${event.executionId}`,
          executedAt: new Date(event.timestamp),
        });
      }

      // Verify all campaigns created
      expect(mockCampaigns.size).toBe(5);

      // Verify all executions processed
      expect(mockExecutions.size).toBe(50);

      // Verify each campaign has correct execution count
      for (let i = 1; i <= 5; i++) {
        const campaign = mockCampaigns.get(i);
        expect(campaign.executionCount).toBe(10);
      }
    });

    it('maintains consistency with 10 concurrent campaigns', async () => {
      const seed = 54321;
      chaosEngine = new ChaosEngine(seed);

      const scenario = {
        seed,
        campaigns: 10,
        executionsPerCampaign: 5,
        faults: [],
      };

      const events = chaosEngine.generateInterleavedEvents(scenario);

      // Separate creates and executions
      const creates = events.filter((e) => e.type === 'create');
      const executions = events.filter((e) => e.type === 'execute');

      // Process creates first
      for (const event of creates) {
        await parser.parseCampaignCreated({
          campaignId: event.campaignId,
          tokenId: `token-${event.campaignId}`,
          creator: 'creator-addr',
          type: 'BUYBACK',
          targetAmount: BigInt(1000000),
          startTime: new Date(event.timestamp),
          txHash: `tx-create-${event.campaignId}`,
        });
      }

      // Then process executions
      for (const event of executions) {
        await parser.parseCampaignExecution({
          campaignId: event.campaignId,
          executor: 'executor-addr',
          amount: event.amount,
          txHash: `tx-exec-${event.executionId}`,
          executedAt: new Date(event.timestamp),
        });
      }

      expect(mockCampaigns.size).toBe(10);
      expect(mockExecutions.size).toBe(50);
    });
  });

  describe('Indexer Lag Injection', () => {
    it('recovers from indexer lag with delayed events', async () => {
      const seed = 11111;
      chaosEngine = new ChaosEngine(seed);

      const scenario = {
        seed,
        campaigns: 3,
        executionsPerCampaign: 5,
        faults: [{ type: 'indexer_lag' as const, probability: 0.3 }],
      };

      let events = chaosEngine.generateInterleavedEvents(scenario);
      events = chaosEngine.injectIndexerLag(events, 100);

      // Separate creates and executions
      const creates = events.filter((e) => e.type === 'create');
      const executions = events.filter((e) => e.type === 'execute');

      // Process creates first
      for (const event of creates) {
        await parser.parseCampaignCreated({
          campaignId: event.campaignId,
          tokenId: `token-${event.campaignId}`,
          creator: 'creator-addr',
          type: 'BUYBACK',
          targetAmount: BigInt(1000000),
          startTime: new Date(event.timestamp),
          txHash: `tx-create-${event.campaignId}`,
        });
      }

      // Process executions (some may be delayed)
      for (const event of executions) {
        await parser.parseCampaignExecution({
          campaignId: event.campaignId,
          executor: 'executor-addr',
          amount: event.amount,
          txHash: `tx-exec-${event.executionId}`,
          executedAt: new Date(event.timestamp),
        });
      }

      // Verify eventual consistency
      expect(mockCampaigns.size).toBe(3);
      expect(mockExecutions.size).toBe(15);
    });
  });

  describe('Duplicate Event Injection', () => {
    it('handles duplicate events without double-counting', async () => {
      const seed = 22222;
      chaosEngine = new ChaosEngine(seed);

      const scenario = {
        seed,
        campaigns: 2,
        executionsPerCampaign: 5,
        faults: [{ type: 'duplicate_event' as const, probability: 0.3 }],
      };

      let events = chaosEngine.generateInterleavedEvents(scenario);
      events = chaosEngine.injectDuplicateEvents(events, 0.3);

      // Separate creates and executions
      const creates = events.filter((e) => e.type === 'create');
      const executions = events.filter((e) => e.type === 'execute');

      // Process creates first
      for (const event of creates) {
        await parser.parseCampaignCreated({
          campaignId: event.campaignId,
          tokenId: `token-${event.campaignId}`,
          creator: 'creator-addr',
          type: 'BUYBACK',
          targetAmount: BigInt(1000000),
          startTime: new Date(event.timestamp),
          txHash: `tx-create-${event.campaignId}`,
        });
      }

      // Then process executions (including duplicates)
      for (const event of executions) {
        await parser.parseCampaignExecution({
          campaignId: event.campaignId,
          executor: 'executor-addr',
          amount: event.amount,
          txHash: `tx-exec-${event.executionId}`,
          executedAt: new Date(event.timestamp),
        });
      }

      // Verify no double-counting despite duplicates
      expect(mockCampaigns.size).toBe(2);
      expect(mockExecutions.size).toBe(10);

      for (let i = 1; i <= 2; i++) {
        const campaign = mockCampaigns.get(i);
        expect(campaign.executionCount).toBe(5);
      }
    });
  });

  describe('Backend Outage Injection', () => {
    it('recovers from partial backend outage', async () => {
      const seed = 33333;
      chaosEngine = new ChaosEngine(seed);

      const scenario = {
        seed,
        campaigns: 3,
        executionsPerCampaign: 5,
        faults: [{ type: 'backend_outage' as const, probability: 0.2 }],
      };

      let events = chaosEngine.generateInterleavedEvents(scenario);
      events = chaosEngine.injectBackendOutage(events, 1000);

      const failedEvents = [];

      for (const event of events) {
        if (event.outage) {
          mockOutageActive.value = true;
        } else {
          mockOutageActive.value = false;
        }

        try {
          if (event.type === 'create') {
            await parser.parseCampaignCreated({
              campaignId: event.campaignId,
              tokenId: `token-${event.campaignId}`,
              creator: 'creator-addr',
              type: 'BUYBACK',
              targetAmount: BigInt(1000000),
              startTime: new Date(event.timestamp),
              txHash: `tx-create-${event.campaignId}`,
            });
          } else if (event.type === 'execute') {
            await parser.parseCampaignExecution({
              campaignId: event.campaignId,
              executor: 'executor-addr',
              amount: event.amount,
              txHash: `tx-exec-${event.executionId}`,
              executedAt: new Date(event.timestamp),
            });
          }
        } catch (e) {
          failedEvents.push(event);
        }
      }

      mockOutageActive.value = false;

      // Retry failed events
      for (const event of failedEvents) {
        if (event.type === 'create') {
          await parser.parseCampaignCreated({
            campaignId: event.campaignId,
            tokenId: `token-${event.campaignId}`,
            creator: 'creator-addr',
            type: 'BUYBACK',
            targetAmount: BigInt(1000000),
            startTime: new Date(event.timestamp),
            txHash: `tx-create-${event.campaignId}`,
          });
        } else if (event.type === 'execute') {
          await parser.parseCampaignExecution({
            campaignId: event.campaignId,
            executor: 'executor-addr',
            amount: event.amount,
            txHash: `tx-exec-${event.executionId}`,
            executedAt: new Date(event.timestamp),
          });
        }
      }

      // Verify recovery
      expect(mockCampaigns.size).toBe(3);
      expect(mockExecutions.size).toBe(15);
    });
  });

  describe('Retry Storm Injection', () => {
    it('handles retry storm without corruption', async () => {
      const seed = 44444;
      chaosEngine = new ChaosEngine(seed);

      const scenario = {
        seed,
        campaigns: 2,
        executionsPerCampaign: 3,
        faults: [{ type: 'retry_storm' as const, probability: 0.3 }],
      };

      let events = chaosEngine.generateInterleavedEvents(scenario);
      events = chaosEngine.injectRetryStorm(events, 0.3);

      // Separate creates and executions
      const creates = events.filter((e) => e.type === 'create');
      const executions = events.filter((e) => e.type === 'execute');

      // Process creates first
      for (const event of creates) {
        await parser.parseCampaignCreated({
          campaignId: event.campaignId,
          tokenId: `token-${event.campaignId}`,
          creator: 'creator-addr',
          type: 'BUYBACK',
          targetAmount: BigInt(1000000),
          startTime: new Date(event.timestamp),
          txHash: `tx-create-${event.campaignId}`,
        });
      }

      // Then process executions (including retries)
      for (const event of executions) {
        await parser.parseCampaignExecution({
          campaignId: event.campaignId,
          executor: 'executor-addr',
          amount: event.amount,
          txHash: `tx-exec-${event.executionId}`,
          executedAt: new Date(event.timestamp),
        });
      }

      // Verify no corruption despite retries
      expect(mockCampaigns.size).toBe(2);
      expect(mockExecutions.size).toBe(6);

      for (let i = 1; i <= 2; i++) {
        const campaign = mockCampaigns.get(i);
        expect(campaign.executionCount).toBe(3);
      }
    });
  });

  describe('Combined Fault Scenarios', () => {
    it('survives combined faults with eventual consistency', async () => {
      const seed = 99999;
      chaosEngine = new ChaosEngine(seed);

      const scenario = {
        seed,
        campaigns: 5,
        executionsPerCampaign: 4,
        faults: [
          { type: 'indexer_lag' as const, probability: 0.2 },
          { type: 'duplicate_event' as const, probability: 0.2 },
          { type: 'retry_storm' as const, probability: 0.2 },
        ],
      };

      let events = chaosEngine.generateInterleavedEvents(scenario);
      events = chaosEngine.injectIndexerLag(events, 50);
      events = chaosEngine.injectDuplicateEvents(events, 0.2);
      events = chaosEngine.injectRetryStorm(events, 0.2);

      // Process all events with retry logic
      const failedEvents = [];
      for (const event of events) {
        try {
          if (event.type === 'create') {
            await parser.parseCampaignCreated({
              campaignId: event.campaignId,
              tokenId: `token-${event.campaignId}`,
              creator: 'creator-addr',
              type: 'BUYBACK',
              targetAmount: BigInt(1000000),
              startTime: new Date(event.timestamp),
              txHash: `tx-create-${event.campaignId}`,
            });
          } else if (event.type === 'execute') {
            await parser.parseCampaignExecution({
              campaignId: event.campaignId,
              executor: 'executor-addr',
              amount: event.amount,
              txHash: `tx-exec-${event.executionId}`,
              executedAt: new Date(event.timestamp),
            });
          }
        } catch (e) {
          failedEvents.push(event);
        }
      }

      // Retry failed events (eventual consistency)
      for (const event of failedEvents) {
        try {
          if (event.type === 'create') {
            await parser.parseCampaignCreated({
              campaignId: event.campaignId,
              tokenId: `token-${event.campaignId}`,
              creator: 'creator-addr',
              type: 'BUYBACK',
              targetAmount: BigInt(1000000),
              startTime: new Date(event.timestamp),
              txHash: `tx-create-${event.campaignId}`,
            });
          } else if (event.type === 'execute') {
            await parser.parseCampaignExecution({
              campaignId: event.campaignId,
              executor: 'executor-addr',
              amount: event.amount,
              txHash: `tx-exec-${event.executionId}`,
              executedAt: new Date(event.timestamp),
            });
          }
        } catch (e) {
          // Final retry failed, ignore
        }
      }

      // Verify eventual consistency
      expect(mockCampaigns.size).toBe(5);
      expect(mockExecutions.size).toBe(20);

      for (let i = 1; i <= 5; i++) {
        const campaign = mockCampaigns.get(i);
        expect(campaign.executionCount).toBe(4);
      }
    });
  });
});
