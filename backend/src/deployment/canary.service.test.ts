/**
 * Unit tests — CanaryDeploymentService
 * Issue: #895, #1350
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CanaryDeploymentService, type CanaryMetrics, type CanaryRolledBackPayload } from './canary.service';

vi.mock('../../monitoring/logging/structured-logger', () => ({
  structuredLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const healthyMetrics = (): CanaryMetrics => ({
  errorRate:        0.5,
  p99LatencyMs:     200,
  healthCheckPassed: true,
  timestamp:        new Date(),
});

describe('CanaryDeploymentService', () => {
  let svc: CanaryDeploymentService;

  beforeEach(() => {
    vi.useFakeTimers();
    svc = new CanaryDeploymentService({
      weight:               10,
      bakeTimeMs:           60_000,
      errorRateThreshold:   5,
      latencyThresholdMs:   2_000,
      autoRollback:         true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── start ──────────────────────────────────────────────────────────────────

  it('transitions to observing after start', async () => {
    await svc.start('v2', 'v1');
    expect(svc.getState().stage).toBe('observing');
  });

  it('throws when starting while already observing', async () => {
    await svc.start('v2', 'v1');
    await expect(svc.start('v3', 'v2')).rejects.toThrow("current stage is 'observing'");
  });

  it('records canary and stable versions', async () => {
    await svc.start('canary-abc', 'stable-xyz');
    const state = svc.getState();
    expect(state.canaryVersion).toBe('canary-abc');
    expect(state.stableVersion).toBe('stable-xyz');
  });

  // ── evaluateMetrics ────────────────────────────────────────────────────────

  it('stays in observing with healthy metrics', async () => {
    await svc.start('v2', 'v1');
    await svc.evaluateMetrics(healthyMetrics());
    expect(svc.getState().stage).toBe('observing');
  });

  it('rolls back when error rate exceeds threshold', async () => {
    await svc.start('v2', 'v1');
    await svc.evaluateMetrics({ ...healthyMetrics(), errorRate: 10 });
    const state = svc.getState();
    expect(state.stage).toBe('rolled_back');
    expect(state.rollbackReason).toContain('error rate');
  });

  it('rolls back when p99 latency exceeds threshold', async () => {
    await svc.start('v2', 'v1');
    await svc.evaluateMetrics({ ...healthyMetrics(), p99LatencyMs: 3_000 });
    const state = svc.getState();
    expect(state.stage).toBe('rolled_back');
    expect(state.rollbackReason).toContain('p99 latency');
  });

  it('rolls back when health check fails', async () => {
    await svc.start('v2', 'v1');
    await svc.evaluateMetrics({ ...healthyMetrics(), healthCheckPassed: false });
    expect(svc.getState().stage).toBe('rolled_back');
    expect(svc.getState().rollbackReason).toBe('health check failed');
  });

  it('does not auto-rollback when autoRollback is false', async () => {
    const manual = new CanaryDeploymentService({ autoRollback: false });
    await manual.start('v2', 'v1');
    await manual.evaluateMetrics({ ...healthyMetrics(), errorRate: 99 });
    expect(manual.getState().stage).toBe('observing');
  });

  // ── manual rollback ────────────────────────────────────────────────────────

  it('supports manual rollback', async () => {
    await svc.start('v2', 'v1');
    await svc.rollback('manual override');
    const state = svc.getState();
    expect(state.stage).toBe('rolled_back');
    expect(state.rollbackReason).toBe('manual override');
  });

  // ── promotion ─────────────────────────────────────────────────────────────

  it('promotes to complete after bake time with healthy metrics', async () => {
    await svc.start('v2', 'v1');
    await svc.evaluateMetrics(healthyMetrics());
    // Advance past bake time
    vi.advanceTimersByTime(61_000);
    await vi.runAllTimersAsync();
    expect(svc.getState().stage).toBe('complete');
  });

  // ── restart after terminal state ───────────────────────────────────────────

  it('can restart after rollback', async () => {
    await svc.start('v2', 'v1');
    await svc.rollback('test');
    await svc.start('v3', 'v2');
    expect(svc.getState().stage).toBe('observing');
  });

  it('can restart after complete', async () => {
    await svc.start('v2', 'v1');
    vi.advanceTimersByTime(61_000);
    await vi.runAllTimersAsync();
    await svc.start('v3', 'v2');
    expect(svc.getState().stage).toBe('observing');
  });

  // ── Issue #1350: event emission, weight reset, rollbackCanary ─────────────

  it('emits deployment.canary.rolled_back event on automatic rollback', async () => {
    await svc.start('v2-canary', 'v1-stable');

    const listener = vi.fn();
    svc.on('deployment.canary.rolled_back', listener);

    await svc.evaluateMetrics({ ...healthyMetrics(), errorRate: 10 });

    expect(listener).toHaveBeenCalledOnce();
    const payload: CanaryRolledBackPayload = listener.mock.calls[0][0];
    expect(payload.deploymentId).toBe('v2-canary');
    expect(payload.reason).toContain('error rate');
    expect(typeof payload.errorRate).toBe('number');
  });

  it('emits deployment.canary.rolled_back with correct errorRate in payload', async () => {
    await svc.start('v3-canary', 'v2-stable');

    const listener = vi.fn();
    svc.on('deployment.canary.rolled_back', listener);

    const spikeErrorRate = 12.5;
    await svc.evaluateMetrics({ ...healthyMetrics(), errorRate: spikeErrorRate });

    const payload: CanaryRolledBackPayload = listener.mock.calls[0][0];
    expect(payload.errorRate).toBe(spikeErrorRate);
  });

  it('emits deployment.canary.rolled_back on manual rollbackCanary call', async () => {
    await svc.start('v4-canary', 'v3-stable');

    const listener = vi.fn();
    svc.on('deployment.canary.rolled_back', listener);

    await svc.rollbackCanary('manual intervention');

    expect(listener).toHaveBeenCalledOnce();
    const payload: CanaryRolledBackPayload = listener.mock.calls[0][0];
    expect(payload.deploymentId).toBe('v4-canary');
    expect(payload.reason).toBe('manual intervention');
  });

  it('sets weight to 0 after error rate spike triggers rollback', async () => {
    await svc.start('v2', 'v1');
    expect(svc.getWeight()).toBe(10); // initial weight

    await svc.evaluateMetrics({ ...healthyMetrics(), errorRate: 10 });

    expect(svc.getWeight()).toBe(0);
  });

  it('sets weight to 0 after manual rollbackCanary', async () => {
    await svc.start('v2', 'v1');
    await svc.rollbackCanary('manual override');

    expect(svc.getWeight()).toBe(0);
  });

  it('rollbackCanary transitions stage to rolled_back', async () => {
    await svc.start('v2', 'v1');
    await svc.rollbackCanary('external trigger');

    const state = svc.getState();
    expect(state.stage).toBe('rolled_back');
    expect(state.rollbackReason).toBe('external trigger');
  });

  it('getWeight returns the configured initial weight before rollback', async () => {
    const customSvc = new CanaryDeploymentService({ weight: 25 });
    expect(customSvc.getWeight()).toBe(25);
  });

  it('error rate spike → automatic rollback → weight 0 → event emitted (integration)', async () => {
    const events: CanaryRolledBackPayload[] = [];
    svc.on('deployment.canary.rolled_back', (p: CanaryRolledBackPayload) => events.push(p));

    await svc.start('canary-v5', 'stable-v4');
    expect(svc.getWeight()).toBe(10);
    expect(svc.getState().stage).toBe('observing');

    // Simulate error rate spike above 5% threshold
    await svc.evaluateMetrics({ ...healthyMetrics(), errorRate: 8 });

    expect(svc.getState().stage).toBe('rolled_back');
    expect(svc.getWeight()).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].deploymentId).toBe('canary-v5');
    expect(events[0].errorRate).toBe(8);
    expect(events[0].reason).toContain('error rate');
  });

  it('startMetricsPolling polls the provider and triggers rollback on high error rate', async () => {
    await svc.start('v2', 'v1');

    const rollbackListener = vi.fn();
    svc.on('deployment.canary.rolled_back', rollbackListener);

    let callCount = 0;
    const provider = vi.fn(async (): Promise<CanaryMetrics> => {
      callCount++;
      // First call returns spiked error rate
      return { ...healthyMetrics(), errorRate: callCount === 1 ? 15 : 0.5 };
    });

    svc.startMetricsPolling(provider);

    // Advance one polling interval (30s)
    vi.advanceTimersByTime(30_000);
    await vi.runAllTimersAsync();

    expect(provider).toHaveBeenCalledOnce();
    expect(svc.getState().stage).toBe('rolled_back');
    expect(svc.getWeight()).toBe(0);
    expect(rollbackListener).toHaveBeenCalledOnce();
  });

  // ── race condition: auto-promote vs rollback ──────────────────────────────

  it('prevents stage-transition race: metrics rollback during auto-promote', async () => {
    await svc.start('v2', 'v1');

    const rollbackListener = vi.fn();
    svc.on('deployment.canary.rolled_back', rollbackListener);

    // Simulate the race: metrics evaluation triggers rollback while observation timer
    // is simultaneously firing (bake time elapsed, attempting auto-promote).
    // Both methods check stage and transitioning guard; only one should succeed.

    // Advance to near the end of bake time
    vi.advanceTimersByTime(59_500);

    // Start evaluateMetrics task (will attempt rollback)
    const metricsTask = svc.evaluateMetrics({
      ...healthyMetrics(),
      errorRate: 10, // exceeds threshold
    });

    // Immediately advance past bake time to trigger auto-promote
    vi.advanceTimersByTime(1_500);
    await vi.runAllTimersAsync();

    // Wait for metrics evaluation to complete
    await metricsTask;

    // One transition should have succeeded; the other should have bailed out.
    // Either outcome is acceptable as long as stage is consistent.
    const state = svc.getState();
    expect(['rolled_back', 'complete']).toContain(state.stage);

    if (state.stage === 'rolled_back') {
      expect(state.rollbackReason).toContain('error rate');
      expect(svc.getWeight()).toBe(0);
      expect(rollbackListener).toHaveBeenCalledOnce();
    } else {
      // If promote won, make sure it completed cleanly (no partial state)
      expect(state.stage).toBe('complete');
      expect(rollbackListener).not.toHaveBeenCalled();
    }
  });
});
