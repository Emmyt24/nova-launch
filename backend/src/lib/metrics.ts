import { logger } from './logger';

type MetricLabels = Record<string, string | number>;

interface HistogramState {
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

const DEFAULT_LATENCY_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

const histograms = new Map<string, HistogramState>();
const counters = new Map<string, number>();

function labelKey(name: string, labels: MetricLabels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k])}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

function getHistogram(name: string, labels: MetricLabels): HistogramState {
  const key = labelKey(name, labels);
  let state = histograms.get(key);
  if (!state) {
    state = {
      buckets: DEFAULT_LATENCY_BUCKETS_MS,
      counts: new Array(DEFAULT_LATENCY_BUCKETS_MS.length).fill(0),
      sum: 0,
      count: 0,
    };
    histograms.set(key, state);
  }
  return state;
}

/**
 * Record an observed latency (in milliseconds) for a named histogram.
 */
export function observeLatency(
  name: string,
  labels: MetricLabels,
  valueMs: number,
): void {
  if (!Number.isFinite(valueMs) || valueMs < 0) {
    return;
  }
  const state = getHistogram(name, labels);
  state.sum += valueMs;
  state.count += 1;
  for (let i = 0; i < state.buckets.length; i += 1) {
    if (valueMs <= state.buckets[i]) {
      state.counts[i] += 1;
    }
  }
}

/**
 * Increment a named counter with labels.
 */
export function incrementCounter(name: string, labels: MetricLabels = {}): void {
  const key = labelKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

function percentileFromHistogram(state: HistogramState, p: number): number {
  if (state.count === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * state.count);
  for (let i = 0; i < state.buckets.length; i += 1) {
    if (state.counts[i] >= rank) {
      return state.buckets[i];
    }
  }
  return state.buckets[state.buckets.length - 1];
}

/**
 * Compute p50/p95/p99 latency (ms) for a histogram name + labels.
 */
export function getLatencyPercentiles(
  name: string,
  labels: MetricLabels,
): { p50: number; p95: number; p99: number; count: number } {
  const state = getHistogram(name, labels);
  return {
    p50: percentileFromHistogram(state, 50),
    p95: percentileFromHistogram(state, 95),
    p99: percentileFromHistogram(state, 99),
    count: state.count,
  };
}

/**
 * Render all recorded metrics in a Prometheus-compatible text format.
 */
export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [key, state] of histograms.entries()) {
    const base = key.split('{')[0];
    const labelPart = key.includes('{') ? key.slice(key.indexOf('{')) : '';
    const suffix = labelPart ? labelPart.slice(0, -1) : '';
    const sep = suffix ? ',' : '';
    for (let i = 0; i < state.buckets.length; i += 1) {
      lines.push(
        `${base}_bucket${suffix}${sep}le="${state.buckets[i]}"} ${state.counts[i]}`,
      );
    }
    lines.push(`${base}_sum${suffix}${sep ? sep : ''} ${state.sum}`.replace(/\s+/g, ' '));
    lines.push(`${base}_count${suffix}${sep ? sep : ''} ${state.count}`.replace(/\s+/g, ' '));
  }
  for (const [key, value] of counters.entries()) {
    lines.push(`${key} ${value}`);
  }
  return lines.join('\n');
}

/**
 * Reset all recorded metrics. Intended for tests.
 */
export function resetMetrics(): void {
  histograms.clear();
  counters.clear();
}

const RPC_LATENCY_METRIC = 'stellar_rpc_request_duration_ms';

/**
 * Default SLA thresholds (ms) for Stellar RPC response times.
 * Overridable via env vars so operators can tune per environment.
 */
export interface RpcSlaThresholds {
  p50: number;
  p95: number;
  p99: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRpcSlaThresholds(): RpcSlaThresholds {
  return {
    p50: envNumber('STELLAR_RPC_SLA_P50_MS', 250),
    p95: envNumber('STELLAR_RPC_SLA_P95_MS', 1000),
    p99: envNumber('STELLAR_RPC_SLA_P99_MS', 2500),
  };
}

/**
 * Record the latency of an outbound Stellar RPC call, labelled by endpoint.
 * Emits an alert signal (counter + log) when the observed latency breaches
 * the configured SLA for the endpoint.
 */
export function recordRpcLatency(endpoint: string, latencyMs: number): void {
  const labels = { endpoint };
  observeLatency(RPC_LATENCY_METRIC, labels, latencyMs);

  const thresholds = getRpcSlaThresholds();
  if (latencyMs > thresholds.p99) {
    incrementCounter('stellar_rpc_sla_breach_total', { endpoint, sla: 'p99' });
    logger.warn('Stellar RPC latency breached p99 SLA', {
      endpoint,
      latencyMs,
      thresholdMs: thresholds.p99,
    });
  } else if (latencyMs > thresholds.p95) {
    incrementCounter('stellar_rpc_sla_breach_total', { endpoint, sla: 'p95' });
    logger.warn('Stellar RPC latency breached p95 SLA', {
      endpoint,
      latencyMs,
      thresholdMs: thresholds.p95,
    });
  } else if (latencyMs > thresholds.p50) {
    incrementCounter('stellar_rpc_sla_breach_total', { endpoint, sla: 'p50' });
  }
}

/**
 * Evaluate the aggregated percentiles for an endpoint against the SLA and
 * emit an alert signal if any percentile is breached.
 */
export function evaluateRpcSla(endpoint: string): {
  breached: boolean;
  percentiles: { p50: number; p95: number; p99: number; count: number };
  thresholds: RpcSlaThresholds;
} {
  const percentiles = getLatencyPercentiles(RPC_LATENCY_METRIC, { endpoint });
  const thresholds = getRpcSlaThresholds();
  const breached =
    percentiles.count > 0 &&
    (percentiles.p50 > thresholds.p50 ||
      percentiles.p95 > thresholds.p95 ||
      percentiles.p99 > thresholds.p99);

  if (breached) {
    incrementCounter('stellar_rpc_sla_breach_total', { endpoint, sla: 'aggregate' });
    logger.warn('Stellar RPC aggregated latency breached SLA', {
      endpoint,
      percentiles,
      thresholds,
    });
  }

  return { breached, percentiles, thresholds };
}
