import { Router, Request, Response } from "express";
import { performance } from "perf_hooks";
import { prisma } from "../lib/prisma";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { TokenSearchResponse } from "../contracts/apiSchemas";

const router = Router();

// Validation schema for search parameters
const searchParamsSchema = z.object({
  q: z.string().optional(),
  creator: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  minSupply: z.string().regex(/^\d+$/).optional(),
  maxSupply: z.string().regex(/^\d+$/).optional(),
  hasBurns: z.enum(["true", "false"]).optional(),
  sortBy: z.enum(["created", "burned", "supply", "name"]).default("created"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  page: z.string().regex(/^\d+$/).default("1"),
  limit: z.string().regex(/^\d+$/).default("20"),
});

// Cache configuration
const CACHE_TTL = 60 * 1000; // 1 minute
const cache = new Map<string, { data: any; timestamp: number }>();

function getCacheKey(params: Record<string, any>): string {
  return JSON.stringify(params);
}

function getFromCache(key: string) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key: string, data: any) {
  cache.set(key, { data, timestamp: Date.now() });

  // Clean old cache entries
  if (cache.size > 100) {
    const oldestKey = Array.from(cache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    )[0][0];
    cache.delete(oldestKey);
  }
}

/**
 * GET /api/tokens/search
 * Search and discover tokens with filters, sorting, and pagination
 */
router.get("/search", async (req: Request, res: Response) => {
  try {
    // Validate parameters
    const validationResult = searchParamsSchema.safeParse(req.query);

    if (!validationResult.success) {
      return res.status(400).json({
        success: false,
        error: "Invalid parameters",
        details: validationResult.error.errors,
      });
    }

    const params = validationResult.data;

    // Check cache
    const cacheKey = getCacheKey(params);
    const cachedResult = getFromCache(cacheKey);
    if (cachedResult) {
      return res.json({
        ...cachedResult,
        cached: true,
      });
    }

    // Parse pagination
    const page = parseInt(params.page);
    const limit = Math.min(parseInt(params.limit), 50); // Max 50 per page
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Prisma.TokenWhereInput = {};

    // Full-text search by name or symbol
    if (params.q) {
      where.OR = [
        { name: { contains: params.q, mode: "insensitive" } },
        { symbol: { contains: params.q, mode: "insensitive" } },
      ];
    }

    // Filter by creator
    if (params.creator) {
      where.creator = params.creator;
    }

    // Filter by creation date range
    if (params.startDate || params.endDate) {
      where.createdAt = {};
      if (params.startDate) {
        where.createdAt.gte = new Date(params.startDate);
      }
      if (params.endDate) {
        where.createdAt.lte = new Date(params.endDate);
      }
    }

    // Filter by supply range
    if (params.minSupply || params.maxSupply) {
      where.totalSupply = {};
      if (params.minSupply) {
        where.totalSupply.gte = BigInt(params.minSupply);
      }
      if (params.maxSupply) {
        where.totalSupply.lte = BigInt(params.maxSupply);
      }
    }

    // Filter by burn status
    if (params.hasBurns === "true") {
      where.burnCount = { gt: 0 };
    } else if (params.hasBurns === "false") {
      where.burnCount = 0;
    }

    // Build orderBy clause
    let orderBy: Prisma.TokenOrderByWithRelationInput = {};

    switch (params.sortBy) {
      case "created":
        orderBy = { createdAt: params.sortOrder };
        break;
      case "burned":
        orderBy = { totalBurned: params.sortOrder };
        break;
      case "supply":
        orderBy = { totalSupply: params.sortOrder };
        break;
      case "name":
        orderBy = { name: params.sortOrder };
        break;
    }

    // Execute queries in parallel
    const start = performance.now();
    const [tokens, total] = await Promise.all([
      prisma.token.findMany({
        where,
        orderBy,
        skip,
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
      }),
      prisma.token.count({ where }),
    ]);
    const duration = performance.now() - start;
    if (duration > 150) {
      console.warn(`[PERF] Token search took ${duration.toFixed(2)}ms`);
    }


    // Convert BigInt to string for JSON serialization
    const serializedTokens = tokens.map((token) => ({
      ...token,
      totalSupply: token.totalSupply.toString(),
      initialSupply: token.initialSupply.toString(),
      totalBurned: token.totalBurned.toString(),
    }));

    const totalPages = Math.ceil(total / limit);

    const response: TokenSearchResponse = {
      success: true,
      data: serializedTokens as any,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
      filters: {
        q: params.q,
        creator: params.creator,
        startDate: params.startDate,
        endDate: params.endDate,
        minSupply: params.minSupply,
        maxSupply: params.maxSupply,
        hasBurns: params.hasBurns,
        sortBy: params.sortBy,
        sortOrder: params.sortOrder,
      },
    };

    // Cache the result
    setCache(cacheKey, response);

    return res.json(response);
  } catch (error) {
    console.error("Token search error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
