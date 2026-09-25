import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../logger';
import * as asyncContext from '../async-context';

describe('logger', () => {
  let consoleLogSpy: any;
  let consoleWarnSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs info messages to console.log with correlation and transaction IDs if present', () => {
    vi.spyOn(asyncContext, 'getCorrelationId').mockReturnValue('corr-1');
    vi.spyOn(asyncContext, 'getTransactionId').mockReturnValue('tx-1');

    logger.info('Info log message', { customKey: 'val1' });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('Info log message');
    expect(parsed.correlationId).toBe('corr-1');
    expect(parsed.transactionId).toBe('tx-1');
    expect(parsed.customKey).toBe('val1');
    expect(parsed.timestamp).toBeDefined();
  });

  it('logs debug messages to console.log', () => {
    logger.debug('Debug log message');

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(parsed.level).toBe('debug');
    expect(parsed.message).toBe('Debug log message');
  });

  it('logs warn messages to console.warn', () => {
    logger.warn('Warning log message');

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(consoleWarnSpy.mock.calls[0][0]);
    expect(parsed.level).toBe('warn');
    expect(parsed.message).toBe('Warning log message');
  });

  it('logs error messages to console.error', () => {
    logger.error('Error log message', { error: 'something broke' });

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe('Error log message');
    expect(parsed.error).toBe('something broke');
  });

  it('omits transactionId when not present in context', () => {
    vi.spyOn(asyncContext, 'getTransactionId').mockReturnValue(undefined);

    logger.info('No tx log');

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect('transactionId' in parsed).toBe(false);
  });
});
