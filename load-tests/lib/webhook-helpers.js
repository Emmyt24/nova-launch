/**
 * Pure helper functions for the webhook delivery throughput load scenario.
 *
 * Methodology:
 *   - VUs fire webhook-triggering POST requests at a sustained rate.
 *   - Throughput = total successful deliveries / elapsed seconds.
 *   - Error rate = failed deliveries / total attempts.
 *
 * Thresholds:
 *   Min throughput : 50 deliveries/sec
 *   Max error rate : 1 % (0.01)
 *
 * These helpers contain no k6 imports and are unit-testable with vitest.
 */

/**
 * Compute delivery throughput in events per second.
 * @param {number} deliveredCount  Successfully delivered webhooks.
 * @param {number} durationSec     Elapsed time in seconds.
 * @returns {number}
 */
export function computeThroughput(deliveredCount, durationSec) {
  if (durationSec <= 0) return 0;
  return deliveredCount / durationSec;
}

/**
 * Compute error rate as a fraction [0, 1].
 * @param {number} errorCount
 * @param {number} totalAttempts
 * @returns {number}
 */
export function computeErrorRate(errorCount, totalAttempts) {
  if (totalAttempts === 0) return 0;
  return errorCount / totalAttempts;
}

/**
 * Return true when throughput and error rate both meet their thresholds.
 * @param {number} throughput       Deliveries per second.
 * @param {number} errorRate        Fraction [0, 1].
 * @param {number} minThroughput    Minimum acceptable deliveries/sec.
 * @param {number} maxErrorRate     Maximum acceptable error rate fraction.
 * @returns {boolean}
 */
export function passesThresholds(throughput, errorRate, minThroughput, maxErrorRate) {
  return throughput >= minThroughput && errorRate <= maxErrorRate;
}

/**
 * Build a throughput report from raw counters.
 *
 * @param {number} delivered     Successful deliveries.
 * @param {number} errors        Failed deliveries.
 * @param {number} durationSec   Elapsed seconds.
 * @param {{ minThroughput: number, maxErrorRate: number }} thresholds
 * @returns {{ throughput: number, errorRate: number, delivered: number,
 *             errors: number, total: number, durationSec: number,
 *             thresholds: object, passed: boolean }}
 */
export function buildThroughputReport(delivered, errors, durationSec, thresholds) {
  const total = delivered + errors;
  const throughput = computeThroughput(delivered, durationSec);
  const errorRate  = computeErrorRate(errors, total);
  const passed     = passesThresholds(
    throughput, errorRate, thresholds.minThroughput, thresholds.maxErrorRate
  );

  return { throughput, errorRate, delivered, errors, total, durationSec, thresholds, passed };
}

/**
 * Format a throughput report for stdout.
 * @param {ReturnType<typeof buildThroughputReport>} report
 * @param {string} [timestamp]
 * @returns {string}
 */
export function formatThroughputSummary(report, timestamp = new Date().toISOString()) {
  const status = report.passed ? 'PASSED' : 'FAILED';
  const t = report.thresholds;
  return [
    '',
    `=== Webhook Delivery Throughput Benchmark — ${status} ===`,
    `  Timestamp       : ${timestamp}`,
    `  Duration        : ${report.durationSec}s`,
    `  Total attempts  : ${report.total}`,
    '',
    '  Delivery:',
    `    Delivered     : ${report.delivered}`,
    `    Errors        : ${report.errors}`,
    `    Throughput    : ${report.throughput.toFixed(2)} req/s  (threshold: >= ${t.minThroughput})`,
    `    Error rate    : ${(report.errorRate * 100).toFixed(2)} %  (threshold: <= ${(t.maxErrorRate * 100).toFixed(0)} %)`,
    '',
  ].join('\n');
}
