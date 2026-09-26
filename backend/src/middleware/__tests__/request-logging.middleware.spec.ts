import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextFunction, Request, Response } from 'express';
import { requestLoggingMiddleware } from '../request-logging.middleware';

function createHarness(headers: Record<string, string> = {}) {
  let finishCallback: (() => void) | undefined;
  const req = {
    method: 'GET',
    originalUrl: '/api/tokens',
    url: '/api/tokens',
    headers: { 'user-agent': 'middleware-spec', ...headers },
    body: { txHash: 'body-hash' },
    query: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    on: vi.fn((event: string, callback: () => void) => {
      if (event === 'finish') finishCallback = callback;
    }),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;

  return {
    req,
    res,
    next,
    finish: () => {
      if (!finishCallback) throw new Error('finish handler was not registered');
      finishCallback();
    },
  };
}

describe('requestLoggingMiddleware', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('propagates request IDs and logs structured success details on finish', () => {
    const context = createHarness({
      'x-request-id': 'request-123',
      'x-correlation-id': 'correlation-123',
      'x-transaction-id': 'transaction-123',
    });

    requestLoggingMiddleware(context.req, context.res, context.next);

    expect(context.next).toHaveBeenCalledOnce();
    expect(context.req.headers['x-request-id']).toBe('request-123');
    expect(context.req.headers['x-correlation-id']).toBe('correlation-123');
    expect((context.req as Request & { transactionId?: string }).transactionId).toBe(
      'transaction-123'
    );
    expect(context.res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'request-123');
    expect(context.res.setHeader).toHaveBeenCalledWith(
      'X-Correlation-Id',
      'correlation-123'
    );
    expect(context.res.setHeader).toHaveBeenCalledWith(
      'X-Transaction-Id',
      'transaction-123'
    );

    context.finish();

    const entry = JSON.parse(consoleLog.mock.calls[0][0] as string);
    expect(entry).toMatchObject({
      method: 'GET',
      path: '/api/tokens',
      statusCode: 200,
      userAgent: 'middleware-spec',
      ip: '127.0.0.1',
      requestId: 'request-123',
      correlationId: 'correlation-123',
      transactionId: 'transaction-123',
      txHash: 'body-hash',
    });
    expect(Date.parse(entry.timestamp)).not.toBeNaN();
    expect(entry.responseTime).toBeGreaterThanOrEqual(0);
  });

  it('generates request and correlation IDs when the request has no ID headers', () => {
    const context = createHarness();

    requestLoggingMiddleware(context.req, context.res, context.next);

    const requestId = context.req.headers['x-request-id'] as string;
    expect(requestId).toMatch(/^req_\d+_[a-z0-9]+$/);
    expect(context.req.headers['x-correlation-id']).toBe(requestId);
    expect(context.res.setHeader).toHaveBeenCalledWith('X-Request-Id', requestId);
    expect(context.res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', requestId);
    expect(context.res.setHeader).not.toHaveBeenCalledWith(
      'X-Transaction-Id',
      expect.anything()
    );
  });

  it('logs 4xx responses as warnings', () => {
    const context = createHarness();
    context.res.statusCode = 404;

    requestLoggingMiddleware(context.req, context.res, context.next);
    context.finish();

    expect(consoleWarn).toHaveBeenCalledOnce();
    expect(JSON.parse(consoleWarn.mock.calls[0][0] as string).statusCode).toBe(404);
  });

  it('logs 5xx responses as errors', () => {
    const context = createHarness();
    context.res.statusCode = 503;

    requestLoggingMiddleware(context.req, context.res, context.next);
    context.finish();

    expect(consoleError).toHaveBeenCalledOnce();
    expect(JSON.parse(consoleError.mock.calls[0][0] as string).statusCode).toBe(503);
    expect(consoleLog).not.toHaveBeenCalled();
  });
});