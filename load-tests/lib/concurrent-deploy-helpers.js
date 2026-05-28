/**
 * Pure helper functions for the concurrent token-deployment stress scenario.
 * Extracted for unit testing — k6-specific modules are not available in Node.js.
 */

const DEPLOY_VARIANTS = ['standard', 'with_metadata', 'with_supply_cap'];

/**
 * Pick a deployment variant based on a [0,1) roll.
 *
 * Distribution:
 *   [0.00, 0.60) → standard        (bare minimum fields)
 *   [0.60, 0.85) → with_metadata   (includes name/url metadata)
 *   [0.85, 1.00) → with_supply_cap (includes a hard supply ceiling)
 *
 * @param {number} roll  Random value in [0, 1)
 * @returns {'standard'|'with_metadata'|'with_supply_cap'}
 */
export function selectDeployVariant(roll) {
  if (roll < 0.60) return DEPLOY_VARIANTS[0];
  if (roll < 0.85) return DEPLOY_VARIANTS[1];
  return DEPLOY_VARIANTS[2];
}

/**
 * Build a token deployment request payload for the given variant.
 *
 * @param {'standard'|'with_metadata'|'with_supply_cap'} variant
 * @returns {object}
 */
export function buildDeployPayload(variant) {
  const base = {
    name: `StressToken_${Date.now()}`,
    symbol: 'STK',
    decimals: 7,
    initialSupply: 1_000_000,
  };

  if (variant === 'with_metadata') {
    return {
      ...base,
      metadata: { description: 'Load test token', url: 'https://example.com' },
    };
  }

  if (variant === 'with_supply_cap') {
    return { ...base, supplyCap: 10_000_000 };
  }

  return base;
}

/**
 * Build the summary object written to concurrent-deploy-summary.json.
 *
 * @param {object} k6Data  k6 handleSummary data object
 * @param {number} vus     Configured concurrent VUs
 * @param {number} duration  Steady-state duration in seconds
 * @returns {object}
 */
export function buildDeploySummary(k6Data, vus, duration) {
  const passed = !Object.values(k6Data.metrics ?? {}).some(
    (m) => m.thresholds && Object.values(m.thresholds).some((t) => t.ok === false)
  );

  return {
    passed,
    timestamp: new Date().toISOString(),
    concurrentVus: vus,
    duration,
    metrics: {
      deploy_duration_p95: k6Data.metrics?.deploy_duration?.values?.['p(95)'],
      deploy_duration_p99: k6Data.metrics?.deploy_duration?.values?.['p(99)'],
      deploy_error_rate: k6Data.metrics?.deploy_errors?.values?.rate,
      deploy_total: k6Data.metrics?.deploy_total?.values?.count,
      http_req_failed_rate: k6Data.metrics?.http_req_failed?.values?.rate,
    },
    thresholds: Object.fromEntries(
      Object.entries(k6Data.metrics ?? {})
        .filter(([, m]) => m.thresholds)
        .map(([name, m]) => [name, m.thresholds])
    ),
  };
}

/**
 * Format the deploy summary for stdout.
 *
 * @param {object} s  Output of buildDeploySummary()
 * @returns {string}
 */
export function formatDeploySummary(s) {
  const status = s.passed ? '✅ PASSED' : '❌ FAILED';
  const m = s.metrics;
  return [
    '',
    `=== Concurrent Deploy Stress Test — ${status} ===`,
    `  Timestamp         : ${s.timestamp}`,
    `  Concurrent VUs    : ${s.concurrentVus}`,
    `  Duration          : ${s.duration}s steady state`,
    '',
    '  Deployment Latency:',
    `    p95 : ${m.deploy_duration_p95?.toFixed(1) ?? 'n/a'} ms`,
    `    p99 : ${m.deploy_duration_p99?.toFixed(1) ?? 'n/a'} ms`,
    '',
    '  Reliability:',
    `    Deploy error rate : ${((m.deploy_error_rate ?? 0) * 100).toFixed(2)} %`,
    `    HTTP error rate   : ${((m.http_req_failed_rate ?? 0) * 100).toFixed(2)} %`,
    '',
    `  Total deployments  : ${m.deploy_total ?? 0}`,
    '',
    '  Thresholds:',
    '    p95 < 3000 ms · p99 < 6000 ms · error rate < 5 %',
    '',
  ].join('\n');
}
