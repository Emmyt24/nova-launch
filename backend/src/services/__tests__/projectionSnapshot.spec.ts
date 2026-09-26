import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectionType } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  captureAllProjectionData,
  captureAllProjectionSnapshots,
  findNearestUsableSnapshotLedger,
  PROJECTION_SNAPSHOT_FORMAT_VERSION,
  PROJECTION_TYPES,
  restoreAllProjectionSnapshots,
} from "../projectionSnapshot";

function makePrisma() {
  const makeDelegate = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  });
  const delegates = {
    campaign: makeDelegate(),
    campaignExecution: makeDelegate(),
    campaignAuditTrail: makeDelegate(),
    proposal: makeDelegate(),
    vote: makeDelegate(),
    proposalExecution: makeDelegate(),
    stream: makeDelegate(),
  };
  const projectionSnapshot = {
    upsert: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
  };
  const prisma = {
    ...delegates,
    projectionSnapshot,
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  } as unknown as PrismaClient;
  return { prisma, delegates, projectionSnapshot };
}

describe("projectionSnapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures every projection with stable ordering and JSON-safe values", async () => {
    const { prisma, projectionSnapshot, delegates } = makePrisma();
    delegates.campaign.findMany
      .mockResolvedValueOnce([{ id: "b", currentAmount: 2n, createdAt: new Date("2025-01-02T00:00:00.000Z") }, { id: "a", currentAmount: 1n, createdAt: new Date("2025-01-01T00:00:00.000Z") }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await captureAllProjectionSnapshots(prisma, 500, "500-2");

    expect(PROJECTION_SNAPSHOT_FORMAT_VERSION).toBe(1);
    expect(projectionSnapshot.upsert).toHaveBeenCalledTimes(PROJECTION_TYPES.length);
    expect(projectionSnapshot.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectionType_ledger: { projectionType: ProjectionType.CAMPAIGN, ledger: 500 } },
      create: expect.objectContaining({
        cursor: "500-2",
        formatVersion: 1,
        data: {
          campaigns: [
            { id: "a", currentAmount: "1", createdAt: "2025-01-01T00:00:00.000Z" },
            { id: "b", currentAmount: "2", createdAt: "2025-01-02T00:00:00.000Z" },
          ],
          executions: [],
          auditTrail: [],
        },
      }),
    }));
  });

  it("propagates errors from projection reads", async () => {
    const { prisma, delegates } = makePrisma();
    delegates.campaign.findMany.mockRejectedValue(new Error("database unavailable"));

    await expect(captureAllProjectionSnapshots(prisma, 500, "500-2")).rejects.toThrow("database unavailable");
  });

  it("returns data keyed by every projection type and shares stream data for vault", async () => {
    const { prisma, delegates } = makePrisma();
    delegates.stream.findMany.mockResolvedValue([{ id: "stream-1", amount: 4n }]);

    const data = await captureAllProjectionData(prisma);

    expect(Object.keys(data)).toEqual(PROJECTION_TYPES);
    expect(data[ProjectionType.STREAM]).toEqual(data[ProjectionType.VAULT]);
    expect(data[ProjectionType.STREAM]).toEqual({ streams: [{ id: "stream-1", amount: "4" }] });
  });

  it("propagates data-capture errors", async () => {
    const { prisma, delegates } = makePrisma();
    delegates.stream.findMany.mockRejectedValue(new Error("stream read failed"));

    await expect(captureAllProjectionData(prisma)).rejects.toThrow("stream read failed");
  });

  it("chooses the highest complete snapshot ledger not above the target", async () => {
    const { prisma, projectionSnapshot } = makePrisma();
    projectionSnapshot.findMany.mockResolvedValue([
      ...PROJECTION_TYPES.map((projectionType) => ({ ledger: 90, projectionType })),
      ...PROJECTION_TYPES.map((projectionType) => ({ ledger: 110, projectionType })),
      ...PROJECTION_TYPES.map((projectionType) => ({ ledger: 130, projectionType })),
    ]);

    await expect(findNearestUsableSnapshotLedger(prisma, 115)).resolves.toBe(110);
  });

  it("returns null when no ledger has a complete snapshot set", async () => {
    const { prisma, projectionSnapshot } = makePrisma();
    projectionSnapshot.findMany.mockResolvedValue([
      { ledger: 90, projectionType: ProjectionType.CAMPAIGN },
      { ledger: 90, projectionType: ProjectionType.STREAM },
    ]);

    await expect(findNearestUsableSnapshotLedger(prisma, 115)).resolves.toBeNull();
  });

  it("restores the complete set once, converting serialized scalar values", async () => {
    const { prisma, projectionSnapshot, delegates } = makePrisma();
    projectionSnapshot.findMany.mockResolvedValue([
      {
        projectionType: ProjectionType.CAMPAIGN,
        data: {
          campaigns: [{ id: "campaign-1", targetAmount: "99", currentAmount: "42", createdAt: "2025-01-01T00:00:00.000Z" }],
          executions: [],
          auditTrail: [],
        },
      },
      { projectionType: ProjectionType.GOVERNANCE, data: { proposals: [], votes: [], executions: [] } },
      { projectionType: ProjectionType.STREAM, data: { streams: [{ id: "stream-1", amount: "7" }] } },
      { projectionType: ProjectionType.VAULT, data: { streams: [{ id: "ignored-vault-alias", amount: "8" }] } },
    ]);

    await restoreAllProjectionSnapshots(prisma, 500);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(delegates.campaign.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      targetAmount: 99n,
      currentAmount: 42n,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    }) });
    expect(delegates.stream.create).toHaveBeenCalledWith({ data: { id: "stream-1", amount: 7n } });
    expect(delegates.stream.create).toHaveBeenCalledTimes(1);
  });

  it("rejects an incomplete snapshot set before deleting projection rows", async () => {
    const { prisma, projectionSnapshot, delegates } = makePrisma();
    projectionSnapshot.findMany.mockResolvedValue([
      { projectionType: ProjectionType.CAMPAIGN, data: {} },
    ]);

    await expect(restoreAllProjectionSnapshots(prisma, 500)).rejects.toThrow("Incomplete snapshot set at ledger 500");
    expect(Object.values(delegates).every((delegate) => delegate.deleteMany.mock.calls.length === 0)).toBe(true);
  });
});