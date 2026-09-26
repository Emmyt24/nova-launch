import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '../../components/UI/Card';
import { Button } from '../../components/UI/Button';
import { EmptyState } from '../../components/UI/EmptyState';
import { Spinner } from '../../components/UI/Spinner';

type CampaignStatus = 'scheduled' | 'active' | 'paused' | 'completed' | 'cancelled';
type TimelineCategory = 'execution' | 'lifecycle';

export interface CampaignMetrics {
  spent: number;
  bought: number;
  burned: number;
  budget: number;
}

export interface CampaignTimelineEvent {
  id: string;
  timestamp: number;
  category: TimelineCategory;
  step?: number;
  action: string;
  details: string;
}

export interface CampaignSnapshot {
  id: string;
  name: string;
  status: CampaignStatus;
  metrics: CampaignMetrics;
  timeline: CampaignTimelineEvent[];
}

export interface CampaignDashboardData {
  updatedAt: number;
  campaigns: CampaignSnapshot[];
}

export type CampaignDashboardFetcher = () => Promise<CampaignDashboardData>;

export interface ContractCampaignState {
  id: string;
  name: string;
  status: CampaignStatus;
  budget: number;
  spent: number;
  tokensBought: number;
  tokensBurned: number;
  executionCount: number;
  auditTrail: CampaignTimelineEvent[];
}

export interface BackendCampaignProjection {
  id: string;
  name: string;
  status: CampaignStatus;
  metrics: CampaignMetrics & { remainingBudget: number };
  timeline: CampaignTimelineEvent[];
}

interface CampaignSeed {
  id: string;
  name: string;
  budget: number;
  baseSpent: number;
  baseBought: number;
  baseBurned: number;
  spendPerTick: number;
  boughtPerTick: number;
  burnedPerTick: number;
  startOffsetMs: number;
}

const MOCK_CAMPAIGN_SEEDS: CampaignSeed[] = [
  {
    id: 'cmp-alpha',
    name: 'Treasury Buyback Alpha',
    budget: 300_000,
    baseSpent: 90_000,
    baseBought: 88_500,
    baseBurned: 75_000,
    spendPerTick: 5_000,
    boughtPerTick: 4_800,
    burnedPerTick: 4_000,
    startOffsetMs: 1000 * 60 * 60 * 24 * 5,
  },
  {
    id: 'cmp-beta',
    name: 'Quarterly Deflation Beta',
    budget: 500_000,
    baseSpent: 310_000,
    baseBought: 306_400,
    baseBurned: 290_300,
    spendPerTick: 8_500,
    boughtPerTick: 8_100,
    burnedPerTick: 7_900,
    startOffsetMs: 1000 * 60 * 60 * 24 * 12,
  },
];

let mockTick = 0;

function clamp(num: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, num));
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatAgeMs(ageMs: number): string {
  const seconds = Math.floor(Math.max(ageMs, 0) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function projectContractCampaignToBackend(contract: ContractCampaignState): BackendCampaignProjection {
  const remainingBudget = Math.max(contract.budget - contract.spent, 0);
  return {
    id: contract.id,
    name: contract.name,
    status: contract.status,
    metrics: {
      spent: contract.spent,
      bought: contract.tokensBought,
      burned: contract.tokensBurned,
      budget: contract.budget,
      remainingBudget,
    },
    timeline: contract.auditTrail.slice(),
  };
}

export function projectBackendCampaignToSnapshot(projection: BackendCampaignProjection): CampaignSnapshot {
  return {
    id: projection.id,
    name: projection.name,
    status: projection.status,
    metrics: {
      spent: projection.metrics.spent,
      bought: projection.metrics.bought,
      burned: projection.metrics.burned,
      budget: projection.metrics.budget,
    },
    timeline: projection.timeline.slice(),
  };
}

function buildMockCampaign(seed: CampaignSeed, now: number, tick: number): CampaignSnapshot {
  const spent = clamp(seed.baseSpent + tick * seed.spendPerTick, 0, seed.budget);
  const bought = clamp(seed.baseBought + tick * seed.boughtPerTick, 0, spent);
  const burned = clamp(seed.baseBurned + tick * seed.burnedPerTick, 0, bought);
  const isCompleted = spent >= seed.budget;
  const status: CampaignStatus = isCompleted ? 'completed' : 'active';

  const startedAt = now - seed.startOffsetMs;
  const lifecycleEvents: CampaignTimelineEvent[] = [
    {
      id: `${seed.id}-created`,
      timestamp: startedAt - 1000 * 60 * 10,
      category: 'lifecycle',
      action: 'Campaign created',
      details: `Budget allocated: ${formatNumber(seed.budget)}.`,
    },
    {
      id: `${seed.id}-activated`,
      timestamp: startedAt,
      category: 'lifecycle',
      action: 'Campaign activated',
      details: 'Execution guardrails passed and scheduler armed.',
    },
  ];

  if (isCompleted) {
    lifecycleEvents.push({
      id: `${seed.id}-completed`,
      timestamp: now - 1000 * 60,
      category: 'lifecycle',
      action: 'Campaign completed',
      details: 'Budget exhausted and campaign closed.',
    });
  }

  const executionCount = Math.max(1, Math.floor(spent / Math.max(1, Math.floor(seed.budget / 4))));
  const executionEvents: CampaignTimelineEvent[] = [];
  for (let step = 1; step <= executionCount; step += 1) {
    const stepTime = now - step * 1000 * 60 * 13;
    executionEvents.push(
      {
        id: `${seed.id}-step-${step}-quote`,
        timestamp: stepTime - 1000 * 60,
        category: 'execution',
        step,
        action: 'Quote accepted',
        details: `Step ${step}: slippage check passed.`,
      },
      {
        id: `${seed.id}-step-${step}-buy`,
        timestamp: stepTime,
        category: 'execution',
        step,
        action: 'Buyback executed',
        details: `Step ${step}: spent ${formatNumber(Math.floor(spent / executionCount))}.`,
      },
      {
        id: `${seed.id}-step-${step}-burn`,
        timestamp: stepTime + 1000 * 20,
        category: 'execution',
        step,
        action: 'Tokens burned',
        details: `Step ${step}: burned ${formatNumber(Math.floor(burned / executionCount))}.`,
      },
    );
  }

  return {
    id: seed.id,
    name: seed.name,
    status,
    metrics: {
      spent,
      bought,
      burned,
      budget: seed.budget,
    },
    timeline: [...lifecycleEvents, ...executionEvents],
  };
}

export const mockCampaignDashboardFetcher: CampaignDashboardFetcher = async () => {
  mockTick += 1;
  const now = Date.now();
  const campaigns = MOCK_CAMPAIGN_SEEDS.map((seed) => buildMockCampaign(seed, now, mockTick));
  return {
    updatedAt: now,
    campaigns,
  };
};

function useCampaignDashboard(
  fetchCampaigns: CampaignDashboardFetcher,
  pollIntervalMs: number,
  staleAfterMs: number,
) {
  const [data, setData] = useState<CampaignDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const inFlightRef = useRef(false);

  const refetch = useCallback(
    async (showLoading: boolean) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setIsFetching(true);

      if (showLoading) {
        setIsLoading(true);
      }

      try {
        const nextData = await fetchCampaigns();
        setData(nextData);
        setLastSuccessAt(nextData.updatedAt || Date.now());
        setError(null);
      } catch (fetchError) {
        const message = fetchError instanceof Error ? fetchError.message : 'Unable to refresh campaign dashboard';
        setError(message);
      } finally {
        setIsFetching(false);
        setIsLoading(false);
        inFlightRef.current = false;
      }
    },
    [fetchCampaigns],
  );

  useEffect(() => {
    void refetch(true);
  }, [refetch]);

  useEffect(() => {
    const pollHandle = window.setInterval(() => {
      void refetch(false);
    }, pollIntervalMs);

    return () => {
      window.clearInterval(pollHandle);
    };
  }, [pollIntervalMs, refetch]);

  useEffect(() => {
    const ticker = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(ticker);
    };
  }, []);

  const isStale = useMemo(() => {
    if (error) return true;
    if (!lastSuccessAt) return false;
    return now - lastSuccessAt > staleAfterMs;
  }, [error, lastSuccessAt, now, staleAfterMs]);

  return {
    data,
    error,
    isLoading,
    isFetching,
    isStale,
    lastSuccessAt,
    now,
    refetch,
  };
}

function statusColor(status: CampaignStatus): string {
  switch (status) {
    case 'active':
      return 'text-green-700 bg-green-100';
    case 'scheduled':
      return 'text-blue-700 bg-blue-100';
    case 'paused':
      return 'text-yellow-700 bg-yellow-100';
    case 'completed':
      return 'text-slate-700 bg-slate-100';
    case 'cancelled':
      return 'text-red-700 bg-red-100';
    default:
      return 'text-gray-700 bg-gray-100';
  }
}

function getLifecycleEvents(campaign: CampaignSnapshot): CampaignTimelineEvent[] {
  return campaign.timeline
    .filter((event) => event.category === 'lifecycle')
    .sort((a, b) => b.timestamp - a.timestamp);
}

function getExecutionSteps(campaign: CampaignSnapshot): Array<{ step: number; events: CampaignTimelineEvent[] }> {
  const grouped = new Map<number, CampaignTimelineEvent[]>();
  for (const event of campaign.timeline) {
    if (event.category !== 'execution' || event.step == null) continue;
    const events = grouped.get(event.step) ?? [];
    events.push(event);
    grouped.set(event.step, events);
  }

  return Array.from(grouped.entries())
    .sort(([stepA], [stepB]) => stepA - stepB)
    .map(([step, events]) => ({
      step,
      events: events.sort((a, b) => b.timestamp - a.timestamp),
    }));
}

interface CampaignDashboardProps {
  fetchCampaigns?: CampaignDashboardFetcher;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  isWalletConnected?: boolean;
  onReconnectWallet?: () => Promise<void> | void;
}

export default function CampaignDashboard({
  fetchCampaigns = mockCampaignDashboardFetcher,
  pollIntervalMs = 15_000,
  staleAfterMs = 35_000,
  isWalletConnected = true,
  onReconnectWallet,
}: CampaignDashboardProps) {
  const { data, error, isLoading, isFetching, isStale, lastSuccessAt, now, refetch } = useCampaignDashboard(
    fetchCampaigns,
    pollIntervalMs,
    staleAfterMs,
  );
  const [isReconnecting, setIsReconnecting] = useState(false);

  const refreshLabel = lastSuccessAt ? formatAgeMs(now - lastSuccessAt) : 'never';

  const handleReconnect = useCallback(async () => {
    if (!onReconnectWallet) return;
    setIsReconnecting(true);
    try {
      await onReconnectWallet();
      await refetch(false);
    } finally {
      setIsReconnecting(false);
    }
  }, [onReconnectWallet, refetch]);

  return (
    <div className="landing-page relative min-h-screen overflow-hidden bg-background-dark p-4 text-left text-text-primary sm:p-6 lg:p-8">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-hero-gradient opacity-60" aria-hidden="true" />
      <div className="relative space-y-6">
      {!isWalletConnected && (
        <Card className="border border-primary/30 bg-background-elevated shadow-glow-red">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-primary">Wallet disconnected</h2>
              <p className="text-sm text-text-secondary">
                Campaign actions are read-only until wallet connection is restored.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleReconnect}
              loading={isReconnecting}
              data-testid="wallet-reconnect-button"
              className="border-primary/40 text-text-primary hover:bg-primary/10"
            >
              Reconnect wallet
            </Button>
          </div>
        </Card>
      )}

      <Card className="border border-border-medium bg-background-elevated shadow-card-hover">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">Campaign Dashboard</h1>
            <p className="text-sm text-text-secondary">
              Live budget progress and audit trail across all buyback campaigns.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                isStale ? 'bg-primary/20 text-primary' : 'bg-emerald-500/20 text-emerald-300'
              }`}
              data-testid="dashboard-stale-indicator"
            >
              {isStale ? 'Stale data' : 'Live'}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refetch(false)}
              loading={isFetching}
              className="border-primary/40 text-text-primary hover:bg-primary/10"
            >
              Refresh
            </Button>
          </div>
        </div>
        <div className="mt-3 text-xs text-text-secondary" role="status" aria-live="polite">
          Last successful sync: {refreshLabel}
          {error ? ` • ${error}` : ''}
        </div>
      </Card>

      {isLoading && (
        <Card className="border border-border-medium bg-background-elevated">
          <div className="flex items-center justify-center gap-3 py-14 text-text-secondary" role="status" aria-live="polite">
            <Spinner />
            Loading campaign metrics...
          </div>
        </Card>
      )}

      {!isLoading && data && data.campaigns.length === 0 && (
        <Card className="border border-border-medium bg-background-elevated">
          <EmptyState title="No campaigns yet" description="Create a campaign to begin tracking budget execution." />
        </Card>
      )}

      {!isLoading &&
        data?.campaigns.map((campaign) => {
          const remainingBudget = Math.max(campaign.metrics.budget - campaign.metrics.spent, 0);
          const lifecycleEvents = getLifecycleEvents(campaign);
          const executionSteps = getExecutionSteps(campaign);

          return (
            <Card key={campaign.id} className="border border-border-medium bg-background-elevated shadow-card-hover" title={campaign.name}>
              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <div className="rounded-lg border border-border-medium bg-background-card p-3">
                    <p className="text-xs uppercase tracking-wide text-text-secondary">Spent</p>
                    <p className="text-lg font-semibold text-text-primary" data-testid={`metric-spent-${campaign.id}`}>
                      {formatNumber(campaign.metrics.spent)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border-medium bg-background-card p-3">
                    <p className="text-xs uppercase tracking-wide text-text-secondary">Bought</p>
                    <p className="text-lg font-semibold text-text-primary" data-testid={`metric-bought-${campaign.id}`}>
                      {formatNumber(campaign.metrics.bought)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border-medium bg-background-card p-3">
                    <p className="text-xs uppercase tracking-wide text-text-secondary">Burned</p>
                    <p className="text-lg font-semibold text-text-primary" data-testid={`metric-burned-${campaign.id}`}>
                      {formatNumber(campaign.metrics.burned)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border-medium bg-background-card p-3">
                    <p className="text-xs uppercase tracking-wide text-text-secondary">Remaining Budget</p>
                    <p className="text-lg font-semibold text-text-primary" data-testid={`metric-remaining-${campaign.id}`}>
                      {formatNumber(remainingBudget)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border-medium bg-background-card p-3">
                    <p className="text-xs uppercase tracking-wide text-text-secondary">Status</p>
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-sm font-semibold capitalize ${statusColor(campaign.status)}`}
                      data-testid={`metric-status-${campaign.id}`}
                    >
                      {campaign.status}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                  <section>
                    <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary">
                      Lifecycle Actions
                    </h3>
                    <ul className="space-y-2">
                      {lifecycleEvents.map((event, index) => (
                        <li
                          key={event.id}
                          className="rounded-lg border border-border-medium bg-background-card p-3"
                          data-testid={`timeline-lifecycle-${campaign.id}-${index}`}
                        >
                          <p className="text-sm font-medium text-text-primary">{event.action}</p>
                          <p className="text-xs text-text-secondary">{event.details}</p>
                          <p className="mt-1 text-xs text-text-muted">{formatTimestamp(event.timestamp)}</p>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section>
                    <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary">
                      Execution Steps
                    </h3>
                    <div className="space-y-4">
                      {executionSteps.map((stepGroup) => (
                        <div key={`${campaign.id}-step-${stepGroup.step}`} className="rounded-lg border border-border-medium bg-background-card p-3">
                          <p className="mb-2 text-sm font-semibold text-text-primary">Step {stepGroup.step}</p>
                          <ul className="space-y-2">
                            {stepGroup.events.map((event, index) => (
                              <li
                                key={event.id}
                                className="rounded-md border border-border-subtle bg-background-elevated p-2"
                                data-testid={`timeline-step-${campaign.id}-${stepGroup.step}-${index}`}
                              >
                                <p className="text-sm font-medium text-text-primary">{event.action}</p>
                                <p className="text-xs text-text-secondary">{event.details}</p>
                                <p className="mt-1 text-xs text-text-muted">{formatTimestamp(event.timestamp)}</p>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
