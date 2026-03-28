/**
 * Integration test: Campaign Query Performance
 *
 * Seeds 1000+ campaigns and verifies that common query patterns complete
 * within acceptable latency thresholds even at scale.
 *
 * Thresholds (all < 100 ms):
 *   - Filter by status
 *   - Filter by creator
 *   - Filter by tokenId
 *   - Paginated listing (page 1, page N)
 *   - Aggregate stats
 *
 * Assumptions / edge cases:
 *   - Tests run against a real Prisma client; if the DB is unavailable the
 *     suite is skipped gracefully (console.warn + return).
 *   - Seed data is inserted in a single createMany call for speed.
 *   - All seeded rows are cleaned up in afterAll regardless of test outcome.
 *   - BigInt fields use string-coerced values to avoid JS precision issues.
 *
 * Follow-up work:
 *   - Add index-coverage assertions (EXPLAIN ANALYZE) once a test-DB helper
 *     is available.
 *   - Extend to 10 000 rows for soak-level validation.
 */

import { performance } from 'perf_hooks'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const SEED_COUNT = 1000
const SEED_TOKEN_PREFIX = 'perf-test-token-'
const SEED_CREATOR_A = 'GCREATOR_PERF_A'
const SEED_CREATOR_B = 'GCREATOR_PERF_B'
const THRESHOLD_MS = 100

/** Build a batch of campaign rows for createMany */
function buildCampaignRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    campaignId: 900_000 + i,
    tokenId: `${SEED_TOKEN_PREFIX}${i % 10}`,
    creator: i % 2 === 0 ? SEED_CREATOR_A : SEED_CREATOR_B,
    type: (['BUYBACK', 'AIRDROP', 'LIQUIDITY'] as const)[i % 3],
    status: (['ACTIVE', 'COMPLETED', 'CANCELLED', 'PAUSED'] as const)[i % 4],
    targetAmount: BigInt(1_000_000),
    currentAmount: BigInt(i * 100),
    executionCount: i % 10,
    startTime: new Date('2025-01-01'),
    txHash: `perf-tx-${i}`,
  }))
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let seeded = false

beforeAll(async () => {
  try {
    await prisma.campaign.createMany({ data: buildCampaignRows(SEED_COUNT), skipDuplicates: true })
    seeded = true
  } catch (err) {
    console.warn('DB unavailable — campaign performance tests will be skipped:', err)
  }
})

afterAll(async () => {
  if (seeded) {
    await prisma.campaign.deleteMany({
      where: { campaignId: { gte: 900_000, lt: 900_000 + SEED_COUNT } },
    })
  }
  await prisma.$disconnect()
})

// ---------------------------------------------------------------------------
// Helper: skip gracefully when DB is not available
// ---------------------------------------------------------------------------

function skipIfNotSeeded() {
  if (!seeded) return true
  return false
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Campaign query performance with 1000+ rows', () => {
  it('filter by status completes within threshold', async () => {
    if (skipIfNotSeeded()) return

    const start = performance.now()
    const rows = await prisma.campaign.findMany({
      where: { status: 'ACTIVE' },
      take: 50,
    })
    const ms = performance.now() - start

    console.log(`[perf] filter by status: ${ms.toFixed(2)}ms, rows=${rows.length}`)
    expect(ms).toBeLessThan(THRESHOLD_MS)
  })

  it('filter by creator completes within threshold', async () => {
    if (skipIfNotSeeded()) return

    const start = performance.now()
    const rows = await prisma.campaign.findMany({
      where: { creator: SEED_CREATOR_A },
      take: 50,
    })
    const ms = performance.now() - start

    console.log(`[perf] filter by creator: ${ms.toFixed(2)}ms, rows=${rows.length}`)
    expect(ms).toBeLessThan(THRESHOLD_MS)
  })

  it('filter by tokenId completes within threshold', async () => {
    if (skipIfNotSeeded()) return

    const start = performance.now()
    const rows = await prisma.campaign.findMany({
      where: { tokenId: `${SEED_TOKEN_PREFIX}0` },
      take: 50,
    })
    const ms = performance.now() - start

    console.log(`[perf] filter by tokenId: ${ms.toFixed(2)}ms, rows=${rows.length}`)
    expect(ms).toBeLessThan(THRESHOLD_MS)
  })

  it('paginated listing page 1 completes within threshold', async () => {
    if (skipIfNotSeeded()) return

    const start = performance.now()
    await prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      skip: 0,
    })
    const ms = performance.now() - start

    console.log(`[perf] paginated page 1: ${ms.toFixed(2)}ms`)
    expect(ms).toBeLessThan(THRESHOLD_MS)
  })

  it('paginated listing deep page completes within threshold', async () => {
    if (skipIfNotSeeded()) return

    const start = performance.now()
    await prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      skip: 500,
    })
    const ms = performance.now() - start

    console.log(`[perf] paginated page 26 (skip=500): ${ms.toFixed(2)}ms`)
    expect(ms).toBeLessThan(THRESHOLD_MS)
  })

  it('aggregate stats query completes within threshold', async () => {
    if (skipIfNotSeeded()) return

    const start = performance.now()
    await Promise.all([
      prisma.campaign.count(),
      prisma.campaign.count({ where: { status: 'ACTIVE' } }),
      prisma.campaign.aggregate({ _sum: { currentAmount: true, executionCount: true } }),
    ])
    const ms = performance.now() - start

    console.log(`[perf] aggregate stats: ${ms.toFixed(2)}ms`)
    expect(ms).toBeLessThan(THRESHOLD_MS)
  })
})
