import express, { Router } from "express";
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
import statsRoutes from "./routes/stats";
import governanceRoutes from "./routes/governance";
import errorRoutes from "./routes/errors";
import vaultRoutes from "./routes/vaults";
import campaignRoutes from "./routes/campaigns";
import versionRoutes from "./routes/version";
import searchRoutes from "./routes/search";
import exportRoutes from "./routes/export";
import stellarRoutes from "./routes/stellar";
import deployStatusRoutes from "./routes/deployStatus";
import discoveryRoutes from "./routes/discovery";
import webhooksRoutes from "./routes/webhooks";
import webhooksDeadletterRoutes from "./routes/webhooks-deadletter";
import eventsRoutes from "./routes/events";
import graphqlRouter, { attachGraphqlSubscriptions } from "./graphql";
import openApiRouter from "./lib/openapi/router";
import { Database } from "./config/database";
import { successResponse, errorResponse } from "./utils/response";
import { requestLoggingMiddleware } from "./middleware/request-logging.middleware";
import { createTimeoutMiddleware } from "./middleware/timeout";
import { createQueryTimeoutMiddleware } from "./middleware/queryTimeout";
import { createMetricsMiddleware, metricsRegistry } from "./lib/metrics";
import { registerPoolMetrics } from "./lib/metrics/poolMetrics";
import { registerPrismaTracing } from "./lib/metrics/prismaTracing";
import { prisma, baseClient } from "./lib/prisma";
import stellarEventListener from "./services/stellarEventListener";
import websocketService from "./services/websocket";
import jobQueue from "./services/jobQueue";
import { streamReconciliationService } from "./services/streamReconciliation";
import "./services/streamDivergenceAlerting";
import sagaCoordinator from "./services/sagaCoordinator";
import "./services/sagas/batchDeployGovernanceSaga";
import { runProjectionSnapshotJob } from "./services/projectionSnapshotJob";

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

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize database and pool metrics
Database.initialize();
registerPoolMetrics(baseClient);
registerPrismaTracing(baseClient);

// ---------------------------------------------------------------------------
// Versioned API router (v1)
//
// All routes live under /api/v1/<resource>.  A backward-compat alias mounts
// the same router at /api/<resource> so existing clients continue to work.
//
// The X-API-Version response header tells clients which version served them.
// ---------------------------------------------------------------------------

const v1Router = Router();

// Version header on every v1 response
v1Router.use((_req, res, next) => {
  res.setHeader("X-API-Version", "v1");
  next();
});

v1Router.use("/admin", limiter, adminRoutes);
v1Router.use("/analytics", limiter, analyticsRoutes);
v1Router.use("/leaderboard", limiter, leaderboardRoutes);
v1Router.use("/tokens", limiter, tokenRoutes);
v1Router.use("/stats", limiter, statsRoutes);
v1Router.use("/governance", limiter, governanceRoutes);
v1Router.use("/errors", limiter, errorRoutes);
v1Router.use("/vaults", limiter, vaultRoutes);
v1Router.use("/campaigns", limiter, campaignRoutes);
v1Router.use("/version", versionRoutes);
v1Router.use("/search", searchRoutes);
v1Router.use("/export", exportRoutes);
v1Router.use("/stellar", limiter, stellarRoutes);
v1Router.use("/deploy", limiter, deployStatusRoutes);
v1Router.use("/discovery", discoveryRoutes);
v1Router.use("/webhooks", limiter, webhooksRoutes);
v1Router.use("/webhooks-deadletter", limiter, webhooksDeadletterRoutes);
v1Router.use("/events", eventsRoutes);
v1Router.use("/graphql", graphqlRouter);
v1Router.use("/docs", openApiRouter);

// Canonical versioned mount
app.use("/api/v1", v1Router);

// Backward-compatibility alias — clients targeting /api/<resource> continue to work
app.use("/api", v1Router);

import { healthService } from "./lib/health/health.service";
import { isAppError, toAppError } from "./lib/errors";
import { getCorrelationId, getTransactionId } from "./lib/async-context";

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
    const correlationId = getCorrelationId() ?? (req as any).correlationId;
    const transactionId = getTransactionId() ?? (req as any).transactionId;

    if (appErr.httpStatus >= 500) {
      console.error("Error:", err);
    }

    const body = appErr.toHttpResponse(isDev);
    if (correlationId) {
      (body as any).correlationId = correlationId;
    }
    if (transactionId) {
      (body as any).transactionId = transactionId;
    }
    res.status(appErr.httpStatus).json(body);
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

  // Register job handlers
  jobQueue.register("stream_reconciliation", async (job) => {
    const result = await streamReconciliationService.reconcile();
    if (result.divergences.length > 0) {
      console.warn(
        `Stream reconciliation found ${result.divergences.length} divergences`
      );
    }
  });

  // Start job queue
  jobQueue.start();

  // Schedule periodic stream reconciliation if enabled
  if (process.env.ENABLE_STREAM_RECONCILIATION === "true") {
    const reconciliationInterval = parseInt(
      process.env.STREAM_RECONCILIATION_INTERVAL_MS || "300000" // 5 minutes default
    );
    jobQueue.scheduleRecurring(
      "stream_reconciliation",
      {},
      reconciliationInterval
    );
    console.log(
      `📋 Stream reconciliation scheduled every ${reconciliationInterval}ms`
    );
  }

  // Register and schedule periodic cross-projection snapshot capture if enabled
  jobQueue.register("projection_snapshot", async () => {
    await runProjectionSnapshotJob(prisma);
  });
  if (process.env.ENABLE_PROJECTION_SNAPSHOTS === "true") {
    const snapshotInterval = parseInt(
      process.env.PROJECTION_SNAPSHOT_INTERVAL_MS || "1800000" // 30 minutes default
    );
    jobQueue.scheduleRecurring("projection_snapshot", {}, snapshotInterval);
    console.log(
      `📋 Projection snapshot capture scheduled every ${snapshotInterval}ms`
    );
  }

  // Attach WebSocket server for live event streaming
  websocketService.attach(server);

  // Attach GraphQL subscriptions (graphql-ws) on the /graphql WS path
  attachGraphqlSubscriptions(server);

  // Resume or compensate any sagas left in-flight by a prior process restart
  await sagaCoordinator.recoverInterruptedSagas();

  // Start event listener only after server (and DB) are ready
  if (process.env.ENABLE_EVENT_LISTENER === "true") {
    await stellarEventListener.start();
  }
});

export default app;
