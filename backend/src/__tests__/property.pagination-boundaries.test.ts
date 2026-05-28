/**
 * Property-Based Tests: Cursor-Based Pagination Boundaries (#1075)
 *
 * Invariants verified:
 *   I1  Concatenating all pages reproduces the full ordered set (no gaps, no duplicates)
 *   I2  Pages never overlap — no item appears in more than one page
 *   I3  Cursors are stable — re-fetching the same cursor returns the same page
 *   I4  An out-of-range cursor yields an empty page, not an error
 *   I5  Page size of 1 works correctly
 *   I6  Page size larger than the dataset returns everything in one page
 *
 * The pagination logic is tested in isolation (pure functions) so no database
 * or HTTP server is required. The same algorithm is used by the token-search
 * and leaderboard routes.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Minimal cursor-based paginator (mirrors the production pattern)
// ---------------------------------------------------------------------------

interface Item {
  id: string;
  value: number;
}

interface PageResult {
  items: Item[];
  nextCursor: string | null;
  prevCursor: string | null;
}

/**
 * Paginate a sorted dataset using opaque string cursors.
 *
 * Cursor encoding: base64(JSON({ id, value })) of the last item on the page.
 * An unknown / out-of-range cursor returns an empty page.
 */
function paginate(
  dataset: Item[],
  pageSize: number,
  cursor: string | null
): PageResult {
  if (pageSize < 1) throw new RangeError("pageSize must be >= 1");

  let startIndex = 0;

  if (cursor !== null) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64").toString());
      const idx = dataset.findIndex(
        (item) => item.id === decoded.id && item.value === decoded.value
      );
      if (idx === -1) {
        // Out-of-range cursor → empty page
        return { items: [], nextCursor: null, prevCursor: null };
      }
      startIndex = idx + 1;
    } catch {
      return { items: [], nextCursor: null, prevCursor: null };
    }
  }

  const page = dataset.slice(startIndex, startIndex + pageSize);

  const nextCursor =
    page.length === pageSize && startIndex + pageSize < dataset.length
      ? Buffer.from(JSON.stringify(page[page.length - 1])).toString("base64")
      : null;

  const prevCursor =
    startIndex > 0
      ? Buffer.from(
          JSON.stringify(dataset[Math.max(0, startIndex - 1)])
        ).toString("base64")
      : null;

  return { items: page, nextCursor, prevCursor };
}

/** Collect all pages by following nextCursor until exhausted. */
function collectAllPages(dataset: Item[], pageSize: number): Item[][] {
  const pages: Item[][] = [];
  let cursor: string | null = null;

  do {
    const result = paginate(dataset, pageSize, cursor);
    if (result.items.length > 0) pages.push(result.items);
    cursor = result.nextCursor;
  } while (cursor !== null);

  return pages;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const itemArb = fc
  .record({
    id: fc.uuid(),
    value: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .map((item): Item => item);

const uniqueDatasetArb = fc
  .array(itemArb, { minLength: 0, maxLength: 200 })
  .map((items) => {
    // Deduplicate by id and sort by value desc, then id asc for stability
    const seen = new Set<string>();
    const unique = items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    return unique.sort((a, b) =>
      b.value !== a.value ? b.value - a.value : a.id.localeCompare(b.id)
    );
  });

const pageSizeArb = fc.integer({ min: 1, max: 50 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property: Cursor-Based Pagination Boundaries", () => {
  it("I1: concatenating all pages reproduces the full ordered set", () => {
    fc.assert(
      fc.property(uniqueDatasetArb, pageSizeArb, (dataset, pageSize) => {
        const pages = collectAllPages(dataset, pageSize);
        const reconstructed = pages.flat();
        expect(reconstructed).toEqual(dataset);
      })
    );
  });

  it("I2: pages never overlap — no item id appears in more than one page", () => {
    fc.assert(
      fc.property(uniqueDatasetArb, pageSizeArb, (dataset, pageSize) => {
        const pages = collectAllPages(dataset, pageSize);
        const seen = new Set<string>();
        for (const page of pages) {
          for (const item of page) {
            expect(seen.has(item.id)).toBe(false);
            seen.add(item.id);
          }
        }
      })
    );
  });

  it("I3: cursors are stable — same cursor always returns the same page", () => {
    fc.assert(
      fc.property(
        uniqueDatasetArb.filter((d) => d.length >= 2),
        fc.integer({ min: 1, max: 10 }),
        (dataset, pageSize) => {
          const first = paginate(dataset, pageSize, null);
          if (first.nextCursor === null) return; // single page, nothing to test

          const second1 = paginate(dataset, pageSize, first.nextCursor);
          const second2 = paginate(dataset, pageSize, first.nextCursor);
          expect(second1.items).toEqual(second2.items);
          expect(second1.nextCursor).toEqual(second2.nextCursor);
        }
      )
    );
  });

  it("I4: an out-of-range cursor yields an empty page, not an error", () => {
    fc.assert(
      fc.property(uniqueDatasetArb, pageSizeArb, (dataset, pageSize) => {
        const outOfRange = Buffer.from(
          JSON.stringify({ id: "nonexistent-id-xyz", value: -999 })
        ).toString("base64");

        const result = paginate(dataset, pageSize, outOfRange);
        expect(result.items).toEqual([]);
        expect(result.nextCursor).toBeNull();
      })
    );
  });

  it("I5: page size of 1 returns exactly one item per page", () => {
    fc.assert(
      fc.property(
        uniqueDatasetArb.filter((d) => d.length > 0),
        (dataset) => {
          const pages = collectAllPages(dataset, 1);
          expect(pages.length).toBe(dataset.length);
          for (const page of pages) {
            expect(page).toHaveLength(1);
          }
        }
      )
    );
  });

  it("I6: page size larger than dataset returns everything in one page", () => {
    fc.assert(
      fc.property(
        uniqueDatasetArb.filter((d) => d.length > 0),
        (dataset) => {
          const oversizedPageSize = dataset.length + 100;
          const result = paginate(dataset, oversizedPageSize, null);
          expect(result.items).toEqual(dataset);
          expect(result.nextCursor).toBeNull();
        }
      )
    );
  });

  it("I7: empty dataset always returns an empty first page", () => {
    fc.assert(
      fc.property(pageSizeArb, (pageSize) => {
        const result = paginate([], pageSize, null);
        expect(result.items).toEqual([]);
        expect(result.nextCursor).toBeNull();
        expect(result.prevCursor).toBeNull();
      })
    );
  });
});
