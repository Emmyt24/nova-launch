import { Router, Request, Response } from "express";
import {
  getMostBurnedLeaderboard,
  getMostActiveLeaderboard,
  getNewestTokensLeaderboard,
  getLargestSupplyLeaderboard,
  getMostBurnersLeaderboard,
  getCacheStatus,
  TimePeriod,
} from "../services/leaderboardService";
import { successResponse, errorResponse } from "../utils/response";
import { parseLeaderboardWindow } from "../lib/validation/leaderboardWindow";

const router = Router();

/**
 * Resolve the time window from `?period=` (or its `?window=` alias).
 * Responds 400 and returns null for unsupported values (#2204).
 */
function resolvePeriod(
  req: Request,
  res: Response,
  fallback: TimePeriod = TimePeriod.D7
): TimePeriod | null {
  if (req.query.period !== undefined && req.query.window !== undefined) {
    res.status(400).json(
      errorResponse({
        code: "INVALID_PARAMETERS",
        message: "Provide either period or window, not both",
        details: { parameter: "period" },
      })
    );
    return null;
  }

  const parsed = parseLeaderboardWindow(
    req.query.period ?? req.query.window,
    fallback
  );
  if (!parsed.ok) {
    res.status(400).json(errorResponse(parsed.error));
    return null;
  }
  return parsed.window;
}

function validatePagination(page?: string, limit?: string) {
  const parsedPage = parseInt(page || "1", 10);
  const parsedLimit = parseInt(limit || "10", 10);

  return {
    page: isNaN(parsedPage) || parsedPage < 1 ? 1 : Math.min(parsedPage, 100),
    limit:
      isNaN(parsedLimit) || parsedLimit < 1 ? 10 : Math.min(parsedLimit, 100),
  };
}

/**
 * GET /api/leaderboard/most-burned
 * Returns tokens with highest burn volume
 * Query: period=24h|7d|30d|all (default: 7d)
 */
router.get("/most-burned", async (req: Request, res: Response) => {
  try {
    const period = resolvePeriod(req, res);
    if (!period) return;
    const { page, limit } = validatePagination(
      req.query.page as string,
      req.query.limit as string
    );

    const result = await getMostBurnedLeaderboard(period, page, limit);
    res.json(successResponse(result));
  } catch (error) {
    console.error("Error fetching most-burned leaderboard:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch leaderboard",
      })
    );
  }
});

/**
 * GET /api/leaderboard/most-active
 * Returns tokens with most burn transactions
 * Query: period=24h|7d|30d|all (default: 7d)
 */
router.get("/most-active", async (req: Request, res: Response) => {
  try {
    const period = resolvePeriod(req, res);
    if (!period) return;
    const { page, limit } = validatePagination(
      req.query.page as string,
      req.query.limit as string
    );

    const result = await getMostActiveLeaderboard(period, page, limit);
    res.json(successResponse(result));
  } catch (error) {
    console.error("Error fetching most-active leaderboard:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch leaderboard",
      })
    );
  }
});

/**
 * GET /api/leaderboard/newest
 * Returns recently created tokens
 * Query: period=24h|7d|30d|all (default: all) — only tokens created in the window
 */
router.get("/newest", async (req: Request, res: Response) => {
  try {
    const { page, limit } = validatePagination(
      req.query.page as string,
      req.query.limit as string
    );

    const period = resolvePeriod(req, res, TimePeriod.ALL);
    if (!period) return;

    const result = await getNewestTokensLeaderboard(page, limit, period);
    res.json(successResponse(result));
  } catch (error) {
    console.error("Error fetching newest leaderboard:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch leaderboard",
      })
    );
  }
});

/**
 * GET /api/leaderboard/largest-supply
 * Returns tokens with highest total supply
 * Query: period=24h|7d|30d|all (default: all) — only tokens created in the window
 */
router.get("/largest-supply", async (req: Request, res: Response) => {
  try {
    const { page, limit } = validatePagination(
      req.query.page as string,
      req.query.limit as string
    );

    const period = resolvePeriod(req, res, TimePeriod.ALL);
    if (!period) return;

    const result = await getLargestSupplyLeaderboard(page, limit, period);
    res.json(successResponse(result));
  } catch (error) {
    console.error("Error fetching largest-supply leaderboard:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch leaderboard",
      })
    );
  }
});

/**
 * GET /api/leaderboard/most-burners
 * Returns tokens with most unique burners
 * Query: period=24h|7d|30d|all (default: 7d)
 */
router.get("/most-burners", async (req: Request, res: Response) => {
  try {
    const period = resolvePeriod(req, res);
    if (!period) return;
    const { page, limit } = validatePagination(
      req.query.page as string,
      req.query.limit as string
    );

    const result = await getMostBurnersLeaderboard(period, page, limit);
    res.json(successResponse(result));
  } catch (error) {
    console.error("Error fetching most-burners leaderboard:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch leaderboard",
      })
    );
  }
});

/**
 * GET /api/leaderboard/cache-status
 * Health-monitoring endpoint reporting whether the Redis sorted-set cache
 * is reachable/warm for each rank-style board, or currently operating in
 * full-recomputation fallback mode.
 */
router.get("/cache-status", async (_req: Request, res: Response) => {
  try {
    const status = await getCacheStatus();
    res.json(successResponse(status));
  } catch (error) {
    console.error("Error fetching leaderboard cache status:", error);
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch cache status",
      })
    );
  }
});

export default router;
