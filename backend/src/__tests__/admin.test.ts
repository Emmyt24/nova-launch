/**
 * Tests for the Database class — #1694.
 *
 * Now that Database delegates to Prisma instead of an in-memory Map, these
 * tests mock the Prisma client so they run without a real database connection.
 * The test behaviour mirrors the original admin.test.ts suite: the same
 * operations must succeed, just against real Prisma queries instead of Maps.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Prisma mock ──────────────────────────────────────────────────

const _userStore: Record<string, any> = {};
const _tokenStore: Record<string, any> = {};
const _auditLogs: any[] = [];

function seedDefaults() {
  _userStore["admin_1"] = {
    id: "admin_1",
    address: "GADMIN123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    role: "super_admin",
    banned: false,
    createdAt: new Date(),
    lastActive: new Date(),
  };
  _tokenStore["token_1"] = {
    id: "token_1",
    name: "Sample Token",
    symbol: "SMPL",
    address: "CTOKEN123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    creator: "GCREATOR123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    totalSupply: BigInt("1000000"),
    totalBurned: BigInt("50000"),
    flagged: false,
    deleted: false,
    metadata: { description: "A sample token" },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

vi.mock("../lib/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(({ where }: any) => {
        if (where.id) return Promise.resolve(_userStore[where.id] ?? null);
        if (where.address)
          return Promise.resolve(
            Object.values(_userStore).find((u: any) => u.address === where.address) ?? null
          );
        return Promise.resolve(null);
      }),
      findMany: vi.fn(() => Promise.resolve(Object.values(_userStore))),
      update: vi.fn(({ where, data }: any) => {
        const row = _userStore[where.id];
        if (!row) return Promise.resolve(null);
        const updated = { ...row, ...data, lastActive: new Date() };
        _userStore[where.id] = updated;
        return Promise.resolve(updated);
      }),
    },
    token: {
      findUnique: vi.fn(({ where }: any) =>
        Promise.resolve(_tokenStore[where.id] ?? null)
      ),
      findMany: vi.fn(({ where }: any) => {
        let rows = Object.values(_tokenStore);
        if (where && where.deleted === false) {
          rows = rows.filter((r: any) => !r.deleted);
        }
        return Promise.resolve(rows);
      }),
      update: vi.fn(({ where, data }: any) => {
        const row = _tokenStore[where.id];
        if (!row) return Promise.resolve(null);
        const updated = { ...row, ...data, updatedAt: new Date() };
        _tokenStore[where.id] = updated;
        return Promise.resolve(updated);
      }),
    },
    adminAuditLog: {
      create: vi.fn((d: any) => {
        const row = {
          id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          timestamp: new Date(),
          ...d.data,
        };
        _auditLogs.push(row);
        return Promise.resolve(row);
      }),
      findMany: vi.fn(({ where }: any) => {
        let logs = [..._auditLogs];
        if (where?.adminId) logs = logs.filter((l) => l.adminId === where.adminId);
        if (where?.action?.contains)
          logs = logs.filter((l) => l.action.includes(where.action.contains));
        if (where?.resource) logs = logs.filter((l) => l.resource === where.resource);
        return Promise.resolve(logs.sort((a, b) => b.timestamp - a.timestamp));
      }),
      deleteMany: vi.fn(() => {
        const count = _auditLogs.length;
        _auditLogs.length = 0;
        return Promise.resolve({ count });
      }),
    },
  },
}));

import { Database } from "../config/database";

beforeEach(() => {
  // Clear stores and re-seed defaults before each test.
  for (const k of Object.keys(_userStore)) delete _userStore[k];
  for (const k of Object.keys(_tokenStore)) delete _tokenStore[k];
  _auditLogs.length = 0;
  seedDefaults();
});

describe("Admin API Tests", () => {
  describe("Database Operations", () => {
    it("should find user by id", async () => {
      const user = await Database.findUserById("admin_1");
      expect(user).toBeDefined();
      expect(user?.role).toBe("super_admin");
    });

    it("should get all tokens", async () => {
      const tokens = await Database.getAllTokens();
      expect(Array.isArray(tokens)).toBe(true);
      expect(tokens.length).toBeGreaterThan(0);
    });

    it("should update token", async () => {
      const updated = await Database.updateToken("token_1", { flagged: true });
      expect(updated?.flagged).toBe(true);
    });

    it("should soft delete token", async () => {
      const success = await Database.softDeleteToken("token_1");
      expect(success).toBe(true);

      const token = await Database.findTokenById("token_1");
      expect(token?.deleted).toBe(true);
    });

    it("should create audit log", async () => {
      const log = await Database.createAuditLog({
        adminId: "admin_1",
        action: "TEST_ACTION",
        resource: "test",
        resourceId: "test_1",
        beforeState: null,
        afterState: { test: true },
        ipAddress: "127.0.0.1",
        userAgent: "test-agent",
      });

      expect(log.id).toBeDefined();
      expect(log.action).toBe("TEST_ACTION");
    });

    it("should filter audit logs by adminId", async () => {
      await Database.createAuditLog({
        adminId: "admin_1",
        action: "CREATE_TOKEN",
        resource: "token",
        resourceId: "token_1",
        beforeState: null,
        afterState: {},
        ipAddress: "127.0.0.1",
        userAgent: "test",
      });

      const logs = await Database.getAuditLogs({ adminId: "admin_1" });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].adminId).toBe("admin_1");
    });
  });

  describe("User Management", () => {
    it("should ban user", async () => {
      const user = await Database.updateUser("admin_1", { banned: true });
      expect(user?.banned).toBe(true);
    });

    it("should change user role", async () => {
      const user = await Database.updateUser("admin_1", { role: "admin" });
      expect(user?.role).toBe("admin");
    });

    it("should find user by address", async () => {
      const user = await Database.findUserByAddress(
        "GADMIN123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      );
      expect(user).toBeDefined();
      expect(user?.id).toBe("admin_1");
    });
  });

  describe("Token Management", () => {
    it("should flag token", async () => {
      const token = await Database.updateToken("token_1", { flagged: true });
      expect(token?.flagged).toBe(true);
    });

    it("should update token metadata", async () => {
      const metadata = { description: "Updated description", verified: true };
      const token = await Database.updateToken("token_1", { metadata });
      expect(token?.metadata).toEqual(metadata);
    });

    it("should exclude deleted tokens by default", async () => {
      await Database.softDeleteToken("token_1");
      const tokens = await Database.getAllTokens(false);
      expect(tokens.find((t) => t.id === "token_1")).toBeUndefined();
    });

    it("should include deleted tokens when requested", async () => {
      await Database.softDeleteToken("token_1");
      const tokens = await Database.getAllTokens(true);
      expect(tokens.find((t) => t.id === "token_1")).toBeDefined();
    });

    it("returned token has contractAddress (mapped from Prisma address)", async () => {
      const token = await Database.findTokenById("token_1");
      expect(token?.contractAddress).toBe("CTOKEN123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    });

    it("returned token has burned (mapped from Prisma totalBurned)", async () => {
      const token = await Database.findTokenById("token_1");
      expect(token?.burned).toBe("50000");
    });
  });
});
