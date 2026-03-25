// Set env vars BEFORE any imports so module-level constants pick them up
process.env.WEBHOOK_MAX_RETRIES = '3'
process.env.WEBHOOK_TIMEOUT_MS = '200'
process.env.WEBHOOK_RETRY_DELAY_MS = '0'

import nock from 'nock'
import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest'
import * as fc from 'fast-check'
import { WebhookEventType, WebhookSubscription, TokenCreatedEventData } from '../types/webhook'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BASE_URL = 'http://chaos-test.local'
const MAX_RETRIES = 3
const TIMEOUT_MS = 200

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Factory that returns a fresh WebhookSubscription pointing at the given URL.
 */
function makeSubscription(url: string): WebhookSubscription {
  return {
    id: 'sub-' + Math.random().toString(36).slice(2),
    url,
    events: [WebhookEventType.TOKEN_CREATED],
    secret: 'test-secret',
    active: true,
    createdBy: 'GTEST...',
    createdAt: new Date(),
    lastTriggered: null,
    tokenAddress: null,
  }
}

/** Sample event data for TOKEN_CREATED */
const eventData: TokenCreatedEventData = {
  tokenAddress: 'GTEST_TOKEN_ADDRESS',
  creator: 'GTEST_CREATOR',
  name: 'Chaos Token',
  symbol: 'CHAOS',
  decimals: 7,
  initialSupply: '1000000',
  transactionHash: 'chaos-tx-hash',
  ledger: 99999,
}

// ---------------------------------------------------------------------------
// Per-test setup / teardown
// ---------------------------------------------------------------------------

let service: import('../services/webhookDeliveryService').WebhookDeliveryService
let webhookService: typeof import('../services/webhookService').default

beforeEach(async () => {
  // Fresh module instance so module-level constants re-read env vars
  vi.resetModules()
  const wsMod = await import('../services/webhookService')
  webhookService = wsMod.default

  // Spy on webhookService side-effects on the SAME instance the delivery service will use
  vi.spyOn(webhookService, 'logDelivery').mockResolvedValue(undefined)
  vi.spyOn(webhookService, 'updateLastTriggered').mockResolvedValue(undefined)
  // createPayload is a pure function — let it run for real
  vi.spyOn(webhookService, 'createPayload')

  const mod = await import('../services/webhookDeliveryService')
  service = mod.default
})

afterEach(() => {
  nock.cleanAll()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Placeholder — property tests will be added in subsequent tasks
// ---------------------------------------------------------------------------

describe('Chaos Tests', () => {
  // Feature: webhook-delivery-chaos-tests, Property 1: 5xx exhaustion
  it('Property 1: 5xx exhaustion — retries exactly MAX_RETRIES times', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 500, max: 599 }), async (statusCode) => {
        nock(BASE_URL).post('/hook').times(MAX_RETRIES).reply(statusCode)
        const sub = makeSubscription(`${BASE_URL}/hook`)
        await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData)

        expect(webhookService.logDelivery).toHaveBeenCalledTimes(1)
        const call = vi.mocked(webhookService.logDelivery).mock.calls[0]
        expect(call[3]).toBe(statusCode)   // statusCode
        expect(call[4]).toBe(false)         // success
        expect(call[5]).toBe(MAX_RETRIES)   // attempts
        expect(nock.isDone()).toBe(true)

        nock.cleanAll()
        vi.mocked(webhookService.logDelivery).mockClear()
      }),
      { numRuns: 10 }  // keep fast — 10 runs × MAX_RETRIES HTTP calls each
    )
  })

  // Feature: webhook-delivery-chaos-tests, Property 2: 4xx dead-letter
  it('Property 2: 4xx dead-letter — stops after exactly 1 attempt', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 400, max: 499 }), async (statusCode) => {
        nock(BASE_URL).post('/hook').reply(statusCode)
        const sub = makeSubscription(`${BASE_URL}/hook`)
        await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData)

        expect(webhookService.logDelivery).toHaveBeenCalledTimes(1)
        const call = vi.mocked(webhookService.logDelivery).mock.calls[0]
        expect(call[3]).toBe(statusCode)   // statusCode
        expect(call[4]).toBe(false)         // success
        expect(call[5]).toBe(1)             // attempts — exactly 1
        expect(nock.isDone()).toBe(true)

        nock.cleanAll()
        vi.mocked(webhookService.logDelivery).mockClear()
      }),
      { numRuns: 20 }
    )
  })
  // Feature: webhook-delivery-chaos-tests, Property 3: flaky endpoint success
  it('Property 3: flaky endpoint — fails once then succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'),
        async (errorCode) => {
          // First request fails with network error, second succeeds
          nock(BASE_URL).post('/hook').replyWithError(errorCode)
          nock(BASE_URL).post('/hook').reply(200)
          const sub = makeSubscription(`${BASE_URL}/hook`)
          await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData)

          expect(webhookService.logDelivery).toHaveBeenCalledTimes(1)
          const call = vi.mocked(webhookService.logDelivery).mock.calls[0]
          expect(call[4]).toBe(true)   // success
          expect(call[5]).toBe(2)      // attempts
          expect(nock.isDone()).toBe(true)

          nock.cleanAll()
          vi.mocked(webhookService.logDelivery).mockClear()
          vi.mocked(webhookService.updateLastTriggered).mockClear()
        }
      ),
      { numRuns: 10 }
    )
  })

  // Feature: webhook-delivery-chaos-tests, Property 4: updateLastTriggered on success
  it('Property 4: successful delivery triggers updateLastTriggered exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: MAX_RETRIES }),
        async (successOnAttempt) => {
          // Set up (successOnAttempt - 1) network errors then a 200
          for (let i = 0; i < successOnAttempt - 1; i++) {
            nock(BASE_URL).post('/hook').replyWithError('ECONNREFUSED')
          }
          nock(BASE_URL).post('/hook').reply(200)

          const sub = makeSubscription(`${BASE_URL}/hook`)
          await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData)

          expect(webhookService.updateLastTriggered).toHaveBeenCalledTimes(1)
          expect(vi.mocked(webhookService.updateLastTriggered).mock.calls[0][0]).toBe(sub.id)
          expect(nock.isDone()).toBe(true)

          nock.cleanAll()
          vi.mocked(webhookService.logDelivery).mockClear()
          vi.mocked(webhookService.updateLastTriggered).mockClear()
        }
      ),
      { numRuns: 15 }
    )
  })

  // Feature: webhook-delivery-chaos-tests, Property 5: timeout exhaustion
  it('Property 5: timeout exhaustion — retries MAX_RETRIES times and logs failure', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(MAX_RETRIES), async (retries) => {
        // Each request delays longer than TIMEOUT_MS so axios times out
        nock(BASE_URL).post('/hook').times(retries).delay(TIMEOUT_MS + 300).reply(200)
        const sub = makeSubscription(`${BASE_URL}/hook`)
        await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData)

        expect(webhookService.logDelivery).toHaveBeenCalledTimes(1)
        const call = vi.mocked(webhookService.logDelivery).mock.calls[0]
        expect(call[4]).toBe(false)           // success = false
        expect(call[5]).toBe(MAX_RETRIES)     // attempts = MAX_RETRIES
        expect(call[6]).not.toBeNull()        // errorMessage is non-null

        nock.cleanAll()
        vi.mocked(webhookService.logDelivery).mockClear()
      }),
      { numRuns: 3 }  // timeouts are slow even at 200ms — keep runs minimal
    )
  }, 30_000)  // 30s timeout for the test itself
  // Feature: webhook-delivery-chaos-tests, Property 6: one log per invocation
  it('Property 6: one log per invocation regardless of outcome', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(200),
          fc.integer({ min: 400, max: 499 }),
          fc.integer({ min: 500, max: 599 })
        ),
        async (statusCode) => {
          const is5xx = statusCode >= 500
          if (is5xx) {
            nock(BASE_URL).post('/hook').times(MAX_RETRIES).reply(statusCode)
          } else {
            nock(BASE_URL).post('/hook').reply(statusCode)
          }
          const sub = makeSubscription(`${BASE_URL}/hook`)
          await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData)

          expect(vi.mocked(webhookService.logDelivery).mock.calls.length).toBe(1)

          nock.cleanAll()
          vi.mocked(webhookService.logDelivery).mockClear()
          vi.mocked(webhookService.updateLastTriggered).mockClear()
        }
      ),
      { numRuns: 20 }
    )
  })

  // Feature: webhook-delivery-chaos-tests, Property 7: null error message on success
  it('Property 7: successful delivery has null error message', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 200, max: 299 }),
        async (statusCode) => {
          nock(BASE_URL).post('/hook').reply(statusCode)
          const sub = makeSubscription(`${BASE_URL}/hook`)
          await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData)

          const call = vi.mocked(webhookService.logDelivery).mock.calls[0]
          expect(call[4]).toBe(true)    // success
          expect(call[6]).toBeNull()    // errorMessage = null

          nock.cleanAll()
          vi.mocked(webhookService.logDelivery).mockClear()
          vi.mocked(webhookService.updateLastTriggered).mockClear()
        }
      ),
      { numRuns: 20 }
    )
  })

  // Feature: webhook-delivery-chaos-tests, Property 8: log records event and payload
  it('Property 8: log records the event type and a non-null payload', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...Object.values(WebhookEventType)),
        async (event) => {
          nock(BASE_URL).post('/hook').reply(200)
          const sub = makeSubscription(`${BASE_URL}/hook`)
          await service.deliverWebhook(sub, event, eventData)

          const call = vi.mocked(webhookService.logDelivery).mock.calls[0]
          expect(call[1]).toBe(event)       // event type matches
          expect(call[2]).not.toBeNull()    // payload is non-null

          nock.cleanAll()
          vi.mocked(webhookService.logDelivery).mockClear()
          vi.mocked(webhookService.updateLastTriggered).mockClear()
        }
      ),
      { numRuns: 20 }
    )
  })

  // Feature: webhook-delivery-chaos-tests, Property 9: parallel delivery isolation
  it('Property 9: parallel delivery isolation — one bad endpoint does not block others', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 4 }),
        async (n) => {
          // First subscription always 5xx, rest succeed
          const badSub = makeSubscription(`${BASE_URL}/bad`)
          const goodSubs = Array.from({ length: n - 1 }, (_, i) =>
            makeSubscription(`${BASE_URL}/good-${i}`)
          )
          const allSubs = [badSub, ...goodSubs]

          // Set up nock: bad endpoint fails all MAX_RETRIES times
          nock(BASE_URL).post('/bad').times(MAX_RETRIES).reply(500)
          // Good endpoints succeed
          goodSubs.forEach((_, i) => {
            nock(BASE_URL).post(`/good-${i}`).reply(200)
          })

          // Mock findMatchingSubscriptions to return our controlled set
          vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue(allSubs)

          await service.triggerEvent(WebhookEventType.TOKEN_CREATED, eventData)

          // logDelivery called once per subscription
          expect(vi.mocked(webhookService.logDelivery).mock.calls.length).toBe(n)

          // Good subs all succeeded
          const successCalls = vi.mocked(webhookService.logDelivery).mock.calls.filter(c => c[4] === true)
          expect(successCalls.length).toBe(n - 1)

          nock.cleanAll()
          vi.mocked(webhookService.logDelivery).mockClear()
          vi.mocked(webhookService.updateLastTriggered).mockClear()
          vi.mocked(webhookService.findMatchingSubscriptions).mockRestore()
        }
      ),
      { numRuns: 10 }
    )
  })
})

describe('Unit tests — concrete log shapes', () => {
  it('14.1: exact log shape for a successful first-attempt delivery', async () => {
    nock(BASE_URL).post('/hook').reply(200)
    const sub = makeSubscription(`${BASE_URL}/hook`)

    await service.deliverWebhook(sub, WebhookEventType.TOKEN_CREATED, eventData)

    expect(webhookService.logDelivery).toHaveBeenCalledTimes(1)
    const [subscriptionId, event, payload, statusCode, success, attempts, errorMessage] =
      vi.mocked(webhookService.logDelivery).mock.calls[0]

    expect(subscriptionId).toBe(sub.id)
    expect(event).toBe(WebhookEventType.TOKEN_CREATED)
    expect(payload).not.toBeNull()
    expect(payload.event).toBe(WebhookEventType.TOKEN_CREATED)
    expect(statusCode).toBe(200)
    expect(success).toBe(true)
    expect(attempts).toBe(1)
    expect(errorMessage).toBeNull()
  })
})
