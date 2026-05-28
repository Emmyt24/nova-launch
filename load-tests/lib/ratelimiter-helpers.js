/**
 * Pure helper functions for the rate-limiter accuracy load scenario.
 *
 * Concurrency: 50 VUs firing simultaneously (5× the default budget of 100 req/min).
 * Tolerance: ±5 % of the configured per-window budget for allowed requests.
 * Denied requests must return HTTP 429.
 *
 * These helpers contain no k6 imports and are unit-testable with vitest.
 */

/**
 * Classify an HTTP status code as 'allowed', 'denied', or 'error'.
 * @param {number} status
 * @returns {'allowed'|'denied'|'error'}
 */
export function classifyResponse(status) {
  if (status >= 200 && status < 300) return 'allowed';
  if (status === 429) return 'denied';
  return 'error';
}

/**
 * Return true when |actual - expected| / expected <= toleranceFraction.
 * @param {number} actual
 * @param {number} expected
 * @param {number} toleranceFraction  e.g. 0.05 for 5 %
 * @returns {boolean}
 */
export function withinTolerance(actual, expected, toleranceFraction) {
  if (expected === 0) return actual === 0;
  return Math.abs(actual - expected) / expected <= toleranceFraction;
}

/**
 * Build a summary report from raw counters.
 *
 * @param {number} allowed        Requests that received 2xx.
 * @param {number} denied         Requests that received 429.
 * @param {number} errors         Requests that received any other status.
 * @param {number} budget         Configured max requests for the window.
 * @param {number} toleranceFraction  e.g. 0.05 for 5 %.
 * @returns {{ passed: boolean, allowed: number, denied: number, errors: number,
 *             budget: number, toleranceFraction: number,
 *             budgetWithinTolerance: boolean, deniedCorrectStatus: boolean }}
 */
export function buildRateLimitReport(allowed, denied, errors, budget, toleranceFraction) {
  const budgetWithinTolerance = withinTolerance(allowed, budget, toleranceFraction);
  const totalAttempted = allowed + denied + errors;
  const deniedCorrectStatus = denied > 0 || totalAttempted <= budget;

  return {
    passed: budgetWithinTolerance && deniedCorrectStatus && errors === 0,
    allowed,
    denied,
    errors,
    budget,
    toleranceFraction,
    budgetWithinTolerance,
    deniedCorrectStatus,
  };
}

/**
 * Format a rate-limit report for stdout.
 * @param {ReturnType<typeof buildRateLimitReport>} report
 * @param {string} [timestamp]
 * @returns {string}
 */
export function formatRateLimitSummary(report, timestamp = new Date().toISOString()) {
  const status = report.passed ? 'PASSED' : 'FAILED';
  const tolerancePct = (report.toleranceFraction * 100).toFixed(0);
  return [
    '',
    `=== Rate-Limiter Accuracy Load Test — ${status} ===`,
    `  Timestamp   : ${timestamp}`,
    `  Budget      : ${report.budget} req/window`,
    `  Tolerance   : ±${tolerancePct}%`,
    '',
    '  Counts:',
    `    Allowed   : ${report.allowed}`,
    `    Denied    : ${report.denied} (429)`,
    `    Errors    : ${report.errors}`,
    '',
    '  Assertions:',
    `    Budget within tolerance : ${report.budgetWithinTolerance ? 'yes' : 'no'}`,
    `    Denied returned 429     : ${report.deniedCorrectStatus ? 'yes' : 'no'}`,
    '',
  ].join('\n');
}
