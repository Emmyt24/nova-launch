/**
 * Pure helper functions for the rate-limiter accuracy load scenario.
 *
 * Concurrency: 50 VUs firing simultaneously against the gateway's default
 * tier of 100 requests per 15-minute window (see config/gateway-defaults.js).
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

/**
 * Convert a millisecond duration to a k6 duration string (whole seconds).
 * @param {number} ms
 * @returns {string} e.g. '900s'
 */
export function msToK6Duration(ms) {
  return `${Math.ceil(ms / 1000)}s`;
}

/**
 * Build k6 stages that hold the target VUs for exactly one rate-limit window,
 * so the allowed-request count is comparable to the per-window budget.
 *
 * @param {number} vus       Virtual users to ramp to.
 * @param {number} windowMs  Gateway rate-limit window in milliseconds.
 * @returns {Array<{ duration: string, target: number }>}
 */
export function buildWindowStages(vus, windowMs) {
  return [
    { duration: '5s', target: vus },
    { duration: msToK6Duration(windowMs), target: vus },
    { duration: '5s', target: 0 },
  ];
}

/**
 * Describe the assumptions the rate-limiter scenario will assert against.
 * Used for `--dry-run` style inspection without contacting the gateway.
 *
 * @param {{ vus: number, budget: number, windowMs: number, toleranceFraction: number, baseUrl: string }} params
 * @returns {{ baseUrl: string, vus: number, budget: number, windowMs: number,
 *             windowMinutes: number, toleranceFraction: number,
 *             stages: Array<{ duration: string, target: number }> }}
 */
export function buildRateLimitPlan({ vus, budget, windowMs, toleranceFraction, baseUrl }) {
  return {
    baseUrl,
    vus,
    budget,
    windowMs,
    windowMinutes: windowMs / 60000,
    toleranceFraction,
    stages: buildWindowStages(vus, windowMs),
  };
}
