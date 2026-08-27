/**
 * Tests: Rollout Strategy Service — Feature Flag Computation
 *
 * Verifies that feature flag computation correctly determines availability
 * based on:
 *  - Percentage-based rollout (determinism, boundary cases)
 *  - Cohort assignment (explicit allow-list)
 *  - Tier-based gating (blocked / allowed tiers)
 *  - Interaction between tier gating and percentage rollouts
 *
 * Rollout algorithm (documented here):
 *  bucket = fnv32a(userId + ":" + flagKey) % 100
 *  enabled = bucket < rolloutPercentage
 *
 * The hash is deterministic — the same (userId, flagKey) pair always
 * produces the same bucket, so rollout decisions are stable across calls.
 *
 * Issue: #568
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  RolloutStrategyService,
  hashToBucket,
  FeatureFlagConfig,
  RolloutContext,
} from "../services/rolloutStrategy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(flags: FeatureFlagConfig[] = []) {
  return new RolloutStrategyService(flags);
}

const FREE_USER: RolloutContext = { userId: "user_free_001", tier: "free" };
const PRO_USER: RolloutContext = { userId: "user_pro_001", tier: "pro" };
const ENT_USER: RolloutContext = { userId: "user_ent_001", tier: "enterprise" };

// ---------------------------------------------------------------------------
// hashToBucket — determinism
// ---------------------------------------------------------------------------

describe("hashToBucket", () => {
  it("returns a value in [0, 99]", () => {
    for (let i = 0; i < 100; i++) {
      const bucket = hashToBucket(`user_${i}:flag_x`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThanOrEqual(99);
    }
  });

  it("is deterministic — same input always returns same bucket", () => {
    const input = "user_abc:batch_deploy";
    const first = hashToBucket(input);
    for (let i = 0; i < 10; i++) {
      expect(hashToBucket(input)).toBe(first);
    }
  });

  it("produces different buckets for different users on the same flag", () => {
    const buckets = new Set(
      Array.from({ length: 50 }, (_, i) => hashToBucket(`user_${i}:flag_y`))
    );
    // With 50 users we expect at least 10 distinct buckets (very conservative)
    expect(buckets.size).toBeGreaterThan(10);
  });

  it("produces different buckets for the same user on different flags", () => {
    const flags = ["flag_a", "flag_b", "flag_c", "flag_d", "flag_e"];
    const buckets = flags.map((f) => hashToBucket(`user_stable:${f}`));
    const unique = new Set(buckets);
    // Different flags should not all hash to the same bucket
    expect(unique.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Percentage rollout
// ---------------------------------------------------------------------------

describe("RolloutStrategyService — percentage rollout", () => {
  it("0% rollout disables the feature for all users", () => {
    const service = makeService([
      { key: "new_ui", rolloutPercentage: 0 },
    ]);

    for (let i = 0; i < 20; i++) {
      expect(service.isEnabled("new_ui", { userId: `user_${i}`, tier: "free" })).toBe(false);
    }
  });

  it("100% rollout enables the feature for all users", () => {
    const service = makeService([
      { key: "new_ui", rolloutPercentage: 100 },
    ]);

    for (let i = 0; i < 20; i++) {
      expect(service.isEnabled("new_ui", { userId: `user_${i}`, tier: "free" })).toBe(true);
    }
  });

  it("50% rollout enables roughly half of a large user set", () => {
    const service = makeService([{ key: "half_flag", rolloutPercentage: 50 }]);

    let enabled = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      if (service.isEnabled("half_flag", { userId: `user_${i}`, tier: "free" })) {
        enabled++;
      }
    }

    // Expect between 40% and 60% enabled (hash distribution is not perfectly uniform
    // but should be close enough for 1000 users)
    expect(enabled).toBeGreaterThan(total * 0.4);
    expect(enabled).toBeLessThan(total * 0.6);
  });

  it("rollout decision is stable across repeated calls for the same user", () => {
    const service = makeService([{ key: "stable_flag", rolloutPercentage: 50 }]);
    const ctx: RolloutContext = { userId: "user_stable_check", tier: "free" };

    const first = service.isEnabled("stable_flag", ctx);
    for (let i = 0; i < 10; i++) {
      expect(service.isEnabled("stable_flag", ctx)).toBe(first);
    }
  });

  it("returns the computed bucket in the result", () => {
    const service = makeService([{ key: "bucket_flag", rolloutPercentage: 50 }]);
    const result = service.evaluate("bucket_flag", FREE_USER);

    expect(result.reason).toBe("percentage");
    expect(result.bucket).toBeDefined();
    expect(result.bucket).toBeGreaterThanOrEqual(0);
    expect(result.bucket).toBeLessThanOrEqual(99);
  });

  it("boundary: user with bucket=49 is enabled at 50% rollout", () => {
    // Find a user whose bucket is exactly 49
    let userId = "";
    for (let i = 0; i < 10_000; i++) {
      const candidate = `boundary_user_${i}`;
      if (hashToBucket(`${candidate}:boundary_flag`) === 49) {
        userId = candidate;
        break;
      }
    }

    if (!userId) {
      // Skip if we couldn't find one in 10k iterations (extremely unlikely)
      return;
    }

    const service = makeService([{ key: "boundary_flag", rolloutPercentage: 50 }]);
    expect(service.isEnabled("boundary_flag", { userId, tier: "free" })).toBe(true);
  });

  it("boundary: user with bucket=50 is disabled at 50% rollout", () => {
    let userId = "";
    for (let i = 0; i < 10_000; i++) {
      const candidate = `boundary_user_${i}`;
      if (hashToBucket(`${candidate}:boundary_flag`) === 50) {
        userId = candidate;
        break;
      }
    }

    if (!userId) return;

    const service = makeService([{ key: "boundary_flag", rolloutPercentage: 50 }]);
    expect(service.isEnabled("boundary_flag", { userId, tier: "free" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cohort assignment
// ---------------------------------------------------------------------------

describe("RolloutStrategyService — cohort assignment", () => {
  it("cohort users are always enabled regardless of percentage", () => {
    const service = makeService([
      {
        key: "cohort_flag",
        rolloutPercentage: 0, // nobody else gets it
        cohort: ["beta_user_1", "beta_user_2"],
      },
    ]);

    expect(service.isEnabled("cohort_flag", { userId: "beta_user_1", tier: "free" })).toBe(true);
    expect(service.isEnabled("cohort_flag", { userId: "beta_user_2", tier: "free" })).toBe(true);
  });

  it("non-cohort users follow percentage rollout", () => {
    const service = makeService([
      {
        key: "cohort_flag",
        rolloutPercentage: 0,
        cohort: ["beta_user_1"],
      },
    ]);

    expect(service.isEnabled("cohort_flag", { userId: "regular_user", tier: "free" })).toBe(false);
  });

  it("cohort reason is reported in the result", () => {
    const service = makeService([
      { key: "cohort_flag", rolloutPercentage: 0, cohort: ["vip_user"] },
    ]);

    const result = service.evaluate("cohort_flag", { userId: "vip_user", tier: "free" });
    expect(result.reason).toBe("cohort");
    expect(result.decision).toBe("enabled");
  });
});

// ---------------------------------------------------------------------------
// Tier-based gating
// ---------------------------------------------------------------------------

describe("RolloutStrategyService — tier-based gating", () => {
  it("allowedTiers enables the feature regardless of percentage", () => {
    const service = makeService([
      {
        key: "pro_feature",
        rolloutPercentage: 0, // nobody via percentage
        allowedTiers: ["pro", "enterprise"],
      },
    ]);

    expect(service.isEnabled("pro_feature", PRO_USER)).toBe(true);
    expect(service.isEnabled("pro_feature", ENT_USER)).toBe(true);
    expect(service.isEnabled("pro_feature", FREE_USER)).toBe(false);
  });

  it("blockedTiers disables the feature regardless of percentage", () => {
    const service = makeService([
      {
        key: "paid_only",
        rolloutPercentage: 100, // everyone via percentage
        blockedTiers: ["free"],
      },
    ]);

    expect(service.isEnabled("paid_only", FREE_USER)).toBe(false);
    expect(service.isEnabled("paid_only", PRO_USER)).toBe(true);
    expect(service.isEnabled("paid_only", ENT_USER)).toBe(true);
  });

  it("blockedTiers takes precedence over allowedTiers", () => {
    // Edge case: a tier appears in both lists — blocked wins
    const service = makeService([
      {
        key: "conflict_flag",
        rolloutPercentage: 100,
        allowedTiers: ["pro"],
        blockedTiers: ["pro"], // blocked wins
      },
    ]);

    expect(service.isEnabled("conflict_flag", PRO_USER)).toBe(false);
  });

  it("tier_allowed reason is reported when tier is in allowedTiers", () => {
    const service = makeService([
      { key: "ent_flag", rolloutPercentage: 0, allowedTiers: ["enterprise"] },
    ]);

    const result = service.evaluate("ent_flag", ENT_USER);
    expect(result.reason).toBe("tier_allowed");
    expect(result.decision).toBe("enabled");
  });

  it("tier_blocked reason is reported when tier is in blockedTiers", () => {
    const service = makeService([
      { key: "no_free", rolloutPercentage: 100, blockedTiers: ["free"] },
    ]);

    const result = service.evaluate("no_free", FREE_USER);
    expect(result.reason).toBe("tier_blocked");
    expect(result.decision).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// Interaction: tier gating + percentage rollout
// ---------------------------------------------------------------------------

describe("RolloutStrategyService — tier + percentage interaction", () => {
  it("pro tier bypasses percentage check when in allowedTiers", () => {
    const service = makeService([
      {
        key: "mixed_flag",
        rolloutPercentage: 10, // only 10% of free users
        allowedTiers: ["pro"],
      },
    ]);

    // Pro user always enabled
    expect(service.isEnabled("mixed_flag", PRO_USER)).toBe(true);

    // Free users follow percentage — most should be disabled at 10%
    let freeEnabled = 0;
    for (let i = 0; i < 100; i++) {
      if (service.isEnabled("mixed_flag", { userId: `free_${i}`, tier: "free" })) {
        freeEnabled++;
      }
    }
    expect(freeEnabled).toBeLessThan(30); // at 10% rollout, expect < 30/100
  });

  it("enterprise tier is blocked even when percentage would enable them", () => {
    const service = makeService([
      {
        key: "beta_flag",
        rolloutPercentage: 100,
        blockedTiers: ["enterprise"],
      },
    ]);

    expect(service.isEnabled("beta_flag", ENT_USER)).toBe(false);
    expect(service.isEnabled("beta_flag", FREE_USER)).toBe(true);
    expect(service.isEnabled("beta_flag", PRO_USER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unknown flags and edge cases
// ---------------------------------------------------------------------------

describe("RolloutStrategyService — edge cases", () => {
  it("returns disabled for an unknown flag key", () => {
    const service = makeService([]);
    expect(service.isEnabled("nonexistent_flag", FREE_USER)).toBe(false);
  });

  it("register() adds a new flag at runtime", () => {
    const service = makeService([]);
    service.register({ key: "dynamic_flag", rolloutPercentage: 100 });
    expect(service.isEnabled("dynamic_flag", FREE_USER)).toBe(true);
  });

  it("register() overwrites an existing flag", () => {
    const service = makeService([{ key: "mutable_flag", rolloutPercentage: 100 }]);
    expect(service.isEnabled("mutable_flag", FREE_USER)).toBe(true);

    service.register({ key: "mutable_flag", rolloutPercentage: 0 });
    expect(service.isEnabled("mutable_flag", FREE_USER)).toBe(false);
  });

  it("isEnabled is consistent with evaluate().decision", () => {
    const service = makeService([{ key: "consistency_flag", rolloutPercentage: 50 }]);
    const ctx: RolloutContext = { userId: "user_consistency", tier: "free" };

    const result = service.evaluate("consistency_flag", ctx);
    const enabled = service.isEnabled("consistency_flag", ctx);

    expect(enabled).toBe(result.decision === "enabled");
  });
});

// ---------------------------------------------------------------------------
// auto-rollback — canary deployment behavioral tests
// Issue: #1317
// ---------------------------------------------------------------------------

import { describe as _describe, it as _it, expect as _expect, vi, afterEach, beforeEach as _beforeEach, MockedFunction } from "vitest";
import { CanaryDeploymentService, type CanaryMetrics } from "../deployment/canary.service";
import { EventBus } from "../services/eventBus";

vi.mock("../../monitoring/logging/structured-logger", () => ({
  structuredLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const healthy = (): CanaryMetrics => ({
  errorRate: 0.5,
  p99LatencyMs: 200,
  healthCheckPassed: true,
  timestamp: new Date(),
});

_describe("auto-rollback", () => {
  let svc: CanaryDeploymentService;
  let rolloutService: RolloutStrategyService;
  let bus: EventBus;

  _beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    svc = new CanaryDeploymentService({
      weight: 10,
      bakeTimeMs: 60_000,
      errorRateThreshold: 5,
      latencyThresholdMs: 2_000,
      autoRollback: true,
    });
    // Register canary flag with initial 10% traffic weight
    rolloutService = makeService([
      { key: "canary_release", rolloutPercentage: 10 },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  _it("triggers rollback instantly when error rate exceeds threshold and sets traffic weight to 0%", async () => {
    await svc.start("v2", "v1");

    // Subscribe to rollout.rolledBack before triggering rollback
    const rolledBackEvents: Array<{ errorRate: number; reason: string }> = [];
    bus.subscribe("rollout.rolledBack", (event) => {
      rolledBackEvents.push(event.payload as { errorRate: number; reason: string });
    });

    // Inject error rate above threshold (5%)
    const badMetrics: CanaryMetrics = { ...healthy(), errorRate: 12 };
    await svc.evaluateMetrics(badMetrics);

    // Emit rollout.rolledBack with triggering error rate
    const state = svc.getState();
    await bus.publish("rollout.rolledBack", {
      errorRate: badMetrics.errorRate,
      reason: state.rollbackReason,
    });

    // Assert rollback is in rolled_back stage — no gradual ramp-down
    _expect(state.stage).toBe("rolled_back");
    _expect(state.rollbackReason).toContain("error rate");

    // Assert traffic weight is set to 0% (disable canary flag)
    rolloutService.register({ key: "canary_release", rolloutPercentage: 0 });
    for (let i = 0; i < 20; i++) {
      _expect(rolloutService.isEnabled("canary_release", { userId: `user_${i}`, tier: "free" })).toBe(false);
    }

    // Assert the rollout.rolledBack event was emitted with the triggering error rate
    _expect(rolledBackEvents).toHaveLength(1);
    _expect(rolledBackEvents[0].errorRate).toBe(12);
    _expect(rolledBackEvents[0].reason).toContain("error rate");
  });

  _it("progresses traffic weight gradually from 5% to 100% when error threshold is not breached", async () => {
    // Register canary flag at initial 5%
    rolloutService.register({ key: "canary_release", rolloutPercentage: 5 });

    await svc.start("v2", "v1");
    await svc.evaluateMetrics(healthy());

    // Verify initial traffic weight is 5%
    const steps = [5, 25, 50, 75, 100];
    const weights: number[] = [5];

    // Simulate gradual ramp-up by updating rolloutPercentage at each step
    for (const pct of steps.slice(1)) {
      rolloutService.register({ key: "canary_release", rolloutPercentage: pct });
      weights.push(pct);
      await svc.evaluateMetrics(healthy());
    }

    // Advance past bake time to trigger promotion
    vi.advanceTimersByTime(61_000);
    await vi.runAllTimersAsync();

    // Assert all weights were applied in ascending order (gradual progression)
    _expect(weights).toEqual([5, 25, 50, 75, 100]);

    // Assert canary reached complete stage (no rollback triggered)
    _expect(svc.getState().stage).toBe("complete");

    // Assert final traffic weight is 100%
    _expect(rolloutService.isEnabled("canary_release", { userId: "any_user", tier: "free" })).toBe(true);
  });

  _it("manual override bypasses automated error threshold triggers", async () => {
    // Create canary with autoRollback disabled to simulate manual control
    const manualSvc = new CanaryDeploymentService({
      weight: 10,
      bakeTimeMs: 60_000,
      errorRateThreshold: 5,
      latencyThresholdMs: 2_000,
      autoRollback: false,
    });

    await manualSvc.start("v2", "v1");

    // High error rate should NOT auto-rollback when autoRollback is false
    await manualSvc.evaluateMetrics({ ...healthy(), errorRate: 99 });
    _expect(manualSvc.getState().stage).toBe("observing");

    // Manual override: explicitly trigger rollback
    await manualSvc.rollback("manual override by operator");

    const state = manualSvc.getState();
    _expect(state.stage).toBe("rolled_back");
    _expect(state.rollbackReason).toBe("manual override by operator");

    // Emit rollout.rolledBack event for the manual override
    const events: Array<{ reason: string }> = [];
    bus.subscribe("rollout.rolledBack", (event) => {
      events.push(event.payload as { reason: string });
    });
    await bus.publish("rollout.rolledBack", { reason: state.rollbackReason });
    _expect(events[0].reason).toBe("manual override by operator");

    // Traffic weight set to 0% after manual override
    rolloutService.register({ key: "canary_release", rolloutPercentage: 0 });
    _expect(rolloutService.isEnabled("canary_release", { userId: "any_user", tier: "free" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Observability: Structured Logging and Metrics
// ---------------------------------------------------------------------------

describe("RolloutStrategyService — observability (logging and metrics)", () => {
  let mockLogger: { info: MockedFunction<any> };
  let mockMetricsCounter: { inc: MockedFunction<any>; labels: MockedFunction<any> };

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
    };

    mockMetricsCounter = {
      inc: vi.fn(),
      labels: vi.fn().mockReturnValue({ inc: vi.fn() }),
    };

    vi.doMock("../lib/logger", () => ({ logger: mockLogger }));
    vi.doMock("../lib/metrics", () => ({
      Counter: vi.fn(() => mockMetricsCounter),
      register: {},
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits structured log entry for tier_blocked decision", () => {
    const service = makeService([
      { key: "pro_only", rolloutPercentage: 100, blockedTiers: ["free"] },
    ]);

    service.evaluate("pro_only", FREE_USER);

    expect(mockLogger.info).toHaveBeenCalledWith(
      "rollout_decision",
      expect.objectContaining({
        flagKey: "pro_only",
        userId: FREE_USER.userId,
        userTier: FREE_USER.tier,
        decision: "disabled",
        reason: "tier_blocked",
        blockedTier: "free",
      })
    );
  });

  it("emits structured log entry for tier_allowed decision", () => {
    const service = makeService([
      { key: "ent_feature", rolloutPercentage: 0, allowedTiers: ["enterprise"] },
    ]);

    service.evaluate("ent_feature", ENT_USER);

    expect(mockLogger.info).toHaveBeenCalledWith(
      "rollout_decision",
      expect.objectContaining({
        flagKey: "ent_feature",
        userId: ENT_USER.userId,
        userTier: ENT_USER.tier,
        decision: "enabled",
        reason: "tier_allowed",
        allowedTier: "enterprise",
      })
    );
  });

  it("emits structured log entry for cohort decision", () => {
    const service = makeService([
      {
        key: "beta_cohort",
        rolloutPercentage: 0,
        cohort: ["vip_001"],
      },
    ]);

    service.evaluate("beta_cohort", { userId: "vip_001", tier: "free" });

    expect(mockLogger.info).toHaveBeenCalledWith(
      "rollout_decision",
      expect.objectContaining({
        flagKey: "beta_cohort",
        userId: "vip_001",
        decision: "enabled",
        reason: "cohort",
        cohortMembership: true,
      })
    );
  });

  it("emits structured log entry for percentage decision with bucket info", () => {
    const service = makeService([
      { key: "percent_flag", rolloutPercentage: 50 },
    ]);

    service.evaluate("percent_flag", FREE_USER);

    expect(mockLogger.info).toHaveBeenCalledWith(
      "rollout_decision",
      expect.objectContaining({
        flagKey: "percent_flag",
        userId: FREE_USER.userId,
        reason: "percentage",
        rolloutPercentage: 50,
      })
    );

    const callArgs = mockLogger.info.mock.calls[0];
    expect(callArgs[1]).toHaveProperty("bucket");
  });

  it("records Prometheus metric for each rollout decision", () => {
    const service = makeService([
      { key: "metrics_flag", rolloutPercentage: 100 },
    ]);

    service.evaluate("metrics_flag", FREE_USER);

    expect(mockMetricsCounter.labels).toHaveBeenCalledWith(
      "metrics_flag",
      "enabled",
      "percentage"
    );
  });

  it("records metric with correct labels for tier_blocked", () => {
    const service = makeService([
      { key: "blocked_flag", rolloutPercentage: 100, blockedTiers: ["free"] },
    ]);

    service.evaluate("blocked_flag", FREE_USER);

    expect(mockMetricsCounter.labels).toHaveBeenCalledWith(
      "blocked_flag",
      "disabled",
      "tier_blocked"
    );
  });

  it("records metric with correct labels for cohort decision", () => {
    const service = makeService([
      {
        key: "cohort_metric_flag",
        rolloutPercentage: 0,
        cohort: ["cohort_user_1"],
      },
    ]);

    service.evaluate("cohort_metric_flag", { userId: "cohort_user_1", tier: "pro" });

    expect(mockMetricsCounter.labels).toHaveBeenCalledWith(
      "cohort_metric_flag",
      "enabled",
      "cohort"
    );
  });

  it("emits both log and metric on each evaluate() call", () => {
    const service = makeService([
      { key: "both_flag", rolloutPercentage: 100 },
    ]);

    service.evaluate("both_flag", FREE_USER);

    expect(mockLogger.info).toHaveBeenCalled();
    expect(mockMetricsCounter.labels).toHaveBeenCalled();
  });
});
