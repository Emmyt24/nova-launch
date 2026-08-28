/**
 * Tests for auditRetentionJob
 *
 * Verifies:
 *  - Archive phase runs before delete phase
 *  - Checkpoint is persisted during and after archival
 *  - Resumability: checkpoint reflects interrupted state
 *  - runAuditArchival returns correct warm/cold counts
 *  - runAuditRetention purges hot-store records
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetAuditLogs = vi.fn();
const mockPurgeAuditLogs = vi.fn();

vi.mock("../config/database", () => ({
  Database: {
    getAuditLogs: (...args: any[]) => mockGetAuditLogs(...args),
    purgeAuditLogs: (...args: any[]) => mockPurgeAuditLogs(...args),
  },
}));

const mockArchiveAuditRecords = vi.fn();
vi.mock("./backup", () => ({
  backupService: {
    archiveAuditRecords: (...args: any[]) => mockArchiveAuditRecords(...args),
  },
}));

const mockCheckpointLoad = vi.fn();
const mockCheckpointSave = vi.fn();
const mockCheckpointClear = vi.fn();

vi.mock("./auditArchiveCheckpoint", () => ({
  AuditArchiveCheckpointStore: vi.fn().mockImplementation(() => ({
    load: mockCheckpointLoad,
    save: mockCheckpointSave,
    clear: mockCheckpointClear,
    getCached: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock("../lib/metrics", () => ({
  MetricsCollector: {
    recordBackgroundJob: vi.fn(),
  },
}));

import {
  runAuditArchival,
  runAuditRetention,
  stopAuditRetentionJob,
} from "./auditRetentionJob";

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeLog = (daysAgo: number) => ({
  id: `audit_${daysAgo}`,
  adminId: "admin_1",
  action: "token.flag",
  resource: "token",
  resourceId: "tok_1",
  beforeState: null,
  afterState: null,
  ipAddress: "127.0.0.1",
  userAgent: "test",
  timestamp: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
});

function makeArchiveResult(archived: number, tier: "warm" | "cold") {
  return { success: true, archived, tier, path: `/test/${tier}/audit.ndjson`, durationMs: 1 };
}

// ── runAuditArchival ──────────────────────────────────────────────────────────

describe("runAuditArchival", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckpointSave.mockResolvedValue(undefined);
    mockCheckpointLoad.mockResolvedValue(null);
  });

  afterEach(() => {
    stopAuditRetentionJob();
  });

  it("archives warm tier then cold tier", async () => {
    mockArchiveAuditRecords
      .mockResolvedValueOnce(makeArchiveResult(5, "warm"))
      .mockResolvedValueOnce(makeArchiveResult(3, "cold"));

    const result = await runAuditArchival();

    expect(mockArchiveAuditRecords).toHaveBeenCalledTimes(2);

    const [, warmTier] = mockArchiveAuditRecords.mock.calls[0];
    const [, coldTier] = mockArchiveAuditRecords.mock.calls[1];
    expect(warmTier).toBe("warm");
    expect(coldTier).toBe("cold");

    expect(result).toEqual({ warm: 5, cold: 3 });
  });

  it("saves checkpoint as in-progress before archiving warm tier", async () => {
    mockArchiveAuditRecords
      .mockResolvedValueOnce(makeArchiveResult(2, "warm"))
      .mockResolvedValueOnce(makeArchiveResult(1, "cold"));

    await runAuditArchival();

    // First save should mark inProgress=true
    const firstSave = mockCheckpointSave.mock.calls[0][0];
    expect(firstSave.inProgress).toBe(true);
    expect(firstSave.tier).toBe("warm");
  });

  it("saves checkpoint after warm completes with tier=cold", async () => {
    mockArchiveAuditRecords
      .mockResolvedValueOnce(makeArchiveResult(4, "warm"))
      .mockResolvedValueOnce(makeArchiveResult(0, "cold"));

    await runAuditArchival();

    const afterWarm = mockCheckpointSave.mock.calls[1][0];
    expect(afterWarm.tier).toBe("cold");
    expect(afterWarm.totalArchived).toBe(4);
    expect(afterWarm.inProgress).toBe(true);
  });

  it("saves checkpoint with inProgress=false and completedAt after both tiers", async () => {
    mockArchiveAuditRecords
      .mockResolvedValueOnce(makeArchiveResult(2, "warm"))
      .mockResolvedValueOnce(makeArchiveResult(3, "cold"));

    await runAuditArchival();

    const finalSave = mockCheckpointSave.mock.calls[2][0];
    expect(finalSave.inProgress).toBe(false);
    expect(finalSave.completedAt).toBeDefined();
    expect(finalSave.totalArchived).toBe(5);
  });

  it("continues and saves checkpoint even when warm archive fails", async () => {
    mockArchiveAuditRecords
      .mockResolvedValueOnce({ success: false, archived: 0, tier: "warm", path: "", durationMs: 1, error: "disk full" })
      .mockResolvedValueOnce(makeArchiveResult(2, "cold"));

    const result = await runAuditArchival();

    // Cold should still run
    expect(result.warm).toBe(0);
    expect(result.cold).toBe(2);
    // Checkpoint should be saved (inProgress=false at the end)
    const finalSave = mockCheckpointSave.mock.calls[2][0];
    expect(finalSave.inProgress).toBe(false);
  });

  it("returns zero counts when no records are eligible", async () => {
    mockArchiveAuditRecords
      .mockResolvedValueOnce(makeArchiveResult(0, "warm"))
      .mockResolvedValueOnce(makeArchiveResult(0, "cold"));

    const result = await runAuditArchival();

    expect(result).toEqual({ warm: 0, cold: 0 });
  });
});

// ── runAuditRetention ─────────────────────────────────────────────────────────

describe("runAuditRetention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckpointSave.mockResolvedValue(undefined);
    mockCheckpointLoad.mockResolvedValue(null);
    mockPurgeAuditLogs.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopAuditRetentionJob();
  });

  it("runs archive phase before purge phase", async () => {
    const callOrder: string[] = [];

    mockArchiveAuditRecords.mockImplementation(async () => {
      callOrder.push("archive");
      return makeArchiveResult(2, "warm");
    });
    mockGetAuditLogs.mockImplementation(async () => {
      callOrder.push("getAuditLogs");
      return [];
    });

    await runAuditRetention(90);

    const archiveIdx = callOrder.indexOf("archive");
    const getIdx = callOrder.indexOf("getAuditLogs");
    expect(archiveIdx).toBeLessThan(getIdx);
  });

  it("purges records older than retentionDays from hot store", async () => {
    mockArchiveAuditRecords.mockResolvedValue(makeArchiveResult(1, "cold"));

    const oldLog = makeLog(100);
    const recentLog = makeLog(10);
    mockGetAuditLogs.mockResolvedValue([oldLog, recentLog]);

    const purged = await runAuditRetention(90);

    expect(purged).toBe(1);
    expect(mockPurgeAuditLogs).toHaveBeenCalledTimes(1);
    const [cutoffArg] = mockPurgeAuditLogs.mock.calls[0];
    expect(cutoffArg).toBeInstanceOf(Date);
    // cutoff should be approximately 90 days ago
    const diffDays = (Date.now() - cutoffArg.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(90, 0);
  });

  it("does not call purge when no records exceed retention", async () => {
    mockArchiveAuditRecords.mockResolvedValue(makeArchiveResult(0, "cold"));
    mockGetAuditLogs.mockResolvedValue([makeLog(10)]);

    const purged = await runAuditRetention(90);

    expect(purged).toBe(0);
    expect(mockPurgeAuditLogs).not.toHaveBeenCalled();
  });

  it("archive phase is called twice (warm + cold) per retention run", async () => {
    mockArchiveAuditRecords.mockResolvedValue(makeArchiveResult(0, "warm"));
    mockGetAuditLogs.mockResolvedValue([]);

    await runAuditRetention(90);

    expect(mockArchiveAuditRecords).toHaveBeenCalledTimes(2);
  });

  it("honors custom retentionDays below 91 so every purged record is archived first", async () => {
    const customRetentionDays = 30; // below 91
    const logs = [
      makeLog(10),  // 10 days old - keep in hot store
      makeLog(45),  // 45 days old - within the (30, 91) gap: must be archived before purge
      makeLog(120), // 120 days old - must be archived before purge
    ];
    mockGetAuditLogs.mockResolvedValue(logs);
    mockArchiveAuditRecords.mockResolvedValue(makeArchiveResult(2, "warm"));

    const purged = await runAuditRetention(customRetentionDays);

    expect(purged).toBe(2);
    expect(mockArchiveAuditRecords).toHaveBeenCalled();

    // Check that warm archival cutoff was derived from customRetentionDays (30 days ago, not hardcoded 91)
    const [warmCutoffArg, tier] = mockArchiveAuditRecords.mock.calls[0];
    expect(tier).toBe("warm");
    expect(warmCutoffArg).toBeInstanceOf(Date);

    const warmCutoffDays =
      (Date.now() - warmCutoffArg.getTime()) / (24 * 60 * 60 * 1000);
    expect(warmCutoffDays).toBeCloseTo(30, 0);

    // Verify all purged records fall within the archival cutoff window
    const [purgeCutoffArg] = mockPurgeAuditLogs.mock.calls[0];
    const purgedRecords = logs.filter((l) => l.timestamp < purgeCutoffArg);
    expect(purgedRecords).toHaveLength(2);
    for (const record of purgedRecords) {
      expect(record.timestamp.getTime()).toBeLessThan(warmCutoffArg.getTime());
    }
  });
});

// ── Checkpoint resumability ───────────────────────────────────────────────────

describe("Checkpoint resumability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckpointSave.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopAuditRetentionJob();
  });

  it("an in-progress checkpoint from a prior run is overwritten by a new run", async () => {
    // Simulate a checkpoint left by an interrupted job.
    mockCheckpointLoad.mockResolvedValueOnce({
      lastArchivedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      tier: "warm",
      totalArchived: 10,
      inProgress: true,
      startedAt: new Date().toISOString(),
    });

    mockArchiveAuditRecords
      .mockResolvedValueOnce(makeArchiveResult(5, "warm"))
      .mockResolvedValueOnce(makeArchiveResult(3, "cold"));

    const result = await runAuditArchival();

    // New run should complete successfully regardless of the stale checkpoint.
    expect(result).toEqual({ warm: 5, cold: 3 });

    // Final checkpoint should be marked complete.
    const finalSave = mockCheckpointSave.mock.calls[
      mockCheckpointSave.mock.calls.length - 1
    ][0];
    expect(finalSave.inProgress).toBe(false);
    expect(finalSave.totalArchived).toBe(8);
  });

  it("checkpoint contains correct totalArchived accumulation", async () => {
    mockCheckpointLoad.mockResolvedValue(null);
    mockArchiveAuditRecords
      .mockResolvedValueOnce(makeArchiveResult(7, "warm"))
      .mockResolvedValueOnce(makeArchiveResult(4, "cold"));

    await runAuditArchival();

    // After warm: totalArchived = 7
    expect(mockCheckpointSave.mock.calls[1][0].totalArchived).toBe(7);
    // After cold: totalArchived = 11
    expect(mockCheckpointSave.mock.calls[2][0].totalArchived).toBe(11);
  });
});
