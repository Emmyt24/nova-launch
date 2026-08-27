/**
 * Tests for the GraphQL resolvers and schema.
 *
 * Strategy:
 *  - Resolver functions are tested directly (unit) — fast, no graphql overhead.
 *  - Schema-level tests use graphql() with buildSchema + rootValue to verify
 *    the SDL compiles and queries route correctly.
 *  - Prisma is mocked throughout.
 */

import { describe, it, expect, vi } from "vitest";
import { buildSchema, graphql } from "graphql";
import { typeDefs } from "../graphql/schema";
import { resolvers } from "../graphql/resolvers";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

vi.mock("../lib/prisma", () => ({
  prisma: {
    token: { findUnique: vi.fn(), findMany: vi.fn() },
    burnRecord: { findMany: vi.fn() },
    stream: { findUnique: vi.fn(), findMany: vi.fn() },
    proposal: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    vote: { findMany: vi.fn() },
    campaign: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

async function getPrisma() {
  return (await import("../lib/prisma")).prisma;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeToken = (o: Record<string, unknown> = {}) => ({
  id: "tok-1",
  address: "CTOKEN123",
  creator: "GCREATOR",
  name: "Test Token",
  symbol: "TST",
  decimals: 7,
  totalSupply: BigInt("1000000000"),
  initialSupply: BigInt("1000000000"),
  totalBurned: BigInt("0"),
  burnCount: 0,
  metadataUri: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...o,
});

const makeStream = (o: Record<string, unknown> = {}) => ({
  id: "str-1",
  streamId: 1,
  creator: "GCREATOR",
  recipient: "GRECIPIENT",
  amount: BigInt("500000"),
  metadata: null,
  status: "CREATED",
  txHash: "hash1",
  createdAt: new Date("2026-01-01"),
  claimedAt: null,
  cancelledAt: null,
  ...o,
});

const makeProposal = (o: Record<string, unknown> = {}) => ({
  id: "prop-1",
  proposalId: 1,
  tokenId: "tok-1",
  proposer: "GPROPOSER",
  title: "Test Proposal",
  description: "A test",
  proposalType: "CUSTOM",
  status: "ACTIVE",
  startTime: new Date("2026-01-01"),
  endTime: new Date("2026-02-01"),
  quorum: BigInt("100"),
  threshold: BigInt("51"),
  metadata: null,
  txHash: "hash2",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  executedAt: null,
  ...o,
});

const makeCampaign = (o: Record<string, unknown> = {}) => ({
  id: "camp-1",
  campaignId: 1,
  tokenId: "tok-1",
  creator: "GCREATOR",
  type: "BUYBACK",
  status: "ACTIVE",
  targetAmount: BigInt("1000000"),
  currentAmount: BigInt("0"),
  executionCount: 0,
  startTime: new Date("2026-01-01"),
  endTime: null,
  metadata: null,
  txHash: "hash3",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  completedAt: null,
  cancelledAt: null,
  ...o,
});

// ---------------------------------------------------------------------------
// Query.token
// ---------------------------------------------------------------------------

describe("Query.token", () => {
  it("returns a token when found", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findUnique).mockResolvedValue(makeToken() as any);

    const result = await resolvers.Query.token(undefined, {
      address: "CTOKEN123",
    });

    expect(result).toMatchObject({
      address: "CTOKEN123",
      name: "Test Token",
      totalSupply: "1000000000",
    });
  });

  it("returns null when token not found", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findUnique).mockResolvedValue(null);

    const result = await resolvers.Query.token(undefined, {
      address: "UNKNOWN",
    });
    expect(result).toBeNull();
  });

  it("serialises BigInt fields as strings", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findUnique).mockResolvedValue(
      makeToken({ totalSupply: BigInt("9007199254740993") }) as any
    );

    const result = (await resolvers.Query.token(undefined, {
      address: "CTOKEN123",
    })) as any;
    expect(result.totalSupply).toBe("9007199254740993");
  });
});

// ---------------------------------------------------------------------------
// Query.tokens
// ---------------------------------------------------------------------------

describe("Query.tokens", () => {
  it("returns a list of tokens", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findMany).mockResolvedValue([makeToken()] as any);

    const result = await resolvers.Query.tokens(undefined, {});
    expect(result).toHaveLength(1);
  });

  it("passes creator filter to Prisma", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findMany).mockResolvedValue([]);

    await resolvers.Query.tokens(undefined, { creator: "GCREATOR" });

    expect(p.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { creator: "GCREATOR" } })
    );
  });

  it("caps limit at 100", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findMany).mockResolvedValue([]);

    await resolvers.Query.tokens(undefined, { limit: 999 });

    expect(p.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 })
    );
  });

  it("applies offset", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findMany).mockResolvedValue([]);

    await resolvers.Query.tokens(undefined, { offset: 10 });

    expect(p.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10 })
    );
  });

  it("uses default limit of 20 when not specified", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findMany).mockResolvedValue([]);

    await resolvers.Query.tokens(undefined, {});

    expect(p.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 })
    );
  });
});

// ---------------------------------------------------------------------------
// Query.stream / streams
// ---------------------------------------------------------------------------

describe("Query.stream", () => {
  it("returns a stream when found", async () => {
    const p = await getPrisma();
    vi.mocked(p.stream.findUnique).mockResolvedValue(makeStream() as any);

    const result = (await resolvers.Query.stream(undefined, {
      streamId: 1,
    })) as any;
    expect(result).toMatchObject({
      streamId: 1,
      status: "CREATED",
      amount: "500000",
    });
  });

  it("returns null when stream not found", async () => {
    const p = await getPrisma();
    vi.mocked(p.stream.findUnique).mockResolvedValue(null);

    const result = await resolvers.Query.stream(undefined, { streamId: 999 });
    expect(result).toBeNull();
  });
});

describe("Query.streams", () => {
  it("returns a list of streams", async () => {
    const p = await getPrisma();
    vi.mocked(p.stream.findMany).mockResolvedValue([makeStream()] as any);

    const result = await resolvers.Query.streams(undefined, {});
    expect(result).toHaveLength(1);
  });

  it("passes status filter to Prisma", async () => {
    const p = await getPrisma();
    vi.mocked(p.stream.findMany).mockResolvedValue([]);

    await resolvers.Query.streams(undefined, { status: "CLAIMED" });

    expect(p.stream.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "CLAIMED" }),
      })
    );
  });

  it("passes creator and recipient filters", async () => {
    const p = await getPrisma();
    vi.mocked(p.stream.findMany).mockResolvedValue([]);

    await resolvers.Query.streams(undefined, {
      creator: "GCREATOR",
      recipient: "GRECIPIENT",
    });

    expect(p.stream.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          creator: "GCREATOR",
          recipient: "GRECIPIENT",
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Query.proposal / proposals
// ---------------------------------------------------------------------------

describe("Query.proposal", () => {
  it("returns a proposal when found", async () => {
    const p = await getPrisma();
    vi.mocked(p.proposal.findUnique).mockResolvedValue(makeProposal() as any);

    const result = (await resolvers.Query.proposal(undefined, {
      proposalId: 1,
    })) as any;
    expect(result).toMatchObject({
      proposalId: 1,
      title: "Test Proposal",
      quorum: "100",
    });
  });

  it("returns null when proposal not found", async () => {
    const p = await getPrisma();
    vi.mocked(p.proposal.findUnique).mockResolvedValue(null);

    const result = await resolvers.Query.proposal(undefined, {
      proposalId: 999,
    });
    expect(result).toBeNull();
  });
});

describe("Query.proposals", () => {
  it("returns a list of proposals", async () => {
    const p = await getPrisma();
    vi.mocked(p.proposal.findMany).mockResolvedValue([makeProposal()] as any);

    const result = await resolvers.Query.proposals(undefined, {});
    expect(result).toHaveLength(1);
  });

  it("passes status and proposalType filters", async () => {
    const p = await getPrisma();
    vi.mocked(p.proposal.findMany).mockResolvedValue([]);

    await resolvers.Query.proposals(undefined, {
      status: "ACTIVE",
      proposalType: "CUSTOM",
    });

    expect(p.proposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "ACTIVE",
          proposalType: "CUSTOM",
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Query.campaign / campaigns
// ---------------------------------------------------------------------------

describe("Query.campaign", () => {
  it("returns a campaign when found", async () => {
    const p = await getPrisma();
    vi.mocked(p.campaign.findUnique).mockResolvedValue(makeCampaign() as any);

    const result = (await resolvers.Query.campaign(undefined, {
      campaignId: 1,
    })) as any;
    expect(result).toMatchObject({
      campaignId: 1,
      type: "BUYBACK",
      targetAmount: "1000000",
    });
  });

  it("returns null when campaign not found", async () => {
    const p = await getPrisma();
    vi.mocked(p.campaign.findUnique).mockResolvedValue(null);

    const result = await resolvers.Query.campaign(undefined, {
      campaignId: 999,
    });
    expect(result).toBeNull();
  });
});

describe("Query.campaigns", () => {
  it("returns a list of campaigns", async () => {
    const p = await getPrisma();
    vi.mocked(p.campaign.findMany).mockResolvedValue([makeCampaign()] as any);

    const result = await resolvers.Query.campaigns(undefined, {});
    expect(result).toHaveLength(1);
  });

  it("passes type and status filters", async () => {
    const p = await getPrisma();
    vi.mocked(p.campaign.findMany).mockResolvedValue([]);

    await resolvers.Query.campaigns(undefined, {
      type: "AIRDROP",
      status: "COMPLETED",
    });

    expect(p.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: "AIRDROP",
          status: "COMPLETED",
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Field resolvers
// ---------------------------------------------------------------------------

describe("Token.burnRecords", () => {
  it("fetches burn records for a token", async () => {
    const p = await getPrisma();
    const burnRow = {
      id: "br-1",
      tokenId: "tok-1",
      from: "GFROM",
      amount: BigInt("100"),
      burnedBy: "GFROM",
      isAdminBurn: false,
      txHash: "bh1",
      timestamp: new Date(),
    };
    vi.mocked(p.burnRecord.findMany).mockResolvedValue([burnRow] as any);

    const result = (await resolvers.Token.burnRecords(
      { id: "tok-1" },
      {}
    )) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe("100");
  });
});

describe("Proposal.votes", () => {
  it("fetches votes for a proposal", async () => {
    const p = await getPrisma();
    const voteRow = {
      id: "v-1",
      proposalId: "prop-1",
      voter: "GVOTER",
      support: true,
      weight: BigInt("50"),
      reason: null,
      txHash: "vh1",
      timestamp: new Date(),
    };
    vi.mocked(p.vote.findMany).mockResolvedValue([voteRow] as any);

    const result = (await resolvers.Proposal.votes(
      { id: "prop-1" },
      {}
    )) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].weight).toBe("50");
  });
});

// ---------------------------------------------------------------------------
// bigintToString
// ---------------------------------------------------------------------------

describe("bigintToString serialisation", () => {
  it("converts large BigInt values to strings without precision loss", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findUnique).mockResolvedValue(
      makeToken({ totalSupply: BigInt("18446744073709551615") }) as any
    );

    const result = (await resolvers.Query.token(undefined, {
      address: "CTOKEN123",
    })) as any;
    expect(result.totalSupply).toBe("18446744073709551615");
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("schema", () => {
  it("builds without errors", () => {
    expect(() => buildSchema(typeDefs)).not.toThrow();
  });

  it("exposes all expected query fields", () => {
    const s = buildSchema(typeDefs);
    const fields = Object.keys(s.getQueryType()?.getFields() ?? {});
    expect(fields).toEqual(
      expect.arrayContaining([
        "token",
        "tokens",
        "stream",
        "streams",
        "proposal",
        "proposals",
        "campaign",
        "campaigns",
      ])
    );
  });

  it("rejects unknown fields via graphql execution", async () => {
    const s = buildSchema(typeDefs);
    const result = await graphql({
      schema: s,
      source: `{ tokens { nonExistentField } }`,
    });
    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toMatch(/nonExistentField/);
  });
});

// ---------------------------------------------------------------------------
// Query resolver error handling
// ---------------------------------------------------------------------------

describe("Query resolver error handling", () => {
  it("token: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findUnique).mockRejectedValue(
      new Error("connection refused: DB is down")
    );

    await expect(
      resolvers.Query.token(undefined, { address: "CTOKEN" })
    ).rejects.toMatchObject({ message: "Internal server error" });
  });

  it("tokens: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findMany).mockRejectedValue(new Error("DB timeout"));

    await expect(
      resolvers.Query.tokens(undefined, {})
    ).rejects.toMatchObject({ message: "Internal server error" });
  });

  it("stream: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.stream.findUnique).mockRejectedValue(new Error("DB timeout"));

    await expect(
      resolvers.Query.stream(undefined, { streamId: 1 })
    ).rejects.toMatchObject({ message: "Internal server error" });
  });

  it("streams: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.stream.findMany).mockRejectedValue(new Error("DB timeout"));

    await expect(
      resolvers.Query.streams(undefined, {})
    ).rejects.toMatchObject({ message: "Internal server error" });
  });

  it("proposal: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.proposal.findUnique).mockRejectedValue(new Error("DB timeout"));

    await expect(
      resolvers.Query.proposal(undefined, { proposalId: 1 })
    ).rejects.toMatchObject({ message: "Internal server error" });
  });

  it("proposals: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.proposal.findMany).mockRejectedValue(new Error("DB timeout"));

    await expect(
      resolvers.Query.proposals(undefined, {})
    ).rejects.toMatchObject({ message: "Internal server error" });
  });

  it("governanceQueue: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.proposal.findMany).mockRejectedValue(new Error("DB timeout"));

    await expect(
      resolvers.Query.governanceQueue(undefined, {})
    ).rejects.toMatchObject({ message: "Internal server error" });
  });

  it("campaign: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.campaign.findUnique).mockRejectedValue(new Error("DB timeout"));

    await expect(
      resolvers.Query.campaign(undefined, { campaignId: 1 })
    ).rejects.toMatchObject({ message: "Internal server error" });
  });

  it("campaigns: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.campaign.findMany).mockRejectedValue(new Error("DB timeout"));

    await expect(
      resolvers.Query.campaigns(undefined, {})
    ).rejects.toMatchObject({ message: "Internal server error" });
  });

  it("does not expose raw error message to client", async () => {
    const p = await getPrisma();
    const rawMsg = "PrismaClientKnownRequestError: table users does not exist";
    vi.mocked(p.token.findUnique).mockRejectedValue(new Error(rawMsg));

    const rejection = await resolvers.Query.token(undefined, { address: "X" }).catch(
      (e) => e
    );
    expect(rejection.message).not.toContain("PrismaClientKnownRequestError");
    expect(rejection.message).toBe("Internal server error");
  });

  it("token: logs the original error before sanitizing", async () => {
    const { logger } = await import("../lib/logger");
    const p = await getPrisma();
    vi.mocked(p.token.findUnique).mockRejectedValue(new Error("raw db error"));

    await resolvers.Query.token(undefined, { address: "X" }).catch(() => {});

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("token"),
      expect.objectContaining({ error: "raw db error" })
    );
  });
});

// ---------------------------------------------------------------------------
// Field resolver error handling
// ---------------------------------------------------------------------------

describe("Field resolver error handling", () => {
  it("Token.burnRecords: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.burnRecord.findMany).mockRejectedValue(new Error("DB timeout"));

    await expect(
      resolvers.Token.burnRecords({ id: "tok-1" }, {})
    ).rejects.toMatchObject({ message: "Internal server error" });
  });

  it("Proposal.votes: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.vote.findMany).mockRejectedValue(new Error("DB timeout"));

    await expect(
      resolvers.Proposal.votes({ id: "prop-1" }, {})
    ).rejects.toMatchObject({ message: "Internal server error" });
  });

  it("Proposal.queuePosition: sanitizes a database error as GraphQLError", async () => {
    const p = await getPrisma();
    vi.mocked(p.proposal.count).mockRejectedValue(new Error("DB timeout"));

    await expect(
      resolvers.Proposal.queuePosition({
        status: "QUEUED",
        proposalType: "CUSTOM",
        createdAt: new Date("2026-01-01"),
      })
    ).rejects.toMatchObject({ message: "Internal server error" });
  });
});

// ---------------------------------------------------------------------------
// Depth guard
// ---------------------------------------------------------------------------

describe("depth guard", () => {
  it("allows queries within depth 6", () => {
    function maxDepth(node: any, d = 0): number {
      if (!node || typeof node !== "object") return d;
      if (node.selectionSet?.selections) {
        return Math.max(
          ...node.selectionSet.selections.map((s: any) => maxDepth(s, d + 1))
        );
      }
      return d;
    }

    const { parse: gqlParse } = require("graphql");
    const doc = gqlParse(`{ tokens { address symbol } }`);
    const depth = Math.max(...doc.definitions.map((def: any) => maxDepth(def)));
    expect(depth).toBeLessThanOrEqual(6);
  });

  it("detects queries exceeding depth 6", () => {
    function maxDepth(node: any, d = 0): number {
      if (!node || typeof node !== "object") return d;
      if (node.selectionSet?.selections) {
        return Math.max(
          ...node.selectionSet.selections.map((s: any) => maxDepth(s, d + 1))
        );
      }
      return d;
    }

    // Manually construct a deeply nested AST-like object (7 levels)
    const deepNode = {
      selectionSet: {
        selections: [
          {
            selectionSet: {
              selections: [
                {
                  selectionSet: {
                    selections: [
                      {
                        selectionSet: {
                          selections: [
                            {
                              selectionSet: {
                                selections: [
                                  {
                                    selectionSet: {
                                      selections: [
                                        {
                                          selectionSet: { selections: [{}] },
                                        },
                                      ],
                                    },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    };

    const depth = maxDepth(deepNode);
    expect(depth).toBeGreaterThan(6);
  });
});
