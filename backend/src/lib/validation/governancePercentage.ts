/**
 * Governance Percentage Parameter Validation
 *
 * Validates governance configuration parameters that are expressed as
 * integer percentages in the range [0, 100].
 *
 * Context:
 *   Governance proposals may carry percentage-based configuration fields
 *   (e.g. quorum_percentage, approval_threshold_percentage) alongside the
 *   absolute token-count fields already stored in the database.  These
 *   percentage values are surfaced in proposal metadata and validated here
 *   before any downstream calculation is performed.
 *
 * Design decisions:
 *   - Percentages are integers only; fractional values are rejected to keep
 *     on-chain encoding simple and deterministic.
 *   - The valid range is [0, 100] inclusive.  Values outside this range
 *     cannot represent a meaningful percentage and are rejected.
 *   - NaN, Infinity, and non-numeric types are rejected explicitly.
 *
 * Edge cases:
 *   - 0 is valid (e.g. a proposal with no quorum requirement).
 *   - When quorum is 0, any otherwise-valid threshold is accepted.
 *   - 100 is valid (e.g. unanimous approval required).
 *   - Negative values are always invalid.
 *   - Values > 100 are always invalid.
 *   - Non-integer numbers (e.g. 50.5) are invalid.
 *
 * Follow-up work:
 *   - If fractional percentages are ever needed, introduce a separate
 *     `validateGovernancePermille` (0-1000) to keep integer semantics.
 */

export interface GovernancePercentageValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a single governance percentage parameter.
 *
 * @param value - The candidate percentage value.
 * @returns A result object with `valid: true` or `valid: false` + `reason`.
 */
export function validateGovernancePercentage(
  value: unknown,
): GovernancePercentageValidationResult {
  if (typeof value !== 'number') {
    return { valid: false, reason: 'value must be a number' };
  }

  if (!Number.isFinite(value)) {
    return { valid: false, reason: 'value must be finite' };
  }

  if (!Number.isInteger(value)) {
    return { valid: false, reason: 'value must be an integer' };
  }

  if (value < 0) {
    return { valid: false, reason: 'value must be >= 0' };
  }

  if (value > 100) {
    return { valid: false, reason: 'value must be <= 100' };
  }

  return { valid: true };
}

/**
 * Validate a pair of governance percentage parameters (quorum + threshold).
 * Both must individually be valid, and threshold must not exceed quorum when
 * quorum > 0 (a threshold higher than quorum can never be reached).
 *
 * @param quorumPct      - Required participation percentage [0, 100].
 * @param thresholdPct   - Required approval percentage [0, 100].
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

  if (quorumPct > 0 && thresholdPct > quorumPct) {
    return {
      valid: false,
      reason: 'thresholdPct must not exceed quorumPct when quorumPct > 0',
    };
  }

  return { valid: true };
}
