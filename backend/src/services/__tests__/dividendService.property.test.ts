/**
 * Property-based tests for dividend pro-rata share calculation (#1759).
 *
 * `calculateDividendShare` mirrors the on-chain arithmetic in
 * `dividend_distribution.rs::claim_dividend`:
 *
 *   share = floor(holderBalance * totalAmount / totalSupplyAtSnapshot)
 *
 * These properties are the ones that actually matter for a dividend engine:
 * the pool is never over-paid, a larger balance never yields a smaller
 * share, and the whole supply claims the whole pool exactly.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { calculateDividendShare } from "../dividendService";

/** totalSupplyAtSnapshot must be > 0 per the contract's DistributionZeroSupply guard. */
const positiveBigInt = (max: bigint) =>
  fc.bigInt({ min: 1n, max }).filter((v) => v > 0n);

describe("calculateDividendShare — property tests", () => {
  it("never returns a negative share", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        positiveBigInt(10n ** 18n),
        (balance, total, supply) => {
          const share = calculateDividendShare(balance, total, supply);
          expect(share).toBeGreaterThanOrEqual(0n);
        }
      )
    );
  });

  it("never exceeds the pool total for a single holder (share <= totalAmount when balance <= supply)", () => {
    fc.assert(
      fc.property(
        positiveBigInt(10n ** 18n),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        (supply, total) => {
          // balance is drawn from [0, supply] — a holder can never hold more
          // than the total supply at the snapshot.
          fc.assert(
            fc.property(fc.bigInt({ min: 0n, max: supply }), (balance) => {
              const share = calculateDividendShare(balance, total, supply);
              expect(share).toBeLessThanOrEqual(total);
            })
          );
        }
      ),
      { numRuns: 50 }
    );
  });

  it("is monotonically non-decreasing in holder balance (more balance never yields a smaller share)", () => {
    fc.assert(
      fc.property(
        positiveBigInt(10n ** 15n),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        (supply, total, balanceA, balanceB) => {
          const [lo, hi] =
            balanceA <= balanceB ? [balanceA, balanceB] : [balanceB, balanceA];
          const shareLo = calculateDividendShare(lo, total, supply);
          const shareHi = calculateDividendShare(hi, total, supply);
          expect(shareHi).toBeGreaterThanOrEqual(shareLo);
        }
      )
    );
  });

  it("a holder with the entire supply claims the entire pool exactly", () => {
    fc.assert(
      fc.property(
        positiveBigInt(10n ** 18n),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        (supply, total) => {
          const share = calculateDividendShare(supply, total, supply);
          expect(share).toBe(total);
        }
      )
    );
  });

  it("splitting the supply across N holders never lets total claims exceed the pool (rounding dust only ever remains, never overpays)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 9n }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        (balances, total) => {
          const supply = balances.reduce((acc, b) => acc + b, 0n);
          fc.pre(supply > 0n);
          const claimedSum = balances.reduce(
            (acc, b) => acc + calculateDividendShare(b, total, supply),
            0n
          );
          expect(claimedSum).toBeLessThanOrEqual(total);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("a zero balance always yields a zero share", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        positiveBigInt(10n ** 18n),
        (total, supply) => {
          expect(calculateDividendShare(0n, total, supply)).toBe(0n);
        }
      )
    );
  });

  it("rejects a non-positive totalSupplyAtSnapshot", () => {
    expect(() => calculateDividendShare(1n, 100n, 0n)).toThrow(RangeError);
    expect(() => calculateDividendShare(1n, 100n, -1n)).toThrow(RangeError);
  });

  it("rejects negative balance or total", () => {
    expect(() => calculateDividendShare(-1n, 100n, 10n)).toThrow(RangeError);
    expect(() => calculateDividendShare(1n, -100n, 10n)).toThrow(RangeError);
  });
});
