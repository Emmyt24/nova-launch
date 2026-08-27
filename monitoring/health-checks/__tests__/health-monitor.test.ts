import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));

vi.mock('../../logging/structured-logger', () => ({
  structuredLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../metrics/prometheus-config', () => ({
  MetricsCollector: { recordHealthCheck: vi.fn() },
}));

import axios from 'axios';
import { HealthMonitor } from '../health-monitor';

const BASE_CONFIG = {
  name: 'test-svc',
  type: 'http' as const,
  url: 'http://test.internal/health',
  interval: 30_000,
  timeout: 5_000,
  critical: false,
};

describe('HealthMonitor – retries and HTTP status code preservation', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new HealthMonitor();
  });

  afterEach(() => {
    monitor.stopAll();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('retries the configured number of times and succeeds on the final attempt', async () => {
    const mockedGet = vi.mocked(axios.get);
    mockedGet
      .mockResolvedValueOnce({ status: 503, data: 'unavailable' })
      .mockResolvedValueOnce({ status: 503, data: 'unavailable' })
      .mockResolvedValueOnce({ status: 200, data: 'ok' });

    const checkPromise = (monitor as any).performCheck({ ...BASE_CONFIG, retries: 2 });
    await vi.runAllTimersAsync();
    await checkPromise;

    expect(mockedGet).toHaveBeenCalledTimes(3);
    const result = monitor.getResults().find(r => r.name === 'test-svc');
    expect(result?.healthy).toBe(true);
    expect(result?.error).toBeUndefined();
  });

  it('carries the last HTTP status code in the error when all retries are exhausted', async () => {
    const mockedGet = vi.mocked(axios.get);
    mockedGet.mockResolvedValue({ status: 503, data: 'downstream unavailable' });

    const checkPromise = (monitor as any).performCheck({
      ...BASE_CONFIG,
      name: 'failing-svc',
      retries: 2,
    });
    await vi.runAllTimersAsync();
    await checkPromise;

    expect(mockedGet).toHaveBeenCalledTimes(3);
    const result = monitor.getResults().find(r => r.name === 'failing-svc');
    expect(result?.healthy).toBe(false);
    expect(result?.error).toContain('503');
    expect(result?.error).toContain('downstream unavailable');
  });

  it('does not retry when the first attempt succeeds', async () => {
    const mockedGet = vi.mocked(axios.get);
    mockedGet.mockResolvedValue({ status: 200, data: 'ok' });

    const checkPromise = (monitor as any).performCheck({ ...BASE_CONFIG, retries: 2 });
    await vi.runAllTimersAsync();
    await checkPromise;

    expect(mockedGet).toHaveBeenCalledTimes(1);
    const result = monitor.getResults().find(r => r.name === 'test-svc');
    expect(result?.healthy).toBe(true);
  });

  it('makes exactly one attempt when retries is 0', async () => {
    const mockedGet = vi.mocked(axios.get);
    mockedGet.mockResolvedValue({ status: 500, data: '' });

    const checkPromise = (monitor as any).performCheck({ ...BASE_CONFIG, retries: 0 });
    await vi.runAllTimersAsync();
    await checkPromise;

    expect(mockedGet).toHaveBeenCalledTimes(1);
    const result = monitor.getResults().find(r => r.name === 'test-svc');
    expect(result?.healthy).toBe(false);
    expect(result?.error).toContain('500');
  });
});
