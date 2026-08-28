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

describe('fetchBackendHealth', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the unwrapped data object for a successful axios.get response', async () => {
    const mockedGet = vi.mocked(axios.get);
    const backendData = { status: 'healthy', services: { db: 'up' } };
    mockedGet.mockResolvedValueOnce({ data: backendData });

    const result = await monitor.fetchBackendHealth('http://test.internal');

    expect(mockedGet).toHaveBeenCalledWith('http://test.internal/health/ready', {
      timeout: 5000,
    });
    expect(result).toEqual(backendData);
  });

  it('unwraps response shaped as { data: { status, services } } correctly', async () => {
    const mockedGet = vi.mocked(axios.get);
    const innerData = { status: 'healthy', services: { db: 'up', cache: 'up' } };
    mockedGet.mockResolvedValueOnce({ data: { data: innerData } });

    const result = await monitor.fetchBackendHealth('http://test.internal');

    expect(result).toEqual(innerData);
  });

  it('returns null and does not throw when axios.get is rejected', async () => {
    const mockedGet = vi.mocked(axios.get);
    mockedGet.mockRejectedValueOnce(new Error('Network error'));

    const result = await monitor.fetchBackendHealth('http://test.internal');

    expect(result).toBeNull();
  });
});

describe('getOverallHealth', () => {
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

  it('returns healthy: true when all health checks are healthy', async () => {
    const check1 = (monitor as any).performCheck({
      name: 'svc-1',
      type: 'custom',
      customCheck: async () => true,
      interval: 1000,
      timeout: 1000,
      retries: 0,
      critical: false,
    });
    const check2 = (monitor as any).performCheck({
      name: 'svc-2',
      type: 'custom',
      customCheck: async () => true,
      interval: 1000,
      timeout: 1000,
      retries: 0,
      critical: false,
    });
    await vi.runAllTimersAsync();
    await Promise.all([check1, check2]);

    const overall = monitor.getOverallHealth();
    expect(overall.healthy).toBe(true);
    expect(overall.checks).toHaveLength(2);
  });

  it('returns healthy: false when any check is unhealthy', async () => {
    const check1 = (monitor as any).performCheck({
      name: 'svc-1',
      type: 'custom',
      customCheck: async () => true,
      interval: 1000,
      timeout: 1000,
      retries: 0,
      critical: false,
    });
    const check2 = (monitor as any).performCheck({
      name: 'svc-2',
      type: 'custom',
      customCheck: async () => false,
      interval: 1000,
      timeout: 1000,
      retries: 0,
      critical: false,
    });
    await vi.runAllTimersAsync();
    await Promise.all([check1, check2]);

    const overall = monitor.getOverallHealth();
    expect(overall.healthy).toBe(false);
    expect(overall.checks).toHaveLength(2);
  });
});

describe('getProjectionLagHealth', () => {
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

  it('returns null when no projection-lag result exists yet', () => {
    expect(monitor.getProjectionLagHealth()).toBeNull();
  });

  it('returns the expected shape once a projection-lag result exists', async () => {
    const checkPromise = (monitor as any).performCheck({
      name: 'projection-lag',
      type: 'projection-lag',
      interval: 1000,
      timeout: 1000,
      retries: 0,
      critical: false,
      lagThresholdConfig: {
        queryFn: async () => ({ average: 500, max: 1200, count: 10 }),
        warningThresholdMs: 30000,
        criticalThresholdMs: 60000,
      },
    });
    await vi.runAllTimersAsync();
    await checkPromise;

    const lagHealth = monitor.getProjectionLagHealth();
    expect(lagHealth).toEqual({
      averageLag: 500,
      maxLag: 1200,
      measurementCount: 10,
      status: 'healthy',
    });
  });
});
