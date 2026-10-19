import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Setup Mocks ─────────────────────────────────────────────────────────────

const mockGetAuditLogs = vi.fn();
const mockQueryAuditLogs = vi.fn();

vi.mock("../../../config/database", () => ({
  Database: {
    getAuditLogs: (...args: any[]) => mockGetAuditLogs(...args),
    queryAuditLogs: (...args: any[]) => mockQueryAuditLogs(...args),
  },
}));

let mockAdminUser: any = { id: "admin-1", role: "super_admin" };

vi.mock("../../../middleware/auth", () => ({
  authenticateAdmin: (req: any, _res: any, next: any) => {
    if (!mockAdminUser) {
      return _res.status(401).json({ success: false, error: "Unauthorized" });
    }
    req.admin = mockAdminUser;
    next();
  },
  requireRole:
    (...roles: string[]) =>
    (req: any, res: any, next: any) => {
      if (!req.admin) return res.status(401).json({ error: "Authentication required" });
      if (!roles.includes(req.admin.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      next();
    },
}));

import auditRouter from "../audit";

describe("Admin Audit-Log Routes (backend/src/routes/admin/audit.ts)", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminUser = { id: "admin-1", role: "super_admin" };

    app = express();
    app.use(express.json());
    app.use("/api/admin/audit", auditRouter);
  });

  describe("GET /api/admin/audit", () => {
    it("returns audit logs with pagination on success", async () => {
      const sampleLogs = [
        { id: "1", action: "CREATE_TOKEN", resource: "token-1", adminId: "admin-1" },
        { id: "2", action: "UPDATE_CONFIG", resource: "config-1", adminId: "admin-1" },
      ];
      mockQueryAuditLogs.mockResolvedValueOnce({ logs: sampleLogs, total: 2 });

      const res = await request(app)
        .get("/api/admin/audit")
        .query({ adminId: "admin-1", limit: "10", offset: "0" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.logs).toEqual(sampleLogs);
      expect(res.body.data.pagination).toEqual({
        total: 2,
        limit: 10,
        offset: 0,
        page: 1,
        totalPages: 1,
        hasMore: false,
      });
      expect(mockQueryAuditLogs).toHaveBeenCalledWith(
        expect.objectContaining({ adminId: "admin-1", skip: 0, take: 10 })
      );
    });

    it("filters by actor, action and date range", async () => {
      mockQueryAuditLogs.mockResolvedValueOnce({ logs: [], total: 0 });

      const res = await request(app).get("/api/admin/audit").query({
        actor: "admin-7",
        action: "DELETE",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-02-01T00:00:00.000Z",
      });

      expect(res.status).toBe(200);
      expect(mockQueryAuditLogs).toHaveBeenCalledWith({
        adminId: "admin-7",
        action: "DELETE",
        resource: undefined,
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2026-02-01T00:00:00.000Z"),
        skip: 0,
        take: 50,
      });
    });

    it("prefers actor over adminId when both are supplied", async () => {
      mockQueryAuditLogs.mockResolvedValueOnce({ logs: [], total: 0 });

      await request(app)
        .get("/api/admin/audit")
        .query({ actor: "admin-a", adminId: "admin-b" });

      expect(mockQueryAuditLogs).toHaveBeenCalledWith(
        expect.objectContaining({ adminId: "admin-a" })
      );
    });

    it("translates page into a database offset", async () => {
      mockQueryAuditLogs.mockResolvedValueOnce({ logs: [{ id: "x" }], total: 45 });

      const res = await request(app)
        .get("/api/admin/audit")
        .query({ page: "3", limit: "20" });

      expect(res.status).toBe(200);
      expect(mockQueryAuditLogs).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 20 })
      );
      expect(res.body.data.pagination).toEqual({
        total: 45,
        limit: 20,
        offset: 40,
        page: 3,
        totalPages: 3,
        hasMore: false,
      });
    });

    it("reports hasMore when further pages exist", async () => {
      mockQueryAuditLogs.mockResolvedValueOnce({ logs: [], total: 120 });

      const res = await request(app)
        .get("/api/admin/audit")
        .query({ page: "1", limit: "50" });

      expect(res.body.data.pagination.hasMore).toBe(true);
      expect(res.body.data.pagination.totalPages).toBe(3);
    });

    it.each([
      [{ limit: "0" }],
      [{ limit: "201" }],
      [{ page: "0" }],
      [{ page: "2", offset: "10" }],
      [{ startDate: "not-a-date" }],
      [{ startDate: "2026-03-01T00:00:00.000Z", endDate: "2026-02-01T00:00:00.000Z" }],
    ])("rejects invalid query %o with 400", async (query) => {
      const res = await request(app).get("/api/admin/audit").query(query);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(mockQueryAuditLogs).not.toHaveBeenCalled();
    });

    it("returns 403 for authenticated users without an admin role", async () => {
      mockAdminUser = { id: "user-1", role: "user" };

      const res = await request(app).get("/api/admin/audit");

      expect(res.status).toBe(403);
      expect(mockQueryAuditLogs).not.toHaveBeenCalled();
    });

    it("allows the admin role as well as super_admin", async () => {
      mockAdminUser = { id: "admin-2", role: "admin" };
      mockQueryAuditLogs.mockResolvedValueOnce({ logs: [], total: 0 });

      const res = await request(app).get("/api/admin/audit");

      expect(res.status).toBe(200);
    });

    it("returns 400 validation error when query parameters are invalid", async () => {
      const res = await request(app)
        .get("/api/admin/audit")
        .query({ limit: "not-a-number" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 500 when database throws an unexpected error", async () => {
      mockQueryAuditLogs.mockRejectedValueOnce(new Error("Database connection failure"));

      const res = await request(app).get("/api/admin/audit");

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    });

    it("returns 401 when unauthenticated", async () => {
      mockAdminUser = null;

      const res = await request(app).get("/api/admin/audit");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/admin/audit/export", () => {
    it("exports audit logs with attachment headers", async () => {
      const sampleLogs = [
        { id: "1", action: "DELETE_USER", resource: "user-1", adminId: "admin-1" },
      ];
      mockGetAuditLogs.mockResolvedValueOnce(sampleLogs);

      const res = await request(app)
        .get("/api/admin/audit/export")
        .query({ action: "DELETE_USER" });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.headers["content-disposition"]).toMatch(/attachment; filename="audit_logs_.*\.json"/);
      expect(res.body.success).toBe(true);
      expect(res.body.data.logs).toEqual(sampleLogs);
      expect(res.body.data.exportedBy).toBe("admin-1");
      expect(res.body.data.filters).toEqual({ action: "DELETE_USER" });
    });

    it("returns 500 when database export operation fails", async () => {
      mockGetAuditLogs.mockRejectedValueOnce(new Error("Disk full or DB error"));

      const res = await request(app).get("/api/admin/audit/export");

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    });
  });
});
