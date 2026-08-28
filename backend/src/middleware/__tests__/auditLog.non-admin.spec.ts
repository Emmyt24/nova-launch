import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { auditLog } from "../auditLog";
import { Database } from "../../config/database";
import { AuthRequest } from "../auth";
import { Response } from "express";

describe("auditLog middleware - non-admin user coverage", () => {
  let mockCreateAuditLog: any;
  let capturedLogs: any[] = [];

  beforeEach(() => {
    capturedLogs = [];
    mockCreateAuditLog = vi
      .spyOn(Database, "createAuditLog")
      .mockImplementation(async (entry) => {
        capturedLogs.push(entry);
        return {
          id: "audit-id",
          adminId: entry.adminId,
          action: entry.action,
          resource: entry.resource,
          resourceId: entry.resourceId,
          beforeState: entry.beforeState,
          afterState: entry.afterState,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
          timestamp: new Date(),
        };
      });

    vi.spyOn(Database, "findTokenById").mockResolvedValue(null);
    vi.spyOn(Database, "findUserById").mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    capturedLogs = [];
  });

  describe("admin user mutations", () => {
    it("should log when admin performs a PATCH mutation", async () => {
      const middleware = auditLog("update_token", "token");
      const req = {
        method: "PATCH",
        headers: { "user-agent": "test-agent" },
        params: { id: "token-123" },
        ip: "192.168.1.1",
        admin: {
          id: "admin-user-id",
          address: "admin-address",
          role: "admin",
          banned: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      } as unknown as AuthRequest;

      const res = {
        json: vi.fn(function (data) {
          return this;
        }),
      } as unknown as Response;

      const next = vi.fn();

      await middleware(req, res, next);

      // Trigger the res.json override
      const jsonFunc = res.json as any;
      jsonFunc({ id: "token-123", name: "Updated Token" });

      expect(capturedLogs).toHaveLength(1);
      expect(capturedLogs[0].adminId).toBe("admin-user-id");
      expect(capturedLogs[0].action).toBe("PATCH update_token");
    });
  });

  describe("non-admin user mutations", () => {
    it("should log when non-admin user performs a PATCH mutation", async () => {
      const middleware = auditLog("update_resource", "resource");
      const req = {
        method: "PATCH",
        headers: { "user-agent": "test-agent" },
        params: { id: "resource-123" },
        ip: "192.168.1.1",
        user: {
          id: "regular-user-id",
          address: "user-address",
          role: "user",
          banned: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      } as unknown as AuthRequest;

      const res = {
        json: vi.fn(function (data) {
          return this;
        }),
      } as unknown as Response;

      const next = vi.fn();

      await middleware(req, res, next);

      // Trigger the res.json override
      const jsonFunc = res.json as any;
      jsonFunc({ id: "resource-123", name: "Updated Resource" });

      expect(capturedLogs).toHaveLength(1);
      expect(capturedLogs[0].adminId).toBe("regular-user-id");
      expect(capturedLogs[0].action).toBe("PATCH update_resource");
    });

    it("should log when non-admin user performs a DELETE mutation", async () => {
      const middleware = auditLog("delete_resource", "resource");
      const req = {
        method: "DELETE",
        headers: { "user-agent": "test-agent" },
        params: { id: "resource-123" },
        ip: "192.168.1.1",
        user: {
          id: "regular-user-id",
          address: "user-address",
          role: "user",
          banned: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      } as unknown as AuthRequest;

      const res = {
        json: vi.fn(function (data) {
          return this;
        }),
      } as unknown as Response;

      const next = vi.fn();

      await middleware(req, res, next);

      // Trigger the res.json override
      const jsonFunc = res.json as any;
      jsonFunc({ success: true });

      expect(capturedLogs).toHaveLength(1);
      expect(capturedLogs[0].adminId).toBe("regular-user-id");
      expect(capturedLogs[0].action).toBe("DELETE delete_resource");
    });

    it("should not log when neither admin nor user is authenticated", async () => {
      const middleware = auditLog("update_resource", "resource");
      const req = {
        method: "PATCH",
        headers: { "user-agent": "test-agent" },
        params: { id: "resource-123" },
        ip: "192.168.1.1",
      } as unknown as AuthRequest;

      const res = {
        json: vi.fn(function (data) {
          return this;
        }),
      } as unknown as Response;

      const next = vi.fn();

      await middleware(req, res, next);

      // Trigger the res.json override
      const jsonFunc = res.json as any;
      jsonFunc({ id: "resource-123" });

      expect(capturedLogs).toHaveLength(0);
    });
  });

  describe("admin takes precedence over user", () => {
    it("should prefer admin over user when both are present", async () => {
      const middleware = auditLog("update_token", "token");
      const req = {
        method: "PATCH",
        headers: { "user-agent": "test-agent" },
        params: { id: "token-123" },
        ip: "192.168.1.1",
        admin: {
          id: "admin-user-id",
          address: "admin-address",
          role: "admin",
          banned: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        user: {
          id: "regular-user-id",
          address: "user-address",
          role: "user",
          banned: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      } as unknown as AuthRequest;

      const res = {
        json: vi.fn(function (data) {
          return this;
        }),
      } as unknown as Response;

      const next = vi.fn();

      await middleware(req, res, next);

      // Trigger the res.json override
      const jsonFunc = res.json as any;
      jsonFunc({ id: "token-123" });

      expect(capturedLogs).toHaveLength(1);
      expect(capturedLogs[0].adminId).toBe("admin-user-id");
    });
  });

  describe("audit log metadata", () => {
    it("should capture correct metadata for non-admin mutations", async () => {
      const middleware = auditLog("update_token", "token");
      const req = {
        method: "PATCH",
        headers: { "user-agent": "Mozilla/5.0" },
        params: { id: "token-123" },
        ip: "10.0.0.1",
        user: {
          id: "user-id",
          address: "user-addr",
          role: "user",
          banned: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      } as unknown as AuthRequest;

      const res = {
        json: vi.fn(function (data) {
          return this;
        }),
      } as unknown as Response;

      const next = vi.fn();

      await middleware(req, res, next);

      // Trigger the res.json override
      const jsonFunc = res.json as any;
      jsonFunc({ result: "ok" });

      expect(capturedLogs[0].ipAddress).toBe("10.0.0.1");
      expect(capturedLogs[0].userAgent).toBe("Mozilla/5.0");
      expect(capturedLogs[0].resource).toBe("token");
      expect(capturedLogs[0].resourceId).toBe("token-123");
    });
  });
});
