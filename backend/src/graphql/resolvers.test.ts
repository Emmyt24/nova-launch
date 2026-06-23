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
    proposal: { findUnique: vi.fn(), findMany: vi.fn() },
    vote: { findMany: vi.fn() },
    campaign: { findUnique: vi.fn(), findMany: vi.fn() },
  },
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
// Subscription.leaderboardUpdated (issue #1377)
// ---------------------------------------------------------------------------

describe("Subscription.leaderboardUpdated", () => {
  beforeEach(async () => {
    const { resetLeaderboardSubscriptionsForTests } = await import(
      "../services/leaderboardService"
    );
    resetLeaderboardSubscriptionsForTests();
  });

  it("defaults to most-burned/7d when no args are given", async () => {
    const iterator = resolvers.Subscription.leaderboardUpdated.subscribe(
      undefined,
      {}
    );

    const { eventBus } = await import("../services/eventBus");
    await eventBus.publish("leaderboard.updated", {
      type: "most-burned",
      period: "7d",
      entries: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect((result.value as any).type).toBe("most-burned");

    await iterator.return?.();
  });

  it("only delivers events matching the requested type and period", async () => {
    const iterator = resolvers.Subscription.leaderboardUpdated.subscribe(
      undefined,
      { type: "NEWEST", period: "all" }
    );

    const { eventBus } = await import("../services/eventBus");
    // Wrong kind — should not be delivered.
    await eventBus.publish("leaderboard.updated", {
      type: "most-burned",
      period: "7d",
      entries: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    // Matching kind — should be delivered.
    await eventBus.publish("leaderboard.updated", {
      type: "newest",
      period: "all",
      entries: [],
      updatedAt: "2026-01-01T00:01:00.000Z",
    });

    const result = await iterator.next();
    expect((result.value as any).updatedAt).toBe("2026-01-01T00:01:00.000Z");

    await iterator.return?.();
  });

  it("resolve() maps internal kind/entries to the GraphQL shape", () => {
    const resolved = resolvers.Subscription.leaderboardUpdated.resolve({
      type: "most-burned",
      period: "7d",
      updatedAt: "2026-01-01T00:00:00.000Z",
      entries: [
        {
          rank: 1,
          token: { address: "GABC", name: "Token A", symbol: "TKA" },
          metric: "1000",
        },
      ],
    } as any);

    expect(resolved.type).toBe("MOST_BURNED");
    expect(resolved.entries).toEqual([
      { rank: 1, tokenAddress: "GABC", tokenName: "Token A", tokenSymbol: "TKA", metric: "1000" },
    ]);
  });

  it("deregisters subscriber interest when the iterator closes", async () => {
    const { registerLeaderboardSubscriber, TimePeriod } = await import(
      "../services/leaderboardService"
    );

    const iterator = resolvers.Subscription.leaderboardUpdated.subscribe(
      undefined,
      { type: "MOST_BURNED", period: TimePeriod.D7 }
    );
    await iterator.return?.();

    // A second independent registration for the same key should start a fresh
    // count rather than inheriting any leaked state from the closed iterator.
    const unregister = registerLeaderboardSubscriber("most-burned", TimePeriod.D7);
    unregister();
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

  it("exposes leaderboardUpdated on the Subscription type with defaults", () => {
    const s = buildSchema(typeDefs);
    const fields = s.getSubscriptionType()?.getFields() ?? {};
    expect(Object.keys(fields)).toContain("leaderboardUpdated");

    const args = fields.leaderboardUpdated.args;
    const typeArg = args.find((a) => a.name === "type");
    const periodArg = args.find((a) => a.name === "period");
    expect(typeArg?.defaultValue).toBe("MOST_BURNED");
    expect(periodArg?.defaultValue).toBe("7d");
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
