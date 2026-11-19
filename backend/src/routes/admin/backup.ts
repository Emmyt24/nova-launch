/**
 * Backup API Routes
 *
 * All endpoints require admin authentication.
 *
 * GET  /api/admin/backup/status   — current PITR backup status
 * GET  /api/admin/backup/list     — list available base backups
 * POST /api/admin/backup/trigger  — trigger a new base backup
 * POST /api/admin/backup/restore  — initiate a PITR restore
 */

import { Router, Request, Response } from "express";
import { authenticateAdmin } from "../../middleware/auth";
import { backupService } from "../../services/backup";
import { successResponse, errorResponse } from "../../utils/response";
import { logger } from "../../lib/logger";

const router = Router();

/**
 * GET /api/admin/backup/status
 * Returns the current PITR backup status (latest backup, WAL count, etc.).
 */
router.get("/status", authenticateAdmin, async (_req: Request, res: Response) => {
  try {
    const status = await backupService.getStatus();
    res.json(successResponse(status));
  } catch (error) {
    logger.error("Failed to fetch backup status", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json(
      errorResponse({ code: "BACKUP_STATUS_ERROR", message: "Failed to fetch backup status" })
    );
  }
});

/**
 * GET /api/admin/backup/list
 * Lists all available base backup labels, newest first.
 */
router.get("/list", authenticateAdmin, async (_req: Request, res: Response) => {
  try {
    const backups = await backupService.listBaseBackups();
    res.json(successResponse({ backups, count: backups.length }));
  } catch (error) {
    logger.error("Failed to list backups", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json(
      errorResponse({ code: "BACKUP_LIST_ERROR", message: "Failed to list backups" })
    );
  }
});

/**
 * POST /api/admin/backup/trigger
 * Triggers a new PITR base backup. This is an async operation; the response
 * reflects the outcome once the backup script exits.
 *
 * Body: (none required)
 */
router.post("/trigger", authenticateAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await backupService.createBaseBackup();
    const statusCode = result.success ? 200 : 500;
    res.status(statusCode).json(
      result.success
        ? successResponse(result)
        : errorResponse({ code: "BACKUP_FAILED", message: result.message })
    );
  } catch (error) {
    logger.error("Failed to trigger backup", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json(
      errorResponse({ code: "BACKUP_TRIGGER_ERROR", message: "Failed to trigger backup" })
    );
  }
});

/**
 * POST /api/admin/backup/restore
 * Initiates a PITR restore.
 *
 * Body:
 *   targetTime  {string}  ISO-8601 UTC timestamp — required
 *   baseLabel   {string}  Base backup label — optional (defaults to latest)
 *   confirmed   {boolean} Must be true to execute; false = dry-run — required
 */
router.post("/restore", authenticateAdmin, async (req: Request, res: Response) => {
  const { targetTime, baseLabel, confirmed } = req.body as {
    targetTime?: string;
    baseLabel?: string;
    confirmed?: boolean;
  };

  if (!targetTime) {
    return res.status(400).json(
      errorResponse({ code: "MISSING_TARGET_TIME", message: "targetTime is required" })
    );
  }

  if (typeof confirmed !== "boolean") {
    return res.status(400).json(
      errorResponse({
        code: "MISSING_CONFIRMED",
        message: "confirmed (boolean) is required. Set to false for a dry-run.",
      })
    );
  }

  try {
    const result = await backupService.restore({ targetTime, baseLabel, confirmed });
    const statusCode = result.success ? 200 : 500;
    res.status(statusCode).json(
      result.success
        ? successResponse(result)
        : errorResponse({ code: "RESTORE_FAILED", message: result.message })
    );
  } catch (error) {
    logger.error("Failed to initiate restore", {
      error: error instanceof Error ? error.message : String(error),
      targetTime,
      baseLabel,
      confirmed,
    });
    res.status(500).json(
      errorResponse({ code: "RESTORE_ERROR", message: "Failed to initiate restore" })
    );
  }
});

export default router;
