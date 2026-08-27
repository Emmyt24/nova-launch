import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { errorResponse } from "../utils/response";

const router = Router();

// ─── Validation schemas ────────────────────────────────────────────────────

const exportQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((n) => n >= 1 && n <= 10_000, {
      message: "limit must be between 1 and 10000",
    })
    .default(1000),
});

// ─── CSV helpers ───────────────────────────────────────────────────────────

/**
 * Escape a single CSV cell value.
 * Wraps in double-quotes and escapes embedded double-quotes per RFC 4180.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Convert an array of objects to a CSV string. */
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(",")),
  ];
  return lines.join("\n");
}

// ─── Serialisers ──────────────────────────────────────────────────────────

/** Serialise a Token row so BigInt fields become strings. */
function serializeToken(token: {
  id: string;
  address: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  initialSupply: bigint;
  totalBurned: bigint;
  burnCount: number;
  metadataUri: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: token.id,
    address: token.address,
    creator: token.creator,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    totalSupply: token.totalSupply.toString(),
    initialSupply: token.initialSupply.toString(),
    totalBurned: token.totalBurned.toString(),
    burnCount: token.burnCount,
    metadataUri: token.metadataUri ?? "",
    createdAt: token.createdAt.toISOString(),
    updatedAt: token.updatedAt.toISOString(),
  };
}

/** Serialise a BurnRecord row. */
function serializeBurnRecord(record: {
  id: string;
  tokenId: string;
  from: string;
  amount: bigint;
  burnedBy: string;
  isAdminBurn: boolean;
  txHash: string;
  timestamp: Date;
}) {
  return {
    id: record.id,
    tokenId: record.tokenId,
    from: record.from,
    amount: record.amount.toString(),
    burnedBy: record.burnedBy,
    isAdminBurn: record.isAdminBurn,
    txHash: record.txHash,
    timestamp: record.timestamp.toISOString(),
  };
}

// ─── Shared response helper ────────────────────────────────────────────────

function sendExport(
  res: Response,
  format: "json" | "csv",
  resource: string,
  rows: Record<string, unknown>[]
) {
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${resource}-export.csv"`
    );
    return res.send(toCsv(rows));
  }

  return res.json({
    success: true,
    data: rows,
    count: rows.length,
    exportedAt: new Date().toISOString(),
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────

/**
 * GET /api/export/tokens
 * Export token records in JSON or CSV format.
 *
 * Query params:
 *   format     – "json" (default) | "csv"
 *   startDate  – ISO-8601 lower bound on createdAt (inclusive)
 *   endDate    – ISO-8601 upper bound on createdAt (inclusive)
 *   limit      – max rows to return (1–10 000, default 1 000)
 */
router.get("/tokens", async (req: Request, res: Response) => {
  const parsed = exportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(
      errorResponse({
        code: "VALIDATION_ERROR",
        message: "Invalid query parameters",
        details: parsed.error.issues,
      })
    );
  }

  const { format, startDate, endDate, limit } = parsed.data;

  try {
    const where: { createdAt?: { gte?: Date; lte?: Date } } = {};
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const tokens = await prisma.token.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        address: true,
        creator: true,
        name: true,
        symbol: true,
        decimals: true,
        totalSupply: true,
        initialSupply: true,
        totalBurned: true,
        burnCount: true,
        metadataUri: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return sendExport(res, format, "tokens", tokens.map(serializeToken));
  } catch (error) {
    console.error("[export] /tokens error:", error);
    return res.status(500).json(
      errorResponse({
        code: "INTERNAL_ERROR",
        message: "Failed to export tokens",
      })
    );
  }
});

/**
 * GET /api/export/burn-records
 * Export burn record history in JSON or CSV format.
 *
 * Query params:
 *   format     – "json" (default) | "csv"
 *   startDate  – ISO-8601 lower bound on timestamp (inclusive)
 *   endDate    – ISO-8601 upper bound on timestamp (inclusive)
 *   limit      – max rows to return (1–10 000, default 1 000)
 */
router.get("/burn-records", async (req: Request, res: Response) => {
  const parsed = exportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(
      errorResponse({
        code: "VALIDATION_ERROR",
        message: "Invalid query parameters",
        details: parsed.error.issues,
      })
    );
  }

  const { format, startDate, endDate, limit } = parsed.data;

  try {
    const where: { timestamp?: { gte?: Date; lte?: Date } } = {};
    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) where.timestamp.gte = new Date(startDate);
      if (endDate) where.timestamp.lte = new Date(endDate);
    }

    const records = await prisma.burnRecord.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: limit,
      select: {
        id: true,
        tokenId: true,
        from: true,
        amount: true,
        burnedBy: true,
        isAdminBurn: true,
        txHash: true,
        timestamp: true,
      },
    });

    return sendExport(
      res,
      format,
      "burn-records",
      records.map(serializeBurnRecord)
    );
  } catch (error) {
    console.error("[export] /burn-records error:", error);
    return res.status(500).json(
      errorResponse({
        code: "INTERNAL_ERROR",
        message: "Failed to export burn records",
      })
    );
  }
});

export default router;
