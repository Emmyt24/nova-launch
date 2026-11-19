/**
 * Shared helpers for parsing numeric pagination query parameters.
 *
 * All helpers parse with an explicit radix of 10 and guard against `NaN`
 * so that malformed input (e.g. `?limit=abc`) falls back to a safe default
 * instead of propagating `NaN` into downstream queries.
 */

/**
 * Parse a `limit`-style query parameter.
 *
 * - Parses with radix 10.
 * - Returns `defaultValue` when the input is `undefined`, empty, or `NaN`.
 * - Rejects negatives by falling back to `defaultValue`.
 * - Caps the result at `max` via `Math.min`.
 *
 * @param value Raw query parameter value.
 * @param defaultValue Fallback used for missing/invalid/negative input.
 * @param max Upper bound applied to the parsed value.
 */
export function parseLimit(
  value: unknown,
  defaultValue: number,
  max: number,
): number {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = parseInt(String(value), 10);

  if (Number.isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }

  return Math.min(parsed, max);
}

/**
 * Parse a non-negative integer query parameter (e.g. `offset`).
 *
 * - Parses with radix 10.
 * - Returns `defaultValue` when the input is `undefined`, empty, or `NaN`.
 * - Clamps negatives to `0`.
 *
 * @param value Raw query parameter value.
 * @param defaultValue Fallback used for missing/invalid input.
 */
export function parseNonNegativeInt(
  value: unknown,
  defaultValue: number,
): number {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = parseInt(String(value), 10);

  if (Number.isNaN(parsed)) {
    return defaultValue;
  }

  return Math.max(parsed, 0);
}