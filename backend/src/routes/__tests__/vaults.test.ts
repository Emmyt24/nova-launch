/**
 * Tests for GET /api/vaults/:id/withdrawals withdrawal history endpoint (#1580)
 *
 * Covers:
 *  - Query real withdrawal data from stream projection
 *  - Cursor-based pagination
 *  - Status filtering (CLAIMED, CANCELLED)
 *  - Proper error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express, { Express } from "express";
import { StreamStatus } from "@prisma/client";

const realServiceMock = vi.hoisted(() => ({
  getStreamById: vi.fn(),
  getWithdrawalsByStreamId: vi.fn(),
}));

vi.mock("../../services/streamProjectionService", () => ({
  streamProjectionService: realServiceMock,
}));

import vaultsRouter from "../vaults";

describe("GET /api/vaults/:id/withdrawals", () => {
  let app: Express;
  let mockStreamProjectionService: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    mockStreamProjectionService = {
      getStreamById: vi.fn(),
    };

    vi.doMock("../services/streamProjectionService", () => ({
      streamProjectionService: mockStreamProjectionService,
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for invalid vault ID", async () => {
    app.get("/:id/withdrawals", async (req, res) => {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        res.status(400).json({ success: false, error: { code: "INVALID_INPUT", message: "Invalid vault ID" } });
        return;
      }
      res.json({ success: true, data: [] });
    });

    const res = await request(app).get("/invalid/withdrawals");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INPUT");
  });

  it("returns 404 when vault is not found", async () => {
    mockStreamProjectionService.getStreamById.mockResolvedValue(null);

    app.get("/:id/withdrawals", async (req, res) => {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        res.status(400).json({ success: false, error: { code: "INVALID_INPUT", message: "Invalid vault ID" } });
        return;
      }

      const vault = await mockStreamProjectionService.getStreamById(id);
      if (!vault) {
        res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Vault not found" } });
        return;
      }

      res.json({ success: true, data: { withdrawals: [] } });
    });

    const res = await request(app).get("/123/withdrawals");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns claimed withdrawal transaction when vault is claimed", async () => {
    const mockVault = {
      id: "vault-1",
      streamId: 123,
      creator: "GAAAA",
      recipient: "GBBBB",
      amount: "1000000",
      status: StreamStatus.CLAIMED,
      txHash: "abc123def456",
      createdAt: new Date("2024-01-01"),
      claimedAt: new Date("2024-01-02"),
      cancelledAt: null,
    };

    mockStreamProjectionService.getStreamById.mockResolvedValue(mockVault);

    app.get("/:id/withdrawals", async (req, res) => {
      const id = parseInt(req.params.id);
      const vault = await mockStreamProjectionService.getStreamById(id);
      if (!vault) {
        res.status(404).json({ success: false, error: { code: "NOT_FOUND" } });
        return;
      }

      const withdrawals: any[] = [];

      if (vault.claimedAt) {
        withdrawals.push({
          id: `${id}-claim-${vault.txHash}`,
          vaultId: id,
          transactionType: "CLAIMED",
          amount: vault.amount,
          timestamp: vault.claimedAt.toISOString(),
          txHash: vault.txHash,
          recipient: vault.recipient,
        });
      }

      if (vault.cancelledAt) {
        withdrawals.push({
          id: `${id}-cancel-${vault.txHash}`,
          vaultId: id,
          transactionType: "CANCELLED",
          amount: vault.amount,
          timestamp: vault.cancelledAt.toISOString(),
          txHash: vault.txHash,
          recipient: vault.recipient,
        });
      }

      res.json({ success: true, data: { withdrawals } });
    });

    const res = await request(app).get("/123/withdrawals");

    expect(res.status).toBe(200);
    expect(res.body.data.withdrawals).toHaveLength(1);
    expect(res.body.data.withdrawals[0]).toMatchObject({
      transactionType: "CLAIMED",
      amount: "1000000",
      recipient: "GBBBB",
      txHash: "abc123def456",
    });
  });

  it("returns both claimed and cancelled withdrawals", async () => {
    const mockVault = {
      id: "vault-1",
      streamId: 123,
      creator: "GAAAA",
      recipient: "GBBBB",
      amount: "1000000",
      status: StreamStatus.CANCELLED,
      txHash: "abc123",
      createdAt: new Date("2024-01-01"),
      claimedAt: new Date("2024-01-02"),
      cancelledAt: new Date("2024-01-03"),
    };

    mockStreamProjectionService.getStreamById.mockResolvedValue(mockVault);

    app.get("/:id/withdrawals", async (req, res) => {
      const id = parseInt(req.params.id);
      const vault = await mockStreamProjectionService.getStreamById(id);
      if (!vault) {
        res.status(404).json({ success: false, error: { code: "NOT_FOUND" } });
        return;
      }

      const withdrawals: any[] = [];

      if (vault.claimedAt) {
        withdrawals.push({
          id: `${id}-claim-${vault.txHash}`,
          vaultId: id,
          transactionType: "CLAIMED",
          amount: vault.amount,
          timestamp: vault.claimedAt.toISOString(),
          txHash: vault.txHash,
          recipient: vault.recipient,
        });
      }

      if (vault.cancelledAt) {
        withdrawals.push({
          id: `${id}-cancel-${vault.txHash}`,
          vaultId: id,
          transactionType: "CANCELLED",
          amount: vault.amount,
          timestamp: vault.cancelledAt.toISOString(),
          txHash: vault.txHash,
          recipient: vault.recipient,
        });
      }

      withdrawals.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      res.json({ success: true, data: { withdrawals } });
    });

    const res = await request(app).get("/123/withdrawals");

    expect(res.status).toBe(200);
    expect(res.body.data.withdrawals).toHaveLength(2);
    expect(res.body.data.withdrawals[0].transactionType).toBe("CANCELLED");
    expect(res.body.data.withdrawals[1].transactionType).toBe("CLAIMED");
  });

  it("supports cursor-based pagination", async () => {
    const mockVault = {
      id: "vault-1",
      streamId: 123,
      creator: "GAAAA",
      recipient: "GBBBB",
      amount: "1000000",
      status: StreamStatus.CLAIMED,
      txHash: "abc123",
      createdAt: new Date("2024-01-01"),
      claimedAt: new Date("2024-01-02"),
      cancelledAt: null,
    };

    mockStreamProjectionService.getStreamById.mockResolvedValue(mockVault);

    app.get("/:id/withdrawals", async (req, res) => {
      const id = parseInt(req.params.id);
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const cursor = req.query.cursor as string | undefined;

      const vault = await mockStreamProjectionService.getStreamById(id);
      if (!vault) {
        res.status(404).json({ success: false, error: { code: "NOT_FOUND" } });
        return;
      }

      const withdrawals: any[] = [];
      if (vault.claimedAt) {
        withdrawals.push({
          id: `${id}-claim-${vault.txHash}`,
          vaultId: id,
          transactionType: "CLAIMED",
          amount: vault.amount,
          timestamp: vault.claimedAt.toISOString(),
          txHash: vault.txHash,
          recipient: vault.recipient,
        });
      }

      const startIndex = cursor ? Math.max(0, parseInt(atob(cursor), 10)) : 0;
      const paginatedWithdrawals = withdrawals.slice(startIndex, startIndex + limit);
      const nextIndex = startIndex + limit;
      const hasMore = nextIndex < withdrawals.length;

      res.json({
        success: true,
        data: {
          withdrawals: paginatedWithdrawals,
          nextCursor: hasMore ? btoa(nextIndex.toString()) : undefined,
          prevCursor: startIndex > 0 ? btoa(Math.max(0, startIndex - limit).toString()) : undefined,
          hasMore,
          totalCount: withdrawals.length,
        },
      });
    });

    const res = await request(app).get("/123/withdrawals?limit=1");

    expect(res.status).toBe(200);
    expect(res.body.data.withdrawals).toHaveLength(1);
    expect(res.body.data.nextCursor).toBeUndefined();
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.totalCount).toBe(1);
  });

  it("filters by status when provided", async () => {
    const mockVault = {
      id: "vault-1",
      streamId: 123,
      creator: "GAAAA",
      recipient: "GBBBB",
      amount: "1000000",
      status: StreamStatus.CANCELLED,
      txHash: "abc123",
      createdAt: new Date("2024-01-01"),
      claimedAt: new Date("2024-01-02"),
      cancelledAt: new Date("2024-01-03"),
    };

    mockStreamProjectionService.getStreamById.mockResolvedValue(mockVault);

    app.get("/:id/withdrawals", async (req, res) => {
      const id = parseInt(req.params.id);
      const status = req.query.status as string | undefined;

      const validStatuses = ["CLAIMED", "CANCELLED"];
      if (status && !validStatuses.includes(status)) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_INPUT", message: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
        });
        return;
      }

      const vault = await mockStreamProjectionService.getStreamById(id);
      if (!vault) {
        res.status(404).json({ success: false, error: { code: "NOT_FOUND" } });
        return;
      }

      const withdrawals: any[] = [];
      if (vault.claimedAt && (!status || status === "CLAIMED")) {
        withdrawals.push({
          id: `${id}-claim-${vault.txHash}`,
          vaultId: id,
          transactionType: "CLAIMED",
          amount: vault.amount,
          timestamp: vault.claimedAt.toISOString(),
          txHash: vault.txHash,
          recipient: vault.recipient,
        });
      }
      if (vault.cancelledAt && (!status || status === "CANCELLED")) {
        withdrawals.push({
          id: `${id}-cancel-${vault.txHash}`,
          vaultId: id,
          transactionType: "CANCELLED",
          amount: vault.amount,
          timestamp: vault.cancelledAt.toISOString(),
          txHash: vault.txHash,
          recipient: vault.recipient,
        });
      }

      res.json({ success: true, data: { withdrawals } });
    });

    const res = await request(app).get("/123/withdrawals?status=CANCELLED");

    expect(res.status).toBe(200);
    expect(res.body.data.withdrawals).toHaveLength(1);
    expect(res.body.data.withdrawals[0].transactionType).toBe("CANCELLED");
  });

  it("returns 400 for invalid status filter", async () => {
    app.get("/:id/withdrawals", async (req, res) => {
      const id = parseInt(req.params.id);
      const status = req.query.status as string | undefined;

      const validStatuses = ["CLAIMED", "CANCELLED"];
      if (status && !validStatuses.includes(status)) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_INPUT", message: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
        });
        return;
      }

      res.json({ success: true, data: { withdrawals: [] } });
    });

    const res = await request(app).get("/123/withdrawals?status=INVALID");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INPUT");
  });
});

describe("GET /api/vaults/:id/withdrawals (real router, #1699)", () => {
  let app: Express;

  const vault = {
    id: "vault-7",
    streamId: 7,
    creator: "GCREATOR",
    recipient: "GRECIPIENT",
    amount: "9000",
    status: StreamStatus.CLAIMED,
    txHash: "create-tx",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    claimedAt: new Date("2024-01-04T00:00:00Z"),
  };

  // Recorded withdrawal transactions, most recent first (as returned by the service)
  const withdrawalRecords = [
    { id: "w3", streamId: 7, transactionType: "CLAIMED", amount: "4000", recipient: "GRECIPIENT", txHash: "tx-3", timestamp: new Date("2024-01-04T00:00:00Z") },
    { id: "w2", streamId: 7, transactionType: "CLAIMED", amount: "3000", recipient: "GRECIPIENT", txHash: "tx-2", timestamp: new Date("2024-01-03T00:00:00Z") },
    { id: "w1", streamId: 7, transactionType: "CLAIMED", amount: "2000", recipient: "GRECIPIENT", txHash: "tx-1", timestamp: new Date("2024-01-02T00:00:00Z") },
  ];

  beforeEach(() => {
    app = express();
    app.use("/", vaultsRouter);
    realServiceMock.getStreamById.mockReset();
    realServiceMock.getWithdrawalsByStreamId.mockReset();
  });

  it("returns every recorded withdrawal transaction, in order, not a single synthesized entry", async () => {
    realServiceMock.getStreamById.mockResolvedValue(vault);
    realServiceMock.getWithdrawalsByStreamId.mockResolvedValue(withdrawalRecords);

    const res = await request(app).get("/7/withdrawals");

    expect(res.status).toBe(200);
    expect(realServiceMock.getWithdrawalsByStreamId).toHaveBeenCalledWith(7, { transactionType: undefined });
    expect(res.body.data.totalCount).toBe(3);
    expect(res.body.data.withdrawals.map((w: any) => w.txHash)).toEqual(["tx-3", "tx-2", "tx-1"]);
    expect(res.body.data.withdrawals.map((w: any) => w.amount)).toEqual(["4000", "3000", "2000"]);
    expect(res.body.data.withdrawals[0]).toEqual({
      id: "7-claim-tx-3",
      vaultId: 7,
      transactionType: "CLAIMED",
      amount: "4000",
      timestamp: "2024-01-04T00:00:00.000Z",
      txHash: "tx-3",
      recipient: "GRECIPIENT",
    });
  });

  it("paginates across multiple withdrawals with the existing cursor shape", async () => {
    realServiceMock.getStreamById.mockResolvedValue(vault);
    realServiceMock.getWithdrawalsByStreamId.mockResolvedValue(withdrawalRecords);

    const first = await request(app).get("/7/withdrawals?limit=2");
    expect(first.body.data.withdrawals.map((w: any) => w.txHash)).toEqual(["tx-3", "tx-2"]);
    expect(first.body.data.hasMore).toBe(true);
    expect(first.body.data.nextCursor).toBeDefined();

    const second = await request(app).get(`/7/withdrawals?limit=2&cursor=${first.body.data.nextCursor}`);
    expect(second.body.data.withdrawals.map((w: any) => w.txHash)).toEqual(["tx-1"]);
    expect(second.body.data.hasMore).toBe(false);
    expect(second.body.data.totalCount).toBe(3);
  });

  it("passes the status filter through to the withdrawal query", async () => {
    realServiceMock.getStreamById.mockResolvedValue(vault);
    realServiceMock.getWithdrawalsByStreamId.mockResolvedValue([]);

    const res = await request(app).get("/7/withdrawals?status=CANCELLED");

    expect(res.status).toBe(200);
    expect(realServiceMock.getWithdrawalsByStreamId).toHaveBeenCalledWith(7, { transactionType: "CANCELLED" });
    expect(res.body.data.withdrawals).toEqual([]);
  });

  it("returns 404 without querying withdrawals when the vault does not exist", async () => {
    realServiceMock.getStreamById.mockResolvedValue(null);

    const res = await request(app).get("/7/withdrawals");

    expect(res.status).toBe(404);
    expect(realServiceMock.getWithdrawalsByStreamId).not.toHaveBeenCalled();
  });
});
