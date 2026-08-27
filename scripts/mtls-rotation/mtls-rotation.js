/**
 * mtls-rotation.js
 *
 * Zero-downtime mTLS certificate rotation pipeline for Nova Launch.
 *
 * Exports:
 *   - RotationState          — enum of orchestrator lifecycle phases
 *   - CertificateIssuer      — issues new cert/key/CA bundles
 *   - ConnectionMonitor      — polls error-rate and rejects on threshold breach
 *   - CertDistributor        — distributes bundles to istio, gateway, backend
 *   - CertRotationOrchestrator — end-to-end rotation state machine with rollback
 */

// ── RotationState ─────────────────────────────────────────────────────────────

/**
 * Lifecycle phases for the rotation orchestrator.
 * @enum {string}
 */
export const RotationState = Object.freeze({
  IDLE:                        'IDLE',
  ISSUING:                     'ISSUING',
  DUAL_TRUST:                  'DUAL_TRUST',
  MONITORING_POST_DISTRIBUTION:'MONITORING_POST_DISTRIBUTION',
  CUTOVER:                     'CUTOVER',
  MONITORING_POST_CUTOVER:     'MONITORING_POST_CUTOVER',
  CLEANUP:                     'CLEANUP',
  COMPLETE:                    'COMPLETE',
  ROLLING_BACK:                'ROLLING_BACK',
  ROLLED_BACK:                 'ROLLED_BACK',
});

// ── CertificateIssuer ─────────────────────────────────────────────────────────

/**
 * Issues new mTLS certificate bundles.
 *
 * In selfSigned mode (for testing / environments without cert-manager) it
 * produces placeholder PEM strings. In production, replace `issue()` with a
 * call to your PKI or cert-manager CertificateRequest API.
 */
export class CertificateIssuer {
  /**
   * @param {object} opts
   * @param {boolean} [opts.selfSigned=false]  Use self-signed placeholder certs.
   * @param {Function} [opts.requestFn]        Async function(params) → {cert,key,ca}.
   *                                           Takes priority over selfSigned mode.
   */
  constructor({ selfSigned = false, requestFn = null } = {}) {
    this._selfSigned = selfSigned;
    this._requestFn  = requestFn;
  }

  /**
   * Issue a new certificate bundle.
   *
   * @param {object} params
   * @param {string}   [params.namespace]  Kubernetes namespace.
   * @param {string[]} [params.dnsNames]   SANs for the certificate.
   * @returns {Promise<{cert: string, key: string, ca: string}>}
   */
  async issue(params = {}) {
    if (this._requestFn) {
      return this._requestFn(params);
    }

    if (this._selfSigned) {
      // Produce deterministic placeholder PEM blocks for testing.
      const ts = Date.now();
      return {
        cert: `-----BEGIN CERTIFICATE-----\nPLACEHOLDER-CERT-${ts}\n-----END CERTIFICATE-----`,
        key:  `-----BEGIN PRIVATE KEY-----\nPLACEHOLDER-KEY-${ts}\n-----END PRIVATE KEY-----`,
        ca:   `-----BEGIN CERTIFICATE-----\nPLACEHOLDER-CA-${ts}\n-----END CERTIFICATE-----`,
      };
    }

    throw new Error('CertificateIssuer: no requestFn supplied and selfSigned=false');
  }
}

// ── ConnectionMonitor ─────────────────────────────────────────────────────────

/**
 * Monitors the 5xx error rate and surfaces spikes.
 *
 * Usage:
 *   const m = new ConnectionMonitor({ threshold: 5, getErrorRate: async () => fetchRate() });
 *   const { ok, rate } = await m.check();
 *   await m.monitor(); // polls for windowMs, rejects on spike
 */
export class ConnectionMonitor {
  /**
   * @param {object} opts
   * @param {number}   opts.threshold        Maximum acceptable error-rate percentage.
   * @param {Function} opts.getErrorRate     Async () → number. Returns current 5xx %.
   * @param {number}   [opts.windowMs=120000]  Total monitoring window in milliseconds.
   * @param {number}   [opts.intervalMs=15000] Poll interval in milliseconds.
   */
  constructor({ threshold, getErrorRate, windowMs = 120_000, intervalMs = 15_000 }) {
    this._threshold   = threshold;
    this._getErrorRate = getErrorRate;
    this._windowMs    = windowMs;
    this._intervalMs  = intervalMs;
  }

  /**
   * Single-shot check.
   * @returns {Promise<{ok: boolean, rate: number}>}
   */
  async check() {
    const rate = await this._getErrorRate();
    return { ok: rate <= this._threshold, rate };
  }

  /**
   * Sustained monitoring over the configured window.
   *
   * Polls every `intervalMs` for `windowMs` total. Rejects with an Error
   * if any poll finds the error rate above the threshold.
   *
   * @returns {Promise<void>} Resolves when the window passes cleanly.
   */
  async monitor() {
    const deadline = Date.now() + this._windowMs;

    while (Date.now() < deadline) {
      const { ok, rate } = await this.check();
      if (!ok) {
        throw new Error(
          `Connection error rate ${rate}% exceeds threshold ${this._threshold}% — rollback required`
        );
      }
      // Sleep intervalMs, but don't overshoot the deadline
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this._intervalMs, remaining));
    }
  }
}

// ── CertDistributor ───────────────────────────────────────────────────────────

const ISTIO_NAMESPACE  = 'istio-system';
const CACERTS_SECRET   = 'cacerts';
const GATEWAY_TLS_SECRET = 'nova-launch-gateway-tls';
const BACKEND_MTLS_SECRET = 'nova-launch-backend-mtls';

/**
 * Distributes certificate bundles to all three mTLS layers:
 *   1. Istio  — patches `istio-system/cacerts`
 *   2. Gateway — patches the Istio Gateway TLS secret
 *   3. Backend  — patches the backend mTLS secret
 *
 * Supports dual-trust mode where both old and new CA are trusted simultaneously,
 * allowing in-flight connections and slow-to-update peers to complete gracefully.
 */
export class CertDistributor {
  /**
   * @param {object} opts
   * @param {object} opts.kube       Kubernetes client with getSecret/applySecret/
   *                                  restartDeployment/deleteResource/waitForRollout.
   * @param {string} opts.namespace  Application namespace (default: nova-launch).
   */
  constructor({ kube, namespace = 'nova-launch' }) {
    this._kube      = kube;
    this._namespace = namespace;
  }

  /**
   * Back up the current state of all three secrets before modification.
   *
   * @returns {Promise<{cacerts: object, gatewayTls: object, backendMtls: object}>}
   */
  async backup() {
    const [cacerts, gatewayTls, backendMtls] = await Promise.all([
      this._kube.getSecret(CACERTS_SECRET,        ISTIO_NAMESPACE),
      this._kube.getSecret(GATEWAY_TLS_SECRET,    this._namespace),
      this._kube.getSecret(BACKEND_MTLS_SECRET,   this._namespace),
    ]);
    return { cacerts, gatewayTls, backendMtls };
  }

  /**
   * Distribute a certificate bundle to all three layers.
   *
   * @param {{cert: string, key: string, ca: string}} bundle  New certificate bundle.
   * @param {object}  opts
   * @param {boolean} opts.dualTrust  When true, combine old and new CA in the Istio bundle.
   * @param {string|null} opts.oldCa  PEM of the old CA (required when dualTrust=true).
   * @returns {Promise<void>}
   */
  async distribute(bundle, { dualTrust, oldCa }) {
    // ── 1. Istio cacerts ──────────────────────────────────────────────────────
    const caBundle = dualTrust && oldCa
      ? `${oldCa}\n${bundle.ca}`
      : bundle.ca;

    await this._kube.applySecret({
      name:      CACERTS_SECRET,
      namespace: ISTIO_NAMESPACE,
      data: {
        'ca-cert.pem':   caBundle,
        'ca-key.pem':    bundle.key,
        'cert-chain.pem': caBundle,
        'root-cert.pem':  caBundle,
      },
    });

    // Restart istiod so it picks up the updated trust bundle.
    await this._kube.restartDeployment('istiod', ISTIO_NAMESPACE);

    // ── 2. Gateway TLS secret ─────────────────────────────────────────────────
    await this._kube.applySecret({
      name:      GATEWAY_TLS_SECRET,
      namespace: this._namespace,
      data: {
        'tls.crt': bundle.cert,
        'tls.key': bundle.key,
        'ca.crt':  bundle.ca,
      },
    });

    // ── 3. Backend mTLS secret ────────────────────────────────────────────────
    await this._kube.applySecret({
      name:      BACKEND_MTLS_SECRET,
      namespace: this._namespace,
      data: {
        'tls.crt': bundle.cert,
        'tls.key': bundle.key,
        'ca.crt':  bundle.ca,
      },
    });
  }

  /**
   * Restore all three secrets from a backup snapshot.
   *
   * @param {{cacerts: object, gatewayTls: object, backendMtls: object}} snapshot
   * @returns {Promise<void>}
   */
  async restore(snapshot) {
    await Promise.all([
      this._kube.applySecret(snapshot.cacerts),
      this._kube.applySecret(snapshot.gatewayTls),
      this._kube.applySecret(snapshot.backendMtls),
    ]);
    // Restart istiod so reverted certs take effect.
    await this._kube.restartDeployment('istiod', ISTIO_NAMESPACE);
  }
}

// ── CertRotationOrchestrator ──────────────────────────────────────────────────

/**
 * End-to-end zero-downtime mTLS certificate rotation state machine.
 *
 * Rotation phases:
 *   IDLE → ISSUING → DUAL_TRUST → MONITORING_POST_DISTRIBUTION
 *        → CUTOVER → MONITORING_POST_CUTOVER → CLEANUP → COMPLETE
 *
 * On error-rate spike:
 *   → ROLLING_BACK → ROLLED_BACK  (throws RotationError)
 *
 * @fires phaseChange  Emitted each time the orchestrator enters a new phase.
 *                     Listener receives the phase name string.
 */
export class CertRotationOrchestrator {
  /**
   * @param {object}  opts
   * @param {object}  opts.kube                Kubernetes client.
   * @param {object}  opts.issuer              CertificateIssuer (or duck-typed).
   * @param {object}  opts.monitor             Object with `getErrorRate` async fn.
   * @param {string}  [opts.namespace]         Application namespace.
   * @param {number}  [opts.dualTrustMs]       Dual-trust overlap window (ms).
   * @param {number}  [opts.monitorWindowMs]   Error-rate monitoring window (ms).
   * @param {number}  [opts.monitorIntervalMs] Poll interval (ms).
   * @param {number}  [opts.errorRateThreshold] Max acceptable 5xx % (0–100).
   */
  constructor({
    kube,
    issuer,
    monitor,
    namespace = 'nova-launch',
    dualTrustMs = 300_000,
    monitorWindowMs = 120_000,
    monitorIntervalMs = 15_000,
    errorRateThreshold = 5,
  }) {
    this._kube       = kube;
    this._issuer     = issuer;
    this._namespace  = namespace;
    this._dualTrustMs = dualTrustMs;
    this._errorRateThreshold = errorRateThreshold;

    this._distributor = new CertDistributor({ kube, namespace });

    this._connectionMonitor = new ConnectionMonitor({
      threshold:   errorRateThreshold,
      getErrorRate: () => monitor.getErrorRate(),
      windowMs:    monitorWindowMs,
      intervalMs:  monitorIntervalMs,
    });

    this.state = RotationState.IDLE;
    this._listeners = {};
  }

  // ── EventEmitter-style API (minimal, no Node.js dependency) ────────────────

  /**
   * Register a listener for an event.
   * @param {string}   event
   * @param {Function} fn
   */
  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return this;
  }

  _emit(event, ...args) {
    for (const fn of (this._listeners[event] || [])) {
      fn(...args);
    }
  }

  _setState(state) {
    this.state = state;
    this._emit('phaseChange', state);
  }

  // ── Rotation entry point ────────────────────────────────────────────────────

  /**
   * Execute the full rotation pipeline.
   *
   * @returns {Promise<void>} Resolves when rotation is COMPLETE.
   * @throws  {Error}         If rollback is triggered; state is ROLLED_BACK.
   */
  async rotate() {
    // ── Phase 0: back up current state ───────────────────────────────────────
    const backup = await this._distributor.backup();

    // Capture old CA for dual-trust window
    const oldCa = backup.cacerts?.data?.['ca-cert.pem'] ?? null;

    // ── Phase 1: issue new certificate ──────────────────────────────────────
    this._setState(RotationState.ISSUING);
    const newBundle = await this._issuer.issue({ namespace: this._namespace });

    // ── Phase 2: dual-trust window — distribute new cert alongside old ───────
    this._setState(RotationState.DUAL_TRUST);
    await this._distributor.distribute(newBundle, { dualTrust: true, oldCa });

    if (this._dualTrustMs > 0) {
      await sleep(this._dualTrustMs);
    }

    // ── Phase 3: monitor post-distribution ──────────────────────────────────
    this._setState(RotationState.MONITORING_POST_DISTRIBUTION);
    try {
      await this._connectionMonitor.monitor();
    } catch (err) {
      await this._rollback(backup, err);
    }

    // ── Phase 4: cutover — new cert only ─────────────────────────────────────
    this._setState(RotationState.CUTOVER);
    await this._distributor.distribute(newBundle, { dualTrust: false, oldCa });

    // ── Phase 5: monitor post-cutover ────────────────────────────────────────
    this._setState(RotationState.MONITORING_POST_CUTOVER);
    try {
      await this._connectionMonitor.monitor();
    } catch (err) {
      await this._rollback(backup, err);
    }

    // ── Phase 6: cleanup ─────────────────────────────────────────────────────
    this._setState(RotationState.CLEANUP);
    // No-op in JS layer; the bash script handles filesystem cleanup.

    this._setState(RotationState.COMPLETE);
  }

  // ── Rollback ────────────────────────────────────────────────────────────────

  async _rollback(backup, cause) {
    this._setState(RotationState.ROLLING_BACK);
    await this._distributor.restore(backup);
    this._setState(RotationState.ROLLED_BACK);
    throw new Error(`mTLS rotation rollback triggered: ${cause?.message ?? cause}`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
