/**
 * Canonical Prometheus metrics module for the backend.
 *
 * This file holds the REAL implementation (backed by `prom-client`). It is the
 * one wired into `src/index.ts` via `createMetricsMiddleware()` and exposed at
 * `GET /metrics` for Prometheus to scrape. All new backend metrics belong here.
 *
 * Do NOT confuse this with `src/monitoring/metrics/prometheus-config.ts`, which
 * is an all-no-op stub with nearly identical export names
 * (`httpRequestDuration`, `errorTotal`, …). Anything registered against that
 * stub is silently discarded. It survives only because a few services still
 * import `IntegrationMetrics` from it (see the header comment in that file and
 * the companion "wire services to real metrics" issue).
 */

// prom-client is a direct dependency of the backend (see package.json).
// We implement the real metrics here to avoid cross-package path issues.

import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const register = new Registry();

register.setDefaultLabels({
  app: "nova-launch",
  env: process.env.NODE_ENV || "development",
});

collectDefaultMetrics({ register });

export const metricsRegistry = register;

// ---------------------------------------------------------------------------
// HTTP Metrics
// ---------------------------------------------------------------------------

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

export const httpRequestSize = new Histogram({
  name: "http_request_size_bytes",
  help: "Size of HTTP request bodies in bytes",
  labelNames: ["method", "route"],
  buckets: [100, 1_000, 10_000, 100_000, 1_000_000],
  registers: [register],
});

export const httpResponseSize = new Histogram({
  name: "http_response_size_bytes",
  help: "Size of HTTP response bodies in bytes",
  labelNames: ["method", "route", "status_code"],
  buckets: [100, 1_000, 10_000, 100_000, 1_000_000],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Contract Interaction Metrics
// ---------------------------------------------------------------------------

export const contractInteractionDuration = new Histogram({
  name: "contract_interaction_duration_seconds",
  help: "Duration of Soroban contract interactions in seconds",
  labelNames: ["contract", "method", "status"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const contractInteractionTotal = new Counter({
  name: "contract_interactions_total",
  help: "Total number of Soroban contract interactions",
  labelNames: ["contract", "method", "status"],
  registers: [register],
});

export const contractGasUsed = new Histogram({
  name: "contract_gas_used",
  help: "Gas (instructions) used per contract call",
  labelNames: ["contract", "method"],
  buckets: [1_000, 10_000, 100_000, 500_000, 1_000_000, 5_000_000],
  registers: [register],
});

export const tokenDeploymentTotal = new Counter({
  name: "token_deployments_total",
  help: "Total number of token deployments",
  labelNames: ["network", "status"],
  registers: [register],
});

export const tokenDeploymentDuration = new Histogram({
  name: "token_deployment_duration_seconds",
  help: "Duration of token deployment operations in seconds",
  labelNames: ["network", "status"],
  buckets: [1, 5, 10, 30, 60, 120],
  registers: [register],
});

export const tokenDeploymentFees = new Histogram({
  name: "token_deployment_fees_xlm",
  help: "Fees paid for token deployments in XLM",
  labelNames: ["network"],
  buckets: [0.001, 0.01, 0.1, 1, 10],
  registers: [register],
});

// ---------------------------------------------------------------------------
// RPC / Stellar Metrics
// ---------------------------------------------------------------------------

export const rpcCallDuration = new Histogram({
  name: "rpc_call_duration_seconds",
  help: "Duration of Stellar RPC calls in seconds",
  labelNames: ["endpoint", "method", "status"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const rpcCallTotal = new Counter({
  name: "rpc_calls_total",
  help: "Total number of Stellar RPC calls",
  labelNames: ["endpoint", "method", "status"],
  registers: [register],
});

export const rpcErrorTotal = new Counter({
  name: "rpc_errors_total",
  help: "Total number of Stellar RPC errors",
  labelNames: ["endpoint", "error_type"],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Database Metrics
// ---------------------------------------------------------------------------

export const dbQueryDuration = new Histogram({
  name: "db_query_duration_seconds",
  help: "Duration of database queries in seconds",
  labelNames: ["operation", "table", "status"],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const dbQueryTotal = new Counter({
  name: "db_queries_total",
  help: "Total number of database queries",
  labelNames: ["operation", "table", "status"],
  registers: [register],
});

export const dbConnectionsActive = new Gauge({
  name: "db_connections_active",
  help: "Number of active database connections",
  registers: [register],
});

export const dbConnectionsIdle = new Gauge({
  name: "db_connections_idle",
  help: "Number of idle database connections",
  registers: [register],
});

export const dbConnectionsWaiting = new Gauge({
  name: "db_connections_waiting",
  help: "Number of queries waiting to acquire a database connection",
  registers: [register],
});

export const dbPoolSaturation = new Gauge({
  name: "db_pool_saturation",
  help: "Connection pool saturation ratio (active / max pool size)",
  registers: [register],
});

// ---------------------------------------------------------------------------
// Wallet Metrics
// ---------------------------------------------------------------------------

export const walletInteractionTotal = new Counter({
  name: "wallet_interactions_total",
  help: "Total number of wallet interactions",
  labelNames: ["type", "status"],
  registers: [register],
});

export const walletConnectionDuration = new Histogram({
  name: "wallet_connection_duration_seconds",
  help: "Duration of wallet connection operations in seconds",
  labelNames: ["wallet_type", "status"],
  buckets: [0.1, 0.5, 1, 2, 5],
  registers: [register],
});

export const walletSigningDuration = new Histogram({
  name: "wallet_signing_duration_seconds",
  help: "Duration of wallet signing operations in seconds",
  labelNames: ["wallet_type", "status"],
  buckets: [0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// ---------------------------------------------------------------------------
// IPFS Metrics
// ---------------------------------------------------------------------------

export const ipfsOperationDuration = new Histogram({
  name: "ipfs_operation_duration_seconds",
  help: "Duration of IPFS operations in seconds",
  labelNames: ["operation", "status"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const ipfsOperationTotal = new Counter({
  name: "ipfs_operations_total",
  help: "Total number of IPFS operations",
  labelNames: ["operation", "status"],
  registers: [register],
});

export const ipfsFileSize = new Histogram({
  name: "ipfs_file_size_bytes",
  help: "Size of files uploaded to IPFS in bytes",
  labelNames: ["operation"],
  buckets: [1_000, 10_000, 100_000, 1_000_000, 10_000_000],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Business / Product Metrics
// ---------------------------------------------------------------------------

export const activeUsers = new Gauge({
  name: "active_users_total",
  help: "Number of currently active users",
  labelNames: ["period"],
  registers: [register],
});

export const revenueTotal = new Counter({
  name: "revenue_total_xlm",
  help: "Total revenue collected in XLM",
  labelNames: ["source"],
  registers: [register],
});

export const userConversionFunnel = new Counter({
  name: "user_conversion_funnel_total",
  help: "User conversion funnel events",
  labelNames: ["step", "status"],
  registers: [register],
});

export const featureUsage = new Counter({
  name: "feature_usage_total",
  help: "Feature usage events",
  labelNames: ["feature", "action"],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Error Metrics
// ---------------------------------------------------------------------------

export const errorTotal = new Counter({
  name: "errors_total",
  help: "Total number of application errors",
  labelNames: ["type", "severity", "component"],
  registers: [register],
});

export const errorRate = new Gauge({
  name: "error_rate",
  help: "Current error rate (errors per second)",
  labelNames: ["component"],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Stellar / Blockchain Event Metrics
// ---------------------------------------------------------------------------

export const walletSubmissionTotal = new Counter({
  name: "wallet_submissions_total",
  help: "Total number of wallet transaction submissions",
  labelNames: ["network", "status"],
  registers: [register],
});

export const txConfirmationDuration = new Histogram({
  name: "tx_confirmation_duration_seconds",
  help: "Time from submission to confirmation in seconds",
  labelNames: ["network", "status"],
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

export const eventIngestionLag = new Histogram({
  name: "event_ingestion_lag_seconds",
  help: "Lag between on-chain event and backend ingestion in seconds",
  labelNames: ["event_type"],
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const eventsProcessedTotal = new Counter({
  name: "events_processed_total",
  help: "Total number of blockchain events processed",
  labelNames: ["event_type", "status"],
  registers: [register],
});

/**
 * Counts occurrences of the `campaign.event_reordered` projection event —
 * emitted whenever the campaign event buffer (see
 * `services/campaignEventBuffer.ts`) detects that an incoming Stellar event
 * arrived out of ledger order for its campaign stream and had to be held
 * back / reordered before being applied to the projection.
 */
export const campaignEventReorderedTotal = new Counter({
  name: "campaign_event_reordered_total",
  help: "Total number of campaign projection events buffered due to out-of-order ledger delivery (campaign.event_reordered)",
  labelNames: ["event_type", "reason"],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Webhook Metrics
// ---------------------------------------------------------------------------

export const webhookDeliveryTotal = new Counter({
  name: "webhook_deliveries_total",
  help: "Total number of webhook delivery attempts",
  labelNames: ["status", "event_type"],
  registers: [register],
});

export const webhookRetryTotal = new Counter({
  name: "webhook_retries_total",
  help: "Total number of webhook delivery retries",
  labelNames: ["event_type"],
  registers: [register],
});

export const webhookDeliveryDuration = new Histogram({
  name: "webhook_delivery_duration_seconds",
  help: "Duration of webhook delivery attempts in seconds",
  labelNames: ["status", "event_type"],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

/**
 * End-to-end webhook delivery latency from event trigger to final outcome.
 *
 * Buckets chosen to capture fast (<500 ms) deliveries, typical retried
 * deliveries (1–10 s with backoff), and worst-case exhausted retries (≥30 s).
 *
 * Labels:
 *   outcome      – "success" | "failed" | "exhausted"
 *   attempt_count – stringified number of attempts made (1-based)
 */
export const webhookDeliveryLatency = new Histogram({
  name: "webhook_delivery_latency_seconds",
  help: "End-to-end latency from event trigger to final delivery outcome in seconds",
  labelNames: ["outcome", "attempt_count"],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

/**
 * Configured concurrency of the webhook delivery worker pool
 * (WEBHOOK_WORKER_CONCURRENCY). Reported as a gauge so it shows up
 * alongside live queue depth even though it rarely changes at runtime.
 */
export const webhookDeliveryWorkerPoolSize = new Gauge({
  name: "webhook_delivery_worker_pool_size",
  help: "Configured concurrency of the webhook delivery worker pool",
  registers: [register],
});

/**
 * Number of webhook deliveries currently waiting for a free worker slot
 * in the delivery pool (i.e. not yet dispatched).
 */
export const webhookDeliveryQueueDepth = new Gauge({
  name: "webhook_delivery_queue_depth",
  help: "Current number of queued webhook deliveries awaiting a free worker slot",
  registers: [register],
});

// ---------------------------------------------------------------------------
// Background Job Metrics
// ---------------------------------------------------------------------------

export const jobExecutionDuration = new Histogram({
  name: "job_execution_duration_seconds",
  help: "Duration of background job executions in seconds",
  labelNames: ["job_name", "status"],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300],
  registers: [register],
});

export const jobExecutionTotal = new Counter({
  name: "job_executions_total",
  help: "Total number of background job executions",
  labelNames: ["job_name", "status"],
  registers: [register],
});

export const jobQueueSize = new Gauge({
  name: "job_queue_size",
  help: "Current number of jobs in the queue",
  labelNames: ["queue_name"],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Health Check Metrics
// ---------------------------------------------------------------------------

export const healthCheckStatus = new Gauge({
  name: "health_check_status",
  help: "Health check status (1=healthy, 0.5=degraded, 0=unhealthy)",
  labelNames: ["service"],
  registers: [register],
});

export const healthCheckDuration = new Histogram({
  name: "health_check_duration_seconds",
  help: "Duration of health check probes in seconds",
  labelNames: ["service"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Helper Classes
// ---------------------------------------------------------------------------

/**
 * Integration-specific metrics helpers for Stellar event pipeline.
 */
export class IntegrationMetrics {
  static recordWalletSubmission(
    network: string,
    status: "success" | "failure"
  ): void {
    walletSubmissionTotal.inc({ network, status });
  }

  static recordTxConfirmation(
    network: string,
    durationSeconds: number,
    status: "confirmed" | "failed"
  ): void {
    txConfirmationDuration.observe({ network, status }, durationSeconds);
  }

  static recordIngestionLag(eventType: string, lagSeconds: number): void {
    eventIngestionLag.observe({ event_type: eventType }, lagSeconds);
  }

  static recordEventProcessed(
    eventType: string,
    status: "success" | "failure"
  ): void {
    eventsProcessedTotal.inc({ event_type: eventType, status });
  }

  /**
   * Emits the `campaign.event_reordered` metric. Call this whenever the
   * campaign event buffer holds back an out-of-order event (ledger sequence
   * lower than the last-applied sequence for that campaign stream) so it can
   * be replayed in the correct order, or flushes a buffer window that was
   * never fully back in order before the buffer timeout elapsed.
   */
  static recordCampaignEventReordered(
    eventType: string,
    reason: "out_of_order" | "timeout_flush" = "out_of_order"
  ): void {
    campaignEventReorderedTotal.inc({ event_type: eventType, reason });
  }

  static recordWebhookDelivery(
    status: "success" | "failure",
    eventType: string,
    durationSeconds: number,
    isRetry = false
  ): void {
    webhookDeliveryTotal.inc({ status, event_type: eventType });
    webhookDeliveryDuration.observe(
      { status, event_type: eventType },
      durationSeconds
    );
    if (isRetry) webhookRetryTotal.inc({ event_type: eventType });
  }
}

/**
 * General-purpose metrics collector with typed helper methods.
 */
export class MetricsCollector {
  static recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
    reqBytes?: number,
    resBytes?: number
  ): void {
    const labels = { method, route, status_code: String(statusCode) };
    httpRequestDuration.observe(labels, durationSeconds);
    httpRequestTotal.inc(labels);
    if (reqBytes !== undefined)
      httpRequestSize.observe({ method, route }, reqBytes);
    if (resBytes !== undefined) httpResponseSize.observe(labels, resBytes);
  }

  static recordContractInteraction(
    contract: string,
    method: string,
    status: "success" | "failure",
    durationSeconds: number,
    gasUsed?: number
  ): void {
    contractInteractionDuration.observe(
      { contract, method, status },
      durationSeconds
    );
    contractInteractionTotal.inc({ contract, method, status });
    if (gasUsed !== undefined)
      contractGasUsed.observe({ contract, method }, gasUsed);
  }

  static recordTokenDeployment(
    network: string,
    status: "success" | "failure",
    durationSeconds: number,
    feesXlm?: number
  ): void {
    tokenDeploymentTotal.inc({ network, status });
    tokenDeploymentDuration.observe({ network, status }, durationSeconds);
    if (feesXlm !== undefined)
      tokenDeploymentFees.observe({ network }, feesXlm);
  }

  static recordRPCCall(
    endpoint: string,
    method: string,
    status: "success" | "failure",
    durationSeconds: number,
    errorType?: string
  ): void {
    rpcCallDuration.observe({ endpoint, method, status }, durationSeconds);
    rpcCallTotal.inc({ endpoint, method, status });
    if (status === "failure" && errorType) {
      rpcErrorTotal.inc({ endpoint, error_type: errorType });
    }
  }

  static recordDatabaseQuery(
    operation: string,
    table: string,
    status: "success" | "failure",
    durationSeconds: number
  ): void {
    dbQueryDuration.observe({ operation, table, status }, durationSeconds);
    dbQueryTotal.inc({ operation, table, status });
  }

  static recordWalletInteraction(
    type: string,
    status: "success" | "failure",
    durationSeconds?: number
  ): void {
    walletInteractionTotal.inc({ type, status });
    if (durationSeconds !== undefined) {
      walletConnectionDuration.observe(
        { wallet_type: type, status },
        durationSeconds
      );
    }
  }

  static recordIPFSOperation(
    operation: string,
    status: "success" | "failure",
    durationSeconds: number,
    fileSizeBytes?: number
  ): void {
    ipfsOperationDuration.observe({ operation, status }, durationSeconds);
    ipfsOperationTotal.inc({ operation, status });
    if (fileSizeBytes !== undefined)
      ipfsFileSize.observe({ operation }, fileSizeBytes);
  }

  static recordBusinessMetric(feature: string, action: string): void {
    featureUsage.inc({ feature, action });
  }

  static recordError(type: string, severity: string, component: string): void {
    errorTotal.inc({ type, severity, component });
  }

  static recordBackgroundJob(
    jobName: string,
    status: "success" | "failure",
    durationSeconds: number
  ): void {
    jobExecutionDuration.observe(
      { job_name: jobName, status },
      durationSeconds
    );
    jobExecutionTotal.inc({ job_name: jobName, status });
  }

  static recordHealthCheck(
    service: string,
    healthy: boolean,
    durationSeconds: number
  ): void {
    const statusValue = healthy ? 1 : 0;
    healthCheckStatus.set({ service }, statusValue);
    healthCheckDuration.observe({ service }, durationSeconds);
  }

  static updateDatabaseConnections(
    active: number,
    idle: number,
    waiting = 0,
    maxPoolSize = 10
  ): void {
    dbConnectionsActive.set(active);
    dbConnectionsIdle.set(idle);
    dbConnectionsWaiting.set(waiting);
    dbPoolSaturation.set(maxPoolSize > 0 ? active / maxPoolSize : 0);
  }

  static updateJobQueueSize(queueName: string, size: number): void {
    jobQueueSize.set({ queue_name: queueName }, size);
  }

  static updateWebhookWorkerPool(poolSize: number, queueDepth: number): void {
    webhookDeliveryWorkerPoolSize.set(poolSize);
    webhookDeliveryQueueDepth.set(queueDepth);
  }

  static updateErrorRate(component: string, rate: number): void {
    errorRate.set({ component }, rate);
  }
}

/**
 * Express middleware that records HTTP request duration and counts.
 * Attach before route handlers:
 *   app.use(createMetricsMiddleware());
 */
export function createMetricsMiddleware() {
  return (req: any, res: any, next: any): void => {
    const start = process.hrtime.bigint();

    res.on("finish", () => {
      const durationNs = process.hrtime.bigint() - start;
      const durationSeconds = Number(durationNs) / 1e9;

      // Normalise route: use express matched route or fall back to path
      const route =
        (req.route?.path as string | undefined) ?? req.path ?? "unknown";
      const method = req.method ?? "UNKNOWN";
      const statusCode = res.statusCode;

      const reqBytes = req.headers["content-length"]
        ? parseInt(req.headers["content-length"] as string, 10)
        : undefined;
      const resBytes = res.getHeader("content-length")
        ? parseInt(res.getHeader("content-length") as string, 10)
        : undefined;

      MetricsCollector.recordHttpRequest(
        method,
        route,
        statusCode,
        durationSeconds,
        reqBytes,
        resBytes
      );
    });

    next();
  };
}
