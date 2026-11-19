import { Router } from "express";
import { z } from "zod";
import { Database } from "../../config/database";
import { authenticateAdmin, requireSuperAdmin } from "../../middleware/auth";
import { auditLog } from "../../middleware/auditLog";
import { successResponse, errorResponse } from "../../utils/response";
import { getNotificationPreferences, upsertNotificationPreferences } from "../../services/notificationPreferences";
import { logger } from "../../lib/logger";

const router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// Validation schemas
const userFilterSchema = z.object({
  banned: z.enum(["true", "false"]).optional(),
  role: z.enum(["user", "admin", "super_admin"]).optional(),
  search: z.string().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

const userUpdateSchema = z.object({
  banned: z.boolean().optional(),
  role: z.enum(["user", "admin", "super_admin"]).optional(),
});


const notificationPreferencesSchema = z.object({
  emailEnabled: z.boolean(),
  smsEnabled: z.boolean(),
  webhookEnabled: z.boolean(),
});


// GET /api/admin/users - List all users
router.get(
  "/",
  authenticateAdmin,
  auditLog("list_users", "user"),
  async (req, res) => {
    try {
      const filters = userFilterSchema.parse(req.query);

      let users = await Database.getAllUsers();

      // Apply filters
      if (filters.banned !== undefined) {
        users = users.filter((u) => u.banned === (filters.banned === "true"));
      }
      if (filters.role) {
        users = users.filter((u) => u.role === filters.role);
      }
      if (filters.search) {
        const search = filters.search.toLowerCase();
        users = users.filter(
          (u) =>
            u.address.toLowerCase().includes(search) ||
            u.id.toLowerCase().includes(search)
        );
      }

      const limit = Math.min(
        filters.limit ? parseInt(filters.limit) : DEFAULT_LIMIT,
        MAX_LIMIT
      );
      const offset = filters.offset ? parseInt(filters.offset) : 0;
      const total = users.length;
      users = users.slice(offset, offset + limit);

      res.json(
        successResponse({
          users,
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
      logger.error("Error fetching users", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch users",
        })
      );
    }
  }
);


// GET /api/admin/users/:id/notification-preferences
router.get(
  "/:id/notification-preferences",
  authenticateAdmin,
  async (req, res) => {
    try {
      const user = await Database.findUserById(req.params.id);
      if (!user) return res.status(404).json(errorResponse({ code: "NOT_FOUND", message: "User not found" }));
      const preferences = await getNotificationPreferences(user.id);
      res.json(successResponse({ userId: user.id, preferences }));
    } catch (error) {
      logger.error("Error fetching notification preferences", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch notification preferences" }));
    }
  }
);

// PUT /api/admin/users/:id/notification-preferences
router.put(
  "/:id/notification-preferences",
  authenticateAdmin,
  async (req, res) => {
    try {
      const user = await Database.findUserById(req.params.id);
      if (!user) return res.status(404).json(errorResponse({ code: "NOT_FOUND", message: "User not found" }));
      const preferences = notificationPreferencesSchema.parse(req.body);
      const saved = await upsertNotificationPreferences(user.id, preferences);
      res.json(successResponse({ userId: user.id, preferences: saved }));
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json(errorResponse({ code: "VALIDATION_ERROR", message: "Invalid notification preferences", details: error.issues }));
      logger.error("Error updating notification preferences", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to update notification preferences" }));
    }
  }
);

// GET /api/admin/users/:id - Get user details with activity
router.get(
  "/:id",
  authenticateAdmin,
  auditLog("view_user", "user"),
  async (req, res) => {
    try {
      const user = await Database.findUserById(req.params.id);

      if (!user) {
        return res.status(404).json(
          errorResponse({
            code: "NOT_FOUND",
            message: "User not found",
          })
        );
      }

      // Get user's tokens
      const allTokens = await Database.getAllTokens();
      const userTokens = allTokens.filter(
        (t) => t.creatorAddress === user.address
      );

      // Get user's audit logs (if they're an admin)
      const auditLogs =
        user.role !== "user"
          ? await Database.getAuditLogs({ adminId: user.id })
          : [];

      res.json(
        successResponse({
          user,
          tokens: userTokens,
          activity: {
            tokensCreated: userTokens.length,
            totalBurned: userTokens
              .reduce((sum, t) => sum + BigInt(t.burned || "0"), BigInt(0))
              .toString(),
            adminActions: auditLogs.length,
          },
          recentAuditLogs: auditLogs.slice(0, 10),
        })
      );
    } catch (error) {
      logger.error("Error fetching user", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch user",
        })
      );
    }
  }
);

// PATCH /api/admin/users/:id - Update user (ban/unban, change role)
router.patch(
  "/:id",
  authenticateAdmin,
  requireSuperAdmin,
  auditLog("update_user", "user"),
  async (req, res) => {
    try {
      const updates = userUpdateSchema.parse(req.body);

      const user = await Database.updateUser(req.params.id, updates);

      if (!user) {
        return res.status(404).json(
          errorResponse({
            code: "NOT_FOUND",
            message: "User not found",
          })
        );
      }

      res.json(successResponse({ user, message: "User updated successfully" }));
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json(
          errorResponse({
            code: "VALIDATION_ERROR",
            message: "Invalid update data",
            details: error.issues,
          })
        );
      }
      logger.error("Error updating user", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update user",
        })
      );
    }
  }
);

// GET /api/admin/users/:id/export - Export user data
router.get(
  "/:id/export",
  authenticateAdmin,
  auditLog("export_user_data", "user"),
  async (req, res) => {
    try {
      const user = await Database.findUserById(req.params.id);

      if (!user) {
        return res.status(404).json(
          errorResponse({
            code: "NOT_FOUND",
            message: "User not found",
          })
        );
      }

      const allTokens = await Database.getAllTokens();
      const userTokens = allTokens.filter(
        (t) => t.creatorAddress === user.address
      );

      const exportData = {
        user,
        tokens: userTokens,
        exportedAt: new Date(),
        exportedBy: req.admin?.id,
      };

      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="user_${user.id}_export.json"`
      );
      res.json(successResponse(exportData));
    } catch (error) {
      logger.error("Error exporting user data", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to export user data",
        })
      );
    }
  }
);

export default router;
