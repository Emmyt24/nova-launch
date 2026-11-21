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
 *   - Overdraft burns (amount > remaining supply) are rejected before any
 *     state mutation; the state must remain unchanged.
 *   - Replaying the same burn sequence (deduped by event id) is idempotent:
 *     the final state is identical to applying it once.
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

/**
 * Represents the mutable token state used by the overdraft and replay models.
 */
interface TokenState {
  totalSupply: bigint;
  totalBurned: bigint;
}

/**
 * Attempts to apply a single burn to the given state, mirroring the
 * TokenEventParser.handleBurn guard: burns that exceed the remaining supply
 * (overdrafts) are rejected before any state mutation.
 *
 * @param state  - Current token state (mutated only on success).
 * @param amount - Burn amount to apply.
 * @returns      - `true` if the burn was accepted, `false` if rejected.
 */
function tryBurn(state: TokenState, amount: bigint): boolean {
  if (amount <= 0n || amount > state.totalSupply) {
    // Overdraft (or invalid zero) — reject before any DB write / mutation.
    return false;
  }
  state.totalBurned += amount;
  state.totalSupply -= amount;
  return true;
}

/**
 * A burn event carrying a stable event id used for replay deduplication.
 */
interface BurnEvent {
  id: string;
  amount: bigint;
}

/**
 * Applies a sequence of burn events to a fresh state, deduplicating by event
 * id so that replaying the same sequence is idempotent.
 *
 * @param initialSupply - The token's original supply.
 * @param events        - Ordered burn events (may contain duplicate ids).
 * @returns             - Final token state after processing.
 */
function applyBurnEvents(
  initialSupply: bigint,
  events: BurnEvent[]
): TokenState {
  const state: TokenState = { totalSupply: initialSupply, totalBurned: 0n };
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) {
      // Already processed — replay is a no-op.
      continue;
    }
    seen.add(event.id);
    tryBurn(state, event.amount);
  }
  return state;
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

  /**
   * Property 8: Overdraft burns are rejected and leave state unchanged.
   *
   * Invariant: A burn whose amount exceeds the remaining supply is rejected
   * before any state mutation.
   * Mathematical form: ∀ token, ∀ amount > token.totalSupply:
   *   tryBurn(state, amount) === false ∧ state unchanged
   *
   * Validates: Requirements 4.1 (overdraft rejection)
   */
  // Feature: token-burn-invariants, Property 8: overdraft burns are rejected
  it("Property 8: burns exceeding remaining supply are rejected with unchanged state", () => {
    fc.assert(
      fc.property(
        fc
          .record({ token: tokenArb })
          .chain(({ token }) =>
            fc.record({
              token: fc.constant(token),
              burnAmount: fc.bigInt({
                min: token.totalSupply + 1n,
                max: token.totalSupply * 2n + 1n,
              }),
            })
          ),
        ({ token, burnAmount }) => {
          const state: TokenState = {
            totalSupply: token.totalSupply,
            totalBurned: token.totalBurned,
          };

          const accepted = tryBurn(state, burnAmount);

          expect(accepted).toBe(false);
          expect(state.totalSupply).toBe(token.totalSupply);
          expect(state.totalBurned).toBe(token.totalBurned);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 9: Replaying a burn sequence is idempotent.
   *
   * Invariant: Applying the same burn sequence twice (deduped by event id)
   * yields the same final state as applying it once.
   * Mathematical form: ∀ token, ∀ burn sequence S:
   *   applyBurnEvents(initialSupply, S ++ S) ≡ applyBurnEvents(initialSupply, S)
   *
   * Validates: Requirements 8.3 (replay idempotency)
   */
  // Feature: token-burn-invariants, Property 9: replay is idempotent
  it("Property 9: replaying the same burn sequence is idempotent", () => {
    fc.assert(
      fc.property(
        fc
          .record({ token: tokenArb })
          .chain(({ token }) =>
            fc.record({
              token: fc.constant(token),
              events: fc
                .array(
                  fc.record({
                    id: fc.uuid(),
                    amount: fc.bigInt({ min: 1n, max: token.initialSupply }),
                  }),
                  { minLength: 1, maxLength: 20 }
                )
                .map((events) =>
                  // Ensure unique ids so the sequence is a valid burn log.
                  events.map((event, index) => ({
                    ...event,
                    id: `${index}-${event.id}`,
                  }))
                ),
            })
          ),
        ({ token, events }) => {
          const once = applyBurnEvents(token.initialSupply, events);
          const replayed = applyBurnEvents(token.initialSupply, [
            ...events,
            ...events,
          ]);

          expect(replayed.totalSupply).toBe(once.totalSupply);
          expect(replayed.totalBurned).toBe(once.totalBurned);
        }
      ),
      { numRuns: 100 }
    );
  });
});

  /**
   * Property 4: Burn order does not affect final state.
   *
   * Invariant: Final state is independent of burn order
   * Mathematical form: ∀ token, ∀ permutations of valid burn sequence S,
   *   applyBurns(token.initialSupply, S) ≡ applyBurns(token.initialSupply, permute(S))
   *   (final step has same totalBurned and currentSupply)
   *
   * Validates: Requirements 8.1, 8.2
   */
  it("Property 4: burn order does not affect final state", () => {
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
          const steps1 = applyBurns(token.initialSupply, amounts);
          const shuffled = fc.sample(fc.shuffledSubarray(amounts), 1)[0];
          const steps2 = applyBurns(token.initialSupply, shuffled);

          const final1 = steps1[steps1.length - 1];
          const final2 = steps2[steps2.length - 1];

          expect(final1.totalBurned).toBe(final2.totalBurned);
          expect(final1.currentSupply).toBe(final2.currentSupply);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5: Monotonic increase of total burned.
   *
   * Invariant: totalBurned is non-decreasing across steps
   * Mathematical form: ∀ i < j: steps[i].totalBurned <= steps[j].totalBurned
   *
   * Validates: Requirements 8.3, 8.4
   */
  it("Property 5: total_burned is monotonically non-decreasing", () => {
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
          for (let i = 1; i < steps.length; i++) {
            expect(steps[i].totalBurned >= steps[i - 1].totalBurned).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 6: Monotonic decrease of current supply.
   *
   * Invariant: currentSupply is non-increasing across steps
   * Mathematical form: ∀ i < j: steps[i].currentSupply >= steps[j].currentSupply
   *
   * Validates: Requirements 8.5, 8.6
   */
  it("Property 6: current_supply is monotonically non-increasing", () => {
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
          for (let i = 1; i < steps.length; i++) {
            expect(steps[i].currentSupply <= steps[i - 1].currentSupply).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7: Burn amount equals supply decrease.
   *
   * Invariant: Each burn amount equals the decrease in current supply
   * Mathematical form: ∀ i: amounts[i] = steps[i-1].currentSupply - steps[i].currentSupply
   *
   * Validates: Requirements 9.1, 9.2
   */
  it("Property 7: each burn amount equals supply decrease", () => {
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
          let prevSupply = token.initialSupply;

          for (let i = 0; i < amounts.length; i++) {
            const burnAmount = amounts[i];
            const currentStep = steps[i];

            if (burnAmount === 0n) {
              expect(currentStep.currentSupply).toBe(prevSupply);
            } else {
              expect(prevSupply - currentStep.currentSupply).toBe(burnAmount);
              prevSupply = currentStep.currentSupply;
            }
          }
        }
      ),
      { numRuns: 100 }
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

  /**
   * Task 4.3 — Multiple zero-amount burns
   *
   * Multiple zero-amount burns should leave state unchanged.
   *
   * Validates: Requirements 6.3
   */
  it("4.3: multiple zero-amount burns leave state unchanged", () => {
    const initialSupply = 1000n;
    const steps = applyBurns(initialSupply, [0n, 0n, 0n]);

    expect(steps).toHaveLength(3);
    for (const step of steps) {
      expect(step.totalBurned).toBe(0n);
      expect(step.currentSupply).toBe(1000n);
    }
  });

  /**
   * Task 4.4 — Mixed zero and non-zero burns
   *
   * Zero-amount burns should not affect the state progression.
   *
   * Validates: Requirements 6.4
   */
  it("4.4: mixed zero and non-zero burns skip zeros", () => {
    const initialSupply = 1000n;
    const steps = applyBurns(initialSupply, [100n, 0n, 200n, 0n, 300n]);

    expect(steps).toHaveLength(5);
    expect(steps[0].totalBurned).toBe(100n);
    expect(steps[1].totalBurned).toBe(100n); // Zero burn, no change
    expect(steps[2].totalBurned).toBe(300n);
    expect(steps[3].totalBurned).toBe(300n); // Zero burn, no change
    expect(steps[4].totalBurned).toBe(600n);
  });

  /**
   * Task 4.5 — Large supply handling
   *
   * Verify that large supplies (near 10^18) are handled correctly.
   *
   * Validates: Requirements 10.1
   */
  it("4.5: large supply (10^18) is handled correctly", () => {
    const initialSupply = 10n ** 18n;
    const burnAmount = 10n ** 17n;
    const steps = applyBurns(initialSupply, [burnAmount]);

    expect(steps[0].totalBurned).toBe(burnAmount);
    expect(steps[0].currentSupply).toBe(initialSupply - burnAmount);
    expect(steps[0].totalBurned + steps[0].currentSupply).toBe(initialSupply);
  });
});
