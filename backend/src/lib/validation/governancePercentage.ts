/**
 * Shared validation for governance percentage fields.
 *
 * Convention: every percentage-like governance field is expected to route
 * through this validator so that bounds and integer rules stay consistent
 * across the codebase. The fields currently expected to use it are:
 *
 * - `quorum_percent` (types/governance.ts, GraphQL schema): validated via
 *   `validateGovernancePercentage` / `validateGovernancePercentagePair`.
 * - `approval_percent` (types/governance.ts, GraphQL schema): validated via
 *   `validateGovernancePercentage` / `validateGovernancePercentagePair`.
 * - `threshold_percent` (types/governance.ts, GraphQL schema): validated via
 *   `validateGovernancePercentage` / `validateGovernancePercentagePair`.
 *
 * All of the above share the same rules: a finite integer in the inclusive
 * range [0, 100]. When a quorum/threshold pair is validated together, the
 * threshold must not exceed the quorum whenever the quorum is greater than 0
 * (see `validateGovernancePercentagePair`).
 *
 * Deliberate exceptions: percentage-like values that are NOT governance
 * percentages (for example display/formatting percentages, or metrics that
 * legitimately allow fractional or out-of-range values) intentionally do not
 * use this validator, because their bounds differ from the [0, 100] integer
 * governance convention. If a new governance percentage field is added, route
 * it through this validator unless it has a documented reason to differ.
 */

export type GovernancePercentageValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Validates a single governance percentage value.
 *
 * Accepts a finite integer in the inclusive range [0, 100].
 */
export function validateGovernancePercentage(
  value: unknown,
): GovernancePercentageValidationResult {
  if (typeof value !== "number") {
    return { valid: false, reason: "value must be a number" };
  }

  if (!Number.isFinite(value)) {
    return { valid: false, reason: "value must be finite" };
  }

  if (!Number.isInteger(value)) {
    return { valid: false, reason: "value must be an integer" };
  }

  if (value < 0) {
    return { valid: false, reason: "value must be >= 0" };
  }

  if (value > 100) {
    return { valid: false, reason: "value must be <= 100" };
  }

  return { valid: true };
}

/**
 * Validates a quorum/threshold percentage pair.
 *
 * Both values must individually satisfy `validateGovernancePercentage`. In
 * addition, when `quorumPct` is greater than 0, `thresholdPct` must not exceed
 * `quorumPct` so that the threshold remains reachable.
 */
export function validateGovernancePercentagePair(
  quorumPct: unknown,
  thresholdPct: unknown,
): GovernancePercentageValidationResult {
  const quorumResult = validateGovernancePercentage(quorumPct);
  if (!quorumResult.valid) {
    return { valid: false, reason: `quorumPct: ${quorumResult.reason}` };
  }

  const thresholdResult = validateGovernancePercentage(thresholdPct);
  if (!thresholdResult.valid) {
    return { valid: false, reason: `thresholdPct: ${thresholdResult.reason}` };
  }

  if ((quorumPct as number) > 0 && (thresholdPct as number) > (quorumPct as number)) {
    return {
      valid: false,
      reason: "thresholdPct must not exceed quorumPct when quorumPct > 0",
    };
  }

  return { valid: true };
}
