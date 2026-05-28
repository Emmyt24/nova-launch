/**
 * Pure helper functions for the GraphQL performance load scenario.
 *
 * Query mix (representative of production traffic):
 *   40% — tokens list          (paginated, read-heavy)
 *   25% — token detail         (single-entity lookup with burns)
 *   20% — streams list         (filtered by status)
 *   15% — proposals list       (governance aggregation)
 *
 * Latency thresholds:
 *   p50 < 200 ms · p95 < 500 ms · p99 < 1 000 ms
 *
 * These helpers contain no k6 imports and are unit-testable with vitest.
 */

/**
 * Select a GraphQL query label based on a [0,1) roll.
 * @param {number} roll
 * @returns {'tokens_list'|'token_detail'|'streams_list'|'proposals_list'}
 */
export function selectGraphQLQuery(roll) {
  if (roll < 0.40) return 'tokens_list';
  if (roll < 0.65) return 'token_detail';
  if (roll < 0.85) return 'streams_list';
  return 'proposals_list';
}

/**
 * Compute a percentile from a sorted (ascending) array of numeric samples.
 * Uses the nearest-rank method.
 *
 * @param {number[]} sorted  Pre-sorted ascending array.
 * @param {number}   pct     Percentile in [0, 100].
 * @returns {number}
 */
export function computePercentile(sorted, pct) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/**
 * Assess whether latency percentiles meet the defined thresholds.
 *
 * @param {{ p50: number, p95: number, p99: number }} latencies
 * @param {{ p50: number, p95: number, p99: number }} thresholds
 * @returns {boolean}
 */
export function meetsLatencyThresholds(latencies, thresholds) {
  return (
    latencies.p50 <= thresholds.p50 &&
    latencies.p95 <= thresholds.p95 &&
    latencies.p99 <= thresholds.p99
  );
}

/**
 * Build a latency report from an unsorted sample array.
 *
 * @param {number[]} samples     Raw latency samples in ms.
 * @param {{ p50: number, p95: number, p99: number }} thresholds
 * @returns {{ p50: number, p95: number, p99: number,
 *             thresholds: object, passed: boolean, total: number }}
 */
export function buildLatencyReport(samples, thresholds) {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, p99: 0, thresholds, passed: true, total: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = computePercentile(sorted, 50);
  const p95 = computePercentile(sorted, 95);
  const p99 = computePercentile(sorted, 99);
  const passed = meetsLatencyThresholds({ p50, p95, p99 }, thresholds);

  return { p50, p95, p99, thresholds, passed, total: samples.length };
}

/**
 * Format a latency report for stdout.
 * @param {ReturnType<typeof buildLatencyReport>} report
 * @param {string} [timestamp]
 * @returns {string}
 */
export function formatLatencySummary(report, timestamp = new Date().toISOString()) {
  const status = report.passed ? 'PASSED' : 'FAILED';
  const t = report.thresholds;
  return [
    '',
    `=== GraphQL Performance Load Test — ${status} ===`,
    `  Timestamp     : ${timestamp}`,
    `  Total queries : ${report.total}`,
    '',
    '  Latency (ms):',
    `    p50 : ${report.p50.toFixed(1)}  (threshold: < ${t.p50})`,
    `    p95 : ${report.p95.toFixed(1)}  (threshold: < ${t.p95})`,
    `    p99 : ${report.p99.toFixed(1)}  (threshold: < ${t.p99})`,
    '',
  ].join('\n');
}
