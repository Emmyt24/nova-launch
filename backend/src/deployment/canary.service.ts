/**
 * Canary Deployment Service — Nova Launch
 * Issue: #895, #1350
 *
 * Tracks canary state, evaluates health metrics, and triggers rollback
 * when error rate or latency thresholds are breached.
 *
 * Issue #1350 additions:
 *  - EventEmitter for `deployment.canary.rolled_back` events
 *  - `getWeight()` to expose current traffic weight
 *  - `rollbackCanary(reason)` public method for external callers
 *  - `startMetricsPolling(provider)` for periodic metrics ingestion
 *  - `performRollback` now sets weight to 0 and emits rollback event
 */

import { EventEmitter } from 'events';
import { structuredLogger } from '../../monitoring/logging/structured-logger';

export type CanaryStage = 'idle' | 'deploying' | 'observing' | 'promoting' | 'rolled_back' | 'complete';

export interface CanaryConfig {
  /** Traffic weight sent to canary (0–100). */
  weight: number;
  /** Observation window in milliseconds. */
  bakeTimeMs: number;
  /** Max acceptable error rate percentage. */
  errorRateThreshold: number;
  /** Max acceptable p99 latency in ms. */
  latencyThresholdMs: number;
  /** Whether to roll back automatically on threshold breach. */
  autoRollback: boolean;
}

export interface CanaryMetrics {
  errorRate: number;
  p99LatencyMs: number;
  healthCheckPassed: boolean;
  timestamp: Date;
}

export interface CanaryState {
  stage: CanaryStage;
  canaryVersion: string;
  stableVersion: string;
  startedAt: Date | null;
  lastMetrics: CanaryMetrics | null;
  rollbackReason: string | null;
}

export interface CanaryRolledBackPayload {
  deploymentId: string;
  errorRate: number;
  reason: string;
}

const DEFAULT_CONFIG: CanaryConfig = {
  weight:               10,
  bakeTimeMs:           300_000, // 5 min
  errorRateThreshold:   5,
  latencyThresholdMs:   2_000,
  autoRollback:         true,
};

export class CanaryDeploymentService extends EventEmitter {
  private state: CanaryState = {
    stage:          'idle',
    canaryVersion:  '',
    stableVersion:  '',
    startedAt:      null,
    lastMetrics:    null,
    rollbackReason: null,
  };

  private observationTimer: ReturnType<typeof setInterval> | null = null;
  private metricsPollingTimer: ReturnType<typeof setInterval> | null = null;
  private transitioning: boolean = false;
  private readonly config: CanaryConfig;

  constructor(config: Partial<CanaryConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Begin a canary deployment. */
  async start(canaryVersion: string, stableVersion: string): Promise<void> {
    if (this.state.stage !== 'idle' && this.state.stage !== 'complete' && this.state.stage !== 'rolled_back') {
      throw new Error(`Cannot start canary: current stage is '${this.state.stage}'`);
    }

    this.state = {
      stage:          'deploying',
      canaryVersion,
      stableVersion,
      startedAt:      new Date(),
      lastMetrics:    null,
      rollbackReason: null,
    };

    structuredLogger.info('Canary deployment started', {
      canaryVersion,
      stableVersion,
      weight: this.config.weight,
    });

    this.transitionTo('observing');
    this.startObservation();
  }

  /** Manually trigger rollback. */
  async rollback(reason: string): Promise<void> {
    await this.performRollback(reason);
  }

  /**
   * Public rollback method for external callers (e.g. middleware, API handlers).
   * Triggers an immediate rollback with the provided reason.
   */
  async rollbackCanary(reason: string): Promise<void> {
    await this.performRollback(reason);
  }

  /** Get current canary state (for health endpoint / API). */
  getState(): Readonly<CanaryState> {
    return { ...this.state };
  }

  /** Returns the current canary traffic weight (0–100). */
  getWeight(): number {
    return this.config.weight;
  }

  /** Feed fresh metrics into the canary evaluator. */
  async evaluateMetrics(metrics: CanaryMetrics): Promise<void> {
    this.state.lastMetrics = metrics;

    if (this.state.stage !== 'observing' || this.transitioning) return;

    const breached = this.checkThresholds(metrics);
    if (breached) {
      // Re-check stage immediately before rolling back (may have already transitioned via auto-promote)
      if (this.state.stage === 'observing' && !this.transitioning) {
        if (this.config.autoRollback) {
          await this.performRollback(breached);
        } else {
          structuredLogger.warn('Canary threshold breached — auto-rollback disabled', { reason: breached });
        }
      }
    }
  }

  /**
   * Start polling an external metrics provider every 30 seconds.
   * Feeds results into `evaluateMetrics` so thresholds are checked automatically.
   *
   * @param metricsProvider - async function that returns fresh CanaryMetrics
   */
  startMetricsPolling(metricsProvider: () => Promise<CanaryMetrics>): void {
    this.stopMetricsPolling();

    const intervalMs = 30_000;
    this.metricsPollingTimer = setInterval(async () => {
      if (this.state.stage !== 'observing') {
        this.stopMetricsPolling();
        return;
      }
      try {
        const metrics = await metricsProvider();
        await this.evaluateMetrics(metrics);
      } catch (err) {
        structuredLogger.warn('Canary metrics polling error', { error: (err as Error).message });
      }
    }, intervalMs);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private transitionTo(stage: CanaryStage): void {
    structuredLogger.info('Canary stage transition', {
      from: this.state.stage,
      to:   stage,
    });
    this.state.stage = stage;
  }

  private startObservation(): void {
    const checkIntervalMs = 30_000;
    const endTime = Date.now() + this.config.bakeTimeMs;

    this.observationTimer = setInterval(async () => {
      if (Date.now() >= endTime) {
        this.stopObservation();
        // Re-check stage immediately before promoting (may have already transitioned via rollback)
        if (this.state.stage === 'observing' && !this.transitioning) {
          await this.promote();
        }
        return;
      }

      // Metrics are fed externally via evaluateMetrics(); log current state
      if (this.state.lastMetrics) {
        structuredLogger.info('Canary observation tick', {
          stage:       this.state.stage,
          errorRate:   this.state.lastMetrics.errorRate,
          p99Latency:  this.state.lastMetrics.p99LatencyMs,
          remaining:   Math.max(0, endTime - Date.now()),
        });
      }
    }, checkIntervalMs);
  }

  private stopObservation(): void {
    if (this.observationTimer) {
      clearInterval(this.observationTimer);
      this.observationTimer = null;
    }
  }

  private stopMetricsPolling(): void {
    if (this.metricsPollingTimer) {
      clearInterval(this.metricsPollingTimer);
      this.metricsPollingTimer = null;
    }
  }

  private checkThresholds(metrics: CanaryMetrics): string | null {
    if (!metrics.healthCheckPassed) return 'health check failed';
    if (metrics.errorRate > this.config.errorRateThreshold) {
      return `error rate ${metrics.errorRate.toFixed(2)}% exceeds threshold ${this.config.errorRateThreshold}%`;
    }
    if (metrics.p99LatencyMs > this.config.latencyThresholdMs) {
      return `p99 latency ${metrics.p99LatencyMs}ms exceeds threshold ${this.config.latencyThresholdMs}ms`;
    }
    return null;
  }

  private async promote(): Promise<void> {
    // Ensure no concurrent transition is in progress
    if (this.transitioning || this.state.stage !== 'observing') return;

    this.transitioning = true;
    try {
      this.transitionTo('promoting');
      structuredLogger.info('Promoting canary to stable', {
        canaryVersion: this.state.canaryVersion,
      });
      // Concrete promotion logic (kubectl / load-balancer update) lives in canary-deploy.sh
      this.transitionTo('complete');
      structuredLogger.info('Canary promotion complete', {
        version: this.state.canaryVersion,
      });
    } finally {
      this.transitioning = false;
    }
  }

  private async performRollback(reason: string): Promise<void> {
    // Ensure no concurrent transition is in progress and we're still in observing state
    if (this.transitioning || this.state.stage !== 'observing') return;

    this.transitioning = true;
    try {
      this.stopObservation();
      this.stopMetricsPolling();

      // Revert canary traffic to 0%
      this.config.weight = 0;

      this.state.rollbackReason = reason;
      this.transitionTo('rolled_back');

      const errorRate = this.state.lastMetrics?.errorRate ?? 0;
      const deploymentId = this.state.canaryVersion;

      structuredLogger.error('Canary rollback triggered', {
        reason,
        canaryVersion:  this.state.canaryVersion,
        stableVersion:  this.state.stableVersion,
        errorRate,
      });

      // Emit event for observability / external listeners
      const payload: CanaryRolledBackPayload = { deploymentId, errorRate, reason };
      this.emit('deployment.canary.rolled_back', payload);

      // Concrete rollback (kubectl scale / nginx upstream) lives in canary-deploy.sh
    } finally {
      this.transitioning = false;
    }
  }
}

// Singleton for use across the application
export const canaryService = new CanaryDeploymentService();
