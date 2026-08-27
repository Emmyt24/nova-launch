import prisma from "../lib/prisma";
import { User, Token, AuditLog } from "../types";

// ---------------------------------------------------------------------------
// Field-mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a Prisma User row to the application's User interface.
 * Prisma stores `lastActive` as the auto-updated timestamp; the app surface
 * exposes it as `updatedAt` to stay compatible with existing route/test code.
 */
function mapUser(row: {
  id: string;
  address: string;
  role: string;
  banned: boolean;
  createdAt: Date;
  lastActive: Date;
}): User {
  return {
    id: row.id,
    address: row.address,
    role: row.role as User["role"],
    banned: row.banned,
    createdAt: row.createdAt,
    updatedAt: row.lastActive,
  };
}

/**
 * Map a Prisma Token row to the application's Token interface.
 * Prisma fields                  → App fields
 *   address                     → contractAddress
 *   creator                     → creatorAddress
 *   totalBurned (BigInt)        → burned (string)
 *   totalSupply (BigInt)        → totalSupply (string)
 *   metadata (Json | null)      → metadata (Record<string, any>)
 */
function mapToken(row: {
  id: string;
  name: string;
  symbol: string;
  address: string;
  creator: string;
  totalSupply: bigint;
  totalBurned: bigint;
  flagged: boolean;
  deleted: boolean;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): Token {
  return {
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    contractAddress: row.address,
    creatorAddress: row.creator,
    totalSupply: row.totalSupply.toString(),
    burned: row.totalBurned.toString(),
    flagged: row.flagged,
    deleted: row.deleted,
    metadata:
      row.metadata != null && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapAuditLog(row: {
  id: string;
  adminId: string;
  action: string;
  resource: string;
  resourceId: string;
  beforeState: unknown;
  afterState: unknown;
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
}): AuditLog {
  return {
    id: row.id,
    adminId: row.adminId,
    action: row.action,
    resource: row.resource,
    resourceId: row.resourceId,
    beforeState:
      row.beforeState != null && typeof row.beforeState === "object"
        ? (row.beforeState as Record<string, unknown>)
        : null,
    afterState:
      row.afterState != null && typeof row.afterState === "object"
        ? (row.afterState as Record<string, unknown>)
        : null,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    timestamp: row.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Database class — all methods delegate to Prisma
// ---------------------------------------------------------------------------

/**
 * Admin database helpers.
 *
 * All public method signatures are preserved from the original in-memory
 * stub so that route code requires no changes.  The implementation now
 * delegates to the shared Prisma client instead of operating on ephemeral
 * in-memory Maps.
 */
export class Database {
  // ── User operations ───────────────────────────────────────────────────────

  static async findUserById(id: string): Promise<User | null> {
    const row = await prisma.user.findUnique({ where: { id } });
    return row ? mapUser(row) : null;
  }

  static async findUserByAddress(address: string): Promise<User | null> {
    const row = await prisma.user.findUnique({ where: { address } });
    return row ? mapUser(row) : null;
  }

  static async getAllUsers(): Promise<User[]> {
    const rows = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(mapUser);
  }

  static async updateUser(
    id: string,
    updates: Partial<User>
  ): Promise<User | null> {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return null;

    // Map app-level field names back to Prisma column names.
    const data: Record<string, unknown> = {};
    if (updates.banned !== undefined) data.banned = updates.banned;
    if (updates.role !== undefined) data.role = updates.role;
    // updatedAt is managed automatically by Prisma (lastActive @updatedAt).

    const row = await prisma.user.update({ where: { id }, data });
    return mapUser(row);
  }

  // ── Token operations ──────────────────────────────────────────────────────

  static async findTokenById(id: string): Promise<Token | null> {
    const row = await prisma.token.findUnique({ where: { id } });
    return row ? mapToken(row) : null;
  }

  static async getAllTokens(includeDeleted = false): Promise<Token[]> {
    const rows = await prisma.token.findMany({
      where: includeDeleted ? undefined : { deleted: false },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapToken);
  }

  static async updateToken(
    id: string,
    updates: Partial<Token>
  ): Promise<Token | null> {
    const existing = await prisma.token.findUnique({ where: { id } });
    if (!existing) return null;

    // Map app-level field names back to Prisma column names.
    const data: Record<string, unknown> = {};
    if (updates.flagged !== undefined) data.flagged = updates.flagged;
    if (updates.deleted !== undefined) data.deleted = updates.deleted;
    if (updates.metadata !== undefined) data.metadata = updates.metadata;
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.symbol !== undefined) data.symbol = updates.symbol;

    const row = await prisma.token.update({ where: { id }, data });
    return mapToken(row);
  }

  static async softDeleteToken(id: string): Promise<boolean> {
    const existing = await prisma.token.findUnique({ where: { id } });
    if (!existing) return false;

    await prisma.token.update({
      where: { id },
      data: { deleted: true },
    });
    return true;
  }

  // ── Audit log operations ──────────────────────────────────────────────────

  static async createAuditLog(
    log: Omit<AuditLog, "id" | "timestamp">
  ): Promise<AuditLog> {
    const row = await prisma.adminAuditLog.create({
      data: {
        adminId: log.adminId,
        action: log.action,
        resource: log.resource,
        resourceId: log.resourceId,
        beforeState:
          log.beforeState != null
            ? (log.beforeState as object)
            : undefined,
        afterState:
          log.afterState != null
            ? (log.afterState as object)
            : undefined,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
      },
    });
    return mapAuditLog(row);
  }

  static async purgeAuditLogs(olderThan: Date): Promise<number> {
    const result = await prisma.adminAuditLog.deleteMany({
      where: { timestamp: { lt: olderThan } },
    });
    return result.count;
  }

  static async getAuditLogs(filters?: {
    adminId?: string;
    action?: string;
    resource?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<AuditLog[]> {
    const rows = await prisma.adminAuditLog.findMany({
      where: {
        ...(filters?.adminId ? { adminId: filters.adminId } : {}),
        ...(filters?.action
          ? { action: { contains: filters.action } }
          : {}),
        ...(filters?.resource ? { resource: filters.resource } : {}),
        ...(filters?.startDate || filters?.endDate
          ? {
              timestamp: {
                ...(filters.startDate ? { gte: filters.startDate } : {}),
                ...(filters.endDate ? { lte: filters.endDate } : {}),
              },
            }
          : {}),
      },
      orderBy: { timestamp: "desc" },
    });
    return rows.map(mapAuditLog);
  }

  /**
   * Test-only helper: delete all audit log rows created during a test.
   * Not used by production code paths.
   */
  static async __resetAuditLogsForTests(): Promise<void> {
    await prisma.adminAuditLog.deleteMany();
  }

  /**
   * @deprecated `initialize()` seeded the old in-memory stub.
   * This no-op is kept so any existing call sites compile without changes;
   * real seed data must be inserted via `prisma/seed.ts` or test helpers.
   */
  static initialize(): void {
    // No-op: seed data is now managed by prisma/seed.ts and test fixtures.
  }
}
