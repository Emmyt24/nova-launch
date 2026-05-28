/**
 * Pure helper functions for the Stellar event-listener sustained-load scenario.
 *
 * Run duration : 120 s of sustained synthetic event ingestion
 * Volume       : 200 events/s aggregate across 20 VUs
 * Lag threshold: 500 ms (events must be acknowledged within 500 ms of being fired)
 *
 * These helpers contain no k6 imports and are unit-testable with vitest.
 */

/**
 * Compute ingestion lag in milliseconds.
 * @param {number} eventTimestampMs   When the event was fired (epoch ms).
 * @param {number} ackTimestampMs     When the acknowledgement was received (epoch ms).
 * @returns {number}
 */
export function computeLagMs(eventTimestampMs, ackTimestampMs) {
  return Math.max(0, ackTimestampMs - eventTimestampMs);
}

/**
 * Return true when the lag is within the allowed threshold.
 * @param {number} lagMs
 * @param {number} thresholdMs
 * @returns {boolean}
 */
export function isLagWithinThreshold(lagMs, thresholdMs) {
  return lagMs <= thresholdMs;
}

/**
 * Build a lag report from an array of lag samples.
 *
 * @param {number[]} lagSamples   Array of lag values in ms.
 * @param {number}   thresholdMs  Maximum acceptable lag.
 * @returns {{ maxLag: number, avgLag: number, violations: number,
 *             total: number, passed: boolean, thresholdMs: number }}
 */
export function buildLagReport(lagSamples, thresholdMs) {
  if (lagSamples.length === 0) {
    return { maxLag: 0, avgLag: 0, violations: 0, total: 0, passed: true, thresholdMs };
  }

  const maxLag = Math.max(...lagSamples);
  const avgLag = lagSamples.reduce((s, v) => s + v, 0) / lagSamples.length;
  const violations = lagSamples.filter((l) => l > thresholdMs).length;

  return {
    maxLag,
    avgLag,
    violations,
    total: lagSamples.length,
    passed: violations === 0,
    thresholdMs,
  };
}

/**
 * Format a lag report for stdout.
 * @param {ReturnType<typeof buildLagReport>} report
 * @param {string} [timestamp]
 * @returns {string}
 */
export function formatLagSummary(report, timestamp = new Date().toISOString()) {
  const status = report.passed ? 'PASSED' : 'FAILED';
  return [
    '',
    `=== Event-Listener Sustained Load Test — ${status} ===`,
    `  Timestamp     : ${timestamp}`,
    `  Lag threshold : ${report.thresholdMs} ms`,
    `  Total events  : ${report.total}`,
    '',
    '  Lag metrics:',
    `    Max  : ${report.maxLag.toFixed(1)} ms`,
    `    Avg  : ${report.avgLag.toFixed(1)} ms`,
    `    Violations (> threshold): ${report.violations}`,
    '',
  ].join('\n');
}
