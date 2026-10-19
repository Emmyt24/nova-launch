/**
 * Relay-style cursor connections for GraphQL list fields (#2206).
 *
 * Implements the subset of the Relay Cursor Connections spec used by the
 * `*Connection` query fields: forward pagination via `first` / `after`,
 * `edges { cursor node }` and `pageInfo { hasNextPage endCursor ... }`.
 *
 * Cursors are opaque base64url strings wrapping the row's primary key. Clients
 * must treat them as opaque — the encoding may change without notice.
 *
 * Paging is keyset-based (Prisma `cursor` + `skip: 1`) rather than offset
 * based, so pages stay stable when new rows are inserted at the head of the
 * list. One extra row is fetched to determine `hasNextPage` without a second
 * COUNT query.
 */

import { GraphQLError } from "graphql";

/** Page size used when `first` is omitted. */
export const DEFAULT_PAGE_SIZE = 20;

/** Hard upper bound on `first`. Requests above it are rejected, not clamped. */
export const MAX_PAGE_SIZE = 100;

const CURSOR_PREFIX = "cursor:";

export interface ConnectionArgs {
  first?: number | null;
  after?: string | null;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface Edge<T> {
  cursor: string;
  node: T;
}

export interface Connection<T> {
  edges: Edge<T>[];
  pageInfo: PageInfo;
  totalCount: number;
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code: "BAD_USER_INPUT" },
  });
}

export function encodeCursor(id: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${id}`, "utf8").toString("base64url");
}

/** Decode an opaque cursor back to a row id, rejecting malformed input. */
export function decodeCursor(cursor: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw badInput("Invalid cursor");
  }
  if (!decoded.startsWith(CURSOR_PREFIX) || decoded.length === CURSOR_PREFIX.length) {
    throw badInput("Invalid cursor");
  }
  return decoded.slice(CURSOR_PREFIX.length);
}

/**
 * Validate connection args and translate them into Prisma `findMany` options.
 * `take` is `first + 1` so the caller can detect a following page.
 */
export function connectionQueryArgs(args: ConnectionArgs): {
  first: number;
  take: number;
  cursor?: { id: string };
  skip?: number;
} {
  const first = args.first ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(first) || first < 1) {
    throw badInput("`first` must be a positive integer");
  }
  if (first > MAX_PAGE_SIZE) {
    throw badInput(`\`first\` must not exceed ${MAX_PAGE_SIZE}`);
  }

  if (args.after == null) return { first, take: first + 1 };

  return {
    first,
    take: first + 1,
    cursor: { id: decodeCursor(args.after) },
    skip: 1,
  };
}

/** Build a connection from rows fetched with `connectionQueryArgs`. */
export function buildConnection<T extends { id: string }>(
  rows: T[],
  first: number,
  hasAfter: boolean,
  totalCount: number
): Connection<T> {
  const hasNextPage = rows.length > first;
  const nodes = hasNextPage ? rows.slice(0, first) : rows;
  const edges = nodes.map((node) => ({ cursor: encodeCursor(node.id), node }));

  return {
    edges,
    pageInfo: {
      hasNextPage,
      // Forward-only pagination: a page requested with `after` is preceded by
      // at least the cursor row itself.
      hasPreviousPage: hasAfter,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
    totalCount,
  };
}
