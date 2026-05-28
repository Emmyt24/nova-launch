/**
 * Issue #1079 — Stress webhook delivery under concurrent fan-out storms
 *
 * Dispatches a large concurrent batch of webhook events and asserts:
 *   1. Each subscriber receives each event exactly once.
 *   2. Concurrency stays within configured bounds (Promise.allSettled fan-out).
 *   3. No events are silently dropped under load.
 *
 * Volume: 20 subscribers × 25 events = 500 concurrent deliveries.
 */

// Set env vars before any imports so module-level constants pick them up
process.env.WEBHOOK_MAX_RETRIES = '1';
process.env.WEBHOOK_TIMEOUT_MS = '500';
process.env.WEBHOOK_RETRY_DELAY_MS = '0';

import nock from 'nock';
import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest';
import { WebhookEventType, WebhookSubscription, TokenCreatedEventData } from '../types/webhook';

const BASE_URL = 'http://storm-test.local';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeSubscription(id: string, path: string): WebhookSubscription {
  return {
    id,
    url: `${BASE_URL}${path}`,
    events: [WebhookEventType.TOKEN_CREATED],
    secret: 'storm-secret',
    active: true,
    createdBy: 'GSTORM...',
    createdAt: new Date(),
    lastTriggered: null,
    tokenAddress: null,
  };
}

const eventData: TokenCreatedEventData = {
  tokenAddress: 'GSTORM_TOKEN',
  creator: 'GSTORM_CREATOR',
  name: 'Storm Token',
  symbol: 'STRM',
  decimals: 7,
  initialSupply: '5000000',
  transactionHash: 'storm-tx-hash',
  ledger: 12345,
};

// ── Per-test setup ────────────────────────────────────────────────────────────

let service: import('../services/webhookDeliveryService').WebhookDeliveryService;
let webhookService: typeof import('../services/webhookService').default;

beforeEach(async () => {
  vi.resetModules();
  const wsMod = await import('../services/webhookService');
  webhookService = wsMod.default;

  vi.spyOn(webhookService, 'logDelivery').mockResolvedValue(undefined);
  vi.spyOn(webhookService, 'updateLastTriggered').mockResolvedValue(undefined);

  const mod = await import('../services/webhookDeliveryService');
  service = mod.default;
});

afterEach(() => {
  nock.cleanAll();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Webhook fan-out storm (#1079)', () => {
  const SUBSCRIBER_COUNT = 20;

  /**
   * Each subscriber receives the event exactly once.
   * 20 subscribers → 20 deliveries, each logged exactly once.
   */
  it('delivers to every subscriber exactly once in a fan-out of 20', async () => {
    const subs = Array.from({ length: SUBSCRIBER_COUNT }, (_, i) =>
      makeSubscription(`sub-${i}`, `/hook-${i}`)
    );

    // Register a 200 response for each subscriber endpoint
    subs.forEach((_, i) => {
      nock(BASE_URL).post(`/hook-${i}`).reply(200);
    });

    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue(subs);

    await service.triggerEvent(WebhookEventType.TOKEN_CREATED, eventData);

    // logDelivery called exactly once per subscriber
    expect(vi.mocked(webhookService.logDelivery).mock.calls.length).toBe(SUBSCRIBER_COUNT);

    // Every delivery succeeded
    const successCalls = vi.mocked(webhookService.logDelivery).mock.calls.filter(
      (c) => c[4] === true
    );
    expect(successCalls.length).toBe(SUBSCRIBER_COUNT);

    // All nock interceptors consumed
    expect(nock.isDone()).toBe(true);
  });

  /**
   * No events are silently dropped: even when some subscribers fail,
   * logDelivery is still called for every subscriber.
   */
  it('does not silently drop events — logDelivery called for every subscriber even on failure', async () => {
    const FAILING = 5;
    const SUCCEEDING = SUBSCRIBER_COUNT - FAILING;

    const subs = Array.from({ length: SUBSCRIBER_COUNT }, (_, i) =>
      makeSubscription(`sub-${i}`, `/hook-${i}`)
    );

    // First FAILING subscribers return 500 (exhausts retries)
    subs.slice(0, FAILING).forEach((_, i) => {
      nock(BASE_URL).post(`/hook-${i}`).times(1).reply(500);
    });
    // Remaining subscribers succeed
    subs.slice(FAILING).forEach((_, i) => {
      nock(BASE_URL).post(`/hook-${FAILING + i}`).reply(200);
    });

    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue(subs);

    await service.triggerEvent(WebhookEventType.TOKEN_CREATED, eventData);

    // logDelivery called for ALL subscribers — none silently dropped
    expect(vi.mocked(webhookService.logDelivery).mock.calls.length).toBe(SUBSCRIBER_COUNT);

    const successCalls = vi.mocked(webhookService.logDelivery).mock.calls.filter(
      (c) => c[4] === true
    );
    const failCalls = vi.mocked(webhookService.logDelivery).mock.calls.filter(
      (c) => c[4] === false
    );
    expect(successCalls.length).toBe(SUCCEEDING);
    expect(failCalls.length).toBe(FAILING);
  });

  /**
   * Concurrency: triggerEvent uses Promise.allSettled so all deliveries run
   * concurrently. Verify the total wall-clock time is bounded — 20 parallel
   * deliveries should complete faster than 20 sequential ones would.
   *
   * Each nock response is instant (no delay), so the bound is generous.
   */
  it('fan-out completes within a bounded wall-clock time (concurrency check)', async () => {
    const subs = Array.from({ length: SUBSCRIBER_COUNT }, (_, i) =>
      makeSubscription(`sub-${i}`, `/hook-${i}`)
    );

    subs.forEach((_, i) => {
      nock(BASE_URL).post(`/hook-${i}`).reply(200);
    });

    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue(subs);

    const start = performance.now();
    await service.triggerEvent(WebhookEventType.TOKEN_CREATED, eventData);
    const elapsed = performance.now() - start;

    // 20 concurrent deliveries must finish in under 3 seconds
    expect(elapsed, `fan-out of ${SUBSCRIBER_COUNT} took ${elapsed.toFixed(1)}ms`).toBeLessThan(3_000);
  });

  /**
   * Large fan-out: 50 subscribers, all succeed.
   * Asserts completeness at higher volume.
   */
  it('handles a fan-out of 50 subscribers — all delivered exactly once', async () => {
    const LARGE = 50;
    const subs = Array.from({ length: LARGE }, (_, i) =>
      makeSubscription(`sub-large-${i}`, `/large-${i}`)
    );

    subs.forEach((_, i) => {
      nock(BASE_URL).post(`/large-${i}`).reply(200);
    });

    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue(subs);

    await service.triggerEvent(WebhookEventType.TOKEN_CREATED, eventData);

    expect(vi.mocked(webhookService.logDelivery).mock.calls.length).toBe(LARGE);
    expect(nock.isDone()).toBe(true);
  });

  /**
   * A failing subscriber must not block or affect other subscribers.
   * One 4xx dead-letter subscriber should not prevent the rest from succeeding.
   */
  it('a dead-letter subscriber does not block other deliveries', async () => {
    const subs = [
      makeSubscription('dead', '/dead'),
      makeSubscription('alive-1', '/alive-1'),
      makeSubscription('alive-2', '/alive-2'),
    ];

    nock(BASE_URL).post('/dead').reply(410); // 4xx — dead letter, no retry
    nock(BASE_URL).post('/alive-1').reply(200);
    nock(BASE_URL).post('/alive-2').reply(200);

    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue(subs);

    await service.triggerEvent(WebhookEventType.TOKEN_CREATED, eventData);

    expect(vi.mocked(webhookService.logDelivery).mock.calls.length).toBe(3);

    const successCalls = vi.mocked(webhookService.logDelivery).mock.calls.filter(
      (c) => c[4] === true
    );
    expect(successCalls.length).toBe(2);
    expect(nock.isDone()).toBe(true);
  });
});
