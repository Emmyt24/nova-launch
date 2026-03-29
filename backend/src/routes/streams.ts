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
 * GET /api/streams/stats/:address?
 * Stream statistics for an address (creator or recipient), or global.
 */
router.get("/stats/:address?", async (req, res) => {
  try {
    const stats = await streamProjectionService.getStreamStats(req.params.address);
    res.json(successResponse(stats));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch stream stats" }));
  }
});

/**
 * GET /api/streams/creator/:address?status=CREATED&limit=50&offset=0
 * Streams created by address.
 */
router.get("/creator/:address", async (req, res) => {
  const opts = parseListOpts(req.query);
  if ("error" in opts) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: opts.error! }));
  try {
    const streams = await streamProjectionService.getStreamsByCreator(req.params.address, opts);
    res.json(successResponse(streams));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch creator streams" }));
  }
});

/**
 * GET /api/streams/recipient/:address?status=CREATED&limit=50&offset=0
 * Streams where address is the recipient.
 */
router.get("/recipient/:address", async (req, res) => {
  const opts = parseListOpts(req.query);
  if ("error" in opts) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: opts.error! }));
  try {
    const streams = await streamProjectionService.getStreamsByRecipient(req.params.address, opts);
    res.json(successResponse(streams));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch recipient streams" }));
  }
});

/**
 * GET /api/streams/:id
 * Single stream by on-chain streamId.
 */
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: "Invalid stream ID" }));
  try {
    const stream = await streamProjectionService.getStreamById(id);
    if (!stream) return res.status(404).json(errorResponse({ code: "NOT_FOUND", message: "Stream not found" }));
    res.json(successResponse(stream));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch stream" }));
  }
});

export default router;
