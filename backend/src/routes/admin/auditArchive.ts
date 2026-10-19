/**
 * GET /api/admin/audit/archive-status
 *
 * Returns the current state of the tiered audit-log archival job:
 *   - The most recently written checkpoint (or null if no job has ever run).
 *   - A live count of hot-tier records broken down by age bucket.
 */

import { Router } from "express";
import { Database } from "../../config/database";
import { checkpointStore } from "../../services/auditRetentionJob";
import { authenticateAdmin } from "../../middleware/auth";
import { sendError } from "../../utils/response";
import { ErrorCode } from "../../lib/errors";

export const auditArchiveRouter = Router();

auditArchiveRouter.get("/archive-status", authenticateAdmin, async (_req, res) => {
  try {
    // Load the latest persisted checkpoint (no-op if already cached).
    const checkpoint = await checkpointStore.load();

    // Count hot-tier records by age bucket.
    const allLogs = await Database.getAuditLogs();
    const now = Date.now();

    const DAY = 24 * 60 * 60 * 1000;
    const warm90 = new Date(now - 90 * DAY);
    const warm365 = new Date(now - 365 * DAY);

    const hotCount = allLogs.filter((l) => l.timestamp >= warm90).length;
    const warmCount = allLogs.filter(
      (l) => l.timestamp < warm90 && l.timestamp >= warm365
    ).length;
    const coldCount = allLogs.filter((l) => l.timestamp < warm365).length;

    res.json({
      status: "ok",
      checkpoint: checkpoint ?? null,
      counts: {
        hot: hotCount,
        warm: warmCount,
        cold: coldCount,
      },
    });
  } catch (err: any) {
    sendError(res, 500, ErrorCode.INTERNAL_SERVER_ERROR, "Failed to fetch audit archive status", {
      reason: err?.message ?? String(err),
    });
  }
});
