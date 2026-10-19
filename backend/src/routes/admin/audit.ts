import { Router } from "express";
import { z } from "zod";
import { Database } from "../../config/database";
import { authenticateAdmin, requireRole } from "../../middleware/auth";
import { successResponse, errorResponse } from "../../utils/response";

const router = Router();

export const DEFAULT_AUDIT_PAGE_SIZE = 50;
export const MAX_AUDIT_PAGE_SIZE = 200;

const requireAuditAccess = requireRole("admin", "super_admin");

// Validation schema
const auditFilterSchema = z.object({
  adminId: z.string().optional(),
  action: z.string().optional(),
  resource: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

// Query schema: adds `actor` (alias for adminId), page-based pagination and
// bounds on page size / date range.
const auditQuerySchema = auditFilterSchema
  .extend({
    actor: z.string().min(1).optional(),
    page: z.string().regex(/^[1-9]\d*$/).optional(),
  })
  .refine((q) => !q.limit || Number(q.limit) >= 1, {
    message: "limit must be at least 1",
    path: ["limit"],
  })
  .refine((q) => !q.limit || Number(q.limit) <= MAX_AUDIT_PAGE_SIZE, {
    message: `limit must not exceed ${MAX_AUDIT_PAGE_SIZE}`,
    path: ["limit"],
  })
  .refine((q) => !(q.page && q.offset), {
    message: "Use either page or offset, not both",
    path: ["page"],
  })
  .refine(
    (q) =>
      !q.startDate ||
      !q.endDate ||
      new Date(q.startDate).getTime() <= new Date(q.endDate).getTime(),
    { message: "startDate must be before endDate", path: ["startDate"] }
  );

// GET /api/admin/audit - Query audit logs with filters (actor, action,
// resource, date range) and database-side pagination. Admin role required.
router.get("/", authenticateAdmin, requireAuditAccess, async (req, res) => {
  try {
    const filters = auditQuerySchema.parse(req.query);

    const limit = filters.limit ? parseInt(filters.limit) : DEFAULT_AUDIT_PAGE_SIZE;
    const page = filters.page ? parseInt(filters.page) : undefined;
    const offset = page
      ? (page - 1) * limit
      : filters.offset
        ? parseInt(filters.offset)
        : 0;

    const { logs, total } = await Database.queryAuditLogs({
      adminId: filters.actor ?? filters.adminId,
      action: filters.action,
      resource: filters.resource,
      startDate: filters.startDate ? new Date(filters.startDate) : undefined,
      endDate: filters.endDate ? new Date(filters.endDate) : undefined,
      skip: offset,
      take: limit,
    });

    res.json(
      successResponse({
        logs,
        pagination: {
          total,
          limit,
          offset,
          page: Math.floor(offset / limit) + 1,
          totalPages: Math.ceil(total / limit),
          hasMore: offset + limit < total,
        },
      })
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json(
        errorResponse({
          code: "VALIDATION_ERROR",
          message: "Invalid filters",
          details: error.issues,
        })
      );
    }
    console.error("Error fetching audit logs:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch audit logs",
      })
    );
  }
});

// GET /api/admin/audit/export - Export audit logs
router.get("/export", authenticateAdmin, requireAuditAccess, async (req, res) => {
  try {
    const filters = auditFilterSchema.parse(req.query);

    const auditFilters: any = {};
    if (filters.adminId) auditFilters.adminId = filters.adminId;
    if (filters.action) auditFilters.action = filters.action;
    if (filters.resource) auditFilters.resource = filters.resource;
    if (filters.startDate) auditFilters.startDate = new Date(filters.startDate);
    if (filters.endDate) auditFilters.endDate = new Date(filters.endDate);

    const logs = await Database.getAuditLogs(auditFilters);

    const exportData = {
      logs,
      exportedAt: new Date(),
      exportedBy: req.admin?.id,
      filters: auditFilters,
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit_logs_${Date.now()}.json"`
    );
    res.json(successResponse(exportData));
  } catch (error) {
    console.error("Error exporting audit logs:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to export audit logs",
      })
    );
  }
});

export default router;
