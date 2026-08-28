import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkPinStatus } from "./pinMonitor";

// ─── Mock fetch ────────────────────────────────────────────────────────────

let mockFetchResponse: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

global.fetch = vi.fn(() => Promise.resolve(mockFetchResponse as Response));

// ─── Tests ────────────────────────────────────────────────────────────────

describe("checkPinStatus", () => {
  const apiKey = "test-key";
  const apiSecret = "test-secret";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns pinned=true when CID has an exact match", async () => {
    const targetCid = "QmExactCidHash1234567890";
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        count: 1,
        rows: [{ ipfs_pin_hash: targetCid }],
      }),
    };

    const result = await checkPinStatus(targetCid, apiKey, apiSecret);

    expect(result.pinned).toBe(true);
    expect(result.cid).toBe(targetCid);
  });

  it("returns pinned=false when CID is a substring but not an exact match", async () => {
    const targetCid = "QmShort";
    const otherCid = "QmShortButLongerHash1234567890";

    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        count: 1,
        rows: [{ ipfs_pin_hash: otherCid }],
      }),
    };

    const result = await checkPinStatus(targetCid, apiKey, apiSecret);

    expect(result.pinned).toBe(false);
    expect(result.cid).toBe(targetCid);
  });

  it("returns pinned=false when no rows are returned", async () => {
    const targetCid = "QmNotPinned";
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        count: 0,
        rows: [],
      }),
    };

    const result = await checkPinStatus(targetCid, apiKey, apiSecret);

    expect(result.pinned).toBe(false);
  });

  it("handles API errors gracefully", async () => {
    const targetCid = "QmSomeCid";
    mockFetchResponse = {
      ok: false,
      status: 401,
      json: async () => ({}),
    };

    const result = await checkPinStatus(targetCid, apiKey, apiSecret);

    expect(result.pinned).toBe(false);
    expect(result.error).toContain("HTTP 401");
  });

  it("finds exact match among multiple returned rows", async () => {
    const targetCid = "QmExactMatch";
    mockFetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        count: 3,
        rows: [
          { ipfs_pin_hash: "QmOtherCid1" },
          { ipfs_pin_hash: targetCid },
          { ipfs_pin_hash: "QmOtherCid2" },
        ],
      }),
    };

    const result = await checkPinStatus(targetCid, apiKey, apiSecret);

    expect(result.pinned).toBe(true);
  });
});
