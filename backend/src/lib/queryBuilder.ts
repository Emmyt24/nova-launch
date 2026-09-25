/**
 * Type-safe query builder for Prisma models.
 *
 * Provides a fluent, composable API for constructing `findMany` queries with
 * compile-time safety. All filter, sort, and pagination options are validated
 * at the type level so callers cannot pass unknown fields.
 *
 * Design decisions:
 * - Wraps Prisma's `WhereInput` / `OrderByInput` types directly so the builder
 *   stays in sync with schema changes automatically.
 * - Pagination is cursor-based (via `cursor` + `take`) or offset-based
 *   (`skip` + `take`); both are supported but should not be mixed.
 * - The builder is immutable: every method returns a new instance, making it
 *   safe to branch queries from a shared base.
 *
 * Security:
 * - `take` is capped at MAX_PAGE_SIZE to prevent DoS via unbounded result sets.
 * - All inputs are typed; no raw SQL strings are accepted.
 *
 * Limitations:
 * - Aggregations (count, sum, groupBy) are out of scope; use Prisma directly.
 * - Nested relation filters are supported via Prisma's `WhereInput` but are not
 *   given dedicated builder methods to keep the API surface small.
 */

import { Prisma } from "@prisma/client";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard upper bound on page size to prevent unbounded queries. */
export const MAX_PAGE_SIZE = 1000;

/** Default page size when none is specified. */
export const DEFAULT_PAGE_SIZE = 20;

// ─── Generic query options ────────────────────────────────────────────────────

export interface QueryOptions<TWhereInput, TOrderByInput> {
  where?: TWhereInput;
  orderBy?: TOrderByInput | TOrderByInput[];
  skip?: number;
  take?: number;
  cursor?: { id: string };
}

// ─── QueryBuilder ─────────────────────────────────────────────────────────────

/**
 * Immutable, fluent query builder.
 *
 * @template TWhereInput  - Prisma `WhereInput` type for the target model.
 * @template TOrderByInput - Prisma `OrderByWithRelationInput` type.
 *
 * @example
 * ```ts
 * const query = new QueryBuilder<Prisma.TokenWhereInput, Prisma.TokenOrderByWithRelationInput>()
 *   .where({ creator: "GABC..." })
 *   .orderBy({ createdAt: "desc" })
 *   .paginate({ skip: 0, take: 10 })
 *   .build();
 *
 * const tokens = await prisma.token.findMany(query);
 * ```
 */
export class QueryBuilder<
  TWhereInput extends object,
  TOrderByInput extends object,
> {
  private readonly options: QueryOptions<TWhereInput, TOrderByInput>;

  constructor(
    options: QueryOptions<TWhereInput, TOrderByInput> = {}
  ) {
    this.options = options;
  }

  /**
   * Merges additional filter conditions using Prisma's AND semantics.
   * Calling `where` multiple times accumulates conditions.
   */
  where(filter: TWhereInput): QueryBuilder<TWhereInput, TOrderByInput> {
    const existing = this.options.where;
    const merged = existing
      ? ({ AND: [existing, filter] } as unknown as TWhereInput)
      : filter;
    return new QueryBuilder({ ...this.options, where: merged });
  }

  /**
   * Sets the sort order. Replaces any previously set order.
   * Pass an array to sort by multiple fields.
   */
  orderBy(
    order: TOrderByInput | TOrderByInput[]
  ): QueryBuilder<TWhereInput, TOrderByInput> {
    return new QueryBuilder({ ...this.options, orderBy: order });
  }

  /**
   * Sets offset-based pagination.
   * `take` is capped at MAX_PAGE_SIZE.
   *
   * Preserves a cursor-derived skip value (from after()) unless the caller
   * explicitly provides their own skip value.
   */
  paginate(opts: {
    skip?: number;
    take?: number;
  }): QueryBuilder<TWhereInput, TOrderByInput> {
    const take = Math.min(opts.take ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    // Preserve cursor-derived skip unless caller explicitly overrides it
    const skip =
      opts.skip !== undefined
        ? Math.max(opts.skip, 0)
        : Math.max(this.options.skip ?? 0, 0);
    return new QueryBuilder({ ...this.options, skip, take });
  }

  /**
   * Sets cursor-based pagination (keyset pagination).
   * Prefer this over offset pagination for large datasets.
   */
  after(cursor: { id: string }): QueryBuilder<TWhereInput, TOrderByInput> {
    return new QueryBuilder({ ...this.options, cursor, skip: 1 });
  }

  /**
   * Limits the number of results without setting a skip offset.
   * `take` is capped at MAX_PAGE_SIZE.
   */
  limit(take: number): QueryBuilder<TWhereInput, TOrderByInput> {
    return new QueryBuilder({
      ...this.options,
      take: Math.min(take, MAX_PAGE_SIZE),
    });
  }

  /**
   * Returns the final Prisma `findMany` argument object.
   * Applies default page size if no `take` was set.
   */
  build(): QueryOptions<TWhereInput, TOrderByInput> {
    return {
      ...this.options,
      take: Math.min(this.options.take ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    };
  }
}

// ─── Model-specific factory helpers ──────────────────────────────────────────

/**
 * Creates a query builder pre-typed for the `Token` model.
 *
 * @example
 * ```ts
 * const q = tokenQuery()
 *   .where({ creator: address })
 *   .orderBy({ createdAt: "desc" })
 *   .paginate({ skip: 0, take: 20 })
 *   .build();
 * const tokens = await prisma.token.findMany(q);
 * ```
 */
export function tokenQuery(): QueryBuilder<
  Prisma.TokenWhereInput,
  Prisma.TokenOrderByWithRelationInput
> {
  return new QueryBuilder();
}

/**
 * Creates a query builder pre-typed for the `BurnRecord` model.
 */
export function burnRecordQuery(): QueryBuilder<
  Prisma.BurnRecordWhereInput,
  Prisma.BurnRecordOrderByWithRelationInput
> {
  return new QueryBuilder();
}

/**
 * Creates a query builder pre-typed for the `Campaign` model.
 */
export function campaignQuery(): QueryBuilder<
  Prisma.CampaignWhereInput,
  Prisma.CampaignOrderByWithRelationInput
> {
  return new QueryBuilder();
}

/**
 * Creates a query builder pre-typed for the `Proposal` model.
 */
export function proposalQuery(): QueryBuilder<
  Prisma.ProposalWhereInput,
  Prisma.ProposalOrderByWithRelationInput
> {
  return new QueryBuilder();
}
