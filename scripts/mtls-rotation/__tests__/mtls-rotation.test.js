/**
 * mtls-rotation.test.js
 *
 * Unit tests for the mTLS certificate rotation pipeline logic.
 *
 * Covers:
 *  - CertRotationOrchestrator state machine (all 6 phases)
 *  - Dual-trust window: old + new CA both present during overlap
 *  - Error-rate monitor: passthrough below threshold, rollback above
 *  - Rollback: restores all three layers (istio, gateway, backend)
 *  - Rollback on distribution failure
 *  - Rollback on post-cutover spike
 *  - CertificateIssuer: produces a cert bundle with required fields
 *  - ConnectionMonitor: check() and sustained monitoring
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CertRotationOrchestrator,
  CertificateIssuer,
  ConnectionMonitor,
  CertDistributor,
  RotationState,
} from '../mtls-rotation.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMockKube() {
  return {
    getSecret: vi.fn().mockResolvedValue({ data: { 'ca-cert.pem': 'OLD_CA' } }),
    applySecret: vi.fn().mockResolvedValue(undefined),
    restartDeployment: vi.fn().mockResolvedValue(undefined),
    deleteResource: vi.fn().mockResolvedValue(undefined),
    waitForRollout: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockIssuer(cert = 'NEW_CERT', key = 'NEW_KEY', ca = 'NEW_CA') {
  return {
    issue: vi.fn().mockResolvedValue({ cert, key, ca }),
  };
}

function makeMockMonitor(errorRate = 0) {
  return {
    getErrorRate: vi.fn().mockResolvedValue(errorRate),
  };
}

// ── CertificateIssuer ─────────────────────────────────────────────────────────

describe('CertificateIssuer', () => {
  it('returns a bundle with cert, key, and ca fields', async () => {
    const issuer = new CertificateIssuer({ selfSigned: true });
    const bundle = await issuer.issue({ namespace: 'nova-launch', dnsNames: ['backend.nova-launch.svc'] });

    expect(bundle).toHaveProperty('cert');
    expect(bundle).toHaveProperty('key');
    expect(bundle).toHaveProperty('ca');
    expect(typeof bundle.cert).toBe('string');
    expect(typeof bundle.key).toBe('string');
    expect(typeof bundle.ca).toBe('string');
  });

  it('cert field is non-empty', async () => {
    const issuer = new CertificateIssuer({ selfSigned: true });
    const bundle = await issuer.issue({ namespace: 'test' });
    expect(bundle.cert.length).toBeGreaterThan(0);
  });
});

// ── ConnectionMonitor ─────────────────────────────────────────────────────────

describe('ConnectionMonitor', () => {
  it('check() returns ok when error rate is below threshold', async () => {
    const monitor = new ConnectionMonitor({ threshold: 5, getErrorRate: async () => 2.1 });
    const result = await monitor.check();
    expect(result.ok).toBe(true);
    expect(result.rate).toBe(2.1);
  });

  it('check() returns not-ok when error rate exceeds threshold', async () => {
    const monitor = new ConnectionMonitor({ threshold: 5, getErrorRate: async () => 7.8 });
    const result = await monitor.check();
    expect(result.ok).toBe(false);
    expect(result.rate).toBe(7.8);
  });

  it('check() treats zero error rate as ok', async () => {
    const monitor = new ConnectionMonitor({ threshold: 5, getErrorRate: async () => 0 });
    const result = await monitor.check();
    expect(result.ok).toBe(true);
  });

  it('check() treats rate exactly at threshold as ok', async () => {
    const monitor = new ConnectionMonitor({ threshold: 5, getErrorRate: async () => 5 });
    const result = await monitor.check();
    expect(result.ok).toBe(true);
  });

  it('monitor() resolves successfully when all polls pass', async () => {
    let calls = 0;
    const monitor = new ConnectionMonitor({
      threshold: 5,
      getErrorRate: async () => { calls++; return 1; },
      windowMs: 50,
      intervalMs: 10,
    });
    await expect(monitor.monitor()).resolves.toBeUndefined();
    expect(calls).toBeGreaterThan(0);
  });

  it('monitor() rejects when a poll exceeds the threshold', async () => {
    let calls = 0;
    const monitor = new ConnectionMonitor({
      threshold: 5,
      getErrorRate: async () => { calls++; return calls >= 2 ? 20 : 1; },
      windowMs: 200,
      intervalMs: 20,
    });
    await expect(monitor.monitor()).rejects.toThrow(/error rate/i);
  });
});

// ── CertDistributor ───────────────────────────────────────────────────────────

describe('CertDistributor', () => {
  it('distribute() applies secrets to all three layers', async () => {
    const kube = makeMockKube();
    const distributor = new CertDistributor({ kube, namespace: 'nova-launch' });
    const bundle = { cert: 'CERT', key: 'KEY', ca: 'CA' };

    await distributor.distribute(bundle, { dualTrust: false, oldCa: null });

    // istio cacerts
    expect(kube.applySecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'cacerts', namespace: 'istio-system' })
    );
    // gateway tls
    expect(kube.applySecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'nova-launch-gateway-tls', namespace: 'nova-launch' })
    );
    // backend mtls
    expect(kube.applySecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'nova-launch-backend-mtls', namespace: 'nova-launch' })
    );
  });

  it('distribute() in dual-trust mode includes old CA in the istio bundle', async () => {
    const kube = makeMockKube();
    const distributor = new CertDistributor({ kube, namespace: 'nova-launch' });
    const bundle = { cert: 'NEW_CERT', key: 'NEW_KEY', ca: 'NEW_CA' };

    await distributor.distribute(bundle, { dualTrust: true, oldCa: 'OLD_CA' });

    const istioPatch = kube.applySecret.mock.calls.find(
      (call) => call[0].name === 'cacerts'
    );
    expect(istioPatch).toBeDefined();
    // Combined CA bundle must contain both old and new
    const caBundle = istioPatch[0].data['ca-cert.pem'];
    expect(caBundle).toContain('OLD_CA');
    expect(caBundle).toContain('NEW_CA');
  });

  it('distribute() in cutover mode includes only new CA in istio bundle', async () => {
    const kube = makeMockKube();
    const distributor = new CertDistributor({ kube, namespace: 'nova-launch' });
    const bundle = { cert: 'NEW_CERT', key: 'NEW_KEY', ca: 'NEW_CA' };

    await distributor.distribute(bundle, { dualTrust: false, oldCa: 'OLD_CA' });

    const istioPatch = kube.applySecret.mock.calls.find(
      (call) => call[0].name === 'cacerts'
    );
    expect(istioPatch).toBeDefined();
    const caBundle = istioPatch[0].data['ca-cert.pem'];
    expect(caBundle).not.toContain('OLD_CA');
    expect(caBundle).toContain('NEW_CA');
  });

  it('distribute() restarts istiod after patching cacerts', async () => {
    const kube = makeMockKube();
    const distributor = new CertDistributor({ kube, namespace: 'nova-launch' });
    await distributor.distribute({ cert: 'C', key: 'K', ca: 'CA' }, { dualTrust: false, oldCa: null });
    expect(kube.restartDeployment).toHaveBeenCalledWith('istiod', 'istio-system');
  });

  it('backup() saves all three secrets before modification', async () => {
    const kube = makeMockKube();
    const distributor = new CertDistributor({ kube, namespace: 'nova-launch' });

    const backup = await distributor.backup();

    expect(kube.getSecret).toHaveBeenCalledWith('cacerts', 'istio-system');
    expect(kube.getSecret).toHaveBeenCalledWith('nova-launch-gateway-tls', 'nova-launch');
    expect(kube.getSecret).toHaveBeenCalledWith('nova-launch-backend-mtls', 'nova-launch');
    expect(backup).toHaveProperty('cacerts');
    expect(backup).toHaveProperty('gatewayTls');
    expect(backup).toHaveProperty('backendMtls');
  });

  it('restore() re-applies all backed-up secrets', async () => {
    const kube = makeMockKube();
    const distributor = new CertDistributor({ kube, namespace: 'nova-launch' });

    const snapshot = {
      cacerts:     { name: 'cacerts',                    namespace: 'istio-system', data: { 'ca-cert.pem': 'OLD' } },
      gatewayTls:  { name: 'nova-launch-gateway-tls',    namespace: 'nova-launch',  data: { 'tls.crt': 'OLD' } },
      backendMtls: { name: 'nova-launch-backend-mtls',   namespace: 'nova-launch',  data: { 'tls.crt': 'OLD' } },
    };

    await distributor.restore(snapshot);

    expect(kube.applySecret).toHaveBeenCalledTimes(3);
    expect(kube.restartDeployment).toHaveBeenCalledWith('istiod', 'istio-system');
  });
});

// ── CertRotationOrchestrator — full rotation cycle ────────────────────────────

describe('CertRotationOrchestrator — successful rotation', () => {
  let kube, issuer, monitor, orchestrator;

  beforeEach(() => {
    kube    = makeMockKube();
    issuer  = makeMockIssuer();
    monitor = makeMockMonitor(0); // no errors

    orchestrator = new CertRotationOrchestrator({
      kube,
      issuer,
      monitor,
      namespace: 'nova-launch',
      dualTrustMs: 0,
      monitorWindowMs: 50,
      monitorIntervalMs: 10,
      errorRateThreshold: 5,
    });
  });

  it('transitions through all phases: IDLE → COMPLETE', async () => {
    expect(orchestrator.state).toBe(RotationState.IDLE);
    await orchestrator.rotate();
    expect(orchestrator.state).toBe(RotationState.COMPLETE);
  });

  it('calls issuer.issue() exactly once', async () => {
    await orchestrator.rotate();
    expect(issuer.issue).toHaveBeenCalledTimes(1);
  });

  it('distributes with dualTrust=true then dualTrust=false', async () => {
    await orchestrator.rotate();

    const calls = kube.applySecret.mock.calls;
    // First distribution (dual-trust) — cacerts must have OLD+NEW
    const firstIstioPatch = calls.find((c) => c[0].name === 'cacerts' && c[0].data?.['ca-cert.pem']?.includes('OLD_CA'));
    expect(firstIstioPatch).toBeDefined();

    // Second distribution (cutover) — cacerts must have only NEW
    const cutoverIstioPatch = calls.filter((c) => c[0].name === 'cacerts')
      .find((c) => !c[0].data?.['ca-cert.pem']?.includes('OLD_CA'));
    expect(cutoverIstioPatch).toBeDefined();
  });

  it('does NOT call rollback when error rate is healthy', async () => {
    const restoreSpy = vi.spyOn(orchestrator._distributor, 'restore');
    await orchestrator.rotate();
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('emits phase lifecycle events', async () => {
    const events = [];
    orchestrator.on('phaseChange', (phase) => events.push(phase));
    await orchestrator.rotate();

    expect(events).toContain('ISSUING');
    expect(events).toContain('DUAL_TRUST');
    expect(events).toContain('MONITORING_POST_DISTRIBUTION');
    expect(events).toContain('CUTOVER');
    expect(events).toContain('MONITORING_POST_CUTOVER');
    expect(events).toContain('CLEANUP');
    expect(events).toContain('COMPLETE');
  });
});

// ── CertRotationOrchestrator — rollback on distribution error spike ───────────

describe('CertRotationOrchestrator — rollback on post-distribution spike', () => {
  it('calls restore() and sets state to ROLLED_BACK', async () => {
    const kube    = makeMockKube();
    const issuer  = makeMockIssuer();
    // High error rate — immediately triggers rollback
    const monitor = makeMockMonitor(25);

    const orchestrator = new CertRotationOrchestrator({
      kube,
      issuer,
      monitor,
      namespace: 'nova-launch',
      dualTrustMs: 0,
      monitorWindowMs: 50,
      monitorIntervalMs: 10,
      errorRateThreshold: 5,
    });

    const restoreSpy = vi.spyOn(orchestrator._distributor, 'restore').mockResolvedValue(undefined);

    await expect(orchestrator.rotate()).rejects.toThrow(/rollback/i);
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(orchestrator.state).toBe(RotationState.ROLLED_BACK);
  });

  it('emits a rollback event', async () => {
    const kube    = makeMockKube();
    const issuer  = makeMockIssuer();
    const monitor = makeMockMonitor(99);

    const orchestrator = new CertRotationOrchestrator({
      kube, issuer, monitor,
      namespace: 'nova-launch',
      dualTrustMs: 0,
      monitorWindowMs: 50,
      monitorIntervalMs: 10,
      errorRateThreshold: 5,
    });

    vi.spyOn(orchestrator._distributor, 'restore').mockResolvedValue(undefined);

    const events = [];
    orchestrator.on('phaseChange', (p) => events.push(p));

    await expect(orchestrator.rotate()).rejects.toThrow();
    expect(events).toContain('ROLLING_BACK');
    expect(events).toContain('ROLLED_BACK');
  });
});

// ── CertRotationOrchestrator — rollback on post-cutover spike ─────────────────

describe('CertRotationOrchestrator — rollback on post-cutover spike', () => {
  it('rolls back after cutover if error rate spikes', async () => {
    const kube   = makeMockKube();
    const issuer = makeMockIssuer();

    // First monitoring window (post-distribution) passes, second (post-cutover) fails
    let monitorCallCount = 0;
    const monitor = {
      getErrorRate: vi.fn().mockImplementation(async () => {
        monitorCallCount++;
        // First round of polls: healthy; subsequent rounds: spike
        return monitorCallCount <= 3 ? 1 : 30;
      }),
    };

    const orchestrator = new CertRotationOrchestrator({
      kube, issuer, monitor,
      namespace: 'nova-launch',
      dualTrustMs: 0,
      monitorWindowMs: 100,
      monitorIntervalMs: 20,
      errorRateThreshold: 5,
    });

    const restoreSpy = vi.spyOn(orchestrator._distributor, 'restore').mockResolvedValue(undefined);

    await expect(orchestrator.rotate()).rejects.toThrow(/rollback/i);
    expect(restoreSpy).toHaveBeenCalled();
    expect(orchestrator.state).toBe(RotationState.ROLLED_BACK);
  });
});
