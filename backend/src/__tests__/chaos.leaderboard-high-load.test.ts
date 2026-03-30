/**
 * Chaos Test: Leaderboard High Load
 *
 * Simulates 100+ concurrent requests to leaderboard endpoints:
 * - /api/leaderboard/most-burned
 * - /api/leaderboard/most-active
 * - /api/leaderboard/newest
 *
 * Verifies:
 * 1. All responses are 200 OK and valid JSON.
 * 2. Cache is used to minimize DB hits (prisma query hook counts).
 * 3. Latency summary is captured for high-load behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import leaderboardRoutes from '../routes/leaderboard';
import { prisma } from '../lib/prisma';
import * as leaderboardService from '../services/leaderboardService';

const app = express();
app.use(express.json());
app.use('/api/leaderboard', leaderboardRoutes);

const sampleToken = {
  id: 'token-1',
  address: '0x111',
  name: 'ChaosToken',
  symbol: 'CHS',
  decimals: 18,
  totalSupply: BigInt(1_000_000),
  totalBurned: BigInt(100_000),
  burnCount: 42,
  metadataUri: null,
  createdAt: new Date(),
};

const mostBurnedResponse = [
  { tokenId: 'token-1', _sum: { amount: BigInt(100_000) } },
];
const mostActiveResponse = [
  { tokenId: 'token-1', _count: { id: BigInt(42) } },
];

function resetPrismaMocks() {
  vi.restoreAllMocks();

  vi.spyOn(prisma.burnRecord, 'groupBy').mockImplementation(async (args: any) => {
    if (args._sum) {
      return mostBurnedResponse;
    }
    if (args._count) {
      return mostActiveResponse;
    }
    // total counts (distinct tokenId) for both most-burned and most-active
    return mostBurnedResponse;
  });

  vi.spyOn(prisma.token, 'findMany').mockResolvedValue([sampleToken] as any);
  vi.spyOn(prisma.token, 'count').mockResolvedValue(1 as any);
}

beforeEach(() => {
  leaderboardService.clearCache();
  resetPrismaMocks();
  vi.clearAllMocks();
});

describe('Chaos Test: Leaderboard High Load', () => {
  it('handles 100+ concurrent leaderboard requests with cache hit and valid JSON', async () => {
    // Warm cache with one call each before large concurrency
    await request(app).get('/api/leaderboard/most-burned').expect(200);
    await request(app).get('/api/leaderboard/most-active').expect(200);
    await request(app).get('/api/leaderboard/newest').expect(200);

    expect(prisma.burnRecord.groupBy).toHaveBeenCalledTimes(4); // 2 for most-burned, 2 for most-active
    expect(prisma.token.findMany).toHaveBeenCalledTimes(3); // one per leaderboard type
    expect(prisma.token.count).toHaveBeenCalledTimes(1); // only newest

    const endpoints = ['/most-burned', '/most-active', '/newest'];
    const requests = Array.from({ length: 120 }, (_, i) => {
      const endpoint = endpoints[i % endpoints.length];
      const startMs = Date.now();
      return request(app)
        .get(`/api/leaderboard${endpoint}`)
        .expect(200)
        .then((response) => ({
          elapsed: Date.now() - startMs,
          body: response.body,
          endpoint,
        }));
    });

    const results = await Promise.all(requests);

    // All returned valid JSON with expected shape
    results.forEach((result) => {
      expect(result.body).toHaveProperty('success', true);
      expect(result.body).toHaveProperty('data');
      expect(Array.isArray(result.body.data.data)).toBe(true);
    });

    // Ensure cached path is taken (no extra DB calls under heavy load)
    expect(prisma.burnRecord.groupBy).toHaveBeenCalledTimes(4);
    expect(prisma.token.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.token.count).toHaveBeenCalledTimes(1);

    // Latency summary
    const latencies = results.map((r) => r.elapsed);
    const maxLatency = Math.max(...latencies);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    expect(maxLatency).toBeLessThan(500);
    expect(avgLatency).toBeLessThan(250);
  });
});
