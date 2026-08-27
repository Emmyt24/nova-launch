/**
 * Admin REST endpoints for dead-letter job inspection and management.
 *
 * GET    /api/admin/jobs/failed        – list failed jobs (filterable)
 * POST   /api/admin/jobs/:id/retry     – re-enqueue a dead-letter job with high priority
 * DELETE /api/admin/jobs/:id           – permanently discard a dead-letter job
 *
 * All routes require admin authentication.
 */

import { Router } from "express";
import { z } from "zod";
import { authenticateAdmin } from "../../middleware/auth";
import { successResponse, errorResponse } from "../../utils/response";
import { jobQueue } from "../../services/jobQueue";

const router = Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const failedJobsQuerySchema = z.object({
  jobType: z.string().optional(),
  errorCode: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/admin/jobs/failed
// ---------------------------------------------------------------------------

router.get("/failed", authenticateAdmin, (req, res) => {
  try {
    const query = failedJobsQuerySchema.parse(req.query);

    const filters: {
      jobType?: string;
      errorCode?: string;
      startDate?: Date;
      endDate?: Date;
    } = {};

    if (query.jobType) filters.jobType = query.jobType;
    if (query.errorCode) filters.errorCode = query.errorCode;
    if (query.startDate) filters.startDate = new Date(query.startDate);
    if (query.endDate) filters.endDate = new Date(query.endDate);

    let jobs = jobQueue.failedJobs(filters);

    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const offset = query.offset ? parseInt(query.offset, 10) : 0;
    const total = jobs.length;
    jobs = jobs.slice(offset, offset + limit);

    res.json(
      successResponse({
        jobs,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      })
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json(
        errorResponse({
          code: "VALIDATION_ERROR",
          message: "Invalid query parameters",
          details: error.issues,
        })
      );
    }
    console.error("Error fetching failed jobs:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch failed jobs",
      })
    );
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/jobs/:id/retry
// ---------------------------------------------------------------------------

router.post("/:id/retry", authenticateAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const job = jobQueue.retryJob(id);

    if (!job) {
      return res.status(404).json(
        errorResponse({
          code: "JOB_NOT_FOUND",
          message: `No dead-letter job found with id "${id}"`,
        })
      );
    }

    res.json(successResponse({ job }));
  } catch (error) {
    console.error("Error retrying job:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to retry job",
      })
    );
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/jobs/:id
// ---------------------------------------------------------------------------

router.delete("/:id", authenticateAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const discarded = jobQueue.discardJob(id);

    if (!discarded) {
      return res.status(404).json(
        errorResponse({
          code: "JOB_NOT_FOUND",
          message: `No dead-letter job found with id "${id}"`,
        })
      );
    }

    res.json(successResponse({ discarded: true, id }));
  } catch (error) {
    console.error("Error discarding job:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to discard job",
      })
    );
  }
});

export default router;
