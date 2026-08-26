import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StructuredLogger, structuredLogger, TraceContext } from '../structured-logger';

describe('StructuredLogger', () => {
  let loggerInstance: StructuredLogger;
  let winstonLogSpy: any;

  beforeEach(() => {
    loggerInstance = StructuredLogger.getInstance();
    loggerInstance.clearTraceContext();
    winstonLogSpy = vi.spyOn((loggerInstance as any).logger, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    loggerInstance.clearTraceContext();
    vi.restoreAllMocks();
  });

  describe('PII hashing', () => {
    it('hashes wallet address and does not log plaintext in logWalletInteraction', () => {
      const plaintextAddress = 'GBZXN7PIRZGNMHGA728XZSVOETKQ3T5KVHGBW7UKTNVBIW35V3G4';

      loggerInstance.logWalletInteraction({
        action: 'connect',
        walletAddress: plaintextAddress,
        walletType: 'freighter',
        success: true,
      });

      expect(winstonLogSpy).toHaveBeenCalledTimes(1);
      const [level, message, meta] = winstonLogSpy.mock.calls[0];

      expect(level).toBe('info');
      expect(message).toBe('Wallet connect succeeded');
      expect(meta.walletAddress).toBeDefined();
      expect(meta.walletAddress).not.toBe(plaintextAddress);
      expect(meta.walletAddress).toMatch(/^hashed_\d+$/);
    });

    it('hashes fromAddress and toAddress in logTransaction', () => {
      const fromAddr = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
      const toAddr = 'GCXKG6RN4ONIEPCMNFB732A436Z5PNDSRLGWK7GBLCMQLIFO4HXQNXAL';

      loggerInstance.logTransaction({
        stage: 'initiated',
        transactionHash: 'tx-12345',
        fromAddress: fromAddr,
        toAddress: toAddr,
        amount: '100',
        fee: '100',
        success: true,
      });

      expect(winstonLogSpy).toHaveBeenCalledTimes(1);
      const [, , meta] = winstonLogSpy.mock.calls[0];

      expect(meta.fromAddress).not.toBe(fromAddr);
      expect(meta.fromAddress).toMatch(/^hashed_\d+$/);
      expect(meta.toAddress).not.toBe(toAddr);
      expect(meta.toAddress).toMatch(/^hashed_\d+$/);
    });

    it('hashes userId and ipAddress in logUserActivity', () => {
      const userId = 'user-secret-id-999';
      const ipAddress = '192.168.1.100';

      loggerInstance.logUserActivity({
        userId,
        action: 'login',
        ipAddress,
        success: true,
      });

      expect(winstonLogSpy).toHaveBeenCalledTimes(1);
      const [, , meta] = winstonLogSpy.mock.calls[0];

      expect(meta.userId).not.toBe(userId);
      expect(meta.userId).toMatch(/^hashed_\d+$/);
      expect(meta.ipAddress).not.toBe(ipAddress);
      expect(meta.ipAddress).toMatch(/^hashed_\d+$/);
    });
  });

  describe('Trace context propagation', () => {
    it('attaches traceId and spanId to subsequent log calls when setTraceContext is called', () => {
      loggerInstance.setTraceContext('trace-abc-123', 'span-def-456');

      loggerInstance.info('Test log with trace context', { extra: 'value' });

      expect(winstonLogSpy).toHaveBeenCalledTimes(1);
      const [, , meta] = winstonLogSpy.mock.calls[0];
      expect(meta.traceId).toBe('trace-abc-123');
      expect(meta.spanId).toBe('span-def-456');
      expect(meta.extra).toBe('value');
    });

    it('removes traceId and spanId from subsequent log calls when clearTraceContext is called', () => {
      loggerInstance.setTraceContext('trace-abc-123', 'span-def-456');
      loggerInstance.clearTraceContext();

      loggerInstance.info('Test log after clear');

      expect(winstonLogSpy).toHaveBeenCalledTimes(1);
      const [, , meta] = winstonLogSpy.mock.calls[0];
      expect(meta.traceId).toBeUndefined();
      expect(meta.spanId).toBeUndefined();
    });

    it('produces a child logger that carries the parent trace context', () => {
      loggerInstance.setTraceContext('parent-trace-789', 'parent-span-012');

      const childLogger = loggerInstance.child({ serviceComponent: 'auth' });
      const childSpy = vi.spyOn((childLogger as any).logger, 'log').mockImplementation(() => {});

      childLogger.info('Child log entry', { foo: 'bar' });

      expect(childSpy).toHaveBeenCalledTimes(1);
      const [, , meta] = childSpy.mock.calls[0];
      expect(meta.traceId).toBe('parent-trace-789');
      expect(meta.spanId).toBe('parent-span-012');
      expect(meta.foo).toBe('bar');
    });
  });
});

describe('TraceContext', () => {
  afterEach(() => {
    StructuredLogger.getInstance().clearTraceContext();
  });

  it('clears internal context map and trace context after a resolved async callback', async () => {
    const traceId = 'trace-async-resolve';
    const spanId = 'span-async-resolve';
    const contextKey = `${traceId}-${spanId}`;

    let contextDuringExecution: { traceId: string; spanId: string } | undefined;

    const result = await TraceContext.withContext(traceId, spanId, async () => {
      contextDuringExecution = TraceContext.get(contextKey);
      return 'success';
    });

    expect(result).toBe('success');
    expect(contextDuringExecution).toEqual({ traceId, spanId });
    expect(TraceContext.get(contextKey)).toBeUndefined();
  });

  it('clears internal context map and trace context after a rejected async callback', async () => {
    const traceId = 'trace-async-reject';
    const spanId = 'span-async-reject';
    const contextKey = `${traceId}-${spanId}`;

    let contextDuringExecution: { traceId: string; spanId: string } | undefined;

    await expect(
      TraceContext.withContext(traceId, spanId, async () => {
        contextDuringExecution = TraceContext.get(contextKey);
        throw new Error('Async execution failed');
      })
    ).rejects.toThrow('Async execution failed');

    expect(contextDuringExecution).toEqual({ traceId, spanId });
    expect(TraceContext.get(contextKey)).toBeUndefined();
  });

  it('clears internal context map and trace context for synchronous callbacks', () => {
    const traceId = 'trace-sync-test';
    const spanId = 'span-sync-test';
    const contextKey = `${traceId}-${spanId}`;

    let contextDuringExecution: { traceId: string; spanId: string } | undefined;

    const result = TraceContext.withContext(traceId, spanId, () => {
      contextDuringExecution = TraceContext.get(contextKey);
      return 42;
    });

    expect(result).toBe(42);
    expect(contextDuringExecution).toEqual({ traceId, spanId });
    expect(TraceContext.get(contextKey)).toBeUndefined();
  });

  it('clears internal context map and trace context when synchronous callback throws', () => {
    const traceId = 'trace-sync-throw';
    const spanId = 'span-sync-throw';
    const contextKey = `${traceId}-${spanId}`;

    let contextDuringExecution: { traceId: string; spanId: string } | undefined;

    expect(() =>
      TraceContext.withContext(traceId, spanId, () => {
        contextDuringExecution = TraceContext.get(contextKey);
        throw new Error('Sync error');
      })
    ).toThrow('Sync error');

    expect(contextDuringExecution).toEqual({ traceId, spanId });
    expect(TraceContext.get(contextKey)).toBeUndefined();
  });
});
