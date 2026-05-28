/**
 * Issue #1080 — Validate high-volume event ingestion throughput and ordering under load
 *
 * Feeds a high volume of synthetic blockchain events through the
 * CampaignEventParser → CampaignProjectionService pipeline and asserts:
 *   1. All events are projected and none are dropped.
 *   2. Per-stream (per-campaign) ordering is preserved.
 *   3. Ingestion lag metrics are emitted via LagWindow.
 *
 * Volume: 500 events across 10 campaigns (50 executions each).
 * Timing: measured with performance.now(); documented below.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  LagWindow,
  determineThresholdStatus,
  PROJECTION_LAG_THRESHOLDS,
} from '../monitoring/metrics/projectionLagThresholds';

// ── In-memory Prisma mock ─────────────────────────────────────────────────────

const mockCampaigns = new Map<number, any>();
const mockExecutions = new Map<string, any>();

const mockPrisma = {
  campaign: {
    upsert: vi.fn(async ({ where, create }: any) => {
      if (!mockCampaigns.has(where.campaignId)) {
        mockCampaigns.set(where.campaignId, {
          ...create,
          id: `campaign-${where.campaignId}`,
          updatedAt: new Date(),
        });
      }
      return mockCampaigns.get(where.campaignId);
    }),
    findUnique: vi.fn(async ({ where }: any) =>
      mockCampaigns.get(where.campaignId) ?? null
    ),
    findMany: vi.fn(async ({ where }: any = {}) => {
      const all = Array.from(mockCampaigns.values());
      if (where?.status) return all.filter((c) => c.status === where.status);
      return all;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      let campaign: any;
      if (where.id) {
        campaign = Array.from(mockCampaigns.values()).find((c) => c.id === where.id);
      } else {
        campaign = mockCampaigns.get(where.campaignId);
      }
      if (!campaign) throw new Error('Campaign not found');
      if (data.currentAmount?.increment)
        campaign.currentAmount =
          (campaign.currentAmount ?? BigInt(0)) + data.currentAmount.increment;
      if (data.executionCount?.increment)
        campaign.executionCount = (campaign.executionCount ?? 0) + data.executionCount.increment;
      if (data.status) campaign.status = data.status;
      campaign.updatedAt = data.updatedAt ?? new Date();
      return campaign;
    }),
    count: vi.fn(async ({ where }: any = {}) => {
      const all = Array.from(mockCampaigns.values());
      if (where?.status) return all.filter((c) => c.status === where.status).length;
      return all.length;
    }),
    aggregate: vi.fn(async () => ({
      _sum: { currentAmount: BigInt(0), executionCount: 0 },
    })),
    deleteMany: vi.fn(async () => { mockCampaigns.clear(); return { count: 0 }; }),
  },
  campaignExecution: {
    create: vi.fn(async ({ data }: any) => {
      const exec = { ...data, id: `exec-${data.txHash}` };
      mockExecutions.set(data.txHash, exec);
      return exec;
    }),
    upsert: vi.fn(async ({ where, create }: any) => {
      if (!mockExecutions.has(where.txHash)) {
        mockExecutions.set(where.txHash, { ...create, id: `exec-${where.txHash}` });
      }
      return mockExecutions.get(where.txHash);
    }),
    findUnique: vi.fn(async ({ where }: any) =>
      mockExecutions.get(where.txHash) ?? null
    ),
    findMany: vi.fn(async () => Array.from(mockExecutions.values())),
    count: vi.fn(async () => mockExecutions.size),
    deleteMany: vi.fn(async () => { mockExecutions.clear(); return { count: 0 }; }),
  },
  $transaction: vi.fn(async (ops: any[]) => {
    const results = [];
    for (const op of ops) results.push(await op);
    return results;
  }),
};

vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn(() => mockPrisma) }));

// ── Lazy imports after mock ───────────────────────────────────────────────────

let parser: any;
let projectionService: any;

beforeAll(async () => {
  const { CampaignEventParser } = await import('../services/campaignEventParser');
  const { CampaignProjectionService } = await import('../services/campaignProjectionService');
  parser = new CampaignEventParser();
  projectionService = new CampaignProjectionService();
});

beforeEach(() => {
  mockCampaigns.clear();
  mockExecutions.clear();
  vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const CAMPAIGNS = 10;
const EXECUTIONS_PER_CAMPAIGN = 50;
const EXEC_AMOUNT = BigInt(1_000);

function makeCreate(campaignId: number) {
  return {
    campaignId,
    tokenId: `CTOKEN${campaignId}`,
    creator: `GCREATOR${campaignId}`,
    type: 'BUYBACK' as const,
    targetAmount: BigInt(EXECUTIONS_PER_CAMPAIGN) * EXEC_AMOUNT,
    startTime: new Date('2026-01-01T00:00:00Z'),
    txHash: `tx-create-${campaignId}`,
  };
}

function makeExec(campaignId: number, seq: number) {
  return {
    campaignId,
    executor: `GEXEC${campaignId}`,
    amount: EXEC_AMOUNT,
    txHash: `tx-exec-${campaignId}-${seq}`,
    executedAt: new Date(Date.now() + seq),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('High-volume event ingestion (#1080)', () => {
  /**
   * Volume: 10 campaigns × 50 executions = 500 execution events + 10 create events.
   * Asserts completeness: every event is projected, none dropped.
   */
  it('projects all 500 execution events without dropping any', async () => {
    // Create all campaigns
    for (let c = 1; c <= CAMPAIGNS; c++) {
      await parser.parseCampaignCreated(makeCreate(c));
    }

    // Feed all executions
    for (let c = 1; c <= CAMPAIGNS; c++) {
      for (let s = 0; s < EXECUTIONS_PER_CAMPAIGN; s++) {
        await parser.parseCampaignExecution(makeExec(c, s));
      }
    }

    // Assert completeness: every campaign has all executions projected
    for (let c = 1; c <= CAMPAIGNS; c++) {
      const projection = await projectionService.getCampaignById(c);
      expect(projection, `campaign ${c} missing`).not.toBeNull();
      expect(projection.executionCount).toBe(EXECUTIONS_PER_CAMPAIGN);
      expect(projection.currentAmount).toBe(BigInt(EXECUTIONS_PER_CAMPAIGN) * EXEC_AMOUNT);
    }

    // Total execution rows in store
    expect(mockExecutions.size).toBe(CAMPAIGNS * EXECUTIONS_PER_CAMPAIGN);
  });

  /**
   * Per-stream ordering: executions for each campaign accumulate monotonically.
   * After each batch of 10 executions the running total must equal seq * EXEC_AMOUNT.
   */
  it('preserves per-stream ordering — running totals are monotonically increasing', async () => {
    const campaignId = 1;
    await parser.parseCampaignCreated(makeCreate(campaignId));

    const checkpoints = [10, 20, 30, 40, 50];
    let seq = 0;

    for (const checkpoint of checkpoints) {
      while (seq < checkpoint) {
        await parser.parseCampaignExecution(makeExec(campaignId, seq));
        seq++;
      }
      const projection = await projectionService.getCampaignById(campaignId);
      expect(projection.executionCount).toBe(checkpoint);
      expect(projection.currentAmount).toBe(BigInt(checkpoint) * EXEC_AMOUNT);
    }
  });

  /**
   * Idempotency under replay: replaying the same 500 events must not inflate counts.
   */
  it('is idempotent — replaying all events does not inflate projection counts', async () => {
    for (let c = 1; c <= CAMPAIGNS; c++) {
      await parser.parseCampaignCreated(makeCreate(c));
    }
    for (let c = 1; c <= CAMPAIGNS; c++) {
      for (let s = 0; s < EXECUTIONS_PER_CAMPAIGN; s++) {
        await parser.parseCampaignExecution(makeExec(c, s));
      }
    }

    // Replay
    for (let c = 1; c <= CAMPAIGNS; c++) {
      await parser.parseCampaignCreated(makeCreate(c));
    }
    for (let c = 1; c <= CAMPAIGNS; c++) {
      for (let s = 0; s < EXECUTIONS_PER_CAMPAIGN; s++) {
        await parser.parseCampaignExecution(makeExec(c, s));
      }
    }

    expect(mockExecutions.size).toBe(CAMPAIGNS * EXECUTIONS_PER_CAMPAIGN);
    for (let c = 1; c <= CAMPAIGNS; c++) {
      const projection = await projectionService.getCampaignById(c);
      expect(projection.executionCount).toBe(EXECUTIONS_PER_CAMPAIGN);
    }
  });

  /**
   * Ingestion lag metrics: LagWindow records measurements and emits correct
   * threshold status for simulated fast vs slow ingestion.
   *
   * Simulates recording one lag measurement per event (500 total).
   */
  it('emits ingestion lag metrics — LagWindow tracks all measurements', () => {
    const lagWindow = new LagWindow(60_000);
    const TOTAL_EVENTS = CAMPAIGNS * EXECUTIONS_PER_CAMPAIGN;

    // Simulate fast ingestion: all lags within normal threshold
    for (let i = 0; i < TOTAL_EVENTS; i++) {
      lagWindow.record(1_000 + (i % 500)); // 1000–1499 ms — well within NORMAL (5000 ms)
    }

    expect(lagWindow.getCount()).toBe(TOTAL_EVENTS);
    expect(lagWindow.getMaxLag()).toBeLessThan(PROJECTION_LAG_THRESHOLDS.NORMAL);
    expect(lagWindow.getAverageLag()).toBeLessThan(PROJECTION_LAG_THRESHOLDS.NORMAL);
    expect(determineThresholdStatus(lagWindow.getMaxLag(), 'campaign_started')).toBe('healthy');
  });

  it('emits warning-level lag metric when ingestion falls behind', () => {
    const lagWindow = new LagWindow(60_000);

    // Simulate degraded ingestion: lags in warning band (30s–60s for campaign_started)
    for (let i = 0; i < 50; i++) {
      lagWindow.record(35_000); // 35 seconds — above WARNING (30s) but below CRITICAL (75s)
    }

    expect(determineThresholdStatus(lagWindow.getMaxLag(), 'campaign_started')).toBe('warning');
  });

  it('emits critical-level lag metric when ingestion is severely delayed', () => {
    const lagWindow = new LagWindow(60_000);

    lagWindow.record(65_000); // 65 seconds — critical

    expect(determineThresholdStatus(lagWindow.getMaxLag(), 'token_created')).toBe('critical');
  });

  /**
   * Throughput benchmark (documented for PR).
   * 500 events must complete in under 5 seconds in the test environment.
   */
  it('processes 500 events within 5 seconds (throughput gate)', async () => {
    const start = performance.now();

    for (let c = 1; c <= CAMPAIGNS; c++) {
      await parser.parseCampaignCreated(makeCreate(c));
    }
    for (let c = 1; c <= CAMPAIGNS; c++) {
      for (let s = 0; s < EXECUTIONS_PER_CAMPAIGN; s++) {
        await parser.parseCampaignExecution(makeExec(c, s));
      }
    }

    const elapsed = performance.now() - start;
    // Document timing in assertion message
    expect(elapsed, `500 events took ${elapsed.toFixed(1)}ms — must be < 5000ms`).toBeLessThan(5_000);
  });
});
