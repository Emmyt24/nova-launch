import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';
import {
  dispatchAlert,
  resolveIncident,
  alertStreamDivergence,
  resolveStreamDivergence,
  _resetRateLimiter,
} from '../pagerduty';

vi.mock('https');

function mockHttpsRequest(statusCode = 200, responseBody = { status: 'success', message: 'Event processed', dedup_key: 'dedup-123' }) {
  const req = new EventEmitter() as any;
  req.write = vi.fn();
  req.end = vi.fn();

  vi.mocked(https.request).mockImplementation((options: any, callback: any) => {
    const res = new EventEmitter() as any;
    res.statusCode = statusCode;
    process.nextTick(() => {
      callback(res);
      res.emit('data', JSON.stringify(responseBody));
      res.emit('end');
    });
    return req;
  });

  return req;
}

describe('pagerduty', () => {
  const origRoutingKey = process.env.PAGERDUTY_ROUTING_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimiter();
    process.env.PAGERDUTY_ROUTING_KEY = 'test-routing-key';
  });

  afterEach(() => {
    process.env.PAGERDUTY_ROUTING_KEY = origRoutingKey;
  });

  describe('dispatchAlert', () => {
    it('throws error when routing key is missing', async () => {
      delete process.env.PAGERDUTY_ROUTING_KEY;
      await expect(
        dispatchAlert('contract-divergence', {
          summary: 'Critical alert',
          dedupKey: 'dedup-1',
          source: 'test-source',
        })
      ).rejects.toThrow('PAGERDUTY_ROUTING_KEY is not set');
    });

    it('dispatches P1 alert and handles success response', async () => {
      mockHttpsRequest(202, { status: 'success', message: 'Event queued', dedup_key: 'dedup-1' });

      const res = await dispatchAlert('contract-divergence', {
        summary: 'Critical alert',
        dedupKey: 'dedup-1',
        source: 'test-source',
      });

      expect(res).toEqual({ status: 'success', message: 'Event queued', dedup_key: 'dedup-1' });
      expect(https.request).toHaveBeenCalled();
    });

    it('handles HTTP error status codes', async () => {
      mockHttpsRequest(400, { status: 'error', message: 'Bad request', dedup_key: 'dedup-1' });

      await expect(
        dispatchAlert('contract-divergence', {
          summary: 'Critical alert',
          dedupKey: 'dedup-1',
          source: 'test-source',
        })
      ).rejects.toThrow('PagerDuty API error 400');
    });

    it('enforces rate limiting for non-P1 alerts', async () => {
      mockHttpsRequest(200, { status: 'success', message: 'ok', dedup_key: 'dedup-rate' });

      const first = await dispatchAlert('auth-failure-spike', {
        summary: 'P2 spike',
        dedupKey: 'dedup-rate',
        source: 'auth',
      });
      expect(first).not.toBeNull();

      // Second call within rate limit window returns null
      const second = await dispatchAlert('auth-failure-spike', {
        summary: 'P2 spike again',
        dedupKey: 'dedup-rate',
        source: 'auth',
      });
      expect(second).toBeNull();
    });
  });

  describe('resolveIncident', () => {
    it('resolves incident with dedup key', async () => {
      mockHttpsRequest(200, { status: 'success', message: 'resolved', dedup_key: 'res-key' });

      const res = await resolveIncident('res-key');
      expect(res).toEqual({ status: 'success', message: 'resolved', dedup_key: 'res-key' });
    });

    it('throws error if routing key is absent', async () => {
      delete process.env.PAGERDUTY_ROUTING_KEY;
      await expect(resolveIncident('res-key')).rejects.toThrow('PAGERDUTY_ROUTING_KEY is not set');
    });
  });

  describe('stream divergence alerts', () => {
    it('triggers stream divergence alert with custom details', async () => {
      mockHttpsRequest(200, { status: 'success', message: 'ok', dedup_key: 'nova-stream-divergence-1-amount' });

      const res = await alertStreamDivergence({
        streamId: 1,
        field: 'amount',
        onChainValue: '100',
        projectedValue: '90',
      });

      expect(res.dedup_key).toBe('nova-stream-divergence-1-amount');
    });

    it('resolves stream divergence incident', async () => {
      mockHttpsRequest(200, { status: 'success', message: 'resolved', dedup_key: 'nova-stream-divergence-1-amount' });

      const res = await resolveStreamDivergence(1, 'amount');
      expect(res.dedup_key).toBe('nova-stream-divergence-1-amount');
    });
  });
});
