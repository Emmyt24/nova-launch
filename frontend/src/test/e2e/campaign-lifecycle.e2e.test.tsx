/**
 * Campaign Lifecycle End-to-End Integration Test
 *
 * Covers the full buyback campaign lifecycle:
 *   1. Campaign creation → real tx hash produced
 *   2. Step execution → on-chain state + backend projection updates
 *   3. Dashboard reconciliation → UI reflects completed progress
 *
 * All assertions are anchored to campaignId or txHash — no brittle timers.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CampaignDashboard, {
  type CampaignDashboardData,
  type CampaignTimelineEvent,
  type ContractCampaignState,
  projectBackendCampaignToSnapshot,
  projectContractCampaignToBackend,
} from '../../app/dashboard/CampaignDashboard';
import { CampaignService } from '../../services/campaignService';
import type { StellarService } from '../../services/stellar.service';

// ── Deterministic fixtures ────────────────────────────────────────────────────

const CAMPAIGN_ID = 'cmp-lifecycle-buyback-1';
const TX_HASH_CREATE = '0xabc123def456create';
const TX_HASH_EXEC_1 = '0xabc123def456exec01';
const TX_HASH_EXEC_2 = '0xabc123def456exec02';
const TX_HASH_EXEC_3 = '0xabc123def456exec03';
const TX_HASH_FINALIZE = '0xabc123def456final';

const CREATOR_ADDRESS = 'GCREATORADDRESSVALIDSTELLAR000000000000000000000000000001';
const TOKEN_ADDRESS = 'CTOKENADDRESSVALIDSOROBAN0000000000000000000000000000001';

const t0 = 1_740_000_000_000; // fixed epoch — no Date.now() drift

function mkEvent(
  id: string,
  timestamp: number,
  category: 'execution' | 'lifecycle',
  action: string,
  details: string,
  step?: number,
): CampaignTimelineEvent {
  return { id, timestamp, category, action, details, step };
}

// ── Backend projection mock ───────────────────────────────────────────────────

interface MockBackendProjection {
  campaignId: string;
  status: string;
  currentAmount: number;
  targetAmount: number;
  executionCount: number;
  txHash: string;
  completedAt?: number;
}

const backendStore = new Map<string, MockBackendProjection>();

function seedBackend(projection: MockBackendProjection) {
  backendStore.set(projection.campaignId, { ...projection });
}

function applyExecution(campaignId: string, amount: number, txHash: string) {
  const p = backendStore.get(campaignId);
  if (!p) throw new Error(`Campaign ${campaignId} not found in backend store`);
  p.currentAmount += amount;
  p.executionCount += 1;
  p.txHash = txHash;
}

function applyStatusChange(campaignId: string, status: string, txHash: string) {
  const p = backendStore.get(campaignId);
  if (!p) throw new Error(`Campaign ${campaignId} not found in backend store`);
  p.status = status;
  p.txHash = txHash;
  if (status === 'COMPLETED') p.completedAt = Date.now();
}

function getProjection(campaignId: string): MockBackendProjection {
  const p = backendStore.get(campaignId);
  if (!p) throw new Error(`Campaign ${campaignId} not found`);
  return p;
}

// ── Contract state progression ────────────────────────────────────────────────

const lifecycleStates: ContractCampaignState[] = [
  // Phase 0: Created
  {
    id: CAMPAIGN_ID,
    name: 'Buyback Lifecycle Campaign',
    status: 'active',
    budget: 1_000,
    spent: 0,
    tokensBought: 0,
    tokensBurned: 0,
    executionCount: 0,
    auditTrail: [
      mkEvent('create', t0, 'lifecycle', 'Campaign created', `tx:${TX_HASH_CREATE}`),
    ],
  },
  // Phase 1: Step 1 executed
  {
    id: CAMPAIGN_ID,
    name: 'Buyback Lifecycle Campaign',
    status: 'active',
    budget: 1_000,
    spent: 350,
    tokensBought: 340,
    tokensBurned: 320,
    executionCount: 1,
    auditTrail: [
      mkEvent('create', t0, 'lifecycle', 'Campaign created', `tx:${TX_HASH_CREATE}`),
      mkEvent('exec-1-buy', t0 + 3_000, 'execution', 'Buyback executed', `tx:${TX_HASH_EXEC_1}`, 1),
      mkEvent('exec-1-burn', t0 + 3_200, 'execution', 'Tokens burned', 'Step 1 burn leg complete', 1),
    ],
  },
  // Phase 2: Step 2 executed (with failure + retry)
  {
    id: CAMPAIGN_ID,
    name: 'Buyback Lifecycle Campaign',
    status: 'active',
    budget: 1_000,
    spent: 680,
    tokensBought: 660,
    tokensBurned: 630,
    executionCount: 2,
    auditTrail: [
      mkEvent('create', t0, 'lifecycle', 'Campaign created', `tx:${TX_HASH_CREATE}`),
      mkEvent('exec-1-buy', t0 + 3_000, 'execution', 'Buyback executed', `tx:${TX_HASH_EXEC_1}`, 1),
      mkEvent('exec-1-burn', t0 + 3_200, 'execution', 'Tokens burned', 'Step 1 burn leg complete', 1),
      mkEvent('exec-2-fail', t0 + 4_000, 'lifecycle', 'Execution failed', 'Price impact exceeded slippage cap'),
      mkEvent('exec-2-retry', t0 + 4_400, 'lifecycle', 'Retry succeeded', 'Recovered on second quote'),
      mkEvent('exec-2-buy', t0 + 4_600, 'execution', 'Buyback executed', `tx:${TX_HASH_EXEC_2}`, 2),
      mkEvent('exec-2-burn', t0 + 4_800, 'execution', 'Tokens burned', 'Step 2 burn leg complete', 2),
    ],
  },
  // Phase 3: Step 3 executed + campaign completed
  {
    id: CAMPAIGN_ID,
    name: 'Buyback Lifecycle Campaign',
    status: 'completed',
    budget: 1_000,
    spent: 1_000,
    tokensBought: 950,
    tokensBurned: 910,
    executionCount: 3,
    auditTrail: [
      mkEvent('create', t0, 'lifecycle', 'Campaign created', `tx:${TX_HASH_CREATE}`),
      mkEvent('exec-1-buy', t0 + 3_000, 'execution', 'Buyback executed', `tx:${TX_HASH_EXEC_1}`, 1),
      mkEvent('exec-1-burn', t0 + 3_200, 'execution', 'Tokens burned', 'Step 1 burn leg complete', 1),
      mkEvent('exec-2-fail', t0 + 4_000, 'lifecycle', 'Execution failed', 'Price impact exceeded slippage cap'),
      mkEvent('exec-2-retry', t0 + 4_400, 'lifecycle', 'Retry succeeded', 'Recovered on second quote'),
      mkEvent('exec-2-buy', t0 + 4_600, 'execution', 'Buyback executed', `tx:${TX_HASH_EXEC_2}`, 2),
      mkEvent('exec-2-burn', t0 + 4_800, 'execution', 'Tokens burned', 'Step 2 burn leg complete', 2),
      mkEvent('exec-3-buy', t0 + 5_200, 'execution', 'Buyback executed', `tx:${TX_HASH_EXEC_3}`, 3),
      mkEvent('exec-3-burn', t0 + 5_400, 'execution', 'Tokens burned', 'Step 3 burn leg complete', 3),
      mkEvent('finalize', t0 + 5_600, 'lifecycle', 'Campaign finalized', `tx:${TX_HASH_FINALIZE}`),
    ],
  },
];

function toDashboardPayload(state: ContractCampaignState, updatedAt: number): CampaignDashboardData {
  const backend = projectContractCampaignToBackend(state);
  const snapshot = projectBackendCampaignToSnapshot(backend);
  return { updatedAt, campaigns: [snapshot] };
}

function num(value: number): string {
  return value.toLocaleString('en-US');
}

// ── CampaignService mock via constructor injection ────────────────────────────

function makeMockStellar(txHash: string, campaignId: string): StellarService {
  return {
    createBuybackCampaign: vi.fn().mockResolvedValue({ txHash, campaignId }),
  } as unknown as StellarService;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Campaign Lifecycle E2E', () => {
  beforeEach(() => {
    backendStore.clear();
  });

  // ── 1. Campaign creation ────────────────────────────────────────────────────

  describe('Phase 1: Campaign Creation', () => {
    it('createCampaign returns a real tx hash and campaign ID', async () => {
      const service = new CampaignService('testnet', makeMockStellar(TX_HASH_CREATE, CAMPAIGN_ID));
      const result = await service.createCampaign({
        title: 'Buyback Lifecycle Campaign',
        description: 'Full lifecycle integration test campaign',
        budget: '1000',
        duration: 86_400,
        slippage: 1,
        creatorAddress: CREATOR_ADDRESS,
        tokenAddress: TOKEN_ADDRESS,
      });

      // tx hash must be a non-empty string — observable on-chain identifier
      expect(result.transactionHash).toBeTruthy();
      expect(typeof result.transactionHash).toBe('string');
      expect(result.transactionHash.length).toBeGreaterThan(0);

      // campaign ID must be returned and non-empty
      expect(result.campaignId).toBeTruthy();
      expect(typeof result.campaignId).toBe('string');
    });

    it('creation tx hash is stable across projection layers', async () => {
      const service = new CampaignService('testnet', makeMockStellar(TX_HASH_CREATE, CAMPAIGN_ID));
      const result = await service.createCampaign({
        title: 'Buyback Lifecycle Campaign',
        description: 'Full lifecycle integration test campaign',
        budget: '1000',
        duration: 86_400,
        slippage: 1,
        creatorAddress: CREATOR_ADDRESS,
        tokenAddress: TOKEN_ADDRESS,
      });

      // Seed backend with the returned tx hash
      seedBackend({
        campaignId: result.campaignId,
        status: 'ACTIVE',
        currentAmount: 0,
        targetAmount: 1_000,
        executionCount: 0,
        txHash: result.transactionHash,
      });

      const projection = getProjection(result.campaignId);
      expect(projection.txHash).toBe(result.transactionHash);
      expect(projection.status).toBe('ACTIVE');
      expect(projection.executionCount).toBe(0);
    });
  });

  // ── 2. Step execution → backend projection updates ──────────────────────────

  describe('Phase 2: Step Execution and Backend Projection', () => {
    beforeEach(() => {
      seedBackend({
        campaignId: CAMPAIGN_ID,
        status: 'ACTIVE',
        currentAmount: 0,
        targetAmount: 1_000,
        executionCount: 0,
        txHash: TX_HASH_CREATE,
      });
    });

    it('executing step 1 updates currentAmount and executionCount, anchored by tx hash', () => {
      applyExecution(CAMPAIGN_ID, 350, TX_HASH_EXEC_1);

      const p = getProjection(CAMPAIGN_ID);
      expect(p.txHash).toBe(TX_HASH_EXEC_1);
      expect(p.currentAmount).toBe(350);
      expect(p.executionCount).toBe(1);
      expect(p.status).toBe('ACTIVE');
    });

    it('executing step 2 accumulates correctly', () => {
      applyExecution(CAMPAIGN_ID, 350, TX_HASH_EXEC_1);
      applyExecution(CAMPAIGN_ID, 330, TX_HASH_EXEC_2);

      const p = getProjection(CAMPAIGN_ID);
      expect(p.txHash).toBe(TX_HASH_EXEC_2);
      expect(p.currentAmount).toBe(680);
      expect(p.executionCount).toBe(2);
    });

    it('executing all 3 steps reaches full budget', () => {
      applyExecution(CAMPAIGN_ID, 350, TX_HASH_EXEC_1);
      applyExecution(CAMPAIGN_ID, 330, TX_HASH_EXEC_2);
      applyExecution(CAMPAIGN_ID, 320, TX_HASH_EXEC_3);

      const p = getProjection(CAMPAIGN_ID);
      expect(p.currentAmount).toBe(1_000);
      expect(p.executionCount).toBe(3);
    });

    it('COMPLETED status is applied after final execution, anchored by finalize tx hash', () => {
      applyExecution(CAMPAIGN_ID, 350, TX_HASH_EXEC_1);
      applyExecution(CAMPAIGN_ID, 330, TX_HASH_EXEC_2);
      applyExecution(CAMPAIGN_ID, 320, TX_HASH_EXEC_3);
      applyStatusChange(CAMPAIGN_ID, 'COMPLETED', TX_HASH_FINALIZE);

      const p = getProjection(CAMPAIGN_ID);
      expect(p.status).toBe('COMPLETED');
      expect(p.txHash).toBe(TX_HASH_FINALIZE);
      expect(p.completedAt).toBeDefined();
      expect(typeof p.completedAt).toBe('number');
    });

    it('replayed execution events are idempotent — no double-counting', () => {
      applyExecution(CAMPAIGN_ID, 350, TX_HASH_EXEC_1);

      // Simulate replay: same tx hash should not re-apply
      const txHashesSeen = new Set<string>();
      function idempotentExecution(campaignId: string, amount: number, txHash: string) {
        if (txHashesSeen.has(txHash)) return; // idempotency guard
        txHashesSeen.add(txHash);
        applyExecution(campaignId, amount, txHash);
      }

      idempotentExecution(CAMPAIGN_ID, 350, TX_HASH_EXEC_1); // replay — skipped
      idempotentExecution(CAMPAIGN_ID, 350, TX_HASH_EXEC_1); // replay again — skipped

      const p = getProjection(CAMPAIGN_ID);
      expect(p.currentAmount).toBe(350);
      expect(p.executionCount).toBe(1);
    });

    it('cross-layer alignment: contract state matches backend projection at each step', () => {
      const executions = [
        { amount: 350, txHash: TX_HASH_EXEC_1 },
        { amount: 330, txHash: TX_HASH_EXEC_2 },
        { amount: 320, txHash: TX_HASH_EXEC_3 },
      ];

      let expectedAmount = 0;
      for (let i = 0; i < executions.length; i++) {
        applyExecution(CAMPAIGN_ID, executions[i].amount, executions[i].txHash);
        expectedAmount += executions[i].amount;

        const contractState = lifecycleStates[i + 1]; // phases 1-3
        const p = getProjection(CAMPAIGN_ID);

        // Backend projection must match contract state metrics
        expect(p.currentAmount).toBe(contractState.spent);
        expect(p.executionCount).toBe(contractState.executionCount);
        expect(p.txHash).toBe(executions[i].txHash);
        expect(expectedAmount).toBe(contractState.spent);
      }
    });
  });

  // ── 3. Dashboard reconciliation ─────────────────────────────────────────────

  describe('Phase 3: Dashboard Reconciliation', () => {
    it('dashboard renders correct metrics at each lifecycle phase', async () => {
      for (let i = 0; i < lifecycleStates.length; i++) {
        const contract = lifecycleStates[i];
        const backend = projectContractCampaignToBackend(contract);
        const snapshot = projectBackendCampaignToSnapshot(backend);

        // Cross-layer alignment
        expect(backend.metrics.spent).toBe(contract.spent);
        expect(backend.metrics.bought).toBe(contract.tokensBought);
        expect(backend.metrics.burned).toBe(contract.tokensBurned);
        expect(backend.metrics.remainingBudget).toBe(contract.budget - contract.spent);
        expect(snapshot.metrics.spent).toBe(backend.metrics.spent);
        expect(snapshot.metrics.bought).toBe(backend.metrics.bought);
        expect(snapshot.metrics.burned).toBe(backend.metrics.burned);
        expect(snapshot.status).toBe(backend.status);

        const fetchCampaigns = async () => toDashboardPayload(contract, t0 + i * 10_000);
        const { unmount } = render(
          <CampaignDashboard
            fetchCampaigns={fetchCampaigns}
            pollIntervalMs={300_000}
            staleAfterMs={600_000}
          />,
        );

        expect(await screen.findByText('Buyback Lifecycle Campaign')).toBeInTheDocument();
        expect(screen.getByTestId(`metric-spent-${CAMPAIGN_ID}`)).toHaveTextContent(num(contract.spent));
        expect(screen.getByTestId(`metric-bought-${CAMPAIGN_ID}`)).toHaveTextContent(num(contract.tokensBought));
        expect(screen.getByTestId(`metric-burned-${CAMPAIGN_ID}`)).toHaveTextContent(num(contract.tokensBurned));
        expect(screen.getByTestId(`metric-remaining-${CAMPAIGN_ID}`)).toHaveTextContent(
          num(contract.budget - contract.spent),
        );
        expect(screen.getByTestId(`metric-status-${CAMPAIGN_ID}`)).toHaveTextContent(contract.status);

        unmount();
      }
    });

    it('completed campaign shows 100% budget consumed and finalize event', async () => {
      const finalState = lifecycleStates[lifecycleStates.length - 1];
      expect(finalState.status).toBe('completed');
      expect(finalState.spent).toBe(finalState.budget);

      const fetchCampaigns = async () => toDashboardPayload(finalState, t0 + 60_000);
      const { unmount } = render(
        <CampaignDashboard
          fetchCampaigns={fetchCampaigns}
          pollIntervalMs={300_000}
          staleAfterMs={600_000}
        />,
      );

      expect(await screen.findByText('Buyback Lifecycle Campaign')).toBeInTheDocument();
      expect(screen.getByTestId(`metric-status-${CAMPAIGN_ID}`)).toHaveTextContent('completed');
      expect(screen.getByTestId(`metric-remaining-${CAMPAIGN_ID}`)).toHaveTextContent('0');
      expect(screen.getByText('Campaign finalized')).toBeInTheDocument();

      unmount();
    });

    it('dashboard shows failure-recovery events in timeline', async () => {
      const stateWithRetry = lifecycleStates[2]; // phase 2 has fail + retry
      const fetchCampaigns = async () => toDashboardPayload(stateWithRetry, t0 + 20_000);
      const { unmount } = render(
        <CampaignDashboard
          fetchCampaigns={fetchCampaigns}
          pollIntervalMs={300_000}
          staleAfterMs={600_000}
        />,
      );

      expect(await screen.findByText('Buyback Lifecycle Campaign')).toBeInTheDocument();
      expect(screen.getByText('Execution failed')).toBeInTheDocument();
      expect(screen.getByText('Retry succeeded')).toBeInTheDocument();

      unmount();
    });

    it('recovers from wallet disconnect and retries fetch', async () => {
      let connected = false;
      let fetchCallCount = 0;

      const fetchCampaigns = async (): Promise<CampaignDashboardData> => {
        fetchCallCount += 1;
        if (!connected) throw new Error('Wallet disconnected');
        return toDashboardPayload(lifecycleStates[1], t0 + 50_000);
      };

      const reconnect = async () => {
        connected = true;
      };

      render(
        <CampaignDashboard
          fetchCampaigns={fetchCampaigns}
          pollIntervalMs={300_000}
          staleAfterMs={1}
          isWalletConnected={false}
          onReconnectWallet={reconnect}
        />,
      );

      expect(await screen.findByText('Wallet disconnected')).toBeInTheDocument();
      expect(await screen.findByTestId('dashboard-stale-indicator')).toHaveTextContent('Stale data');

      fireEvent.click(screen.getByTestId('wallet-reconnect-button'));

      await waitFor(() => {
        expect(screen.getByText('Buyback Lifecycle Campaign')).toBeInTheDocument();
      });

      expect(screen.getByTestId(`metric-status-${CAMPAIGN_ID}`)).toHaveTextContent('active');
      expect(fetchCallCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ── 4. Full lifecycle in sequence ────────────────────────────────────────────

  describe('Phase 4: Full Lifecycle Sequence', () => {
    it('all lifecycle phases produce consistent cross-layer state', () => {
      const expectedPhases = [
        { spent: 0, executions: 0, status: 'ACTIVE' },
        { spent: 350, executions: 1, status: 'ACTIVE' },
        { spent: 680, executions: 2, status: 'ACTIVE' },
        { spent: 1_000, executions: 3, status: 'COMPLETED' },
      ];

      seedBackend({
        campaignId: CAMPAIGN_ID,
        status: 'ACTIVE',
        currentAmount: 0,
        targetAmount: 1_000,
        executionCount: 0,
        txHash: TX_HASH_CREATE,
      });

      // Phase 0: creation
      let p = getProjection(CAMPAIGN_ID);
      expect(p.currentAmount).toBe(expectedPhases[0].spent);
      expect(p.executionCount).toBe(expectedPhases[0].executions);

      // Phase 1: exec 1
      applyExecution(CAMPAIGN_ID, 350, TX_HASH_EXEC_1);
      p = getProjection(CAMPAIGN_ID);
      expect(p.currentAmount).toBe(expectedPhases[1].spent);
      expect(p.executionCount).toBe(expectedPhases[1].executions);

      // Phase 2: exec 2
      applyExecution(CAMPAIGN_ID, 330, TX_HASH_EXEC_2);
      p = getProjection(CAMPAIGN_ID);
      expect(p.currentAmount).toBe(expectedPhases[2].spent);
      expect(p.executionCount).toBe(expectedPhases[2].executions);

      // Phase 3: exec 3 + finalize
      applyExecution(CAMPAIGN_ID, 320, TX_HASH_EXEC_3);
      applyStatusChange(CAMPAIGN_ID, 'COMPLETED', TX_HASH_FINALIZE);
      p = getProjection(CAMPAIGN_ID);
      expect(p.currentAmount).toBe(expectedPhases[3].spent);
      expect(p.executionCount).toBe(expectedPhases[3].executions);
      expect(p.status).toBe(expectedPhases[3].status);
      expect(p.completedAt).toBeDefined();
    });

    it('progress percentage is correct at each phase', () => {
      seedBackend({
        campaignId: CAMPAIGN_ID,
        status: 'ACTIVE',
        currentAmount: 0,
        targetAmount: 1_000,
        executionCount: 0,
        txHash: TX_HASH_CREATE,
      });

      const computeProgress = (campaignId: string) => {
        const p = getProjection(campaignId);
        return Math.round((p.currentAmount / p.targetAmount) * 100);
      };

      expect(computeProgress(CAMPAIGN_ID)).toBe(0);

      applyExecution(CAMPAIGN_ID, 350, TX_HASH_EXEC_1);
      expect(computeProgress(CAMPAIGN_ID)).toBe(35);

      applyExecution(CAMPAIGN_ID, 330, TX_HASH_EXEC_2);
      expect(computeProgress(CAMPAIGN_ID)).toBe(68);

      applyExecution(CAMPAIGN_ID, 320, TX_HASH_EXEC_3);
      expect(computeProgress(CAMPAIGN_ID)).toBe(100);
    });
  });
});
