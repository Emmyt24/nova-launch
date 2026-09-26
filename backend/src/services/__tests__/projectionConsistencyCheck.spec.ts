import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventReplayService } from "../eventReplayService";

vi.mock("../projectionSnapshot", () => ({
  PROJECTION_TYPES: ["CAMPAIGN", "GOVERNANCE", "STREAM", "VAULT"],
  captureAllProjectionData: vi.fn(),
}));

import { captureAllProjectionData } from "../projectionSnapshot";
import { verifyProjectionSnapshotConsistency } from "../projectionConsistencyCheck";

const projectionState = (campaigns: unknown[] = []) => ({
  CAMPAIGN: { campaigns },
  GOVERNANCE: { proposals: [] },
  STREAM: { streams: [] },
  VAULT: { streams: [] },
});

describe("verifyProjectionSnapshotConsistency", () => {
  let replayService: {
    replayFromLedger: ReturnType<typeof vi.fn>;
    clearAndRebuild: ReturnType<typeof vi.fn>;
  };
  const prisma = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();
    replayService = {
      replayFromLedger: vi.fn().mockResolvedValue(undefined),
      clearAndRebuild: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("reports consistency when both replay strategies produce the same state", async () => {
    vi.mocked(captureAllProjectionData)
      .mockResolvedValueOnce(projectionState() as any)
      .mockResolvedValueOnce(projectionState() as any);

    await expect(
      verifyProjectionSnapshotConsistency(replayService as unknown as EventReplayService, prisma, 120),
    ).resolves.toEqual({ consistent: true, targetLedger: 120, mismatchedProjectionTypes: [] });
    expect(replayService.replayFromLedger).toHaveBeenCalledWith(120);
    expect(replayService.clearAndRebuild).toHaveBeenCalledWith({ endLedger: 120 });
    expect(captureAllProjectionData).toHaveBeenCalledTimes(2);
  });

  it("identifies only projection types whose replayed data differs", async () => {
    vi.mocked(captureAllProjectionData)
      .mockResolvedValueOnce(projectionState([{ id: "campaign-1" }]) as any)
      .mockResolvedValueOnce(projectionState() as any);

    const result = await verifyProjectionSnapshotConsistency(
      replayService as unknown as EventReplayService,
      prisma,
      55,
    );

    expect(result.consistent).toBe(false);
    expect(result.mismatchedProjectionTypes).toEqual(["CAMPAIGN"]);
  });

  it("propagates replay failures without attempting the comparison pass", async () => {
    replayService.replayFromLedger.mockRejectedValueOnce(new Error("replay failed"));

    await expect(
      verifyProjectionSnapshotConsistency(replayService as unknown as EventReplayService, prisma, 20),
    ).rejects.toThrow("replay failed");
    expect(captureAllProjectionData).not.toHaveBeenCalled();
    expect(replayService.clearAndRebuild).not.toHaveBeenCalled();
  });
});