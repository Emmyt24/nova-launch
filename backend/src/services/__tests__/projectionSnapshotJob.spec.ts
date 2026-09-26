import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { loadCursor, parseLedgerFromCursor, captureSnapshots } = vi.hoisted(() => ({
  loadCursor: vi.fn(),
  parseLedgerFromCursor: vi.fn(),
  captureSnapshots: vi.fn(),
}));

vi.mock("../eventCursorStore", () => ({
  EventCursorStore: vi.fn().mockImplementation(() => ({ load: loadCursor })),
  parseLedgerFromCursor,
}));

vi.mock("../projectionSnapshot", () => ({
  captureAllProjectionSnapshots: captureSnapshots,
}));

import { runProjectionSnapshotJob } from "../projectionSnapshotJob";

describe("runProjectionSnapshotJob", () => {
  const prisma = {} as PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();
    loadCursor.mockReset();
    parseLedgerFromCursor.mockReset();
    captureSnapshots.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("captures snapshots at the ledger parsed from the stored cursor", async () => {
    loadCursor.mockResolvedValue("12345-7");
    parseLedgerFromCursor.mockReturnValue(12345);

    await runProjectionSnapshotJob(prisma);

    expect(captureSnapshots).toHaveBeenCalledWith(prisma, 12345, "12345-7");
    expect(console.log).toHaveBeenCalledWith("[ProjectionSnapshotJob] captured snapshot at ledger 12345");
  });

  it("skips capture when there is no persisted cursor", async () => {
    loadCursor.mockResolvedValue(null);

    await runProjectionSnapshotJob(prisma);

    expect(captureSnapshots).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[ProjectionSnapshotJob] no cursor persisted yet — skipping snapshot capture");
  });

  it("skips capture when the stored cursor has no ledger", async () => {
    loadCursor.mockResolvedValue("invalid-cursor");
    parseLedgerFromCursor.mockReturnValue(null);

    await runProjectionSnapshotJob(prisma);

    expect(captureSnapshots).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('[ProjectionSnapshotJob] cursor "invalid-cursor" has no parseable ledger — skipping snapshot capture');
  });

  it("propagates snapshot capture failures", async () => {
    loadCursor.mockResolvedValue("12345-7");
    parseLedgerFromCursor.mockReturnValue(12345);
    captureSnapshots.mockRejectedValue(new Error("snapshot storage unavailable"));

    await expect(runProjectionSnapshotJob(prisma)).rejects.toThrow("snapshot storage unavailable");
  });
});