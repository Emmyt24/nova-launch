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
 * @module rolloutStrategy
 */

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
   */
  evaluate(flagKey: string, context: RolloutContext): RolloutResult {
    const config = this.flags.get(flagKey);
    if (!config) {
      return { decision: "disabled", reason: "percentage", bucket: 0 };
    }

    // 1. Tier blocked
    if (config.blockedTiers?.includes(context.tier)) {
      return { decision: "disabled", reason: "tier_blocked" };
    }

    // 2. Tier allowed
    if (config.allowedTiers?.includes(context.tier)) {
      return { decision: "enabled", reason: "tier_allowed" };
    }

    // 3. Cohort allow-list
    if (config.cohort?.includes(context.userId)) {
      return { decision: "enabled", reason: "cohort" };
    }

    // 4. Percentage rollout
    const bucket = hashToBucket(`${context.userId}:${flagKey}`);
    const decision: RolloutDecision =
      bucket < config.rolloutPercentage ? "enabled" : "disabled";

    return { decision, reason: "percentage", bucket };
  }

  /**
   * Convenience wrapper — returns true when the feature is enabled.
   */
  isEnabled(flagKey: string, context: RolloutContext): boolean {
    return this.evaluate(flagKey, context).decision === "enabled";
  }
}

export default new RolloutStrategyService();
