import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  QueryBuilder,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  tokenQuery,
  burnRecordQuery,
  campaignQuery,
  proposalQuery,
} from "./queryBuilder";

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe("QueryBuilder", () => {
  // ── build() defaults ──────────────────────────────────────────────────────

  describe("build()", () => {
    it("returns default page size when no take is set", () => {
      const result = new QueryBuilder().build();
      expect(result.take).toBe(DEFAULT_PAGE_SIZE);
    });

    it("returns empty where/orderBy when nothing is set", () => {
      const result = new QueryBuilder().build();
      expect(result.where).toBeUndefined();
      expect(result.orderBy).toBeUndefined();
      expect(result.skip).toBeUndefined();
      expect(result.cursor).toBeUndefined();
    });
  });

  // ── where() ───────────────────────────────────────────────────────────────

  describe("where()", () => {
    it("sets a filter condition", () => {
      const result = new QueryBuilder<
        Prisma.TokenWhereInput,
        Prisma.TokenOrderByWithRelationInput
      >()
        .where({ creator: "GABC" })
        .build();

      expect(result.where).toEqual({ creator: "GABC" });
    });

    it("merges multiple where calls with AND", () => {
      const result = new QueryBuilder<
        Prisma.TokenWhereInput,
        Prisma.TokenOrderByWithRelationInput
      >()
        .where({ creator: "GABC" })
        .where({ symbol: "TEST" })
        .build();

      expect(result.where).toEqual({
        AND: [{ creator: "GABC" }, { symbol: "TEST" }],
      });
    });

    it("is immutable — original builder is unchanged", () => {
      const base = new QueryBuilder<
        Prisma.TokenWhereInput,
        Prisma.TokenOrderByWithRelationInput
      >().where({ creator: "GABC" });

      const derived = base.where({ symbol: "TEST" });

      expect(base.build().where).toEqual({ creator: "GABC" });
      expect(derived.build().where).toEqual({
        AND: [{ creator: "GABC" }, { symbol: "TEST" }],
      });
    });
  });

  // ── orderBy() ─────────────────────────────────────────────────────────────

  describe("orderBy()", () => {
    it("sets a single sort field", () => {
      const result = new QueryBuilder<
        Prisma.TokenWhereInput,
        Prisma.TokenOrderByWithRelationInput
      >()
        .orderBy({ createdAt: "desc" })
        .build();

      expect(result.orderBy).toEqual({ createdAt: "desc" });
    });

    it("accepts an array of sort fields", () => {
      const order = [{ createdAt: "desc" as const }, { name: "asc" as const }];
      const result = new QueryBuilder<
        Prisma.TokenWhereInput,
        Prisma.TokenOrderByWithRelationInput
      >()
        .orderBy(order)
        .build();

      expect(result.orderBy).toEqual(order);
    });

    it("replaces a previously set order", () => {
      const result = new QueryBuilder<
        Prisma.TokenWhereInput,
        Prisma.TokenOrderByWithRelationInput
      >()
        .orderBy({ createdAt: "asc" })
        .orderBy({ createdAt: "desc" })
        .build();

      expect(result.orderBy).toEqual({ createdAt: "desc" });
    });
  });

  // ── paginate() ────────────────────────────────────────────────────────────

  describe("paginate()", () => {
    it("sets skip and take", () => {
      const result = new QueryBuilder().paginate({ skip: 40, take: 20 }).build();
      expect(result.skip).toBe(40);
      expect(result.take).toBe(20);
    });

    it("caps take at MAX_PAGE_SIZE", () => {
      const result = new QueryBuilder()
        .paginate({ take: MAX_PAGE_SIZE + 500 })
        .build();
      expect(result.take).toBe(MAX_PAGE_SIZE);
    });

    it("clamps negative skip to 0", () => {
      const result = new QueryBuilder().paginate({ skip: -10 }).build();
      expect(result.skip).toBe(0);
    });

    it("uses DEFAULT_PAGE_SIZE when take is omitted", () => {
      const result = new QueryBuilder().paginate({ skip: 0 }).build();
      expect(result.take).toBe(DEFAULT_PAGE_SIZE);
    });
  });

  // ── limit() ───────────────────────────────────────────────────────────────

  describe("limit()", () => {
    it("sets take without affecting skip", () => {
      const result = new QueryBuilder().limit(5).build();
      expect(result.take).toBe(5);
      expect(result.skip).toBeUndefined();
    });

    it("caps at MAX_PAGE_SIZE", () => {
      const result = new QueryBuilder().limit(MAX_PAGE_SIZE * 2).build();
      expect(result.take).toBe(MAX_PAGE_SIZE);
    });
  });

  // ── after() (cursor pagination) ───────────────────────────────────────────

  describe("after()", () => {
    it("sets cursor and skip=1", () => {
      const cursor = { id: "abc-123" };
      const result = new QueryBuilder().after(cursor).build();
      expect(result.cursor).toEqual(cursor);
      expect(result.skip).toBe(1);
    });

    it("preserves cursor-derived skip when chained with paginate()", () => {
      const cursor = { id: "abc-123" };
      const result = new QueryBuilder()
        .after(cursor)
        .paginate({ take: 10 })
        .build();

      expect(result.cursor).toEqual(cursor);
      expect(result.skip).toBe(1); // Should be preserved, not reset to 0
      expect(result.take).toBe(10);
    });

    it("allows caller to override skip when explicitly provided", () => {
      const cursor = { id: "abc-123" };
      const result = new QueryBuilder()
        .after(cursor)
        .paginate({ skip: 5, take: 10 })
        .build();

      expect(result.cursor).toEqual(cursor);
      expect(result.skip).toBe(5); // Caller's explicit value takes precedence
      expect(result.take).toBe(10);
    });
  });

  // ── chaining ──────────────────────────────────────────────────────────────

  describe("method chaining", () => {
    it("composes where + orderBy + paginate correctly", () => {
      const result = new QueryBuilder<
        Prisma.TokenWhereInput,
        Prisma.TokenOrderByWithRelationInput
      >()
        .where({ creator: "GABC" })
        .orderBy({ createdAt: "desc" })
        .paginate({ skip: 0, take: 10 })
        .build();

      expect(result.where).toEqual({ creator: "GABC" });
      expect(result.orderBy).toEqual({ createdAt: "desc" });
      expect(result.skip).toBe(0);
      expect(result.take).toBe(10);
    });
  });
});

// ─── Factory helpers ──────────────────────────────────────────────────────────

describe("factory helpers", () => {
  it("tokenQuery() returns a QueryBuilder with Token types", () => {
    const result = tokenQuery()
      .where({ creator: "GABC" })
      .orderBy({ createdAt: "desc" })
      .paginate({ skip: 0, take: 5 })
      .build();

    expect(result.where).toEqual({ creator: "GABC" });
    expect(result.take).toBe(5);
  });

  it("burnRecordQuery() returns a QueryBuilder with BurnRecord types", () => {
    const result = burnRecordQuery()
      .where({ tokenId: "token-1" })
      .orderBy({ timestamp: "desc" })
      .build();

    expect(result.where).toEqual({ tokenId: "token-1" });
    expect(result.orderBy).toEqual({ timestamp: "desc" });
  });

  it("campaignQuery() returns a QueryBuilder with Campaign types", () => {
    const result = campaignQuery()
      .where({ status: "ACTIVE" })
      .limit(50)
      .build();

    expect(result.where).toEqual({ status: "ACTIVE" });
    expect(result.take).toBe(50);
  });

  it("proposalQuery() returns a QueryBuilder with Proposal types", () => {
    const result = proposalQuery()
      .where({ status: "ACTIVE" })
      .orderBy({ startTime: "asc" })
      .build();

    expect(result.where).toEqual({ status: "ACTIVE" });
    expect(result.orderBy).toEqual({ startTime: "asc" });
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("build() caps take even when set directly via constructor", () => {
    const builder = new QueryBuilder({ take: MAX_PAGE_SIZE + 1 });
    expect(builder.build().take).toBe(MAX_PAGE_SIZE);
  });

  it("three chained where() calls nest correctly", () => {
    const result = new QueryBuilder<
      Prisma.TokenWhereInput,
      Prisma.TokenOrderByWithRelationInput
    >()
      .where({ creator: "GABC" })
      .where({ symbol: "TEST" })
      .where({ decimals: 18 })
      .build();

    // Third call wraps the already-merged AND
    expect(result.where).toEqual({
      AND: [
        { AND: [{ creator: "GABC" }, { symbol: "TEST" }] },
        { decimals: 18 },
      ],
    });
  });

  it("cursor pagination and limit can be combined", () => {
    const result = new QueryBuilder()
      .after({ id: "cursor-id" })
      .limit(5)
      .build();

    expect(result.cursor).toEqual({ id: "cursor-id" });
    expect(result.take).toBe(5);
    expect(result.skip).toBe(1);
  });

  it("take of 0 is preserved (caller intent)", () => {
    const result = new QueryBuilder().paginate({ take: 0 }).build();
    expect(result.take).toBe(0);
  });

  it("take of exactly MAX_PAGE_SIZE is allowed", () => {
    const result = new QueryBuilder().limit(MAX_PAGE_SIZE).build();
    expect(result.take).toBe(MAX_PAGE_SIZE);
  });
});
