/**
 * Tests for issue #2186 — X-Request-Id propagation through logs and
 * downstream calls.
 *
 * Covers:
 *  - A well-formed incoming X-Request-Id is accepted and echoed back
 *  - A missing or malformed X-Request-Id is replaced by a generated one
 *  - The request ID is available from the async context and in log entries
 *  - Outbound HTTP calls and Stellar RPC calls forward the request ID
 *  - Webhook deliveries carry the originating request ID
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  requestLoggingMiddleware,
  resolveRequestId,
} from '../middleware/request-logging.middleware';
import { getRequestId, runWithContext, runWithTenant } from '../lib/async-context';
import { logger } from '../lib/logger';
import { buildPropagationHeaders } from '../lib/outboundHttpClient';
import {
  applyPropagationHeaders,
  withRequestIdPropagation,
} from '../lib/stellar/requestIdPropagation';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildApp(handler?: express.RequestHandler) {
  const app = express();
  app.use(requestLoggingMiddleware);
  app.get('/test', handler ?? ((_req, res) => res.json({ ok: true })));
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveRequestId', () => {
  it('accepts a well-formed client value', () => {
    expect(resolveRequestId('client-req-123')).toBe('client-req-123');
  });

  it('generates a UUID when the header is missing', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_PATTERN);
  });

  it('rejects values with unsafe characters', () => {
    expect(resolveRequestId('bad\nvalue')).toMatch(UUID_PATTERN);
    expect(resolveRequestId('<script>')).toMatch(UUID_PATTERN);
  });

  it('rejects overly long values', () => {
    expect(resolveRequestId('a'.repeat(129))).toMatch(UUID_PATTERN);
  });
});

describe('requestLoggingMiddleware — X-Request-Id', () => {
  it('echoes a client-supplied request ID in the response header', async () => {
    const res = await request(buildApp()).get('/test').set('X-Request-Id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('generates a request ID when none is supplied', async () => {
    const res = await request(buildApp()).get('/test');
    expect(res.headers['x-request-id']).toMatch(UUID_PATTERN);
  });

  it('exposes the request ID through the async context and req object', async () => {
    let fromContext: string | undefined;
    let fromReq: string | undefined;
    const app = buildApp((req, res) => {
      fromContext = getRequestId();
      fromReq = req.requestId;
      res.json({ ok: true });
    });

    await request(app).get('/test').set('X-Request-Id', 'ctx-req-1');
    expect(fromContext).toBe('ctx-req-1');
    expect(fromReq).toBe('ctx-req-1');
  });

  it('isolates request IDs across concurrent requests', async () => {
    const app = buildApp(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 5));
      res.json({ requestId: getRequestId() });
    });

    const [a, b] = await Promise.all([
      request(app).get('/test').set('X-Request-Id', 'req-a'),
      request(app).get('/test').set('X-Request-Id', 'req-b'),
    ]);
    expect(a.body.requestId).toBe('req-a');
    expect(b.body.requestId).toBe('req-b');
  });
});

describe('logger — requestId', () => {
  it('includes the request ID in structured log entries', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runWithContext('corr-1', () => logger.info('hello'), undefined, undefined, 'log-req-1');
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.requestId).toBe('log-req-1');
    expect(entry.correlationId).toBe('corr-1');
  });

  it('omits requestId outside a request context', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('background');
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry).not.toHaveProperty('requestId');
  });

  it('keeps the request ID when entering a tenant scope', () => {
    let inner: string | undefined;
    runWithContext('corr', () => runWithTenant('t1', () => { inner = getRequestId(); }), undefined, undefined, 'req-t');
    expect(inner).toBe('req-t');
  });
});

describe('outbound propagation', () => {
  it('forwards the inbound request ID on outbound calls', () => {
    const headers = runWithContext('corr', () => buildPropagationHeaders(), undefined, undefined, 'out-req-1');
    expect(headers['x-request-id']).toBe('out-req-1');
  });

  it('generates a request ID outside a request context', () => {
    expect(buildPropagationHeaders()['x-request-id']).toMatch(UUID_PATTERN);
  });

  it('adds propagation headers to Stellar RPC request configs', () => {
    const config = runWithContext(
      'corr-rpc',
      () => applyPropagationHeaders({ headers: {} as Record<string, string> }),
      undefined,
      undefined,
      'rpc-req-1'
    );
    expect(config.headers['x-request-id']).toBe('rpc-req-1');
    expect(config.headers['x-correlation-id']).toBe('corr-rpc');
  });

  it('does not overwrite headers set by the caller', () => {
    const config = runWithContext(
      'corr',
      () => applyPropagationHeaders({ headers: { 'x-request-id': 'explicit' } as Record<string, string> }),
      undefined,
      undefined,
      'ctx-req'
    );
    expect(config.headers['x-request-id']).toBe('explicit');
  });

  it('registers a request interceptor on the Stellar server httpClient', () => {
    const use = vi.fn();
    const server = { httpClient: { interceptors: { request: { use } } } };
    expect(withRequestIdPropagation(server)).toBe(server);
    expect(use).toHaveBeenCalledTimes(1);

    const interceptor = use.mock.calls[0][0];
    const config = runWithContext('c', () => interceptor({ headers: {} }), undefined, undefined, 'int-req');
    expect(config.headers['x-request-id']).toBe('int-req');
  });

  it('leaves servers without an httpClient untouched', () => {
    const server = {};
    expect(() => withRequestIdPropagation(server)).not.toThrow();
  });
});

describe('webhook delivery — X-Request-Id', () => {
  it('sends the originating request ID to the subscriber', async () => {
    vi.resetModules();
    const post = vi.fn().mockResolvedValue({ status: 200 });
    vi.doMock('axios', () => ({ default: { post }, AxiosError: class extends Error {} }));
    vi.doMock('../services/webhookService', () => ({
      default: {
        createPayload: () => ({ event: 'token.created', data: {}, signature: 'sig' }),
        updateLastTriggered: vi.fn().mockResolvedValue(undefined),
        logDelivery: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { WebhookDeliveryService } = await import('../services/webhookDeliveryService');
    const service = new WebhookDeliveryService({ acquire: vi.fn().mockResolvedValue(undefined) } as any);
    vi.spyOn(service as any, 'isWithinTenantRateLimit').mockResolvedValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await service.deliverWebhook(
      { id: 's1', url: 'https://example.com/hook', secret: 's', createdBy: 'tenant' } as any,
      'token.created' as any,
      {} as any,
      'corr-wh',
      'wh-req-1'
    );

    expect(post).toHaveBeenCalled();
    const headers = post.mock.calls[0][2].headers;
    expect(headers['X-Request-Id']).toBe('wh-req-1');
    expect(headers['X-Correlation-Id']).toBe('corr-wh');

    vi.doUnmock('axios');
    vi.doUnmock('../services/webhookService');
  });
});
