import { Router } from "express";
import { z } from "zod";
import { Database } from "../../config/database";
import { authenticateAdmin } from "../../middleware/auth";
import { successResponse, errorResponse } from "../../utils/response";

const router = Router();

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

// GET /api/admin/audit - Get audit logs with filters
router.get("/", authenticateAdmin, async (req, res) => {
  try {
    const filters = auditFilterSchema.parse(req.query);

    const auditFilters: any = {};
    if (filters.adminId) auditFilters.adminId = filters.adminId;
    if (filters.action) auditFilters.action = filters.action;
    if (filters.resource) auditFilters.resource = filters.resource;
    if (filters.startDate) auditFilters.startDate = new Date(filters.startDate);
    if (filters.endDate) auditFilters.endDate = new Date(filters.endDate);

    let logs = await Database.getAuditLogs(auditFilters);

    // Pagination
    const limit = filters.limit ? parseInt(filters.limit) : 50;
    const offset = filters.offset ? parseInt(filters.offset) : 0;
    const total = logs.length;
    logs = logs.slice(offset, offset + limit);

    res.json(
      successResponse({
        logs,
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
router.get("/export", authenticateAdmin, async (req, res) => {
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
