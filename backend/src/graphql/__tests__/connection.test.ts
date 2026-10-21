/**
 * Tests for Relay cursor connections (#2206): helper behaviour plus the
 * tokensConnection / streamsConnection fields executed through the SDL.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSchema, graphql } from "graphql";
import { typeDefs } from "../schema";
import { resolvers } from "../resolvers";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildConnection,
  connectionQueryArgs,
  decodeCursor,
  encodeCursor,
} from "../connection";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    token: { findMany: vi.fn(), count: vi.fn() },
    stream: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

async function getPrisma() {
  return (await import("../../lib/prisma")).prisma as any;
}

const schema = buildSchema(typeDefs);
const rootValue = { ...resolvers.Query };

const makeToken = (id: string) => ({
  id,
  address: `C${id}`,
  creator: "GCREATOR",
  name: `Token ${id}`,
  symbol: "TST",
  decimals: 7,
  totalSupply: BigInt("1000"),
  initialSupply: BigInt("1000"),
  totalBurned: BigInt("0"),
  burnCount: 0,
  metadataUri: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
});

const makeStream = (id: string, streamId: number) => ({
  id,
  streamId,
  creator: "GCREATOR",
  recipient: "GRECIPIENT",
  amount: BigInt("500"),
  metadata: null,
  status: "CREATED",
  txHash: `tx-${id}`,
  createdAt: new Date("2026-01-01"),
  claimedAt: null,
  cancelledAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cursor encoding", () => {
  it("round-trips ids", () => {
    expect(decodeCursor(encodeCursor("tok-42"))).toBe("tok-42");
  });

  it("produces opaque cursors that do not expose the raw id", () => {
    expect(encodeCursor("tok-42")).not.toContain("tok-42");
  });

  it("rejects cursors that were not issued by the server", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow("Invalid cursor");
    expect(() => decodeCursor(Buffer.from("cursor:").toString("base64url"))).toThrow(
      "Invalid cursor"
    );
  });
});

describe("connectionQueryArgs", () => {
  it("defaults first and fetches one extra row", () => {
    expect(connectionQueryArgs({})).toEqual({
      first: DEFAULT_PAGE_SIZE,
      take: DEFAULT_PAGE_SIZE + 1,
    });
  });

  it("translates after into a keyset cursor", () => {
    expect(connectionQueryArgs({ first: 5, after: encodeCursor("tok-9") })).toEqual({
      first: 5,
      take: 6,
      cursor: { id: "tok-9" },
      skip: 1,
    });
  });

  it("accepts the maximum page size", () => {
    expect(connectionQueryArgs({ first: MAX_PAGE_SIZE }).first).toBe(MAX_PAGE_SIZE);
  });

  it.each([0, -1, 1.5])("rejects first=%s", (first) => {
    expect(() => connectionQueryArgs({ first })).toThrow("positive integer");
  });

  it("rejects first above the maximum page size", () => {
    expect(() => connectionQueryArgs({ first: MAX_PAGE_SIZE + 1 })).toThrow(
      `must not exceed ${MAX_PAGE_SIZE}`
    );
  });
});

describe("buildConnection", () => {
  it("trims the look-ahead row and reports hasNextPage", () => {
    const conn = buildConnection(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      2,
      false,
      10
    );
    expect(conn.edges.map((e) => e.node.id)).toEqual(["a", "b"]);
    expect(conn.pageInfo).toEqual({
      hasNextPage: true,
      hasPreviousPage: false,
      startCursor: encodeCursor("a"),
      endCursor: encodeCursor("b"),
    });
    expect(conn.totalCount).toBe(10);
  });

  it("handles an empty page", () => {
    const conn = buildConnection([], 5, true, 0);
    expect(conn.edges).toEqual([]);
    expect(conn.pageInfo).toEqual({
      hasNextPage: false,
      hasPreviousPage: true,
      startCursor: null,
      endCursor: null,
    });
  });
});

describe("Query.tokensConnection", () => {
  const query = /* GraphQL */ `
    query ($first: Int, $after: String, $creator: String) {
      tokensConnection(first: $first, after: $after, creator: $creator) {
        totalCount
        edges { cursor node { id totalSupply } }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }
  `;

  it("returns the first page with an endCursor", async () => {
    const prisma = await getPrisma();
    prisma.token.findMany.mockResolvedValue([
      makeToken("t1"),
      makeToken("t2"),
      makeToken("t3"),
    ]);
    prisma.token.count.mockResolvedValue(3);

    const res = await graphql({
      schema,
      source: query,
      rootValue,
      variableValues: { first: 2, creator: "GCREATOR" },
    });

    expect(res.errors).toBeUndefined();
    const conn = (res.data as any).tokensConnection;
    expect(conn.totalCount).toBe(3);
    expect(conn.edges).toHaveLength(2);
    expect(conn.edges[0].node.totalSupply).toBe("1000");
    expect(conn.pageInfo.hasNextPage).toBe(true);
    expect(conn.pageInfo.endCursor).toBe(encodeCursor("t2"));
    expect(prisma.token.findMany).toHaveBeenCalledWith({
      where: { creator: "GCREATOR" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
    });
    expect(prisma.token.count).toHaveBeenCalledWith({
      where: { creator: "GCREATOR" },
    });
  });

  it("continues from the after cursor", async () => {
    const prisma = await getPrisma();
    prisma.token.findMany.mockResolvedValue([makeToken("t3")]);
    prisma.token.count.mockResolvedValue(3);

    const res = await graphql({
      schema,
      source: query,
      rootValue,
      variableValues: { first: 2, after: encodeCursor("t2") },
    });

    expect(res.errors).toBeUndefined();
    const conn = (res.data as any).tokensConnection;
    expect(conn.edges.map((e: any) => e.node.id)).toEqual(["t3"]);
    expect(conn.pageInfo.hasNextPage).toBe(false);
    expect(conn.pageInfo.hasPreviousPage).toBe(true);
    expect(prisma.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: "t2" }, skip: 1, take: 3 })
    );
  });

  it("rejects page sizes above the maximum without querying", async () => {
    const prisma = await getPrisma();
    const res = await graphql({
      schema,
      source: query,
      rootValue,
      variableValues: { first: MAX_PAGE_SIZE + 1 },
    });

    expect(res.errors?.[0].message).toContain(`must not exceed ${MAX_PAGE_SIZE}`);
    expect(res.errors?.[0].extensions?.code).toBe("BAD_USER_INPUT");
    expect(prisma.token.findMany).not.toHaveBeenCalled();
  });

  it("rejects malformed cursors", async () => {
    const res = await graphql({
      schema,
      source: query,
      rootValue,
      variableValues: { after: "garbage" },
    });
    expect(res.errors?.[0].message).toBe("Invalid cursor");
  });

  it("sanitizes database errors", async () => {
    const prisma = await getPrisma();
    prisma.token.findMany.mockRejectedValue(new Error('relation "Token" does not exist'));
    prisma.token.count.mockResolvedValue(0);

    const res = await graphql({ schema, source: query, rootValue });
    expect(res.errors?.[0].message).toBe("Internal server error");
  });
});

describe("Query.streamsConnection", () => {
  it("applies filters and paginates", async () => {
    const prisma = await getPrisma();
    prisma.stream.findMany.mockResolvedValue([makeStream("s1", 1)]);
    prisma.stream.count.mockResolvedValue(1);

    const res = await graphql({
      schema,
      source: /* GraphQL */ `
        {
          streamsConnection(recipient: "GRECIPIENT", status: CREATED, first: 10) {
            totalCount
            edges { cursor node { streamId amount status } }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      rootValue,
    });

    expect(res.errors).toBeUndefined();
    const conn = (res.data as any).streamsConnection;
    expect(conn.edges[0].node).toEqual({ streamId: 1, amount: "500", status: "CREATED" });
    expect(conn.pageInfo).toEqual({ hasNextPage: false, endCursor: encodeCursor("s1") });
    expect(prisma.stream.findMany).toHaveBeenCalledWith({
      where: { recipient: "GRECIPIENT", status: "CREATED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 11,
    });
  });
});
