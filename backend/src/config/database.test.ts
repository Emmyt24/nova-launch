/**
 * Unit tests — Database config helpers (config/database.ts)
 *
 * `Database` is a thin static wrapper around the shared Prisma client that
 * maps Prisma rows onto the app-level User/Token/AuditLog shapes. Prisma is
 * mocked throughout so no real database connection is required.
 */

import { describe, it, expect, vi } from "vitest";
import { Database } from "./database";

vi.mock("../lib/prisma", () => ({
  default: {
    user: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    token: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    adminAuditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

async function getPrisma() {
  return (await import("../lib/prisma")).default;
}

const makeUserRow = (o: Record<string, unknown> = {}) => ({
  id: "user-1",
  address: "GUSER",
  role: "user",
  banned: false,
  createdAt: new Date("2026-01-01"),
  lastActive: new Date("2026-01-02"),
  ...o,
});

const makeTokenRow = (o: Record<string, unknown> = {}) => ({
  id: "tok-1",
  name: "Test Token",
  symbol: "TST",
  address: "CTOKEN123",
  creator: "GCREATOR",
  totalSupply: BigInt("1000"),
  totalBurned: BigInt("0"),
  flagged: false,
  deleted: false,
  metadata: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...o,
});

const makeAuditLogRow = (o: Record<string, unknown> = {}) => ({
  id: "log-1",
  adminId: "admin-1",
  action: "BAN_USER",
  resource: "user",
  resourceId: "user-1",
  beforeState: null,
  afterState: null,
  ipAddress: "127.0.0.1",
  userAgent: "test-agent",
  timestamp: new Date("2026-01-01"),
  ...o,
});

// ---------------------------------------------------------------------------
// User operations
// ---------------------------------------------------------------------------

describe("Database user operations", () => {
  it("findUserById maps lastActive to updatedAt", async () => {
    const p = await getPrisma();
    vi.mocked(p.user.findUnique).mockResolvedValue(makeUserRow() as any);

    const result = await Database.findUserById("user-1");

    expect(result).toMatchObject({
      id: "user-1",
      updatedAt: new Date("2026-01-02"),
    });
  });

  it("findUserById returns null when the row is not found", async () => {
    const p = await getPrisma();
    vi.mocked(p.user.findUnique).mockResolvedValue(null);

    const result = await Database.findUserById("missing");
    expect(result).toBeNull();
  });

  it("findUserByAddress queries by address", async () => {
    const p = await getPrisma();
    vi.mocked(p.user.findUnique).mockResolvedValue(makeUserRow() as any);

    await Database.findUserByAddress("GUSER");

    expect(p.user.findUnique).toHaveBeenCalledWith({
      where: { address: "GUSER" },
    });
  });

  it("updateUser returns null when the user does not exist", async () => {
    const p = await getPrisma();
    vi.mocked(p.user.findUnique).mockResolvedValue(null);

    const result = await Database.updateUser("missing", { banned: true });

    expect(result).toBeNull();
    expect(p.user.update).not.toHaveBeenCalled();
  });

  it("updateUser only forwards defined fields to Prisma", async () => {
    const p = await getPrisma();
    vi.mocked(p.user.findUnique).mockResolvedValue(makeUserRow() as any);
    vi.mocked(p.user.update).mockResolvedValue(
      makeUserRow({ banned: true }) as any
    );

    await Database.updateUser("user-1", { banned: true });

    expect(p.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { banned: true },
    });
  });
});

// ---------------------------------------------------------------------------
// Token operations
// ---------------------------------------------------------------------------

describe("Database token operations", () => {
  it("findTokenById maps null metadata to an empty object by default", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findUnique).mockResolvedValue(makeTokenRow() as any);

    const result = await Database.findTokenById("tok-1");

    expect(result?.metadata).toEqual({});
    expect(result?.totalSupply).toBe("1000");
    expect(result?.contractAddress).toBe("CTOKEN123");
  });

  it("findTokenById preserves object metadata when present", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findUnique).mockResolvedValue(
      makeTokenRow({ metadata: { uri: "ipfs://x" } }) as any
    );

    const result = await Database.findTokenById("tok-1");

    expect(result?.metadata).toEqual({ uri: "ipfs://x" });
  });

  it("getAllTokens excludes deleted tokens by default", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findMany).mockResolvedValue([]);

    await Database.getAllTokens();

    expect(p.token.findMany).toHaveBeenCalledWith({
      where: { deleted: false },
      orderBy: { createdAt: "asc" },
    });
  });

  it("getAllTokens includes deleted tokens when overridden", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findMany).mockResolvedValue([]);

    await Database.getAllTokens(true);

    expect(p.token.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: { createdAt: "asc" },
    });
  });

  it("softDeleteToken returns false when the token does not exist", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findUnique).mockResolvedValue(null);

    const result = await Database.softDeleteToken("missing");

    expect(result).toBe(false);
    expect(p.token.update).not.toHaveBeenCalled();
  });

  it("softDeleteToken marks the token deleted and returns true", async () => {
    const p = await getPrisma();
    vi.mocked(p.token.findUnique).mockResolvedValue(makeTokenRow() as any);
    vi.mocked(p.token.update).mockResolvedValue(
      makeTokenRow({ deleted: true }) as any
    );

    const result = await Database.softDeleteToken("tok-1");

    expect(result).toBe(true);
    expect(p.token.update).toHaveBeenCalledWith({
      where: { id: "tok-1" },
      data: { deleted: true },
    });
  });
});

// ---------------------------------------------------------------------------
// Audit log operations
// ---------------------------------------------------------------------------

describe("Database audit log operations", () => {
  it("createAuditLog maps null before/after state through", async () => {
    const p = await getPrisma();
    vi.mocked(p.adminAuditLog.create).mockResolvedValue(
      makeAuditLogRow() as any
    );

    const result = await Database.createAuditLog({
      adminId: "admin-1",
      action: "BAN_USER",
      resource: "user",
      resourceId: "user-1",
      beforeState: null,
      afterState: null,
      ipAddress: "127.0.0.1",
      userAgent: "test-agent",
    });

    expect(result.beforeState).toBeNull();
    expect(result.afterState).toBeNull();
    expect(p.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        beforeState: undefined,
        afterState: undefined,
      }),
    });
  });

  it("getAuditLogs applies no filters by default", async () => {
    const p = await getPrisma();
    vi.mocked(p.adminAuditLog.findMany).mockResolvedValue([]);

    await Database.getAuditLogs();

    expect(p.adminAuditLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { timestamp: "desc" },
    });
  });

  it("getAuditLogs overrides defaults with adminId/action/resource/date filters", async () => {
    const p = await getPrisma();
    vi.mocked(p.adminAuditLog.findMany).mockResolvedValue([]);

    const startDate = new Date("2026-01-01");
    const endDate = new Date("2026-01-31");

    await Database.getAuditLogs({
      adminId: "admin-1",
      action: "BAN",
      resource: "user",
      startDate,
      endDate,
    });

    expect(p.adminAuditLog.findMany).toHaveBeenCalledWith({
      where: {
        adminId: "admin-1",
        action: { contains: "BAN" },
        resource: "user",
        timestamp: { gte: startDate, lte: endDate },
      },
      orderBy: { timestamp: "desc" },
    });
  });

  it("purgeAuditLogs deletes logs older than the given date and returns the count", async () => {
    const p = await getPrisma();
    vi.mocked(p.adminAuditLog.deleteMany).mockResolvedValue({ count: 3 });

    const cutoff = new Date("2026-01-01");
    const result = await Database.purgeAuditLogs(cutoff);

    expect(result).toBe(3);
    expect(p.adminAuditLog.deleteMany).toHaveBeenCalledWith({
      where: { timestamp: { lt: cutoff } },
    });
  });
});

// ---------------------------------------------------------------------------
// initialize (deprecated no-op)
// ---------------------------------------------------------------------------

describe("Database.initialize", () => {
  it("is a no-op kept for call-site compatibility", () => {
    expect(() => Database.initialize()).not.toThrow();
  });
});
