import { Router, Request, Response } from "express";
import { Database } from "../config/database";
import { successResponse } from "../utils/response";

const router = Router();

// Cache for analytics data
let analyticsCache: {
  data: any;
  timestamp: number;
} | null = null;

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Server start time for uptime calculation
const serverStartTime = Date.now();

/**
 * GET /api/stats
 * Returns basic platform statistics
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    // Check cache
    const now = Date.now();
    if (analyticsCache && now - analyticsCache.timestamp < CACHE_DURATION) {
      return res.json(successResponse(analyticsCache.data));
    }

    // Fetch fresh data
    const [users, tokens] = await Promise.all([
      Database.getAllUsers(),
      Database.getAllTokens(false),
    ]);

    // Calculate statistics
    const totalTokens = tokens.length;
    const totalUsers = users.length;
    const totalBurned = tokens.reduce((sum, token) => {
      return sum + BigInt(token.burned || "0");
    }, BigInt(0));

    // Calculate uptime
    const uptimeMs = now - serverStartTime;
    const uptimeDays = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
    const uptimeHours = Math.floor(
      (uptimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
    );
    const uptime =
      uptimeDays > 0
        ? `${uptimeDays} day${uptimeDays !== 1 ? "s" : ""}`
        : `${uptimeHours} hour${uptimeHours !== 1 ? "s" : ""}`;

    const stats = {
      totalTokens,
      totalUsers,
      totalBurned: totalBurned.toString(),
      uptime,
      lastUpdated: new Date().toISOString(),
    };

    // Update cache
    analyticsCache = {
      data: stats,
      timestamp: now,
    };

    res.json(successResponse(stats));
  } catch (error) {
    console.error("Analytics error:", error);
    res.status(500).json({
      success: false,
      error: {
        code: "ANALYTICS_ERROR",
        message: "Failed to fetch analytics data",
      },
    });
  }
});

export default router;
