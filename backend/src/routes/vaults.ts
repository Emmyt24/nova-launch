import { Router } from "express";
import { StreamStatus } from "@prisma/client";
import { streamProjectionService } from "../services/streamProjectionService";
import { successResponse, errorResponse } from "../utils/response";

const router = Router();

function parseListOpts(query: any) {
  const limit = Math.min(parseInt(query.limit as string) || 50, 200);
  const offset = parseInt(query.offset as string) || 0;
  const status = query.status as StreamStatus | undefined;
  if (status && !Object.values(StreamStatus).includes(status)) {
    return { error: `Invalid status. Must be one of: ${Object.values(StreamStatus).join(", ")}` };
  }
  return { limit, offset, status };
}

/**
 * GET /api/vaults/creator/:address?status=CREATED&limit=50&offset=0
 * Vaults created by address.
 */
router.get("/creator/:address", async (req, res) => {
  const opts = parseListOpts(req.query);
  if ("error" in opts) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: opts.error! }));
  try {
    const vaults = await streamProjectionService.getStreamsByCreator(req.params.address, opts);
    res.json(successResponse(vaults));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch creator vaults" }));
  }
});

/**
 * GET /api/vaults/beneficiary/:address?status=CREATED&limit=50&offset=0
 * Vaults where address is the beneficiary (recipient).
 */
router.get("/beneficiary/:address", async (req, res) => {
  const opts = parseListOpts(req.query);
  if ("error" in opts) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: opts.error! }));
  try {
    const vaults = await streamProjectionService.getStreamsByRecipient(req.params.address, opts);
    res.json(successResponse(vaults));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch beneficiary vaults" }));
  }
});

/**
 * GET /api/vaults/:id
 * Single vault by on-chain streamId.
 */
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: "Invalid vault ID" }));
  try {
    const vault = await streamProjectionService.getStreamById(id);
    if (!vault) return res.status(404).json(errorResponse({ code: "NOT_FOUND", message: "Vault not found" }));
    res.json(successResponse(vault));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch vault" }));
  }
});

/**
 * GET /api/vaults/:id/withdrawals?limit=10&cursor=...
 * Withdrawal history for a vault with cursor-based pagination.
 */
router.get("/:id/withdrawals", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: "Invalid vault ID" }));

  const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
  const cursor = req.query.cursor as string | undefined;
  const status = req.query.status as string | undefined;

  // Validate status filter if provided
  const validStatuses = ["CLAIMED", "CANCELLED"];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json(
      errorResponse({
        code: "INVALID_INPUT",
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      })
    );
  }

  try {
    const vault = await streamProjectionService.getStreamById(id);
    if (!vault) return res.status(404).json(errorResponse({ code: "NOT_FOUND", message: "Vault not found" }));

    // Query withdrawal transactions from the stream projection.
    // A withdrawal transaction represents a claim or cancellation of a vault.
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

    // Sort by timestamp descending (most recent first)
    withdrawals.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Implement cursor-based pagination
    const startIndex = cursor ? Math.max(0, parseInt(atob(cursor), 10)) : 0;
    const paginatedWithdrawals = withdrawals.slice(startIndex, startIndex + limit);
    const nextIndex = startIndex + limit;
    const hasMore = nextIndex < withdrawals.length;

    res.json(
      successResponse({
        withdrawals: paginatedWithdrawals,
        nextCursor: hasMore ? btoa(nextIndex.toString()) : undefined,
        prevCursor: startIndex > 0 ? btoa(Math.max(0, startIndex - limit).toString()) : undefined,
        hasMore,
        totalCount: withdrawals.length,
      })
    );
  } catch (err) {
    console.error(err);
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch withdrawal history" }));
  }
});

export default router;
