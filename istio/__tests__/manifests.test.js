/**
 * Istio manifest validation tests.
 *
 * These tests parse the YAML manifests and assert structural and security
 * properties without requiring a live Kubernetes cluster.
 *
 * Coverage areas:
 *   - All expected resources are present with correct apiVersions/kinds
 *   - Namespace has istio-injection label
 *   - Deployments: non-root user, resource limits, health probes, correct ports
 *   - Services: named ports (required for Istio L7 policies)
 *   - Gateway: correct selector and server definitions
 *   - VirtualServices: routing rules, timeouts, retries
 *   - DestinationRules: mTLS mode, circuit breaker, Redis exemption
 *   - PeerAuthentication: STRICT default, Redis PERMISSIVE exemption
 *   - No secrets hardcoded in manifests
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll } from 'vitest';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ISTIO_DIR = join(__dirname, '..');

/** Load and parse all documents from a YAML file. */
function loadAll(filename) {
  const raw = readFileSync(join(ISTIO_DIR, filename), 'utf8');
  return yaml.loadAll(raw).filter(Boolean);
}

/** Find a document by kind (and optional name). */
function find(docs, kind, name) {
  return docs.find(
    (d) => d.kind === kind && (name === undefined || d.metadata?.name === name)
  );
}

// ── Load all manifests once ───────────────────────────────────────────────────

let ns, deployments, services, gateway, virtualServices, destRules, peerAuths;

beforeAll(() => {
  ns           = loadAll('namespace.yaml');
  deployments  = loadAll('deployments.yaml');
  services     = loadAll('services.yaml');
  gateway      = loadAll('gateway.yaml');
  virtualServices = loadAll('virtual-services.yaml');
  destRules    = loadAll('destination-rules.yaml');
  peerAuths    = loadAll('peer-authentication.yaml');
});

// ── namespace.yaml ────────────────────────────────────────────────────────────

describe('namespace.yaml', () => {
  it('defines a Namespace resource', () => {
    expect(find(ns, 'Namespace', 'nova-launch')).toBeDefined();
  });

  it('has istio-injection=enabled label', () => {
    const n = find(ns, 'Namespace', 'nova-launch');
    expect(n.metadata.labels['istio-injection']).toBe('enabled');
  });
});

// ── deployments.yaml ──────────────────────────────────────────────────────────

describe('deployments.yaml', () => {
  const SERVICES = ['backend', 'frontend', 'gateway'];

  it.each(SERVICES)('defines a Deployment for %s', (name) => {
    expect(find(deployments, 'Deployment', name)).toBeDefined();
  });

  it.each(SERVICES)('%s deployment is in nova-launch namespace', (name) => {
    const d = find(deployments, 'Deployment', name);
    expect(d.metadata.namespace).toBe('nova-launch');
  });

  it.each(SERVICES)('%s deployment has version=v1 label', (name) => {
    const d = find(deployments, 'Deployment', name);
    expect(d.spec.template.metadata.labels.version).toBe('v1');
  });

  it('backend runs as non-root user', () => {
    const d = find(deployments, 'Deployment', 'backend');
    const sc = d.spec.template.spec.securityContext;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.runAsUser).toBeGreaterThan(0);
  });

  it('gateway runs as non-root user', () => {
    const d = find(deployments, 'Deployment', 'gateway');
    const sc = d.spec.template.spec.securityContext;
    expect(sc.runAsNonRoot).toBe(true);
  });

  it.each(['backend', 'gateway'])('%s has resource limits defined', (name) => {
    const d = find(deployments, 'Deployment', name);
    const res = d.spec.template.spec.containers[0].resources;
    expect(res.limits.cpu).toBeDefined();
    expect(res.limits.memory).toBeDefined();
  });

  it.each(['backend', 'gateway'])('%s has readiness probe', (name) => {
    const d = find(deployments, 'Deployment', name);
    expect(d.spec.template.spec.containers[0].readinessProbe).toBeDefined();
  });

  it.each(['backend', 'gateway'])('%s has liveness probe', (name) => {
    const d = find(deployments, 'Deployment', name);
    expect(d.spec.template.spec.containers[0].livenessProbe).toBeDefined();
  });

  it('backend exposes port 3001', () => {
    const d = find(deployments, 'Deployment', 'backend');
    const ports = d.spec.template.spec.containers[0].ports;
    expect(ports.some((p) => p.containerPort === 3001)).toBe(true);
  });

  it('gateway exposes port 4000', () => {
    const d = find(deployments, 'Deployment', 'gateway');
    const ports = d.spec.template.spec.containers[0].ports;
    expect(ports.some((p) => p.containerPort === 4000)).toBe(true);
  });

  it('no hardcoded secrets in env values', () => {
    for (const d of deployments) {
      const containers = d.spec?.template?.spec?.containers ?? [];
      for (const c of containers) {
        for (const env of c.env ?? []) {
          // Env vars with plain `value` must not look like secrets
          if (env.value && /secret|password|key/i.test(env.name)) {
            // Should use secretKeyRef, not a plain value
            expect(env.valueFrom?.secretKeyRef).toBeDefined();
          }
        }
      }
    }
  });
});

// ── services.yaml ─────────────────────────────────────────────────────────────

describe('services.yaml', () => {
  const SVCS = ['backend', 'frontend', 'gateway', 'redis'];

  it.each(SVCS)('defines a Service for %s', (name) => {
    expect(find(services, 'Service', name)).toBeDefined();
  });

  it.each(['backend', 'frontend', 'gateway'])('%s service port is named http', (name) => {
    const svc = find(services, 'Service', name);
    expect(svc.spec.ports[0].name).toBe('http');
  });

  it('redis service port is named tcp-redis (required for Istio)', () => {
    const svc = find(services, 'Service', 'redis');
    expect(svc.spec.ports[0].name).toMatch(/^tcp/);
  });

  it('backend service targets port 3001', () => {
    const svc = find(services, 'Service', 'backend');
    expect(svc.spec.ports[0].port).toBe(3001);
  });

  it('gateway service targets port 4000', () => {
    const svc = find(services, 'Service', 'gateway');
    expect(svc.spec.ports[0].port).toBe(4000);
  });
});

// ── gateway.yaml ──────────────────────────────────────────────────────────────

describe('gateway.yaml', () => {
  it('defines an Istio Gateway', () => {
    expect(find(gateway, 'Gateway', 'nova-launch-gateway')).toBeDefined();
  });

  it('uses istio ingressgateway selector', () => {
    const gw = find(gateway, 'Gateway', 'nova-launch-gateway');
    expect(gw.spec.selector.istio).toBe('ingressgateway');
  });

  it('exposes port 80 (HTTP)', () => {
    const gw = find(gateway, 'Gateway', 'nova-launch-gateway');
    const ports = gw.spec.servers.map((s) => s.port.number);
    expect(ports).toContain(80);
  });

  it('exposes port 443 (HTTPS)', () => {
    const gw = find(gateway, 'Gateway', 'nova-launch-gateway');
    const ports = gw.spec.servers.map((s) => s.port.number);
    expect(ports).toContain(443);
  });

  it('HTTPS server uses SIMPLE TLS mode', () => {
    const gw = find(gateway, 'Gateway', 'nova-launch-gateway');
    const https = gw.spec.servers.find((s) => s.port.number === 443);
    expect(https.tls.mode).toBe('SIMPLE');
  });
});

// ── virtual-services.yaml ─────────────────────────────────────────────────────

describe('virtual-services.yaml', () => {
  it('defines ingress VirtualService', () => {
    expect(find(virtualServices, 'VirtualService', 'nova-launch-ingress')).toBeDefined();
  });

  it('defines backend-internal VirtualService', () => {
    expect(find(virtualServices, 'VirtualService', 'backend-internal')).toBeDefined();
  });

  it('ingress VS routes /api/* to gateway', () => {
    const vs = find(virtualServices, 'VirtualService', 'nova-launch-ingress');
    const apiRoute = vs.spec.http.find((r) =>
      r.match?.some((m) => m.uri?.prefix === '/api')
    );
    expect(apiRoute).toBeDefined();
    expect(apiRoute.route[0].destination.host).toBe('gateway');
  });

  it('ingress VS routes /health* to backend', () => {
    const vs = find(virtualServices, 'VirtualService', 'nova-launch-ingress');
    const healthRoute = vs.spec.http.find((r) =>
      r.match?.some((m) => m.uri?.prefix === '/health')
    );
    expect(healthRoute).toBeDefined();
    expect(healthRoute.route[0].destination.host).toBe('backend');
  });

  it('ingress VS has a default route to frontend', () => {
    const vs = find(virtualServices, 'VirtualService', 'nova-launch-ingress');
    const defaultRoute = vs.spec.http.find((r) => !r.match);
    expect(defaultRoute).toBeDefined();
    expect(defaultRoute.route[0].destination.host).toBe('frontend');
  });

  it('/api route has retry policy', () => {
    const vs = find(virtualServices, 'VirtualService', 'nova-launch-ingress');
    const apiRoute = vs.spec.http.find((r) =>
      r.match?.some((m) => m.uri?.prefix === '/api')
    );
    expect(apiRoute.retries).toBeDefined();
    expect(apiRoute.retries.attempts).toBeGreaterThan(0);
  });

  it('backend-internal VS has timeout', () => {
    const vs = find(virtualServices, 'VirtualService', 'backend-internal');
    expect(vs.spec.http[0].timeout).toBeDefined();
  });
});

// ── destination-rules.yaml ────────────────────────────────────────────────────

describe('destination-rules.yaml', () => {
  const MTLS_SERVICES = ['backend', 'gateway', 'frontend'];

  it.each(MTLS_SERVICES)('%s DestinationRule uses ISTIO_MUTUAL TLS', (name) => {
    const dr = find(destRules, 'DestinationRule', name);
    expect(dr).toBeDefined();
    expect(dr.spec.trafficPolicy.tls.mode).toBe('ISTIO_MUTUAL');
  });

  it('redis DestinationRule disables TLS (plain TCP)', () => {
    const dr = find(destRules, 'DestinationRule', 'redis');
    expect(dr.spec.trafficPolicy.tls.mode).toBe('DISABLE');
  });

  it.each(['backend', 'gateway'])('%s has outlier detection (circuit breaker)', (name) => {
    const dr = find(destRules, 'DestinationRule', name);
    expect(dr.spec.trafficPolicy.outlierDetection).toBeDefined();
    expect(dr.spec.trafficPolicy.outlierDetection.consecutive5xxErrors).toBeGreaterThan(0);
  });

  it.each(['backend', 'gateway'])('%s has connection pool limits', (name) => {
    const dr = find(destRules, 'DestinationRule', name);
    expect(dr.spec.trafficPolicy.connectionPool).toBeDefined();
  });
});

// ── peer-authentication.yaml ──────────────────────────────────────────────────

describe('peer-authentication.yaml', () => {
  it('defines a default PeerAuthentication', () => {
    expect(find(peerAuths, 'PeerAuthentication', 'default')).toBeDefined();
  });

  it('default policy enforces STRICT mTLS', () => {
    const pa = find(peerAuths, 'PeerAuthentication', 'default');
    expect(pa.spec.mtls.mode).toBe('STRICT');
  });

  it('default policy applies to the nova-launch namespace', () => {
    const pa = find(peerAuths, 'PeerAuthentication', 'default');
    expect(pa.metadata.namespace).toBe('nova-launch');
  });

  it('redis has a PERMISSIVE exemption', () => {
    const pa = find(peerAuths, 'PeerAuthentication', 'redis-permissive');
    expect(pa).toBeDefined();
    expect(pa.spec.mtls.mode).toBe('PERMISSIVE');
    expect(pa.spec.selector.matchLabels.app).toBe('redis');
  });

  // Guards against a policy edit silently downgrading enforcement: the only
  // resource allowed to be non-STRICT is the documented Redis exemption.
  // See istio/README.md "mTLS STRICT verification" for the full approach,
  // including the live plaintext-rejection check in scripts/verify-istio-mtls-strict.sh.
  it('no PeerAuthentication other than the documented redis exemption is non-STRICT', () => {
    const nonStrict = peerAuths.filter((pa) => pa.spec?.mtls?.mode && pa.spec.mtls.mode !== 'STRICT');
    const unexpected = nonStrict.filter((pa) => pa.metadata?.name !== 'redis-permissive');
    expect(unexpected).toEqual([]);
  });

  it('the default policy has no selector (applies mesh-wide, not scoped to a workload)', () => {
    const pa = find(peerAuths, 'PeerAuthentication', 'default');
    expect(pa.spec.selector).toBeUndefined();
  });
});
