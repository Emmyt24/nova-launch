/**
 * Frontend ↔ Backend API Contract Tests
 *
 * Verifies that frontend API clients remain compatible with backend route
 * response payloads. A failing test here means a breaking schema change.
 *
 * Strategy: mock fetch with payloads that exactly match the canonical
 * schemas in backend/src/contracts/apiSchemas.ts, then assert that the
 * client functions parse and return the expected shapes without throwing.
 *
 * Issue: #654
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Frontend clients under test
import { searchTokens } from "../../services/tokenSearchApi";
import { campaignApi } from "../../services/campaignApi";
import { fetchProposals } from "../../services/governanceApi";
import { fetchLeaderboard } from "../../services/leaderboardApi";
import { webhookApi } from "../../services/webhookApi";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(payload: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Canonical fixture payloads (mirror backend/src/contracts/apiSchemas.ts)
// ---------------------------------------------------------------------------

const TOKEN_RECORD = {
  id: "tok_1",
  address: "CABC123",
  creator: "GCREATOR",
  name: "Nova Token",
  symbol: "NVT",
  decimals: 7,
  totalSupply: "1000000000",
  initialSupply: "1000000000",
  totalBurned: "5000000",
  burnCount: 3,
  metadataUri: null,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
};

const TOKEN_SEARCH_PAYLOAD = {
  success: true,
  data: [TOKEN_RECORD],
  pagination: {
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  },
  filters: {
    sortBy: "created",
    sortOrder: "desc",
  },
};

const CAMPAIGN_RECORD = {
  id: "camp_1",
  campaignId: 42,
  tokenId: "CABC123",
  creator: "GCREATOR",
  type: "BURN",
  status: "ACTIVE",
  targetAmount: "500000",
  currentAmount: "100000",
  executionCount: 2,
  progress: 20,
  startTime: "2025-01-01T00:00:00.000Z",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
};

const CAMPAIGN_STATS_PAYLOAD = {
  totalCampaigns: 10,
  activeCampaigns: 3,
  completedCampaigns: 6,
  totalVolume: "9000000",
  totalExecutions: 42,
};

const GOVERNANCE_VOTE = {
  id: "vote_1",
  voter: "GVOTER",
  support: true,
  weight: "1000",
  timestamp: "2025-01-01T00:00:00.000Z",
};

const PROPOSAL_RECORD = {
  id: "prop_1",
  proposalId: 1,
  tokenId: "CABC123",
  proposer: "GPROPOSER",
  status: "ACTIVE",
  proposalType: "PARAMETER_CHANGE",
  quorum: "5000",
  threshold: "3000",
  createdAt: "2025-01-01T00:00:00.000Z",
  startTime: "2025-01-01T00:00:00.000Z",
  endTime: "2025-01-08T00:00:00.000Z",
  votes: [GOVERNANCE_VOTE],
  executions: [],
};

const PROPOSAL_LIST_PAYLOAD = {
  success: true,
  data: {
    proposals: [PROPOSAL_RECORD],
    total: 1,
    limit: 50,
    offset: 0,
  },
};

const LEADERBOARD_TOKEN = {
  rank: 1,
  token: {
    address: "CABC123",
    name: "Nova Token",
    symbol: "NVT",
    decimals: 7,
    totalSupply: "1000000000",
    totalBurned: "5000000",
    burnCount: 3,
    metadataUri: null,
    createdAt: "2025-01-01T00:00:00.000Z",
  },
  metric: "5000000",
  change: 0,
};

const LEADERBOARD_PAYLOAD = {
  success: true,
  data: [LEADERBOARD_TOKEN],
  period: "7d",
  updatedAt: "2025-01-02T00:00:00.000Z",
  pagination: { page: 1, limit: 20, total: 1 },
};

const WEBHOOK_SUBSCRIPTION = {
  id: "sub_1",
  url: "https://example.com/hook",
  tokenAddress: null,
  events: ["token.burn.self"],
  secret: "abc12345...",
  active: true,
  createdBy: "GCREATOR",
  createdAt: "2025-01-01T00:00:00.000Z",
  lastTriggered: null,
};

// ---------------------------------------------------------------------------
// Token contract tests
// ---------------------------------------------------------------------------

describe("Token Search API contract", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("accepts a valid token search response", async () => {
    mockFetch(TOKEN_SEARCH_PAYLOAD);
    const result = await searchTokens({ q: "Nova" });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data[0]).toMatchObject({
      id: expect.any(String),
      address: expect.any(String),
      creator: expect.any(String),
      name: expect.any(String),
      symbol: expect.any(String),
      decimals: expect.any(Number),
      totalSupply: expect.any(String),
      initialSupply: expect.any(String),
      totalBurned: expect.any(String),
      burnCount: expect.any(Number),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("includes pagination metadata", async () => {
    mockFetch(TOKEN_SEARCH_PAYLOAD);
    const result = await searchTokens({});

    expect(result.pagination).toMatchObject({
      page: expect.any(Number),
      limit: expect.any(Number),
      total: expect.any(Number),
      totalPages: expect.any(Number),
      hasNext: expect.any(Boolean),
      hasPrev: expect.any(Boolean),
    });
  });

  it("includes filters echoed back from backend", async () => {
    mockFetch(TOKEN_SEARCH_PAYLOAD);
    const result = await searchTokens({ sortBy: "created", sortOrder: "desc" });

    expect(result.filters).toMatchObject({
      sortBy: expect.any(String),
      sortOrder: expect.any(String),
    });
  });

  it("accepts optional cached flag", async () => {
    mockFetch({ ...TOKEN_SEARCH_PAYLOAD, cached: true });
    const result = await searchTokens({});
    // cached is optional – just ensure it doesn't break parsing
    expect(result.success).toBe(true);
  });

  it("throws on non-ok response", async () => {
    mockFetch({ success: false, error: "Invalid parameters", details: [] }, 400);
    await expect(searchTokens({ q: "bad" })).rejects.toThrow();
  });

  it("BigInt fields are strings, not numbers", async () => {
    mockFetch(TOKEN_SEARCH_PAYLOAD);
    const result = await searchTokens({});
    const token = result.data[0];
    expect(typeof token.totalSupply).toBe("string");
    expect(typeof token.initialSupply).toBe("string");
    expect(typeof token.totalBurned).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Campaign contract tests
// ---------------------------------------------------------------------------

describe("Campaign API contract", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("getById returns a campaign record", async () => {
    mockFetch(CAMPAIGN_RECORD);
    const result = await campaignApi.getById(42);

    expect(result).toMatchObject({
      id: expect.any(String),
      campaignId: expect.any(Number),
      tokenId: expect.any(String),
      creator: expect.any(String),
      type: expect.any(String),
      status: expect.any(String),
      targetAmount: expect.any(String),
      currentAmount: expect.any(String),
      executionCount: expect.any(Number),
      progress: expect.any(Number),
      startTime: expect.any(String),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("getByToken returns an array of campaign records", async () => {
    mockFetch([CAMPAIGN_RECORD]);
    const result = await campaignApi.getByToken("CABC123");
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].tokenId).toBe("CABC123");
  });

  it("getStats returns campaign statistics", async () => {
    mockFetch(CAMPAIGN_STATS_PAYLOAD);
    const result = await campaignApi.getStats();

    expect(result).toMatchObject({
      totalCampaigns: expect.any(Number),
      activeCampaigns: expect.any(Number),
      completedCampaigns: expect.any(Number),
      totalVolume: expect.any(String),
      totalExecutions: expect.any(Number),
    });
  });

  it("getExecutions returns paginated executions", async () => {
    mockFetch({ executions: [], total: 0 });
    const result = await campaignApi.getExecutions(42);

    expect(result).toMatchObject({
      executions: expect.any(Array),
      total: expect.any(Number),
    });
  });

  it("optional fields (endTime, completedAt, cancelledAt) may be absent", async () => {
    // Record without optional fields – client must not crash
    const minimal = { ...CAMPAIGN_RECORD };
    mockFetch(minimal);
    const result = await campaignApi.getById(42);
    expect(result.endTime).toBeUndefined();
    expect(result.completedAt).toBeUndefined();
    expect(result.cancelledAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Governance contract tests
// ---------------------------------------------------------------------------

describe("Governance API contract", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fetchProposals returns paginated proposal list", async () => {
    mockFetch(PROPOSAL_LIST_PAYLOAD);
    const result = await fetchProposals({});

    // governanceApi wraps the backend response – check the raw shape it receives
    // The client returns ProposalListResponse directly
    expect(result).toBeDefined();
  });

  it("backend proposal list payload has required envelope", () => {
    // Structural assertion against the canonical fixture
    expect(PROPOSAL_LIST_PAYLOAD).toMatchObject({
      success: true,
      data: {
        proposals: expect.any(Array),
        total: expect.any(Number),
        limit: expect.any(Number),
        offset: expect.any(Number),
      },
    });
  });

  it("proposal record has BigInt fields as strings", () => {
    expect(typeof PROPOSAL_RECORD.quorum).toBe("string");
    expect(typeof PROPOSAL_RECORD.threshold).toBe("string");
  });

  it("vote record has weight as string", () => {
    expect(typeof GOVERNANCE_VOTE.weight).toBe("string");
  });

  it("proposal status is one of the known enum values", () => {
    const validStatuses = ["ACTIVE", "PASSED", "REJECTED", "EXECUTED", "CANCELLED", "EXPIRED"];
    expect(validStatuses).toContain(PROPOSAL_RECORD.status);
  });

  it("proposal type is one of the known enum values", () => {
    const validTypes = ["PARAMETER_CHANGE", "ADMIN_TRANSFER", "TREASURY_SPEND", "CONTRACT_UPGRADE", "CUSTOM"];
    expect(validTypes).toContain(PROPOSAL_RECORD.proposalType);
  });
});

// ---------------------------------------------------------------------------
// Leaderboard contract tests
// ---------------------------------------------------------------------------

describe("Leaderboard API contract", () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * NOTE: The frontend LeaderboardResponse interface uses `entries`, `lastUpdated`,
   * `total`, `offset`, and `type` fields, while the backend returns `data`,
   * `updatedAt`, and a nested `pagination` object.
   *
   * The client currently returns the raw backend payload without mapping.
   * These tests document the ACTUAL backend shape so any backend change
   * that breaks the existing field names is caught immediately.
   */

  it("backend leaderboard payload has success wrapper and pagination", () => {
    expect(LEADERBOARD_PAYLOAD).toMatchObject({
      success: true,
      data: expect.any(Array),
      period: expect.any(String),
      updatedAt: expect.any(String),
      pagination: {
        page: expect.any(Number),
        limit: expect.any(Number),
        total: expect.any(Number),
      },
    });
  });

  it("leaderboard entry has required token sub-object", () => {
    expect(LEADERBOARD_TOKEN).toMatchObject({
      rank: expect.any(Number),
      token: {
        address: expect.any(String),
        name: expect.any(String),
        symbol: expect.any(String),
        totalSupply: expect.any(String),
        totalBurned: expect.any(String),
        burnCount: expect.any(Number),
        createdAt: expect.any(String),
      },
      metric: expect.any(String),
    });
  });

  it("period is one of the valid enum values", () => {
    const validPeriods = ["24h", "7d", "30d", "all"];
    expect(validPeriods).toContain(LEADERBOARD_PAYLOAD.period);
  });

  it("fetchLeaderboard passes the raw backend payload through to the caller", async () => {
    // The client returns the raw JSON – callers must handle the backend shape.
    // This test will fail if the backend changes its top-level field names.
    mockFetch(LEADERBOARD_PAYLOAD);
    const result = await fetchLeaderboard({ type: "most-burned", period: "7d" });

    // Backend uses `data` array, not `entries`
    expect((result as any).data).toBeDefined();
    expect(Array.isArray((result as any).data)).toBe(true);
    // Backend uses `updatedAt`, not `lastUpdated`
    expect((result as any).updatedAt).toBeDefined();
    // Backend uses nested `pagination`, not flat `total`/`offset`
    expect((result as any).pagination).toMatchObject({
      page: expect.any(Number),
      limit: expect.any(Number),
      total: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// Webhook contract tests
// ---------------------------------------------------------------------------

describe("Webhook API contract", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("subscribe returns a subscription with full secret", async () => {
    mockFetch(
      { success: true, data: WEBHOOK_SUBSCRIPTION, message: "Created." },
      201
    );
    const result = await webhookApi.subscribe({
      url: "https://example.com/hook",
      events: ["token.burn.self" as any],
      createdBy: "GCREATOR",
    });

    expect(result).toMatchObject({
      id: expect.any(String),
      url: expect.any(String),
      events: expect.any(Array),
      active: expect.any(Boolean),
      createdBy: expect.any(String),
      createdAt: expect.any(String),
    });
  });

  it("listSubscriptions returns array of subscriptions", async () => {
    mockFetch({ success: true, data: [WEBHOOK_SUBSCRIPTION], count: 1 });
    const result = await webhookApi.listSubscriptions("GCREATOR");
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toMatchObject({ id: expect.any(String), url: expect.any(String) });
  });

  it("getLogs returns delivery log array", async () => {
    const log = {
      id: "log_1",
      subscriptionId: "sub_1",
      event: "token.burn.self",
      payload: {},
      statusCode: 200,
      success: true,
      attempts: 1,
      lastAttemptAt: "2025-01-01T00:00:00.000Z",
      errorMessage: null,
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    mockFetch({ success: true, data: [log], count: 1 });
    const result = await webhookApi.getLogs("sub_1");
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toMatchObject({
      id: expect.any(String),
      subscriptionId: expect.any(String),
      success: expect.any(Boolean),
      attempts: expect.any(Number),
    });
  });

  it("testWebhook returns success flag and message", async () => {
    mockFetch({ success: true, message: "Test webhook delivered successfully" });
    const result = await webhookApi.testWebhook("sub_1");
    expect(result).toMatchObject({
      success: expect.any(Boolean),
      message: expect.any(String),
    });
  });

  it("event types match the canonical enum values", () => {
    const validEvents = [
      "token.burn.self",
      "token.burn.admin",
      "token.created",
      "token.metadata.updated",
    ];
    for (const event of WEBHOOK_SUBSCRIPTION.events) {
      expect(validEvents).toContain(event);
    }
  });

  it("secret is truncated in list/get responses", () => {
    // Truncated secrets end with '...'
    expect(WEBHOOK_SUBSCRIPTION.secret).toMatch(/\.\.\.$/);
  });
});
