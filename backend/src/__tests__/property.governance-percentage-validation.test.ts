/**
 * Property 65: Governance Percentage Parameter Validation
 *
 * Proves that governance percentage parameters are validated correctly,
 * enforcing the [0, 100] integer range for fields such as
 * quorum_percentage and approval_threshold_percentage.
 *
 * Properties tested:
 *   P65-A  Values in [0, 100] are accepted
 *   P65-B  Values > 100 are rejected
 *   P65-C  Negative values are rejected
 *   P65-D  Non-integer numbers are rejected
 *   P65-E  Non-numeric types are rejected
 *   P65-F  Boundary values 0 and 100 are accepted
 *   P65-G  Pair validation accepts two valid percentages
 *   P65-H  Pair validation rejects when either field is invalid
 *
 * Mathematical invariant:
 *   valid(x) ⟺ x ∈ ℤ ∧ 0 ≤ x ≤ 100
 *
 * Security considerations:
 *   - Rejecting values > 100 prevents a governance configuration where the
 *     required approval threshold can never be reached, which could be used
 *     to permanently block proposal execution.
 *   - Rejecting negative values prevents underflow when percentages are used
 *     in arithmetic (e.g. computing required vote counts from total supply).
 *   - Rejecting non-integers keeps on-chain encoding deterministic and
 *     prevents floating-point rounding discrepancies between clients.
 *
 * Edge cases / assumptions:
 *   - 0 is valid: a proposal with no quorum requirement is a legitimate
 *     governance configuration.
 *   - 100 is valid: unanimous approval is a legitimate (if strict) setting.
 *   - NaN and Infinity are treated as invalid non-finite numbers.
 *   - The validation operates on the percentage representation only; the
 *     conversion to absolute token counts happens downstream and is out of
 *     scope for this property.
 *
 * Follow-up work:
 *   - Add property test for the absolute-count conversion once a
 *     `percentageToTokenCount` helper is introduced.
 *   - Consider permille (0-1000) range if sub-percent precision is needed.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validateGovernancePercentage,
  validateGovernancePercentagePair,
} from '../lib/validation/governancePercentage';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Integer in the valid range [0, 100] */
const validPctArb = fc.integer({ min: 0, max: 100 });

/** Integer strictly above 100 */
const aboveRangeArb = fc.integer({ min: 101, max: 1_000_000 });

/** Negative integer */
const negativeArb = fc.integer({ min: -1_000_000, max: -1 });

/** Non-integer finite number (fractional) */
const fractionalArb = fc
  .tuple(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 1, max: 99 }))
  .map(([whole, frac]) => whole + frac / 100)
  .filter((n) => !Number.isInteger(n));

/** Non-numeric types */
const nonNumericArb = fc.oneof(
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.integer()),
);

// ---------------------------------------------------------------------------
// Property 65-A: Valid range [0, 100] is accepted
// ---------------------------------------------------------------------------
describe('Property 65-A: integers in [0, 100] are accepted', () => {
  it('accepts any integer in [0, 100]', () => {
    fc.assert(
      fc.property(validPctArb, (pct) => {
        const result = validateGovernancePercentage(pct);
        return result.valid === true;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 65-B: Values > 100 are rejected
// ---------------------------------------------------------------------------
describe('Property 65-B: values > 100 are rejected', () => {
  it('rejects any integer above 100', () => {
    fc.assert(
      fc.property(aboveRangeArb, (pct) => {
        const result = validateGovernancePercentage(pct);
        return result.valid === false;
      }),
      { numRuns: 100 },
    );
  });

  it('provides a reason when value > 100', () => {
    fc.assert(
      fc.property(aboveRangeArb, (pct) => {
        const result = validateGovernancePercentage(pct);
        return typeof result.reason === 'string' && result.reason.length > 0;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 65-C: Negative values are rejected
// ---------------------------------------------------------------------------
describe('Property 65-C: negative values are rejected', () => {
  it('rejects any negative integer', () => {
    fc.assert(
      fc.property(negativeArb, (pct) => {
        const result = validateGovernancePercentage(pct);
        return result.valid === false;
      }),
      { numRuns: 100 },
    );
  });

  it('provides a reason when value is negative', () => {
    fc.assert(
      fc.property(negativeArb, (pct) => {
        const result = validateGovernancePercentage(pct);
        return typeof result.reason === 'string' && result.reason.length > 0;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 65-D: Non-integer numbers are rejected
// ---------------------------------------------------------------------------
describe('Property 65-D: non-integer (fractional) numbers are rejected', () => {
  it('rejects fractional numbers even when in [0, 100]', () => {
    fc.assert(
      fc.property(fractionalArb, (pct) => {
        const result = validateGovernancePercentage(pct);
        return result.valid === false;
      }),
      { numRuns: 100 },
    );
  });

  it('rejects NaN', () => {
    const result = validateGovernancePercentage(NaN);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('rejects Infinity', () => {
    const result = validateGovernancePercentage(Infinity);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('rejects -Infinity', () => {
    const result = validateGovernancePercentage(-Infinity);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Property 65-E: Non-numeric types are rejected
// ---------------------------------------------------------------------------
describe('Property 65-E: non-numeric types are rejected', () => {
  it('rejects strings, booleans, null, undefined, and arrays', () => {
    fc.assert(
      fc.property(nonNumericArb, (value) => {
        const result = validateGovernancePercentage(value);
        return result.valid === false;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 65-F: Boundary values 0 and 100 are accepted
// ---------------------------------------------------------------------------
describe('Property 65-F: boundary values 0 and 100 are accepted', () => {
  it('accepts 0 (no quorum / no threshold requirement)', () => {
    expect(validateGovernancePercentage(0).valid).toBe(true);
  });

  it('accepts 100 (unanimous requirement)', () => {
    expect(validateGovernancePercentage(100).valid).toBe(true);
  });

  it('rejects 101 (one above upper boundary)', () => {
    expect(validateGovernancePercentage(101).valid).toBe(false);
  });

  it('rejects -1 (one below lower boundary)', () => {
    expect(validateGovernancePercentage(-1).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 65-G: Pair validation accepts reachable valid percentages
// ---------------------------------------------------------------------------
describe('Property 65-G: pair validation accepts reachable valid percentages', () => {
  it('accepts thresholds no greater than quorum, or any threshold with no quorum', () => {
    fc.assert(
      fc.property(validPctArb, validPctArb, (quorum, threshold) => {
        const result = validateGovernancePercentagePair(quorum, threshold);
        return result.valid === (quorum === 0 || threshold <= quorum);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects a threshold above a positive quorum', () => {
    expect(validateGovernancePercentagePair(10, 90)).toEqual({
      valid: false,
      reason: 'thresholdPct must not exceed quorumPct when quorumPct > 0',
    });
  });

  it('accepts equal and lower thresholds', () => {
    expect(validateGovernancePercentagePair(50, 50).valid).toBe(true);
    expect(validateGovernancePercentagePair(50, 25).valid).toBe(true);
  });

  it('accepts any valid threshold when quorum is zero', () => {
    expect(validateGovernancePercentagePair(0, 100).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 65-H: Pair validation rejects when either field is invalid
// ---------------------------------------------------------------------------
describe('Property 65-H: pair validation rejects when either field is invalid', () => {
  it('rejects when quorumPct is above 100', () => {
    fc.assert(
      fc.property(aboveRangeArb, validPctArb, (quorum, threshold) => {
        const result = validateGovernancePercentagePair(quorum, threshold);
        return result.valid === false;
      }),
      { numRuns: 100 },
    );
  });

  it('rejects when thresholdPct is above 100', () => {
    fc.assert(
      fc.property(validPctArb, aboveRangeArb, (quorum, threshold) => {
        const result = validateGovernancePercentagePair(quorum, threshold);
        return result.valid === false;
      }),
      { numRuns: 100 },
    );
  });

  it('rejects when quorumPct is negative', () => {
    fc.assert(
      fc.property(negativeArb, validPctArb, (quorum, threshold) => {
        const result = validateGovernancePercentagePair(quorum, threshold);
        return result.valid === false;
      }),
      { numRuns: 100 },
    );
  });

  it('rejects when thresholdPct is negative', () => {
    fc.assert(
      fc.property(validPctArb, negativeArb, (quorum, threshold) => {
        const result = validateGovernancePercentagePair(quorum, threshold);
        return result.valid === false;
      }),
      { numRuns: 100 },
    );
  });

  it('rejects when both fields are invalid', () => {
    fc.assert(
      fc.property(aboveRangeArb, negativeArb, (quorum, threshold) => {
        const result = validateGovernancePercentagePair(quorum, threshold);
        return result.valid === false;
      }),
      { numRuns: 100 },
    );
  });
});
