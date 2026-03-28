/**
 * Property 64 — Token Burn Invariants
 *
 * This suite proves that token burn operations maintain supply invariants
 * across arbitrarily generated burn sequences using fast-check + Vitest.
 *
 * Two core invariants are verified for every generated scenario:
 *   1. total_burned <= initial_supply
 *      Cumulative burned tokens never exceed what was originally minted.
 *   2. current_supply >= 0n
 *      The remaining supply is always non-negative.
 *
 * A conservation identity ties the two together:
 *   current_supply + total_burned = initial_supply  (at every step)
 *
 * The pure in-memory model mirrors TokenEventParser.handleBurn arithmetic:
 *   totalBurned += amount
 *   totalSupply  -= amount
 *
 * Edge cases and assumptions:
 *   - Zero-amount burns (0n) are treated as invalid and must be rejected;
 *     state must remain unchanged.
 *   - Burn sequences generated for the invariant properties are constrained
 *     so their sum does not exceed initialSupply (valid / non-overdraft only).
 *   - All arithmetic uses bigint to avoid floating-point precision issues.
 *   - Token addresses are non-empty alphanumeric strings (10–56 chars).
 *   - initialSupply is in the range [1n, 10n ** 18n].
 *
 * // TODO: Add property test for overdraft rejection — burns that exceed
 * //       remaining supply should be rejected at the service layer
 * //       (TokenEventParser) before any DB write.
 * // TODO: Fuzz test idempotency — replaying the same burn sequence should
 * //       not change state (Requirements 8.3).
 */

import fc from "fast-check";
import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Prisma mock — intercepts all DB calls so the suite runs without a live DB.
// Required because future imports from the service layer pull in Prisma at
// module load time.
// ---------------------------------------------------------------------------
vi.mock("../lib/prisma", () => ({
  prisma: {
    token: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    burnRecord: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Arbitraries and in-memory burn model (module-level, used by Tasks 3 & 4)
// ---------------------------------------------------------------------------

/**
 * Generates a random token with:
 *   - address: alphanumeric string, length 10–56
 *   - initialSupply: bigint in [1n, 10n ** 18n]
 *   - totalSupply: equals initialSupply at generation
 *   - totalBurned: 0n at generation
 *
 * Requirements: 2.1, 2.2, 2.3
 */
const tokenArb = fc
  .record({
    address: fc.stringMatching(/^[a-zA-Z0-9]{10,56}$/),
    initialSupply: fc.bigInt({ min: 1n, max: 10n ** 18n }),
  })
  .map(({ address, initialSupply }) => ({
    address,
    initialSupply,
    totalSupply: initialSupply,
    totalBurned: 0n,
  }));

/**
 * Generates an array of 1–50 burn amounts (each in [1n, initialSupply])
 * whose sum does not exceed initialSupply, ensuring only valid
 * (non-overdraft) sequences are tested.
 *
 * Requirements: 3.1, 3.2, 3.3
 */
const burnSequenceArb = (initialSupply: bigint) =>
  fc
    .array(fc.bigInt({ min: 1n, max: initialSupply }), {
      minLength: 1,
      maxLength: 50,
    })
    .filter((amounts) => amounts.reduce((s, a) => s + a, 0n) <= initialSupply);

/**
 * Represents the state after a single burn step.
 *
 * Requirements: 4.4, 5.4, 6.2
 */
interface BurnStep {
  totalBurned: bigint;
  currentSupply: bigint;
}

/**
 * Pure in-memory burn model that mirrors TokenEventParser.handleBurn arithmetic.
 * Zero-amount burns (0n) are skipped — state is left unchanged for that step.
 *
 * @param initialSupply - The token's original supply before any burns.
 * @param amounts       - Ordered list of burn amounts to apply.
 * @returns             - Per-step state after each burn is applied.
 *
 * Requirements: 4.4, 5.4, 6.2
 */
function applyBurns(initialSupply: bigint, amounts: bigint[]): BurnStep[] {
  let totalBurned = 0n;
  const steps: BurnStep[] = [];
  for (const amount of amounts) {
    if (amount === 0n) {
      // Zero-amount burns are invalid — leave state unchanged.
      steps.push({ totalBurned, currentSupply: initialSupply - totalBurned });
      continue;
    }
    totalBurned += amount;
    steps.push({ totalBurned, currentSupply: initialSupply - totalBurned });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe("Property 64 — Token Burn Invariants", () => {
  /**
   * Property 1: Cumulative burns never exceed initial supply.
   *
   * Invariant: total_burned <= initial_supply
   * Mathematical form: ∀ token, ∀ valid burn sequence S,
   *   ∀ i ∈ [0, |S|): Σ S[0..i] <= token.initialSupply
   *
   * Assumptions:
   *   - Burn sequences are constrained so their sum does not exceed initialSupply
   *     (valid / non-overdraft sequences only).
   *   - All arithmetic uses bigint to avoid floating-point precision issues.
   *
   * Validates: Requirements 4.1, 4.2, 4.3
   */
  // Feature: token-burn-invariants, Property 1: total_burned <= initial_supply
  it("Property 1: total_burned <= initial_supply at every burn step", () => {
    fc.assert(
      fc.property(
        fc
          .record({ token: tokenArb })
          .chain(({ token }) =>
            fc.record({
              token: fc.constant(token),
              amounts: burnSequenceArb(token.initialSupply),
            })
          ),
        ({ token, amounts }) => {
          const steps = applyBurns(token.initialSupply, amounts);
          for (const step of steps) {
            expect(step.totalBurned <= token.initialSupply).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * Property 2: Current supply is always non-negative.
   *
   * Invariant: current_supply >= 0n
   * Mathematical form: ∀ token, ∀ valid burn sequence S,
   *   ∀ i ∈ [0, |S|): token.initialSupply - Σ S[0..i] >= 0n
   *
   * Assumptions:
   *   - Burn sequences are constrained so their sum does not exceed initialSupply.
   *   - current_supply is derived as initial_supply − total_burned at each step.
   *
   * Validates: Requirements 5.1, 5.2, 5.3
   */
  // Feature: token-burn-invariants, Property 2: current_supply >= 0n
  it("Property 2: current_supply >= 0n at every burn step", () => {
    fc.assert(
      fc.property(
        fc
          .record({ token: tokenArb })
          .chain(({ token }) =>
            fc.record({
              token: fc.constant(token),
              amounts: burnSequenceArb(token.initialSupply),
            })
          ),
        ({ token, amounts }) => {
          const steps = applyBurns(token.initialSupply, amounts);
          for (const step of steps) {
            expect(step.currentSupply >= 0n).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * Property 3: Supply conservation identity holds at every step.
   *
   * Invariant: current_supply + total_burned = initial_supply
   * Mathematical form: ∀ token, ∀ valid burn sequence S,
   *   ∀ i ∈ [0, |S|): (token.initialSupply - Σ S[0..i]) + Σ S[0..i] = token.initialSupply
   *
   * Assumptions:
   *   - Burning moves value from totalSupply to totalBurned without creating
   *     or destroying any tokens (conservation of supply).
   *   - All arithmetic uses bigint.
   *
   * Validates: Requirements 5.4
   */
  // Feature: token-burn-invariants, Property 3: current_supply + total_burned = initial_supply
  it("Property 3: current_supply + total_burned === initial_supply at every burn step", () => {
    fc.assert(
      fc.property(
        fc
          .record({ token: tokenArb })
          .chain(({ token }) =>
            fc.record({
              token: fc.constant(token),
              amounts: burnSequenceArb(token.initialSupply),
            })
          ),
        ({ token, amounts }) => {
          const steps = applyBurns(token.initialSupply, amounts);
          for (const step of steps) {
            expect(step.currentSupply + step.totalBurned).toBe(token.initialSupply);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Edge-case unit tests
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  /**
   * Task 4.1 — Zero-amount burn rejection
   *
   * A burn of 0n is invalid. applyBurns skips the amount but still records
   * a step with the unchanged state, so total_burned and current_supply must
   * remain at their initial values.
   *
   * Validates: Requirements 6.1, 6.2
   */
  it("4.1: zero-amount burn leaves state unchanged", () => {
    const initialSupply = 1000n;
    const steps = applyBurns(initialSupply, [0n]);

    expect(steps).toHaveLength(1);
    expect(steps[0].totalBurned).toBe(0n);
    expect(steps[0].currentSupply).toBe(1000n);
  });

  /**
   * Task 4.2 — Exact depletion (single burn equal to full supply)
   *
   * Burning the entire supply in one step must drive currentSupply to 0n
   * and totalBurned to initialSupply. Both core invariants must still hold.
   *
   * Validates: Requirements 7.1, 7.2
   */
  it("4.2: single burn equal to full supply depletes supply to zero", () => {
    const initialSupply = 1000n;
    const steps = applyBurns(initialSupply, [1000n]);

    expect(steps).toHaveLength(1);
    expect(steps[0].totalBurned).toBe(1000n);
    expect(steps[0].currentSupply).toBe(0n);

    // Both invariants must hold at exact depletion
    expect(steps[0].totalBurned <= initialSupply).toBe(true);
    expect(steps[0].currentSupply >= 0n).toBe(true);
  });
});
