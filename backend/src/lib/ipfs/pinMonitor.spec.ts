import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { checkPinStatus, startPinMonitor } from "./pinMonitor";

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

describe("startPinMonitor", () => {
  const apiKey = "test-key";
  const apiSecret = "test-secret";
  const cids = new Set<string>();
  const onUnpinned = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up timers
    vi.clearAllTimers();
  });

  it("uses the provided intervalMs parameter when explicitly passed", () => {
    const stop = startPinMonitor(cids, apiKey, apiSecret, onUnpinned, 5000);

    // Since we can't directly inspect the interval, we verify it doesn't throw
    expect(stop).toBeDefined();
    stop();
  });

  it("uses the default interval when no parameter is provided and env var is unset", () => {
    // Ensure env var is unset
    const originalEnv = process.env.PIN_MONITOR_INTERVAL_MS;
    delete process.env.PIN_MONITOR_INTERVAL_MS;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stop = startPinMonitor(cids, apiKey, apiSecret, onUnpinned);

    // Should not warn when using default
    expect(warnSpy).not.toHaveBeenCalled();
    expect(stop).toBeDefined();

    stop();
    warnSpy.mockRestore();

    // Restore env var
    if (originalEnv !== undefined) {
      process.env.PIN_MONITOR_INTERVAL_MS = originalEnv;
    }
  });

  it("falls back to default interval when PIN_MONITOR_INTERVAL_MS is not numeric", () => {
    const originalEnv = process.env.PIN_MONITOR_INTERVAL_MS;
    process.env.PIN_MONITOR_INTERVAL_MS = "not-a-number";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stop = startPinMonitor(cids, apiKey, apiSecret, onUnpinned);

    // Should warn about invalid interval
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid PIN_MONITOR_INTERVAL_MS")
    );

    expect(stop).toBeDefined();
    stop();

    warnSpy.mockRestore();

    // Restore env var
    if (originalEnv !== undefined) {
      process.env.PIN_MONITOR_INTERVAL_MS = originalEnv;
    } else {
      delete process.env.PIN_MONITOR_INTERVAL_MS;
    }
  });

  it("falls back to default interval when PIN_MONITOR_INTERVAL_MS is NaN", () => {
    const originalEnv = process.env.PIN_MONITOR_INTERVAL_MS;
    process.env.PIN_MONITOR_INTERVAL_MS = "NaN";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stop = startPinMonitor(cids, apiKey, apiSecret, onUnpinned);

    // Should warn about invalid interval
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid PIN_MONITOR_INTERVAL_MS")
    );

    expect(stop).toBeDefined();
    stop();

    warnSpy.mockRestore();

    // Restore env var
    if (originalEnv !== undefined) {
      process.env.PIN_MONITOR_INTERVAL_MS = originalEnv;
    } else {
      delete process.env.PIN_MONITOR_INTERVAL_MS;
    }
  });

  it("falls back to default interval when PIN_MONITOR_INTERVAL_MS is negative", () => {
    const originalEnv = process.env.PIN_MONITOR_INTERVAL_MS;
    process.env.PIN_MONITOR_INTERVAL_MS = "-1000";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stop = startPinMonitor(cids, apiKey, apiSecret, onUnpinned);

    // Should warn about invalid interval
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid PIN_MONITOR_INTERVAL_MS")
    );

    expect(stop).toBeDefined();
    stop();

    warnSpy.mockRestore();

    // Restore env var
    if (originalEnv !== undefined) {
      process.env.PIN_MONITOR_INTERVAL_MS = originalEnv;
    } else {
      delete process.env.PIN_MONITOR_INTERVAL_MS;
    }
  });

  it("falls back to default interval when PIN_MONITOR_INTERVAL_MS is zero", () => {
    const originalEnv = process.env.PIN_MONITOR_INTERVAL_MS;
    process.env.PIN_MONITOR_INTERVAL_MS = "0";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stop = startPinMonitor(cids, apiKey, apiSecret, onUnpinned);

    // Should warn about invalid interval
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid PIN_MONITOR_INTERVAL_MS")
    );

    expect(stop).toBeDefined();
    stop();

    warnSpy.mockRestore();

    // Restore env var
    if (originalEnv !== undefined) {
      process.env.PIN_MONITOR_INTERVAL_MS = originalEnv;
    } else {
      delete process.env.PIN_MONITOR_INTERVAL_MS;
    }
  });

  it("returns a stop function that clears the timer", () => {
    const stop = startPinMonitor(cids, apiKey, apiSecret, onUnpinned, 1000);

    expect(typeof stop).toBe("function");

    // Calling stop should not throw
    expect(() => stop()).not.toThrow();
  });
});
