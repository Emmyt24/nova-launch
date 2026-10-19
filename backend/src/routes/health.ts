/**
 * Health check router.
 *
 * Endpoints:
 *   GET /health/live    — liveness probe (process is alive, no deps checked)
 *   GET /health/ready   — readiness probe (all dependencies reachable)
 *   GET /health/detail  — detailed probe with memory/CPU/request metrics
 *   GET /health         — alias for /health/ready (backwards compat)
 *
 * HTTP status mapping:
 *   healthy   → 200
 *   degraded  → 207 (partial success)
 *   unhealthy → 503
 *
 * Security:
 *   - No authentication required (standard k8s/load-balancer pattern)
 *   - Detailed endpoint (/health/detail) is disabled in production unless
 *     HEALTH_DETAIL_ENABLED=true is explicitly set, to avoid leaking metrics
 *   - Response times and error messages are included only in non-production
 *     environments unless HEALTH_VERBOSE=true
 */

import { Router, Request, Response } from "express";
import { healthService } from "../lib/health/health.service";
import { rpcEndpointPool } from "../lib/rpc/endpoint-pool";
import { successResponse } from "../utils/response";

const router = Router();

const isProduction = () => process.env.NODE_ENV === "production";
const detailEnabled = () =>
  !isProduction() || process.env.HEALTH_DETAIL_ENABLED === "true";

function statusCode(status: string): number {
  if (status === "healthy") return 200;
  if (status === "degraded") return 207;
  return 503;
}

/**
 * GET /health/live
 * Liveness probe — returns 200 as long as the process is running.
 * Does NOT check external dependencies.
 */
router.get("/live", (_req: Request, res: Response) => {
  res.json(
    successResponse({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    })
  );
});

/**
 * GET /health/ready
 * Readiness probe — checks all dependency connections.
 * Returns 207 if degraded, 503 if unhealthy.
 */
router.get("/ready", async (_req: Request, res: Response) => {
  const result = await healthService.checkHealth();
  res.status(statusCode(result.status)).json(successResponse(result));
});

/**
 * GET /health/detail
 * Detailed health check including memory, CPU, and request metrics.
 * Disabled in production unless HEALTH_DETAIL_ENABLED=true.
 */
router.get("/detail", async (_req: Request, res: Response) => {
  if (!detailEnabled()) {
    return res.status(403).json(
      successResponse({ error: "Detailed health endpoint is disabled in production" })
    );
  }
  const result = await healthService.checkDetailedHealth();
  const endpoints = rpcEndpointPool.getSnapshot();
  res.status(statusCode(result.status)).json(
    successResponse({
      ...result,
      endpoints,
    })
  );
});

/**
 * GET /health
 * Backwards-compatible alias for /health/ready.
 */
router.get("/", async (_req: Request, res: Response) => {
  const result = await healthService.checkHealth();
  res.status(statusCode(result.status)).json(successResponse(result));
});

export default router;
