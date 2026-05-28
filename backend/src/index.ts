import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { corsOptions } from "./config/cors";
import { validateEnv } from "./config/env";
import { runStartupValidation } from "./config/startupValidation";
import adminRoutes from "./routes/admin";
import analyticsRoutes from "./routes/analytics";
import leaderboardRoutes from "./routes/leaderboard";
import tokenRoutes from "./routes/tokens";
import dividendRoutes from "./routes/dividends";
import statsRoutes from "./routes/stats";
import governanceRoutes from "./routes/governance";
import campaignRoutes from "./routes/campaigns";
import streamRoutes from "./routes/streams";
import vaultRoutes from "./routes/vaults";
import versionRoutes from "./routes/version";
import searchRoutes from "./routes/search";
import exportRoutes from "./routes/export";
import graphqlRouter from "./graphql";
import openApiRouter from "./lib/openapi/router";
import { Database } from "./config/database";
import { successResponse, errorResponse } from "./utils/response";
import { requestLoggingMiddleware } from "./middleware/request-logging.middleware";
import { createTimeoutMiddleware } from "./middleware/timeout";
import { createQueryTimeoutMiddleware } from "./middleware/queryTimeout";
import { createMetricsMiddleware, metricsRegistry } from "./lib/metrics";
import stellarEventListener from "./services/stellarEventListener";
import websocketService from "./services/websocket";

dotenv.config();

// Validate required environment variables before starting the server.
// This will throw and exit if any required variable is missing or invalid.
const env = validateEnv();

const app = express();
const PORT = env.PORT;

// Request logging middleware (first to capture all requests)
app.use(requestLoggingMiddleware);

// Request timeout — responds 503 if a handler takes too long
app.use(createTimeoutMiddleware());

// Attach default DB query timeout to res.locals for downstream handlers
app.use(createQueryTimeoutMiddleware());

// Prometheus metrics middleware — records HTTP request duration and counts
app.use(createMetricsMiddleware());

// Security middleware
app.use(helmet());
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
});

app.use("/api/admin", limiter);
app.use("/api/analytics", limiter);
app.use("/api/leaderboard", limiter);
app.use("/api/tokens", limiter);
app.use("/api/dividends", limiter);
app.use("/api/stats", limiter);
app.use("/api/governance", limiter);
app.use("/api/campaigns", limiter);
app.use("/api/streams", limiter);
app.use("/api/vaults", limiter);

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize database
Database.initialize();

// Routes
app.use("/api/admin", adminRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/tokens", tokenRoutes);
app.use("/api/dividends", dividendRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/governance", governanceRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/streams", streamRoutes);
app.use("/api/vaults", vaultRoutes);
app.use("/api/version", versionRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/graphql", graphqlRouter);
app.use("/api/docs", openApiRouter);

import { healthService } from "./lib/health/health.service";
import { isAppError, toAppError } from "./lib/errors";

// Health check — liveness (is the process alive?)
app.get("/health/live", (_req, res) => {
  res.json(successResponse({ status: "ok", uptime: process.uptime() }));
});

// Health check — readiness (are all dependencies reachable?)
app.get("/health/ready", async (_req, res) => {
  const result = await healthService.checkHealth();
  const httpStatus =
    result.status === "healthy"
      ? 200
      : result.status === "degraded"
        ? 207
        : 503;
  res.status(httpStatus).json(successResponse(result));
});

// Legacy /health — kept for backwards compatibility, maps to readiness
app.get("/health", async (_req, res) => {
  const result = await healthService.checkHealth();
  const httpStatus =
    result.status === "healthy"
      ? 200
      : result.status === "degraded"
        ? 207
        : 503;
  res.status(httpStatus).json(successResponse(result));
});

/**
 * GET /metrics
 * Prometheus metrics endpoint — scraped by Prometheus every 15 s.
 *
 * Security: restrict to internal network in production (e.g. via nginx
 * allow/deny or a network policy). The endpoint is intentionally unauthenticated
 * so Prometheus can scrape it without credentials.
 *
 * Disable by setting METRICS_ENABLED=false.
 */
if (process.env.METRICS_ENABLED !== "false") {
  app.get("/metrics", async (_req, res) => {
    try {
      res.set("Content-Type", metricsRegistry.contentType);
      res.end(await metricsRegistry.metrics());
    } catch (err) {
      res.status(500).end(String(err));
    }
  });
}

// Error handling middleware — uses AppError framework for typed, consistent responses
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const appErr = toAppError(err);
    const isDev = process.env.NODE_ENV === "development";

    if (appErr.httpStatus >= 500) {
      console.error("Error:", err);
    }

    res.status(appErr.httpStatus).json(appErr.toHttpResponse(isDev));
  }
);

// 404 handler
app.use((req, res) => {
  res.status(404).json(
    errorResponse({
      code: "NOT_FOUND",
      message: "Route not found",
    })
  );
});

const server = app.listen(PORT, async () => {
  console.log(`🚀 Admin API server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);

  // Attach WebSocket server for live event streaming
  websocketService.attach(server);

  // Start event listener only after server (and DB) are ready
  if (process.env.ENABLE_EVENT_LISTENER === "true") {
    await stellarEventListener.start();
  }
});

export default app;
