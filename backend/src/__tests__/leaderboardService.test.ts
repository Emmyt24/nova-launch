import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getMostBurnedLeaderboard,
  getMostActiveLeaderboard,
  getNewestTokensLeaderboard,
  getLargestSupplyLeaderboard,
  getMostBurnersLeaderboard,
  TimePeriod,
  clearCache,
} from "../services/leaderboardService";
import { prisma } from "../lib/prisma";

// Mock Prisma
vi.mock("../lib/prisma", () => ({
  prisma: {
    burnRecord: {
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    token: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

// Force the cold-start (Prisma recompute) path for sorted-set-backed boards.
// readTopFromSortedSet returning null means "cache miss" → the service falls
// back to recomputeMostBurned / recomputeMostActive and then calls warmSortedSet.
vi.mock("../lib/leaderboardSortedSetCache", () => ({
  readTopFromSortedSet: vi.fn().mockResolvedValue(null),
  warmSortedSet: vi.fn().mockResolvedValue(undefined),
  incrementScore: vi.fn().mockResolvedValue(undefined),
  ensureMember: vi.fn().mockResolvedValue(undefined),
  getSortedSetStatus: vi.fn().mockResolvedValue({ reachable: false, warm: false }),
  sortedSetKey: vi.fn((board: string, period: string) => `leaderboard:zset:${board}:${period}`),
}));

describe("Leaderboard Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  describe("getMostBurnedLeaderboard", () => {
    it("should return tokens sorted by burn volume", async () => {
      const mockBurns = [
        { tokenId: "token1", _sum: { amount: BigInt(1000000) } },
        { tokenId: "token2", _sum: { amount: BigInt(500000) } },
      ];

      const mockTokens = [
        {
          id: "token1",
          address: "0x123",
          name: "Token A",
          symbol: "TKA",
          decimals: 18,
          totalSupply: BigInt(1000000000),
          totalBurned: BigInt(1000000),
          burnCount: 10,
          metadataUri: null,
          createdAt: new Date("2024-01-01"),
        },
        {
          id: "token2",
          address: "0x456",
          name: "Token B",
          symbol: "TKB",
          decimals: 18,
          totalSupply: BigInt(2000000000),
          totalBurned: BigInt(500000),
          burnCount: 5,
          metadataUri: null,
          createdAt: new Date("2024-01-02"),
        },
      ];

      vi.mocked(prisma.burnRecord.groupBy).mockResolvedValueOnce(
        mockBurns as any
      );
      vi.mocked(prisma.burnRecord.groupBy).mockResolvedValueOnce(
        mockBurns as any
      );
      vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens as any);

      const result = await getMostBurnedLeaderboard(TimePeriod.D7, 1, 10);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data[0].rank).toBe(1);
      expect(result.data[0].token.address).toBe("0x123");
      expect(result.data[0].metric).toBe("1000000");
      expect(result.period).toBe(TimePeriod.D7);
    });

    it("should use cache on subsequent calls", async () => {
      const mockBurns = [
        { tokenId: "token1", _sum: { amount: BigInt(1000000) } },
      ];

      const mockTokens = [
        {
          id: "token1",
          address: "0x123",
          name: "Token A",
          symbol: "TKA",
          decimals: 18,
          totalSupply: BigInt(1000000000),
          totalBurned: BigInt(1000000),
          burnCount: 10,
          metadataUri: null,
          createdAt: new Date("2024-01-01"),
        },
      ];

      vi.mocked(prisma.burnRecord.groupBy).mockResolvedValue(mockBurns as any);
      vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens as any);

      await getMostBurnedLeaderboard(TimePeriod.D7, 1, 10);
      await getMostBurnedLeaderboard(TimePeriod.D7, 1, 10);

      // Should only call once due to cache
      expect(prisma.burnRecord.groupBy).toHaveBeenCalledTimes(2);
    });

    it("should handle pagination correctly", async () => {
      const mockBurns = [
        { tokenId: "token3", _sum: { amount: BigInt(300000) } },
      ];

      const mockTokens = [
        {
          id: "token3",
          address: "0x789",
          name: "Token C",
          symbol: "TKC",
          decimals: 18,
          totalSupply: BigInt(3000000000),
          totalBurned: BigInt(300000),
          burnCount: 3,
          metadataUri: null,
          createdAt: new Date("2024-01-03"),
        },
      ];

      vi.mocked(prisma.burnRecord.groupBy).mockResolvedValue(mockBurns as any);
      vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens as any);

      const result = await getMostBurnedLeaderboard(TimePeriod.D7, 2, 5);

      expect(result.pagination.page).toBe(2);
      expect(result.pagination.limit).toBe(5);
      expect(result.data[0].rank).toBe(6); // Second page, rank starts at 6
    });
  });

  describe("getMostActiveLeaderboard", () => {
    it("should return tokens sorted by transaction count", async () => {
      const mockBurns = [
        { tokenId: "token1", _count: { id: 50 } },
        { tokenId: "token2", _count: { id: 30 } },
      ];

      const mockTokens = [
        {
          id: "token1",
          address: "0x123",
          name: "Token A",
          symbol: "TKA",
          decimals: 18,
          totalSupply: BigInt(1000000000),
          totalBurned: BigInt(1000000),
          burnCount: 50,
          metadataUri: null,
          createdAt: new Date("2024-01-01"),
        },
        {
          id: "token2",
          address: "0x456",
          name: "Token B",
          symbol: "TKB",
          decimals: 18,
          totalSupply: BigInt(2000000000),
          totalBurned: BigInt(500000),
          burnCount: 30,
          metadataUri: null,
          createdAt: new Date("2024-01-02"),
        },
      ];

      vi.mocked(prisma.burnRecord.groupBy).mockResolvedValue(mockBurns as any);
      vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens as any);

      const result = await getMostActiveLeaderboard(TimePeriod.D7, 1, 10);

      expect(result.success).toBe(true);
      expect(result.data[0].metric).toBe("50");
      expect(result.data[1].metric).toBe("30");
    });
  });

  describe("getNewestTokensLeaderboard", () => {
    it("should return tokens sorted by creation date", async () => {
      const mockTokens = [
        {
          id: "token2",
          address: "0x456",
          name: "Token B",
          symbol: "TKB",
          decimals: 18,
          totalSupply: BigInt(2000000000),
          totalBurned: BigInt(0),
          burnCount: 0,
          metadataUri: null,
          createdAt: new Date("2024-01-02"),
        },
        {
          id: "token1",
          address: "0x123",
          name: "Token A",
          symbol: "TKA",
          decimals: 18,
          totalSupply: BigInt(1000000000),
          totalBurned: BigInt(0),
          burnCount: 0,
          metadataUri: null,
          createdAt: new Date("2024-01-01"),
        },
      ];

      vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens as any);
      vi.mocked(prisma.token.count).mockResolvedValue(2);

      const result = await getNewestTokensLeaderboard(1, 10);

      expect(result.success).toBe(true);
      expect(result.data[0].token.address).toBe("0x456");
      expect(result.data[1].token.address).toBe("0x123");
    });
  });

  describe("getLargestSupplyLeaderboard", () => {
    it("should return tokens sorted by total supply", async () => {
      const mockTokens = [
        {
          id: "token2",
          address: "0x456",
          name: "Token B",
          symbol: "TKB",
          decimals: 18,
          totalSupply: BigInt(2000000000),
          totalBurned: BigInt(0),
          burnCount: 0,
          metadataUri: null,
          createdAt: new Date("2024-01-02"),
        },
        {
          id: "token1",
          address: "0x123",
          name: "Token A",
          symbol: "TKA",
          decimals: 18,
          totalSupply: BigInt(1000000000),
          totalBurned: BigInt(0),
          burnCount: 0,
          metadataUri: null,
          createdAt: new Date("2024-01-01"),
        },
      ];

      vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens as any);
      vi.mocked(prisma.token.count).mockResolvedValue(2);

      const result = await getLargestSupplyLeaderboard(1, 10);

      expect(result.success).toBe(true);
      expect(result.data[0].metric).toBe("2000000000");
      expect(result.data[1].metric).toBe("1000000000");
    });
  });

  describe("getMostBurnersLeaderboard", () => {
    it("should return tokens sorted by unique burners", async () => {
      const mockQueryResult = [
        { tokenId: "token1", uniqueBurners: BigInt(25) },
        { tokenId: "token2", uniqueBurners: BigInt(15) },
      ];

      const mockCountResult = [{ count: BigInt(2) }];

      const mockTokens = [
        {
          id: "token1",
          address: "0x123",
          name: "Token A",
          symbol: "TKA",
          decimals: 18,
          totalSupply: BigInt(1000000000),
          totalBurned: BigInt(1000000),
          burnCount: 50,
          metadataUri: null,
          createdAt: new Date("2024-01-01"),
        },
        {
          id: "token2",
          address: "0x456",
          name: "Token B",
          symbol: "TKB",
          decimals: 18,
          totalSupply: BigInt(2000000000),
          totalBurned: BigInt(500000),
          burnCount: 30,
          metadataUri: null,
          createdAt: new Date("2024-01-02"),
        },
      ];

      vi.mocked(prisma.$queryRaw)
        .mockResolvedValueOnce(mockQueryResult)
        .mockResolvedValueOnce(mockCountResult);
      vi.mocked(prisma.token.findMany).mockResolvedValue(mockTokens as any);

      const result = await getMostBurnersLeaderboard(TimePeriod.D7, 1, 10);

      expect(result.success).toBe(true);
      expect(result.data[0].metric).toBe("25");
      expect(result.data[1].metric).toBe("15");
    });
  });
});

// =============================================================================
// Tie-break tests
//
// The service delegates ordering entirely to Prisma.  When two tokens have the
// same score, the documented tie-break rule is "earliest achiever first" —
// i.e. the token whose first qualifying event happened sooner ranks higher.
// Because the service trusts the order that Prisma returns, our mocks must
// place the earlier-created token before the later-created one in the returned
// array.  These tests assert that the service preserves and surfaces that order
// correctly (correct rank assignment, correct metric values).
// =============================================================================

// ---------------------------------------------------------------------------
// Shared token fixture helpers
// ---------------------------------------------------------------------------

function makeTieBreakTokens() {
  const earlier = {
    id: "tie-token-early",
    address: "0xEEEE",
    name: "Early Token",
    symbol: "EARLY",
    decimals: 18,
    totalSupply: BigInt(1_000_000),
    totalBurned: BigInt(500),
    burnCount: 5,
    metadataUri: null,
    // Earlier timestamp → should rank #1 when scores are equal
    createdAt: new Date("2024-01-01T00:00:00Z"),
  };
  const later = {
    id: "tie-token-late",
    address: "0xLLLL",
    name: "Late Token",
    symbol: "LATE",
    decimals: 18,
    totalSupply: BigInt(1_000_000),
    totalBurned: BigInt(500),
    burnCount: 5,
    metadataUri: null,
    // Later timestamp → should rank #2 when scores are equal
    createdAt: new Date("2024-06-01T00:00:00Z"),
  };
  return { earlier, later };
}

describe("Tie-break ordering — equal score, different timestamp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  describe("getMostBurnedLeaderboard — equal burn volume", () => {
    it("ranks the earlier-created token first when both have the same burn amount", async () => {
      const { earlier, later } = makeTieBreakTokens();
      const TIED_AMOUNT = BigInt(500);

      // Prisma groupBy returns early token first (earliest achiever → top rank)
      const mockBurns = [
        { tokenId: earlier.id, _sum: { amount: TIED_AMOUNT } },
        { tokenId: later.id, _sum: { amount: TIED_AMOUNT } },
      ];

      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce(mockBurns as any) // main page query
        .mockResolvedValueOnce(mockBurns as any); // total count query
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce([earlier, later] as any);

      const result = await getMostBurnedLeaderboard(TimePeriod.ALL, 1, 10);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);

      // Both tokens carry the same metric value
      expect(result.data[0].metric).toBe(TIED_AMOUNT.toString());
      expect(result.data[1].metric).toBe(TIED_AMOUNT.toString());

      // Rank ordering: earlier achiever is #1
      expect(result.data[0].rank).toBe(1);
      expect(result.data[1].rank).toBe(2);
      expect(result.data[0].token.address).toBe(earlier.address);
      expect(result.data[1].token.address).toBe(later.address);
    });

    it("still ranks by score when scores differ (no tie-break needed)", async () => {
      const { earlier, later } = makeTieBreakTokens();

      // later token has a higher burn amount despite being created later
      const mockBurns = [
        { tokenId: later.id, _sum: { amount: BigInt(1000) } },
        { tokenId: earlier.id, _sum: { amount: BigInt(100) } },
      ];

      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce(mockBurns as any)
        .mockResolvedValueOnce(mockBurns as any);
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce([later, earlier] as any);

      const result = await getMostBurnedLeaderboard(TimePeriod.ALL, 1, 10);

      expect(result.data[0].token.address).toBe(later.address);
      expect(result.data[0].metric).toBe("1000");
      expect(result.data[1].token.address).toBe(earlier.address);
      expect(result.data[1].metric).toBe("100");
    });
  });

  describe("getMostActiveLeaderboard — equal burn count", () => {
    it("ranks the earlier-created token first when both have the same burn count", async () => {
      const { earlier, later } = makeTieBreakTokens();
      const TIED_COUNT = 5;

      const mockBurns = [
        { tokenId: earlier.id, _count: { id: TIED_COUNT } },
        { tokenId: later.id, _count: { id: TIED_COUNT } },
      ];

      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce(mockBurns as any)
        .mockResolvedValueOnce(mockBurns as any);
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce([earlier, later] as any);

      const result = await getMostActiveLeaderboard(TimePeriod.ALL, 1, 10);

      expect(result.success).toBe(true);
      expect(result.data[0].metric).toBe(String(TIED_COUNT));
      expect(result.data[1].metric).toBe(String(TIED_COUNT));
      expect(result.data[0].rank).toBe(1);
      expect(result.data[1].rank).toBe(2);
      expect(result.data[0].token.address).toBe(earlier.address);
      expect(result.data[1].token.address).toBe(later.address);
    });
  });

  describe("getNewestTokensLeaderboard — tie on createdAt", () => {
    it("preserves Prisma's returned order when two tokens share an identical createdAt", async () => {
      const sharedTs = new Date("2024-03-15T12:00:00Z");
      const tokenA = { ...makeTieBreakTokens().earlier, createdAt: sharedTs, id: "same-ts-a", address: "0xAAAA" };
      const tokenB = { ...makeTieBreakTokens().later, createdAt: sharedTs, id: "same-ts-b", address: "0xBBBB" };

      // Prisma returns tokenA first (lower id / alphabetical tie-break within Prisma)
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce([tokenA, tokenB] as any);
      vi.mocked(prisma.token.count).mockResolvedValueOnce(2);

      const result = await getNewestTokensLeaderboard(1, 10);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data[0].rank).toBe(1);
      expect(result.data[1].rank).toBe(2);
      expect(result.data[0].token.address).toBe("0xAAAA");
      expect(result.data[1].token.address).toBe("0xBBBB");
    });
  });

  describe("getLargestSupplyLeaderboard — equal totalSupply", () => {
    it("ranks the earlier-created token first when both have the same totalSupply", async () => {
      const TIED_SUPPLY = BigInt(5_000_000);
      const { earlier, later } = makeTieBreakTokens();
      const tokensWithSameSupply = [
        { ...earlier, totalSupply: TIED_SUPPLY },
        { ...later, totalSupply: TIED_SUPPLY },
      ];

      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(tokensWithSameSupply as any);
      vi.mocked(prisma.token.count).mockResolvedValueOnce(2);

      const result = await getLargestSupplyLeaderboard(1, 10);

      expect(result.success).toBe(true);
      expect(result.data[0].metric).toBe(TIED_SUPPLY.toString());
      expect(result.data[1].metric).toBe(TIED_SUPPLY.toString());
      expect(result.data[0].rank).toBe(1);
      expect(result.data[1].rank).toBe(2);
      expect(result.data[0].token.address).toBe(earlier.address);
    });
  });

  describe("getMostBurnersLeaderboard — equal unique burner count", () => {
    it("ranks the earlier-created token first when both have the same unique-burner count", async () => {
      const { earlier, later } = makeTieBreakTokens();
      const TIED_BURNERS = BigInt(10);

      vi.mocked(prisma.$queryRaw)
        .mockResolvedValueOnce([
          { tokenId: earlier.id, uniqueBurners: TIED_BURNERS },
          { tokenId: later.id, uniqueBurners: TIED_BURNERS },
        ] as any)
        .mockResolvedValueOnce([{ count: BigInt(2) }] as any);
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce([earlier, later] as any);

      const result = await getMostBurnersLeaderboard(TimePeriod.ALL, 1, 10);

      expect(result.success).toBe(true);
      expect(result.data[0].metric).toBe(TIED_BURNERS.toString());
      expect(result.data[1].metric).toBe(TIED_BURNERS.toString());
      expect(result.data[0].rank).toBe(1);
      expect(result.data[1].rank).toBe(2);
      expect(result.data[0].token.address).toBe(earlier.address);
    });
  });
});

// =============================================================================
// Empty leaderboard tests
//
// When there are no records in the database (cold deploy, no burns yet, etc.)
// each leaderboard function must return a well-formed response with an empty
// data array and correct zero/false pagination metadata.
// =============================================================================

describe("Empty leaderboard — no records in database", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("getMostBurnedLeaderboard returns empty data array with total=0", async () => {
    vi.mocked(prisma.burnRecord.groupBy)
      .mockResolvedValueOnce([] as any) // page query
      .mockResolvedValueOnce([] as any); // total count query
    vi.mocked(prisma.token.findMany).mockResolvedValueOnce([] as any);

    const result = await getMostBurnedLeaderboard(TimePeriod.D7, 1, 10);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.limit).toBe(10);
  });

  it("getMostActiveLeaderboard returns empty data array with total=0", async () => {
    vi.mocked(prisma.burnRecord.groupBy)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([] as any);
    vi.mocked(prisma.token.findMany).mockResolvedValueOnce([] as any);

    const result = await getMostActiveLeaderboard(TimePeriod.D7, 1, 10);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });

  it("getNewestTokensLeaderboard returns empty data array with total=0", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValueOnce([] as any);
    vi.mocked(prisma.token.count).mockResolvedValueOnce(0);

    const result = await getNewestTokensLeaderboard(1, 10);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
    expect(result.pagination.page).toBe(1);
  });

  it("getLargestSupplyLeaderboard returns empty data array with total=0", async () => {
    vi.mocked(prisma.token.findMany).mockResolvedValueOnce([] as any);
    vi.mocked(prisma.token.count).mockResolvedValueOnce(0);

    const result = await getLargestSupplyLeaderboard(1, 10);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });

  it("getMostBurnersLeaderboard returns empty data array with total=0", async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([{ count: BigInt(0) }] as any);
    vi.mocked(prisma.token.findMany).mockResolvedValueOnce([] as any);

    const result = await getMostBurnersLeaderboard(TimePeriod.D7, 1, 10);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });

  it("getMostBurnedLeaderboard: empty result has correct period and updatedAt", async () => {
    vi.mocked(prisma.burnRecord.groupBy)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([] as any);
    vi.mocked(prisma.token.findMany).mockResolvedValueOnce([] as any);

    const before = new Date();
    const result = await getMostBurnedLeaderboard(TimePeriod.H24, 1, 5);
    const after = new Date();

    expect(result.period).toBe(TimePeriod.H24);
    const updatedAt = new Date(result.updatedAt);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// =============================================================================
// Pagination boundary tests
//
// Edge cases that are easy to get wrong:
//   1. pageSize == exact result count → last page has data, next page is empty
//   2. pageSize = 1                   → exactly one item per page; verify rank
//   3. Requesting page 2 when total == pageSize → empty response (out of range)
//   4. Total == 0, page > 1          → empty and ranks don't start at negative numbers
// =============================================================================

describe("Pagination boundary cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  // -------------------------------------------------------------------------
  // Helper: a small but complete token fixture
  // -------------------------------------------------------------------------
  function makeTokenRow(id: string, address: string, offset: number) {
    return {
      id,
      address,
      name: `Token ${id}`,
      symbol: id.toUpperCase(),
      decimals: 18,
      totalSupply: BigInt(1_000_000),
      totalBurned: BigInt(offset * 100),
      burnCount: offset,
      metadataUri: null,
      createdAt: new Date(Date.now() - offset * 1_000),
    };
  }

  // -------------------------------------------------------------------------
  // 1. pageSize == exact result count
  // -------------------------------------------------------------------------
  describe("pageSize == exact result count (no overflow)", () => {
    it("getMostBurnedLeaderboard: 3 results, limit=3 → single full page, ranks 1-3", async () => {
      const burns = [
        { tokenId: "t1", _sum: { amount: BigInt(300) } },
        { tokenId: "t2", _sum: { amount: BigInt(200) } },
        { tokenId: "t3", _sum: { amount: BigInt(100) } },
      ];
      const tokens = [
        makeTokenRow("t1", "0xT1", 1),
        makeTokenRow("t2", "0xT2", 2),
        makeTokenRow("t3", "0xT3", 3),
      ];

      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce(burns as any)
        .mockResolvedValueOnce(burns as any); // total = 3
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(tokens as any);

      const result = await getMostBurnedLeaderboard(TimePeriod.ALL, 1, 3);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(3);
      expect(result.data[0].rank).toBe(1);
      expect(result.data[2].rank).toBe(3);
      expect(result.pagination.total).toBe(3);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(3);
    });

    it("getMostBurnedLeaderboard: page 2 when total==limit → empty", async () => {
      // Total is 3, limit is 3 → page 2 (skip=3) should have nothing
      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce([] as any) // page 2 has no rows
        .mockResolvedValueOnce([
          { tokenId: "t1", _sum: { amount: BigInt(300) } },
          { tokenId: "t2", _sum: { amount: BigInt(200) } },
          { tokenId: "t3", _sum: { amount: BigInt(100) } },
        ] as any); // total count still 3
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce([] as any);

      const result = await getMostBurnedLeaderboard(TimePeriod.ALL, 2, 3);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(3);
      expect(result.pagination.page).toBe(2);
    });

    it("getNewestTokensLeaderboard: 5 results, limit=5 → single full page, ranks 1-5", async () => {
      const tokens = Array.from({ length: 5 }, (_, i) =>
        makeTokenRow(`t${i}`, `0x${i}`, i)
      );

      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(tokens as any);
      vi.mocked(prisma.token.count).mockResolvedValueOnce(5);

      const result = await getNewestTokensLeaderboard(1, 5);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(5);
      expect(result.data[0].rank).toBe(1);
      expect(result.data[4].rank).toBe(5);
      expect(result.pagination.total).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // 2. pageSize = 1 — one item per page, ranks offset correctly
  // -------------------------------------------------------------------------
  describe("pageSize = 1 (one item per page)", () => {
    it("getMostBurnedLeaderboard: page 1, limit 1 → rank 1", async () => {
      const burns = [{ tokenId: "t1", _sum: { amount: BigInt(500) } }];
      const tokens = [makeTokenRow("t1", "0xT1", 1)];

      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce(burns as any)
        .mockResolvedValueOnce([burns[0], { tokenId: "t2", _sum: { amount: BigInt(100) } }] as any);
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(tokens as any);

      const result = await getMostBurnedLeaderboard(TimePeriod.ALL, 1, 1);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].rank).toBe(1);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(1);
    });

    it("getMostBurnedLeaderboard: page 2, limit 1 → rank 2", async () => {
      const token2Burns = [{ tokenId: "t2", _sum: { amount: BigInt(100) } }];
      const tokens = [makeTokenRow("t2", "0xT2", 2)];

      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce(token2Burns as any)
        .mockResolvedValueOnce([
          { tokenId: "t1", _sum: { amount: BigInt(500) } },
          { tokenId: "t2", _sum: { amount: BigInt(100) } },
        ] as any);
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(tokens as any);

      const result = await getMostBurnedLeaderboard(TimePeriod.ALL, 2, 1);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].rank).toBe(2); // skip = (2-1)*1 = 1 → rank offset = 2
    });

    it("getNewestTokensLeaderboard: page 3, limit 1 → rank 3", async () => {
      const tokens = [makeTokenRow("t3", "0xT3", 3)];

      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(tokens as any);
      vi.mocked(prisma.token.count).mockResolvedValueOnce(5);

      const result = await getNewestTokensLeaderboard(3, 1);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].rank).toBe(3);
    });

    it("getMostActiveLeaderboard: page 1, limit 1 → rank 1", async () => {
      const burns = [{ tokenId: "t1", _count: { id: 42 } }];
      const tokens = [makeTokenRow("t1", "0xT1", 1)];

      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce(burns as any)
        .mockResolvedValueOnce(burns as any);
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(tokens as any);

      const result = await getMostActiveLeaderboard(TimePeriod.ALL, 1, 1);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].rank).toBe(1);
      expect(result.data[0].metric).toBe("42");
    });

    it("getLargestSupplyLeaderboard: page 2, limit 1 → rank 2", async () => {
      const tokens = [makeTokenRow("t2", "0xT2", 2)];

      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(tokens as any);
      vi.mocked(prisma.token.count).mockResolvedValueOnce(4);

      const result = await getLargestSupplyLeaderboard(2, 1);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].rank).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Out-of-range page (page > ceil(total / limit)) → empty, not an error
  // -------------------------------------------------------------------------
  describe("out-of-range page → empty data, not an error", () => {
    it("getMostBurnedLeaderboard: page 99, only 2 total records → empty response", async () => {
      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce([] as any)
        .mockResolvedValueOnce([
          { tokenId: "t1", _sum: { amount: BigInt(100) } },
          { tokenId: "t2", _sum: { amount: BigInt(50) } },
        ] as any);
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce([] as any);

      const result = await getMostBurnedLeaderboard(TimePeriod.ALL, 99, 10);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(2);
      expect(result.pagination.page).toBe(99);
    });

    it("getNewestTokensLeaderboard: page 100, only 1 total record → empty response", async () => {
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce([] as any);
      vi.mocked(prisma.token.count).mockResolvedValueOnce(1);

      const result = await getNewestTokensLeaderboard(100, 10);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(1);
    });

    it("getMostBurnersLeaderboard: page 50, only 3 total unique tokens → empty response", async () => {
      vi.mocked(prisma.$queryRaw)
        .mockResolvedValueOnce([] as any)
        .mockResolvedValueOnce([{ count: BigInt(3) }] as any);
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce([] as any);

      const result = await getMostBurnersLeaderboard(TimePeriod.ALL, 50, 10);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Rank arithmetic — verify that rank = (page - 1) * limit + position + 1
  //    holds for a multi-page dataset
  // -------------------------------------------------------------------------
  describe("rank arithmetic across pages", () => {
    it("getMostBurnedLeaderboard: ranks on page 3 (limit=2) start at 5", async () => {
      const burns = [
        { tokenId: "t5", _sum: { amount: BigInt(50) } },
        { tokenId: "t6", _sum: { amount: BigInt(40) } },
      ];
      const tokens = [
        makeTokenRow("t5", "0xT5", 5),
        makeTokenRow("t6", "0xT6", 6),
      ];

      vi.mocked(prisma.burnRecord.groupBy)
        .mockResolvedValueOnce(burns as any)
        .mockResolvedValueOnce(
          Array.from({ length: 6 }, (_, i) => ({
            tokenId: `t${i + 1}`,
            _sum: { amount: BigInt((6 - i) * 100) },
          })) as any
        );
      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(tokens as any);

      const result = await getMostBurnedLeaderboard(TimePeriod.ALL, 3, 2);

      // skip = (3 - 1) * 2 = 4; first rank = 5
      expect(result.data[0].rank).toBe(5);
      expect(result.data[1].rank).toBe(6);
    });

    it("getNewestTokensLeaderboard: ranks on page 2 (limit=3) start at 4", async () => {
      const tokens = Array.from({ length: 3 }, (_, i) =>
        makeTokenRow(`t${i + 4}`, `0xP2${i}`, i + 4)
      );

      vi.mocked(prisma.token.findMany).mockResolvedValueOnce(tokens as any);
      vi.mocked(prisma.token.count).mockResolvedValueOnce(10);

      const result = await getNewestTokensLeaderboard(2, 3);

      // skip = (2 - 1) * 3 = 3; first rank = 4
      expect(result.data[0].rank).toBe(4);
      expect(result.data[2].rank).toBe(6);
    });
  });
});
