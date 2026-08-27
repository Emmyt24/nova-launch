import { Router, Response } from "express";
import { z } from "zod";
import webhookDeadLetterService from "../services/webhookDeadLetterService";
import webhookService from "../services/webhookService";
import webhookDeliveryService from "../services/webhookDeliveryService";
import { authenticateAdmin, AuthRequest } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { successResponse, errorResponse } from "../utils/response";

/**
 * Admin-only API for inspecting, retrying, and discarding webhook
 * dead-letter entries (failed deliveries that exhausted all retries).
 *
 * All endpoints in this router require admin authentication — see
 * `authenticateAdmin` in `../middleware/auth`.
 *
 * Tenant filtering: there is no dedicated "tenant" column on webhook
 * subscriptions or dead-letter rows in this codebase. The closest existing
 * field is `webhook_subscriptions.created_by` (the Stellar address that
 * created the subscription). `GET /` filters by tenant via that field —
 * see `DeadLetterListFilters` in `webhookDeadLetterService.ts` for the
 * underlying query and rationale.
 */

const router = Router();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
  tenant: z.string().optional(),
  failureReason: z.string().optional(),
  resolved: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

/**
 * GET /api/webhooks/dead-letter
 * List dead-letter entries across all subscriptions, paginated and
 * optionally filtered by tenant (subscription owner) and failure reason.
 */
router.get(
  "/",
  authenticateAdmin,
  auditLog("list_dead_letters", "webhook_dead_letter"),
  async (req: AuthRequest, res: Response) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(
          errorResponse({
            code: "VALIDATION_ERROR",
            message: "Invalid query parameters",
            details: parsed.error.issues,
          }, req.correlationId)
        );
      }

      const { page, limit, tenant, failureReason, resolved } = parsed.data;

      const { entries, total } = await webhookDeadLetterService.listAllPaginated(
        page,
        limit,
        { tenant, failureReason, resolved }
      );

      res.json(
        successResponse({
          entries,
          pagination: {
            page,
            limit,
            total,
          },
        }, req.correlationId)
      );
    } catch (error) {
      console.error("Error listing dead-letter entries:", error);
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to list dead-letter entries",
        }, req.correlationId)
      );
    }
  }
);

/**
 * POST /api/webhooks/dead-letter/:id/retry
 * Re-enqueue the original payload for delivery with a FRESH attempt
 * counter (the underlying delivery service always starts a new call at
 * attempt 1, so this never resumes the previously exhausted counter).
 */
router.post(
  "/:id/retry",
  authenticateAdmin,
  auditLog("retry_dead_letter", "webhook_dead_letter"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const deadLetter = await webhookDeadLetterService.getEntry(id);

      if (!deadLetter) {
        return res.status(404).json(
          errorResponse({
            code: "NOT_FOUND",
            message: "Dead-letter entry not found",
          }, req.correlationId)
        );
      }

      if (deadLetter.resolvedAt) {
        return res.status(409).json(
          errorResponse({
            code: "ALREADY_RESOLVED",
            message: `Dead-letter entry was already resolved (${deadLetter.resolution})`,
          }, req.correlationId)
        );
      }

      const subscription = await webhookService.getSubscription(
        deadLetter.subscriptionId
      );
      if (!subscription) {
        return res.status(404).json(
          errorResponse({
            code: "SUBSCRIPTION_NOT_FOUND",
            message: "Associated webhook subscription no longer exists",
          }, req.correlationId)
        );
      }

      const payload = JSON.parse(deadLetter.payload);

      // Re-deliver via the standard delivery path. Each call to
      // deliverWebhook starts its own retry loop at attempt 1, so this is
      // always a fresh attempt counter — never a resumption of the
      // exhausted one that landed the entry in the dead-letter queue.
      await webhookDeliveryService.deliverWebhook(
        subscription,
        deadLetter.event,
        payload.data || payload,
        `admin_retry_${id}`
      );

      await webhookDeadLetterService.markResolved(id, "retried");

      res.json(
        successResponse({
          message: "Dead-letter entry re-enqueued for delivery",
          id,
        }, req.correlationId)
      );
    } catch (error) {
      console.error("Error retrying dead-letter entry:", error);
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to retry dead-letter entry",
        }, req.correlationId)
      );
    }
  }
);

/**
 * POST /api/webhooks/dead-letter/:id/requeue
 * Manually trigger a requeue for a dead-letter entry, incrementing the
 * requeue counter. Rejects with 409 if the poison-message cap is hit.
 */
router.post(
  "/:id/requeue",
  authenticateAdmin,
  auditLog("requeue_dead_letter", "webhook_dead_letter"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const deadLetter = await webhookDeadLetterService.getEntry(id);

      if (!deadLetter) {
        return res.status(404).json(
          errorResponse({
            code: "NOT_FOUND",
            message: "Dead-letter entry not found",
          }, req.correlationId)
        );
      }

      if (deadLetter.resolvedAt) {
        return res.status(409).json(
          errorResponse({
            code: "ALREADY_RESOLVED",
            message: `Dead-letter entry was already resolved (${deadLetter.resolution})`,
          }, req.correlationId)
        );
      }

      try {
        const requeued = await webhookDeadLetterService.requeueDeadLetter(id);

        res.json(
          successResponse({
            message: "Dead-letter entry requeued for delivery",
            id,
            requeueCount: requeued.requeueCount,
          }, req.correlationId)
        );
      } catch (error: any) {
        if (error.name === "PoisonMessageError") {
          return res.status(409).json(
            errorResponse({
              code: "POISON_MESSAGE",
              message: "Dead-letter entry has exceeded the maximum requeue limit",
              details: { requeueCount: deadLetter.requeueCount },
            }, req.correlationId)
          );
        }
        throw error;
      }
    } catch (error) {
      console.error("Error requeuing dead-letter entry:", error);
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to requeue dead-letter entry",
        }, req.correlationId)
      );
    }
  }
);

/**
 * DELETE /api/webhooks/dead-letter/:id
 * Discard a dead-letter entry without retrying delivery.
 */
router.delete(
  "/:id",
  authenticateAdmin,
  auditLog("discard_dead_letter", "webhook_dead_letter"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const deadLetter = await webhookDeadLetterService.getEntry(id);

      if (!deadLetter) {
        return res.status(404).json(
          errorResponse({
            code: "NOT_FOUND",
            message: "Dead-letter entry not found",
          }, req.correlationId)
        );
      }

      if (deadLetter.resolvedAt) {
        return res.status(409).json(
          errorResponse({
            code: "ALREADY_RESOLVED",
            message: `Dead-letter entry was already resolved (${deadLetter.resolution})`,
          }, req.correlationId)
        );
      }

      await webhookDeadLetterService.markResolved(id, "archived");

      res.json(
        successResponse({
          message: "Dead-letter entry discarded",
          id,
        }, req.correlationId)
      );
    } catch (error) {
      console.error("Error discarding dead-letter entry:", error);
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to discard dead-letter entry",
        }, req.correlationId)
      );
    }
  }
);

export default router;
