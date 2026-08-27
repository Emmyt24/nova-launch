import { Router } from "express";
import { z } from "zod";
import { Database } from "../../config/database";
import { authenticateAdmin, requireSuperAdmin } from "../../middleware/auth";
import { auditLog } from "../../middleware/auditLog";
import { successResponse, errorResponse } from "../../utils/response";

const router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// Validation schemas
const tokenFilterSchema = z.object({
  flagged: z.enum(["true", "false"]).optional(),
  deleted: z.enum(["true", "false"]).optional(),
  creator: z.string().optional(),
  search: z.string().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

const tokenUpdateSchema = z.object({
  flagged: z.boolean().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

// GET /api/admin/tokens - List all tokens with filters
router.get(
  "/",
  authenticateAdmin,
  auditLog("list_tokens", "token"),
  async (req, res) => {
    try {
      const filters = tokenFilterSchema.parse(req.query);

      let tokens = await Database.getAllTokens(filters.deleted === "true");

      // Apply filters
      if (filters.flagged !== undefined) {
        tokens = tokens.filter(
          (t) => t.flagged === (filters.flagged === "true")
        );
      }
      if (filters.creator) {
        tokens = tokens.filter((t) => t.creatorAddress === filters.creator);
      }
      if (filters.search) {
        const search = filters.search.toLowerCase();
        tokens = tokens.filter(
          (t) =>
            t.name.toLowerCase().includes(search) ||
            t.symbol.toLowerCase().includes(search) ||
            t.contractAddress.toLowerCase().includes(search)
        );
      }

      const limit = Math.min(
        filters.limit ? parseInt(filters.limit) : DEFAULT_LIMIT,
        MAX_LIMIT
      );
      const offset = filters.offset ? parseInt(filters.offset) : 0;
      const total = tokens.length;
      tokens = tokens.slice(offset, offset + limit);

      res.json(
        successResponse({
          tokens,
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
      console.error("Error fetching tokens:", error);
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch tokens",
        })
      );
    }
  }
);

// GET /api/admin/tokens/:id - Get detailed token info
router.get(
  "/:id",
  authenticateAdmin,
  auditLog("view_token", "token"),
  async (req, res) => {
    try {
      const token = await Database.findTokenById(req.params.id);

      if (!token) {
        return res.status(404).json(
          errorResponse({
            code: "NOT_FOUND",
            message: "Token not found",
          })
        );
      }

      // Get creator info
      const creator = await Database.findUserByAddress(token.creatorAddress);

      res.json(
        successResponse({
          token,
          creator: creator
            ? {
                id: creator.id,
                address: creator.address,
                role: creator.role,
                banned: creator.banned,
                createdAt: creator.createdAt,
              }
            : null,
        })
      );
    } catch (error) {
      console.error("Error fetching token:", error);
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch token",
        })
      );
    }
  }
);

// PATCH /api/admin/tokens/:id - Update token (flag/unflag, update metadata)
router.patch(
  "/:id",
  authenticateAdmin,
  auditLog("update_token", "token"),
  async (req, res) => {
    try {
      const updates = tokenUpdateSchema.parse(req.body);

      const token = await Database.updateToken(req.params.id, updates);

      if (!token) {
        return res.status(404).json(
          errorResponse({
            code: "NOT_FOUND",
            message: "Token not found",
          })
        );
      }

      res.json(
        successResponse({ token, message: "Token updated successfully" })
      );
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
      console.error("Error updating token:", error);
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update token",
        })
      );
    }
  }
);

// DELETE /api/admin/tokens/:id - Soft delete token (super admin only)
router.delete(
  "/:id",
  authenticateAdmin,
  requireSuperAdmin,
  auditLog("delete_token", "token"),
  async (req, res) => {
    try {
      const success = await Database.softDeleteToken(req.params.id);

      if (!success) {
        return res.status(404).json(
          errorResponse({
            code: "NOT_FOUND",
            message: "Token not found",
          })
        );
      }

      res.json(successResponse({ message: "Token deleted successfully" }));
    } catch (error) {
      console.error("Error deleting token:", error);
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete token",
        })
      );
    }
  }
);

export default router;
