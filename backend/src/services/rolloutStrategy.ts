/**
 * Rollout Strategy Service
 *
 * Determines feature flag availability for a given user based on three
 * orthogonal mechanisms that are evaluated in priority order:
 *
 *  1. Tier gating  — certain tiers always have (or never have) a feature.
 *  2. Cohort list  — explicit allow-list of user IDs.
 *  3. Percentage rollout — deterministic hash-based bucketing so the same
 *     user always lands in the same bucket for a given flag.
 *
 * Algorithm (percentage rollout):
 *  bucket = fnv32a(userId + ":" + flagKey) % 100
 *  enabled = bucket < rolloutPercentage
 *
 * The hash function is pure and side-effect-free, making rollout decisions
 * stable across repeated calls for the same (user, flag) pair.
 *
 * Emits structured logs and Prometheus metrics for observability.
 *
 * Relationship to `deployment/canary.service.ts`:
 *  This service and the canary deployment service are INDEPENDENT concepts
 *  that happen to share the word "rollout". This module is a general
 *  feature-flag policy layer: it decides *whether a given user sees a
 *  feature* using tier gating, cohort allow-lists, and deterministic
 *  percentage bucketing. It does NOT compose, invoke, or select
 *  `canary.service.ts` as one of several strategies, and it has no notion of
 *  "canary" as a strategy name.
 *
 *  `deployment/canary.service.ts` is a specific deployment mechanism: it
 *  governs *how a new build is progressively shifted to live traffic*
 *  (weighted traffic splitting, health checks, automatic rollback). It does
 *  not consult feature-flag configuration and does not call into this module.
 *
 *  The two are deliberately kept separate because they operate on different
 *  axes: this service gates feature *visibility* per user, while the canary
 *  service gates *traffic* per deployment. A feature can be fully rolled out
 *  (100% of users) while its backing deployment is still canarying, and vice
 *  versa. Coupling them would conflate per-user flag evaluation with
 *  per-deployment traffic management.
 *
 *  Deliberate exception: if a future feature needs to gate visibility on
 *  deployment state (e.g. only expose a feature once its canary has been
 *  promoted), that coordination must be done explicitly by the caller — it
 *  is intentionally NOT built into this service's evaluation order.
 *
 * @module rolloutStrategy
 */

import { logger } from '../lib/logger';
import { Counter, register } from '../lib/metrics';

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const rolloutDecisionCounter = new Counter({
  name: 'rollout_decisions_total',
  help: 'Total number of rollout decisions by flag and decision type',
  labelNames: ['flag_key', 'decision', 'reason'],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserTier = "free" | "pro" | "enterprise";

export interface FeatureFlagConfig {
  /** Unique flag identifier, e.g. "batch_deploy" */
  key: string;
  /**
   * Percentage of users (0–100) who should see this feature.
   * 0 = nobody, 100 = everybody.
   */
  rolloutPercentage: number;
  /**
   * Tiers that always have access regardless of percentage.
   * Takes precedence over `blockedTiers`.
   */
  allowedTiers?: UserTier[];
  /**
   * Tiers that are always blocked regardless of percentage.
   */
  blockedTiers?: UserTier[];
  /**
   * Explicit user IDs that are always included (cohort allow-list).
   */
  cohort?: string[];
}

export interface RolloutContext {
  userId: string;
  tier: UserTier;
}

export type RolloutDecision = "enabled" | "disabled";

export interface RolloutResult {
  decision: RolloutDecision;
  /** Reason for the decision — useful for debugging and audit logs */
  reason: "tier_allowed" | "tier_blocked" | "cohort" | "percentage";
  /** The computed bucket (0–99) for percentage-based decisions */
  bucket?: number;
}

// ---------------------------------------------------------------------------
// Hash function (FNV-32a — deterministic, no external deps)
// ---------------------------------------------------------------------------

/**
 * FNV-32a hash of a string, returning a value in [0, 99].
 * Deterministic: same input always produces the same output.
 */
export function hashToBucket(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by FNV prime (32-bit), keeping within 32-bit unsigned range
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash % 100;
}

// ---------------------------------------------------------------------------
// RolloutStrategyService
// ---------------------------------------------------------------------------

/**
 * Evaluates feature flag availability for a user.
 *
 * Evaluation order:
 *  1. If user's tier is in `blockedTiers` → disabled
 *  2. If user's tier is in `allowedTiers` → enabled
 *  3. If user's ID is in `cohort` → enabled
 *  4. Percentage bucket check → enabled if bucket < rolloutPercentage
 *
 * This is a per-user feature-visibility policy layer and is independent of
 * `deployment/canary.service.ts` (see module docs above): it does not select
 * or delegate to the canary deployment service as a strategy.
 */
export class RolloutStrategyService {
  private readonly flags: Map<string, FeatureFlagConfig>;

  constructor(flags: FeatureFlagConfig[] = []) {
    this.flags = new Map(flags.map((f) => [f.key, f]));
  }

  /**
   * Register or update a feature flag configuration.
   */
  register(config: FeatureFlagConfig): void {
    this.flags.set(config.key, config);
  }

  /**
   * Evaluate whether a feature is enabled for the given context.
   * Emits structured logs and metrics for observability.
   */
  evaluate(flagKey: string, context: RolloutContext): RolloutResult {
    const config = this.flags.get(flagKey);
    if (!config) {
      const result = { decision: "disabled", reason: "percentage" as const, bucket: 0 };
      this.logDecision(flagKey, context, result);
      this.recordMetric(flagKey, result);
      return result;
    }

    // 1. Tier blocked
    if (config.blockedTiers?.includes(context.tier)) {
      const result = { decision: "disabled", reason: "tier_blocked" as const };
      this.logDecision(flagKey, context, result, { blockedTier: context.tier });
      this.recordMetric(flagKey, result);
      return result;
    }

    // 2. Tier allowed
    if (config.allowedTiers?.includes(context.tier)) {
      const result = { decision: "enabled", reason: "tier_allowed" as const };
      this.logDecision(flagKey, context, result, { allowedTier: context.tier });
      this.recordMetric(flagKey, result);
      return result;
    }

    // 3. Cohort allow-list
    if (config.cohort?.includes(context.userId)) {
      const result = { decision: "enabled", reason: "cohort" as const };
      this.logDecision(flagKey, context, result, { cohortMembership: true });
      this.recordMetric(flagKey, result);
      return result;
    }

    // 4. Percentage rollout
    const bucket = hashToBucket(`${context.userId}:${flagKey}`);
    const decision: RolloutDecision =
      bucket < config.rolloutPercentage ? "enabled" : "disabled";

    const result = { decision, reason: "percentage" as const, bucket };
    this.logDecision(flagKey, context, result, {
      rolloutPercentage: config.rolloutPercentage,
      threshold: config.rolloutPercentage,
    });
    this.recordMetric(flagKey, result);
    return result;
  }

  /**
   * Emit a structured log entry for a rollout decision.
   */
  private logDecision(
    flagKey: string,
    context: RolloutContext,
    result: RolloutResult,
    additionalContext?: Record<string, unknown>,
  ): void {
    logger.info('rollout_decision', {
      flagKey,
      userId: context.userId,
      userTier: context.tier,
      decision: result.decision,
      reason: result.reason,
      bucket: result.bucket,
      ...additionalContext,
    });
  }

  /**
   * Record a Prometheus metric for this rollout decision.
   */
  private recordMetric(flagKey: string, result: RolloutResult): void {
    rolloutDecisionCounter.labels(flagKey, result.decision, result.reason).inc();
  }

  /**
   * Convenience wrapper — returns true when the feature is enabled.
   */
  isEnabled(flagKey: string, context: RolloutContext): boolean {
    return this.evaluate(flagKey, context).decision === "enabled";
  }
}

export default new RolloutStrategyService();
