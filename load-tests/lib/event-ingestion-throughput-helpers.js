/**
 * Pure helper functions for the event-ingestion throughput scenario
 * (scenarios/event-ingestion-throughput.js, #2213).
 *
 * Target throughput : 200 events/s (EI_TARGET_EPS)
 * Batch size        : 10 events per ingest request (EI_BATCH_SIZE)
 * p95 budget        : 500 ms per ingest batch (EI_P95_THRESHOLD_MS)
 *
 * These helpers contain no k6 imports and are unit-testable with vitest.
 */

/** Default target sustained ingestion rate, in events per second. */
export const DEFAULT_TARGET_EPS = 200;

/** Default number of events posted per ingest request. */
export const DEFAULT_BATCH_SIZE = 10;

/** Default p95 processing-latency budget per ingest batch, in ms. */
export const DEFAULT_P95_THRESHOLD_MS = 500;

/**
 * Minimum fraction of the target rate that must actually be processed for
 * the run to count as sustaining the target.
 */
export const DEFAULT_MIN_THROUGHPUT_RATIO = 0.95;

/** Minimum fraction of sent events the backend must report as processed. */
export const MIN_SUCCESS_RATE = 0.99;

/**
 * Parse a positive integer, falling back to `fallback` for missing, non-numeric,
 * zero or negative input.
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
export function parsePositiveInt(raw, fallback) {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Ingest requests per second needed to hit `targetEps` with `batchSize`
 * events per request. Rounded up so the target is never undershot.
 * @param {number} targetEps
 * @param {number} batchSize
 * @returns {number}
 */
export function computeRequestRate(targetEps, batchSize) {
  if (targetEps <= 0 || batchSize <= 0) {
    throw new Error('targetEps and batchSize must be positive');
  }
  return Math.ceil(targetEps / batchSize);
}

/**
 * Stages for a k6 `ramping-arrival-rate` executor: ramp from 0 to the target
 * request rate, hold it for `steadySec`, then ramp down.
 * @param {number} requestRate   Target ingest requests per second.
 * @param {number} rampSec
 * @param {number} steadySec
 * @returns {{ duration: string, target: number }[]}
 */
export function buildArrivalStages(requestRate, rampSec, steadySec) {
  return [
    { duration: `${rampSec}s`, target: requestRate },
    { duration: `${steadySec}s`, target: requestRate },
    { duration: '5s', target: 0 },
  ];
}

/**
 * Pre-allocated VUs for the arrival-rate executor. Each in-flight request
 * holds a VU, so by Little's law we need rate × expected latency, with
 * headroom; never fewer than `minVus`.
 * @param {number} requestRate
 * @param {number} expectedLatencyMs
 * @param {number} [minVus=5]
 * @returns {number}
 */
export function estimatePreAllocatedVus(requestRate, expectedLatencyMs, minVus = 5) {
  const inFlight = requestRate * (expectedLatencyMs / 1000);
  return Math.max(minVus, Math.ceil(inFlight * 2));
}

/**
 * Count events the backend reported as successfully processed in an ingest
 * response body: `{ data: { results: [{ success: boolean }] } }`.
 * @param {unknown} body  Parsed JSON response.
 * @returns {{ processed: number, failed: number }}
 */
export function countProcessedEvents(body) {
  const results = body?.data?.results;
  if (!Array.isArray(results)) return { processed: 0, failed: 0 };
  let processed = 0;
  for (const r of results) if (r?.success === true) processed++;
  return { processed, failed: results.length - processed };
}

/**
 * Build a governance event batch: one `proposal_created` followed by
 * `vote_cast` events on that proposal from distinct voters, so every event
 * in the batch is valid and exercises a write.
 * @param {number} proposalId
 * @param {number} batchSize
 * @param {Date} [now=new Date()]
 * @returns {object[]}
 */
export function buildEventBatch(proposalId, batchSize, now = new Date()) {
  const ts = now.toISOString();
  const ledger = 500_000 + (proposalId % 1_000_000);
  const base = { ledger, timestamp: ts, contractId: 'CTEST_GOVERNANCE_THROUGHPUT' };
  const endTime = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const events = [
    {
      ...base,
      type: 'proposal_created',
      txHash: `ei-tx-${proposalId}-0`,
      proposalId,
      tokenAddress: 'CTEST_TOKEN_THROUGHPUT',
      proposer: 'GTHROUGHPUT_PROPOSER',
      title: `Throughput proposal ${proposalId}`,
      proposalType: 'CUSTOM',
      startTime: ts,
      endTime,
      quorum: '1000',
      threshold: '500',
    },
  ];

  for (let i = 1; i < batchSize; i++) {
    events.push({
      ...base,
      type: 'vote_cast',
      txHash: `ei-tx-${proposalId}-${i}`,
      proposalId,
      voter: `GTHROUGHPUT_VOTER_${proposalId}_${i}`,
      support: i % 2 === 0,
      weight: String(100 + i),
    });
  }
  return events;
}

/**
 * Summarise a run.
 * @param {object} input
 * @param {number} input.targetEps
 * @param {number} input.steadySec
 * @param {number} input.eventsProcessed
 * @param {number} input.eventsFailed
 * @param {number} input.eventsSent
 * @param {number} input.processingP95Ms
 * @param {number} input.p95ThresholdMs
 * @param {number} input.droppedIterations  Batches k6 skipped for lack of free VUs.
 * @param {number} input.batchSize
 * @param {number} input.testDurationSec    Wall-clock run duration including ramps.
 * @param {number} [input.minThroughputRatio=DEFAULT_MIN_THROUGHPUT_RATIO]
 */
export function buildThroughputReport({
  targetEps,
  steadySec,
  eventsProcessed,
  eventsFailed,
  eventsSent,
  processingP95Ms,
  p95ThresholdMs,
  droppedIterations,
  batchSize,
  testDurationSec,
  minThroughputRatio = DEFAULT_MIN_THROUGHPUT_RATIO,
}) {
  const achievedEps = testDurationSec > 0 ? eventsProcessed / testDurationSec : 0;
  // The arrival-rate executor schedules batches on the target timeline
  // regardless of latency; batches it could not start (no free VU) are
  // "dropped". Sent + dropped is therefore what the target demanded, and a
  // backend that cannot keep up shows as processed < demanded.
  const expectedEvents = eventsSent + droppedIterations * batchSize;
  const successRate = eventsSent > 0 ? eventsProcessed / eventsSent : 0;
  const throughputRatio = expectedEvents > 0 ? eventsProcessed / expectedEvents : 0;

  const latencyOk = processingP95Ms <= p95ThresholdMs;
  const throughputOk = throughputRatio >= minThroughputRatio;
  const successOk = successRate >= MIN_SUCCESS_RATE;
  const passed = latencyOk && throughputOk && successOk;

  return {
    passed,
    targetEps,
    steadySec,
    achievedEps,
    eventsSent,
    eventsProcessed,
    eventsFailed,
    successRate,
    throughputRatio,
    droppedIterations,
    processingP95Ms,
    p95ThresholdMs,
    latencyOk,
    throughputOk,
    successOk,
  };
}

/**
 * Human-readable summary for k6 stdout.
 * @param {ReturnType<typeof buildThroughputReport>} report
 * @param {object} extra  { p50, p99, max, batchSize, timestamp, rateLimited? }
 * @returns {string}
 */
export function formatThroughputSummary(report, extra) {
  const status = report.passed ? 'PASSED' : 'FAILED';
  const pct = (v) => `${(v * 100).toFixed(2)} %`;
  const ms = (v) => `${(v ?? 0).toFixed(1)} ms`;
  const warnings = [];
  if (extra.rateLimited > 0) {
    warnings.push(
      `  WARNING: ${extra.rateLimited} batches were rate limited (HTTP 429).`,
      '  The API rate limiter, not ingestion, capped this run. See',
      '  docs/EVENT_INGESTION_THROUGHPUT.md#rate-limiting before reading results.',
      ''
    );
  }
  return [
    '',
    `=== Event Ingestion Throughput — ${status} ===`,
    `  Timestamp          : ${extra.timestamp}`,
    `  Target             : ${report.targetEps} events/s (${extra.batchSize} per batch)`,
    `  Steady state       : ${report.steadySec}s`,
    '',
    `  Events sent        : ${report.eventsSent}`,
    `  Events processed   : ${report.eventsProcessed}`,
    `  Events failed      : ${report.eventsFailed}`,
    `  Dropped batches    : ${report.droppedIterations}`,
    `  Success rate       : ${pct(report.successRate)}${report.successOk ? '' : '  ← below 99 %'}`,
    `  Throughput vs plan : ${pct(report.throughputRatio)}${report.throughputOk ? '' : '  ← below target'}`,
    `  Avg achieved rate  : ${report.achievedEps.toFixed(1)} events/s (whole run incl. ramps)`,
    '',
    '  Batch processing latency:',
    `    p50              : ${ms(extra.p50)}`,
    `    p95              : ${ms(report.processingP95Ms)} (budget ${report.p95ThresholdMs} ms)${report.latencyOk ? '' : '  ← over budget'}`,
    `    p99              : ${ms(extra.p99)}`,
    `    max              : ${ms(extra.max)}`,
    '',
    ...warnings,
  ].join('\n');
}
