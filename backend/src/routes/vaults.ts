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

export default router;
