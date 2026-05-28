import { describe, it, expect } from 'vitest';
import {
  selectDeployVariant,
  buildDeployPayload,
  buildDeploySummary,
  formatDeploySummary,
} from '../lib/concurrent-deploy-helpers.js';

// ── selectDeployVariant ───────────────────────────────────────────────────────

describe('selectDeployVariant', () => {
  it('returns standard for roll in [0, 0.60)', () => {
    expect(selectDeployVariant(0)).toBe('standard');
    expect(selectDeployVariant(0.30)).toBe('standard');
    expect(selectDeployVariant(0.599)).toBe('standard');
  });

  it('returns with_metadata for roll in [0.60, 0.85)', () => {
    expect(selectDeployVariant(0.60)).toBe('with_metadata');
    expect(selectDeployVariant(0.72)).toBe('with_metadata');
    expect(selectDeployVariant(0.849)).toBe('with_metadata');
  });

  it('returns with_supply_cap for roll in [0.85, 1.00)', () => {
    expect(selectDeployVariant(0.85)).toBe('with_supply_cap');
    expect(selectDeployVariant(0.92)).toBe('with_supply_cap');
    expect(selectDeployVariant(0.999)).toBe('with_supply_cap');
  });

  it('covers the correct distribution over 10 000 samples', () => {
    const counts = { standard: 0, with_metadata: 0, with_supply_cap: 0 };
    const N = 10_000;
    for (let i = 0; i < N; i++) counts[selectDeployVariant(Math.random())]++;
    // standard ≈ 60 % ± 2 %
    expect(counts.standard / N).toBeGreaterThan(0.58);
    expect(counts.standard / N).toBeLessThan(0.62);
    // with_metadata ≈ 25 % ± 2 %
    expect(counts.with_metadata / N).toBeGreaterThan(0.23);
    expect(counts.with_metadata / N).toBeLessThan(0.27);
    // with_supply_cap ≈ 15 % ± 2 %
    expect(counts.with_supply_cap / N).toBeGreaterThan(0.13);
    expect(counts.with_supply_cap / N).toBeLessThan(0.17);
  });
});

// ── buildDeployPayload ────────────────────────────────────────────────────────

describe('buildDeployPayload', () => {
  it('builds a standard payload with required fields', () => {
    const p = buildDeployPayload('standard');
    expect(typeof p.name).toBe('string');
    expect(p.name.startsWith('StressToken_')).toBe(true);
    expect(p.symbol).toBe('STK');
    expect(p.decimals).toBe(7);
    expect(p.initialSupply).toBe(1_000_000);
    expect(p.metadata).toBeUndefined();
    expect(p.supplyCap).toBeUndefined();
  });

  it('includes metadata for with_metadata variant', () => {
    const p = buildDeployPayload('with_metadata');
    expect(p.metadata).toBeDefined();
    expect(typeof p.metadata.description).toBe('string');
    expect(typeof p.metadata.url).toBe('string');
    expect(p.supplyCap).toBeUndefined();
  });

  it('includes supplyCap for with_supply_cap variant', () => {
    const p = buildDeployPayload('with_supply_cap');
    expect(p.supplyCap).toBe(10_000_000);
    expect(p.metadata).toBeUndefined();
  });

  it('retains base fields across all variants', () => {
    for (const v of ['standard', 'with_metadata', 'with_supply_cap']) {
      const p = buildDeployPayload(v);
      expect(p.symbol).toBe('STK');
      expect(p.decimals).toBe(7);
      expect(p.initialSupply).toBe(1_000_000);
    }
  });
});

// ── buildDeploySummary ────────────────────────────────────────────────────────

describe('buildDeploySummary', () => {
  const passingData = {
    metrics: {
      deploy_duration: {
        values: { 'p(95)': 850, 'p(99)': 1800 },
        thresholds: { 'p(95)<3000': { ok: true }, 'p(99)<6000': { ok: true } },
      },
      deploy_errors: {
        values: { rate: 0.01 },
        thresholds: { 'rate<0.05': { ok: true } },
      },
      deploy_total: { values: { count: 240 } },
      http_req_failed: {
        values: { rate: 0.008 },
        thresholds: { 'rate<0.05': { ok: true } },
      },
    },
  };

  it('sets passed=true when all thresholds pass', () => {
    expect(buildDeploySummary(passingData, 20, 60).passed).toBe(true);
  });

  it('sets passed=false when any threshold fails', () => {
    const failing = JSON.parse(JSON.stringify(passingData));
    failing.metrics.deploy_duration.thresholds['p(95)<3000'].ok = false;
    expect(buildDeploySummary(failing, 20, 60).passed).toBe(false);
  });

  it('includes concurrentVus and duration', () => {
    const s = buildDeploySummary(passingData, 20, 60);
    expect(s.concurrentVus).toBe(20);
    expect(s.duration).toBe(60);
  });

  it('extracts p95 and p99 latency', () => {
    const s = buildDeploySummary(passingData, 20, 60);
    expect(s.metrics.deploy_duration_p95).toBe(850);
    expect(s.metrics.deploy_duration_p99).toBe(1800);
  });

  it('extracts error rate and total deployments', () => {
    const s = buildDeploySummary(passingData, 20, 60);
    expect(s.metrics.deploy_error_rate).toBe(0.01);
    expect(s.metrics.deploy_total).toBe(240);
  });

  it('handles empty metrics gracefully', () => {
    const s = buildDeploySummary({ metrics: {} }, 5, 30);
    expect(s.passed).toBe(true);
    expect(s.metrics.deploy_duration_p95).toBeUndefined();
    expect(s.metrics.deploy_total).toBeUndefined();
  });

  it('includes a valid ISO timestamp', () => {
    const s = buildDeploySummary(passingData, 20, 60);
    expect(s.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── formatDeploySummary ───────────────────────────────────────────────────────

describe('formatDeploySummary', () => {
  const summary = {
    passed: true,
    timestamp: '2026-01-01T00:00:00.000Z',
    concurrentVus: 20,
    duration: 60,
    metrics: {
      deploy_duration_p95: 850.5,
      deploy_duration_p99: 1800.3,
      deploy_error_rate: 0.01,
      http_req_failed_rate: 0.008,
      deploy_total: 240,
    },
  };

  it('contains PASSED status for a passing run', () => {
    expect(formatDeploySummary(summary)).toContain('✅ PASSED');
  });

  it('contains FAILED status for a failing run', () => {
    expect(formatDeploySummary({ ...summary, passed: false })).toContain('❌ FAILED');
  });

  it('includes p95 latency', () => {
    expect(formatDeploySummary(summary)).toContain('850.5');
  });

  it('includes p99 latency', () => {
    expect(formatDeploySummary(summary)).toContain('1800.3');
  });

  it('includes error rate as percentage', () => {
    expect(formatDeploySummary(summary)).toContain('1.00');
  });

  it('includes total deployments count', () => {
    expect(formatDeploySummary(summary)).toContain('240');
  });

  it('shows n/a when metrics are undefined', () => {
    const s = { ...summary, metrics: {} };
    expect(formatDeploySummary(s)).toContain('n/a');
  });

  it('includes threshold description', () => {
    expect(formatDeploySummary(summary)).toContain('p95 < 3000 ms');
    expect(formatDeploySummary(summary)).toContain('error rate < 5 %');
  });
});
