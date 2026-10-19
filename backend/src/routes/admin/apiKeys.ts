/**
 * Admin API key rotation endpoints (#2189).
 *
 *   POST /api/admin/api-keys/:id/rotate            – issue a new key, keep the old one for a grace window
 *   POST /api/admin/api-keys/:id/rotation/commit   – end the grace window early
 *
 * Only the key owner or a super admin may rotate a key.
 */

import { Router, Response } from "express";
import { z } from "zod";
import { authenticateAdmin, AuthRequest } from "../../middleware/auth";
import { apiKeyManager, MAX_GRACE_MS } from "../../auth/apiKey";
import apiKeyRotationService, { RotationActor } from "../../services/apiKeyRotationService";
import { successResponse, sendError } from "../../utils/response";
import { ErrorCode } from "../../lib/errors";

const router = Router();

const rotateSchema = z
  .object({
    /** Grace window for the old key, in seconds. */
    gracePeriodSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_GRACE_MS / 1000)
      .optional(),
  })
  .strict();

function actorFrom(req: AuthRequest): RotationActor {
  return {
    id: req.admin!.id,
    ipAddress: req.ip || req.socket.remoteAddress || "unknown",
    userAgent: req.headers["user-agent"] || "unknown",
  };
}

/**
 * Resolve the key and check the caller may manage it. Sends the error
 * response and returns false when the request cannot proceed.
 */
function authorizeKeyAccess(req: AuthRequest, res: Response): boolean {
  const key = apiKeyManager.get(req.params.id);
  if (!key) {
    sendError(res, 404, ErrorCode.NOT_FOUND, "API key not found", { resource: "api_key", identifier: req.params.id });
    return false;
  }
  const isOwner = key.ownerId !== null && key.ownerId === req.admin!.id;
  if (!isOwner && req.admin!.role !== "super_admin") {
    sendError(res, 403, ErrorCode.FORBIDDEN, "Only the key owner or a super admin can manage this key");
    return false;
  }
  if (key.status === "revoked") {
    sendError(res, 409, ErrorCode.CONFLICT, "Cannot rotate a revoked key");
    return false;
  }
  return true;
}

router.post("/:id/rotate", authenticateAdmin, async (req: AuthRequest, res: Response) => {
  const parsed = rotateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return sendError(res, 400, ErrorCode.VALIDATION_ERROR, "Invalid rotation request", parsed.error.issues);
  }
  if (!authorizeKeyAccess(req, res)) return;

  const { gracePeriodSeconds } = parsed.data;

  try {
    const result = await apiKeyRotationService.rotate({
      keyId: req.params.id,
      graceMs: gracePeriodSeconds !== undefined ? gracePeriodSeconds * 1000 : undefined,
      actor: actorFrom(req),
    });

    // The raw key is only ever returned here — never cache this response
    res.setHeader("Cache-Control", "no-store");
    return res.status(201).json(
      successResponse({
        id: result.id,
        apiKey: result.rawKey,
        previousKeyValidUntil: result.graceEndsAt,
        gracePeriodSeconds: Math.floor(result.graceMs / 1000),
        ownerNotified: result.ownerNotified,
      })
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
    }
    console.error("API key rotation error:", error);
    return sendError(res, 500, ErrorCode.INTERNAL_SERVER_ERROR, "Failed to rotate API key");
  }
});

router.post("/:id/rotation/commit", authenticateAdmin, async (req: AuthRequest, res: Response) => {
  if (!authorizeKeyAccess(req, res)) return;

  if (apiKeyManager.get(req.params.id)!.status !== "rotating") {
    return sendError(res, 409, ErrorCode.CONFLICT, "API key is not in a rotation grace period");
  }

  try {
    await apiKeyRotationService.commit(req.params.id, actorFrom(req));
    return res.json(successResponse({ id: req.params.id, status: "active" }));
  } catch (error) {
    console.error("API key rotation commit error:", error);
    return sendError(res, 500, ErrorCode.INTERNAL_SERVER_ERROR, "Failed to commit API key rotation");
  }
});

export default router;
