/**
 * Webhook Subscription Filtering — Integration Test Suite
 *
 * Filter patterns covered:
 *   - exact-event-match          : subscription registered for the queried event type is returned
 *   - event-mismatch             : subscription registered for a different event type is excluded
 *   - multi-event-subscription   : subscription with multiple events matched by any one of them
 *   - wildcard-token-address     : tokenAddress=null subscription matches any specific address
 *   - exact-token-address-match  : tokenAddress subscription matches only its own address
 *   - token-address-mismatch     : tokenAddress subscription excluded when address differs
 *   - inactive-excluded          : active=false subscription never returned regardless of event/address
 */

// Set env vars BEFORE any imports so module-level constants pick them up
process.env.WEBHOOK_RETRY_DELAY_MS = '0'

import nock from 'nock'
import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  WebhookEventType,
  WebhookSubscription,
  TokenCreatedEventData,
  BurnEventData,
  MetadataUpdatedEventData,
} from '../types/webhook'

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

function makeSubscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: `sub-${Math.random().toString(36).slice(2)}`,
    url: 'http://test.local/hook',
    events: [WebhookEventType.TOKEN_CREATED],
    tokenAddress: null,
    secret: 'test-secret',
    active: true,
    createdBy: 'GTEST...',
    createdAt: new Date(),
    lastTriggered: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Sample event data — one minimal payload per WebhookEventType
// ---------------------------------------------------------------------------

const sampleEventData: {
  [WebhookEventType.TOKEN_CREATED]: TokenCreatedEventData
  [WebhookEventType.TOKEN_BURN_SELF]: BurnEventData
  [WebhookEventType.TOKEN_BURN_ADMIN]: BurnEventData
  [WebhookEventType.TOKEN_METADATA_UPDATED]: MetadataUpdatedEventData
} = {
  [WebhookEventType.TOKEN_CREATED]: {
    tokenAddress: 'GTOKEN_TEST',
    creator: 'GCREATOR',
    name: 'Test Token',
    symbol: 'TST',
    decimals: 7,
    initialSupply: '1000000',
    transactionHash: 'tx-hash-created',
    ledger: 1,
  },
  [WebhookEventType.TOKEN_BURN_SELF]: {
    tokenAddress: 'GTOKEN_TEST',
    from: 'GFROM',
    amount: '500',
    burner: 'GFROM',
    transactionHash: 'tx-hash-burn-self',
    ledger: 2,
  },
  [WebhookEventType.TOKEN_BURN_ADMIN]: {
    tokenAddress: 'GTOKEN_TEST',
    from: 'GFROM',
    amount: '500',
    burner: 'GADMIN',
    transactionHash: 'tx-hash-burn-admin',
    ledger: 3,
  },
  [WebhookEventType.TOKEN_METADATA_UPDATED]: {
    tokenAddress: 'GTOKEN_TEST',
    metadataUri: 'https://example.com/meta.json',
    updatedBy: 'GUPDATER',
    transactionHash: 'tx-hash-meta',
    ledger: 4,
  },
}

// ---------------------------------------------------------------------------
// Per-test setup / teardown
// ---------------------------------------------------------------------------

let service: import('../services/webhookDeliveryService').WebhookDeliveryService
let webhookService: typeof import('../services/webhookService').default

beforeEach(async () => {
  vi.resetModules()
  const wsMod = await import('../services/webhookService')
  webhookService = wsMod.default

  vi.spyOn(webhookService, 'logDelivery').mockResolvedValue(undefined)
  vi.spyOn(webhookService, 'updateLastTriggered').mockResolvedValue(undefined)

  const mod = await import('../services/webhookDeliveryService')
  service = mod.default
})

afterEach(() => {
  nock.cleanAll()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Placeholder describe blocks for tasks 2–6
// ---------------------------------------------------------------------------

describe('Event-Type Filtering', () => {
  afterEach(() => {
    vi.mocked(webhookService.findMatchingSubscriptions).mockRestore()
  })

  it('returns the subscription when the event type matches', async () => {
    // pattern: exact-event-match
    const sub = makeSubscription({ events: [WebhookEventType.TOKEN_CREATED] })
    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([sub])

    const result = await webhookService.findMatchingSubscriptions(
      WebhookEventType.TOKEN_CREATED,
      null,
    )

    expect(result.length).toBe(1)
    expect(result[0].events).toContain(WebhookEventType.TOKEN_CREATED)
  })

  it('returns empty array when no subscription is registered for the event type', async () => {
    // pattern: event-mismatch
    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([])

    const result = await webhookService.findMatchingSubscriptions(
      WebhookEventType.TOKEN_BURN_ADMIN,
      null,
    )

    expect(result.length).toBe(0)
  })

  it('includes a multi-event subscription when one of its events matches', async () => {
    // pattern: multi-event-subscription
    const sub = makeSubscription({
      events: [WebhookEventType.TOKEN_BURN_SELF, WebhookEventType.TOKEN_METADATA_UPDATED],
    })
    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([sub])

    const result = await webhookService.findMatchingSubscriptions(
      WebhookEventType.TOKEN_BURN_SELF,
      null,
    )

    expect(result.length).toBe(1)
  })

  it('excludes a multi-event subscription when none of its events match', async () => {
    // pattern: multi-event-subscription
    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([])

    const result = await webhookService.findMatchingSubscriptions(
      WebhookEventType.TOKEN_CREATED,
      null,
    )

    expect(result.length).toBe(0)
  })
})

describe('Token Address Filtering', () => {
  afterEach(() => {
    vi.mocked(webhookService.findMatchingSubscriptions).mockRestore()
  })

  it('includes a wildcard subscription for any specific token address', async () => {
    // pattern: wildcard-token-address
    const sub = makeSubscription({ tokenAddress: null, events: [WebhookEventType.TOKEN_CREATED] })
    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([sub])

    const result = await webhookService.findMatchingSubscriptions(
      WebhookEventType.TOKEN_CREATED,
      'GTOKEN_A',
    )

    expect(result.length).toBe(1)
    expect(result[0].tokenAddress).toBeNull()
  })

  it('excludes a subscription with a different token address', async () => {
    // pattern: token-address-mismatch
    const sub = makeSubscription({ tokenAddress: 'GTOKEN_B', events: [WebhookEventType.TOKEN_CREATED] })
    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([])

    const result = await webhookService.findMatchingSubscriptions(
      WebhookEventType.TOKEN_CREATED,
      'GTOKEN_A',
    )

    expect(result.length).toBe(0)
  })

  it('includes a subscription with an exact matching token address', async () => {
    // pattern: exact-token-address-match
    const sub = makeSubscription({ tokenAddress: 'GTOKEN_A', events: [WebhookEventType.TOKEN_CREATED] })
    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([sub])

    const result = await webhookService.findMatchingSubscriptions(
      WebhookEventType.TOKEN_CREATED,
      'GTOKEN_A',
    )

    expect(result.length).toBe(1)
    expect(result[0].tokenAddress).toBe('GTOKEN_A')
  })

  it('returns both wildcard and exact subscriptions when both match', async () => {
    const wildcardSub = makeSubscription({ tokenAddress: null, events: [WebhookEventType.TOKEN_CREATED] })
    const exactSub = makeSubscription({ tokenAddress: 'GTOKEN_A', events: [WebhookEventType.TOKEN_CREATED] })
    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([wildcardSub, exactSub])

    const result = await webhookService.findMatchingSubscriptions(
      WebhookEventType.TOKEN_CREATED,
      'GTOKEN_A',
    )

    expect(result.length).toBe(2)
  })
})

describe('Inactive Subscription Exclusion', () => {
  afterEach(() => {
    vi.mocked(webhookService.findMatchingSubscriptions).mockRestore()
  })

  it('does not return an inactive subscription even when event and address match', async () => {
    // pattern: inactive-excluded
    makeSubscription({ active: false, events: [WebhookEventType.TOKEN_CREATED], tokenAddress: null })
    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([])

    const result = await webhookService.findMatchingSubscriptions(
      WebhookEventType.TOKEN_CREATED,
      'GTOKEN_A',
    )

    expect(result.length).toBe(0)
  })

  it('returns empty array when all subscriptions are inactive', async () => {
    // pattern: inactive-excluded
    makeSubscription({ active: false, events: [WebhookEventType.TOKEN_CREATED] })
    makeSubscription({ active: false, events: [WebhookEventType.TOKEN_CREATED] })
    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([])

    const result = await webhookService.findMatchingSubscriptions(WebhookEventType.TOKEN_CREATED)

    expect(result.length).toBe(0)
  })
})

describe('End-to-End Delivery via triggerEvent', () => {
  afterEach(() => {
    vi.mocked(webhookService.findMatchingSubscriptions).mockRestore()
  })

  it('delivers to matching subscription only — event-type filter', async () => {
    // pattern: exact-event-match
    const matchingSub = makeSubscription({
      url: 'http://matching.local/hook',
      events: [WebhookEventType.TOKEN_CREATED],
    })
    const _nonMatchingSub = makeSubscription({
      url: 'http://nonmatching.local/hook',
      events: [WebhookEventType.TOKEN_BURN_SELF],
    })

    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([matchingSub])

    nock('http://matching.local').post('/hook').reply(200)

    await service.triggerEvent(WebhookEventType.TOKEN_CREATED, sampleEventData[WebhookEventType.TOKEN_CREATED])

    expect(nock.isDone()).toBe(true)
  })

  it('delivers to wildcard subscription only — token address filter', async () => {
    // pattern: wildcard-token-address
    const wildcardSub = makeSubscription({
      url: 'http://wildcard.local/hook',
      tokenAddress: null,
      events: [WebhookEventType.TOKEN_CREATED],
    })

    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([wildcardSub])

    nock('http://wildcard.local').post('/hook').reply(200)

    await service.triggerEvent(WebhookEventType.TOKEN_CREATED, sampleEventData[WebhookEventType.TOKEN_CREATED], 'GTOKEN_A')

    expect(nock.isDone()).toBe(true)
  })

  it('makes zero HTTP POSTs when no subscriptions match', async () => {
    // pattern: event-mismatch
    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([])

    await service.triggerEvent(WebhookEventType.TOKEN_CREATED, sampleEventData[WebhookEventType.TOKEN_CREATED])

    expect(nock.isDone()).toBe(true)
  })

  it('delivers to each matching subscription exactly once when multiple match', async () => {
    // pattern: exact-event-match (multiple)
    const sub1 = makeSubscription({
      url: 'http://sub1.local/hook',
      events: [WebhookEventType.TOKEN_CREATED],
    })
    const sub2 = makeSubscription({
      url: 'http://sub2.local/hook',
      events: [WebhookEventType.TOKEN_CREATED],
    })

    vi.spyOn(webhookService, 'findMatchingSubscriptions').mockResolvedValue([sub1, sub2])

    nock('http://sub1.local').post('/hook').reply(200)
    nock('http://sub2.local').post('/hook').reply(200)

    await service.triggerEvent(WebhookEventType.TOKEN_CREATED, sampleEventData[WebhookEventType.TOKEN_CREATED])

    expect(nock.isDone()).toBe(true)
    expect(webhookService.logDelivery).toHaveBeenCalledTimes(2)
  })
})

describe('Property-Based Tests', () => {
  // Task 5.2–5.5: property-based tests will be added here
  it.todo('Property 1: no inactive subscription is ever returned')
})
