/**
 * Unit tests for the Prometheus metrics module.
 *
 * Tests cover:
 *  - Registry initialisation and default labels
 *  - Counter, Histogram, and Gauge metric creation
 *  - MetricsCollector helper methods
 *  - IntegrationMetrics helper methods
 *  - createMetricsMiddleware Express middleware
 *  - /metrics endpoint output format
 */

import { describe, it, expect, vi } from "vitest";
import {
  metricsRegistry,
  MetricsCollector,
  IntegrationMetrics,
  createMetricsMiddleware,
} from "../index";

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

describe("MetricsCollector", () => {
  it("recordHttpRequest does not throw", () => {
    expect(() =>
      MetricsCollector.recordHttpRequest(
        "GET",
        "/api/tokens",
        200,
        0.05,
        512,
        1024
      )
    ).not.toThrow();
  });

  it("recordHttpRequest without optional bytes does not throw", () => {
    expect(() =>
      MetricsCollector.recordHttpRequest("POST", "/api/tokens", 201, 0.1)
    ).not.toThrow();
  });

  it("recordContractInteraction records success", () => {
    expect(() =>
      MetricsCollector.recordContractInteraction(
        "token-factory",
        "deploy",
        "success",
        5.2,
        100_000
      )
    ).not.toThrow();
  });

  it("recordContractInteraction records failure without gas", () => {
    expect(() =>
      MetricsCollector.recordContractInteraction(
        "token-factory",
        "deploy",
        "failure",
        1.0
      )
    ).not.toThrow();
  });

  it("recordTokenDeployment records success with fees", () => {
    expect(() =>
      MetricsCollector.recordTokenDeployment("testnet", "success", 12.5, 0.01)
    ).not.toThrow();
  });

  it("recordTokenDeployment records failure without fees", () => {
    expect(() =>
      MetricsCollector.recordTokenDeployment("mainnet", "failure", 3.0)
    ).not.toThrow();
  });

  it("recordRPCCall records success", () => {
    expect(() =>
      MetricsCollector.recordRPCCall("horizon", "getAccount", "success", 0.2)
    ).not.toThrow();
  });

  it("recordRPCCall records failure with error type", () => {
    expect(() =>
      MetricsCollector.recordRPCCall(
        "soroban",
        "simulateTransaction",
        "failure",
        0.5,
        "timeout"
      )
    ).not.toThrow();
  });

  it("recordDatabaseQuery records success", () => {
    expect(() =>
      MetricsCollector.recordDatabaseQuery("SELECT", "tokens", "success", 0.003)
    ).not.toThrow();
  });

  it("recordWalletInteraction records with duration", () => {
    expect(() =>
      MetricsCollector.recordWalletInteraction("freighter", "success", 1.5)
    ).not.toThrow();
  });

  it("recordWalletInteraction records without duration", () => {
    expect(() =>
      MetricsCollector.recordWalletInteraction("xbull", "failure")
    ).not.toThrow();
  });

  it("recordIPFSOperation records with file size", () => {
    expect(() =>
      MetricsCollector.recordIPFSOperation("upload", "success", 2.1, 50_000)
    ).not.toThrow();
  });

  it("recordIPFSOperation records without file size", () => {
    expect(() =>
      MetricsCollector.recordIPFSOperation("pin", "failure", 0.5)
    ).not.toThrow();
  });

  it("recordBusinessMetric does not throw", () => {
    expect(() =>
      MetricsCollector.recordBusinessMetric("token-deployment", "started")
    ).not.toThrow();
  });

  it("recordError does not throw", () => {
    expect(() =>
      MetricsCollector.recordError("validation", "warning", "api")
    ).not.toThrow();
  });

  it("recordBackgroundJob does not throw", () => {
    expect(() =>
      MetricsCollector.recordBackgroundJob("event-listener", "success", 0.5)
    ).not.toThrow();
  });

  it("recordHealthCheck sets healthy status", () => {
    expect(() =>
      MetricsCollector.recordHealthCheck("database", true, 0.01)
    ).not.toThrow();
  });

  it("recordHealthCheck sets unhealthy status", () => {
    expect(() =>
      MetricsCollector.recordHealthCheck("stellarHorizon", false, 5.0)
    ).not.toThrow();
  });

  it("updateDatabaseConnections does not throw", () => {
    expect(() =>
      MetricsCollector.updateDatabaseConnections(5, 15)
    ).not.toThrow();
  });

  it("updateJobQueueSize does not throw", () => {
    expect(() =>
      MetricsCollector.updateJobQueueSize("webhooks", 42)
    ).not.toThrow();
  });

  it("updateErrorRate does not throw", () => {
    expect(() => MetricsCollector.updateErrorRate("api", 0.02)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// IntegrationMetrics
// ---------------------------------------------------------------------------

describe("IntegrationMetrics", () => {
  it("recordWalletSubmission does not throw", () => {
    expect(() =>
      IntegrationMetrics.recordWalletSubmission("testnet", "success")
    ).not.toThrow();
  });

  it("recordTxConfirmation does not throw", () => {
    expect(() =>
      IntegrationMetrics.recordTxConfirmation("testnet", 8.5, "confirmed")
    ).not.toThrow();
  });

  it("recordIngestionLag does not throw", () => {
    expect(() =>
      IntegrationMetrics.recordIngestionLag("TokenMinted", 2.3)
    ).not.toThrow();
  });

  it("recordEventProcessed does not throw", () => {
    expect(() =>
      IntegrationMetrics.recordEventProcessed("TokenBurned", "success")
    ).not.toThrow();
  });

  it("recordWebhookDelivery success without retry", () => {
    expect(() =>
      IntegrationMetrics.recordWebhookDelivery(
        "success",
        "TokenMinted",
        0.3,
        false
      )
    ).not.toThrow();
  });

  it("recordWebhookDelivery failure with retry", () => {
    expect(() =>
      IntegrationMetrics.recordWebhookDelivery(
        "failure",
        "TokenBurned",
        5.0,
        true
      )
    ).not.toThrow();
  });

  it("recordWebhookDelivery uses default isRetry=false", () => {
    expect(() =>
      IntegrationMetrics.recordWebhookDelivery(
        "success",
        "TokenTransferred",
        0.1
      )
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createMetricsMiddleware
// ---------------------------------------------------------------------------

describe("createMetricsMiddleware", () => {
  it("returns a function", () => {
    const middleware = createMetricsMiddleware();
    expect(typeof middleware).toBe("function");
  });

  it("calls next()", () => {
    const middleware = createMetricsMiddleware();
    const next = vi.fn();
    const req = {
      method: "GET",
      path: "/api/tokens",
      headers: {},
      route: { path: "/api/tokens" },
    };
    const res = {
      statusCode: 200,
      on: vi.fn(),
      getHeader: vi.fn().mockReturnValue(undefined),
    };
    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("registers a finish listener on the response", () => {
    const middleware = createMetricsMiddleware();
    const next = vi.fn();
    const onMock = vi.fn();
    const req = {
      method: "POST",
      path: "/api/tokens",
      headers: { "content-length": "256" },
      route: undefined,
    };
    const res = {
      statusCode: 201,
      on: onMock,
      getHeader: vi.fn().mockReturnValue("512"),
    };
    middleware(req, res, next);
    expect(onMock).toHaveBeenCalledWith("finish", expect.any(Function));
  });

  it("finish callback does not throw on valid response", () => {
    const middleware = createMetricsMiddleware();
    const next = vi.fn();
    let finishCallback: (() => void) | undefined;
    const req = {
      method: "DELETE",
      path: "/api/tokens/123",
      headers: {},
      route: { path: "/api/tokens/:id" },
    };
    const res = {
      statusCode: 204,
      on: (event: string, cb: () => void) => {
        if (event === "finish") finishCallback = cb;
      },
      getHeader: vi.fn().mockReturnValue(undefined),
    };
    middleware(req, res, next);
    expect(() => finishCallback?.()).not.toThrow();
  });

  it("handles missing route and path gracefully", () => {
    const middleware = createMetricsMiddleware();
    const next = vi.fn();
    let finishCallback: (() => void) | undefined;
    const req = {
      method: "GET",
      path: undefined,
      headers: {},
      route: undefined,
    };
    const res = {
      statusCode: 404,
      on: (event: string, cb: () => void) => {
        if (event === "finish") finishCallback = cb;
      },
      getHeader: vi.fn().mockReturnValue(undefined),
    };
    middleware(req, res, next);
    expect(() => finishCallback?.()).not.toThrow();
  });

  it("uses a bounded label for unmatched paths", () => {
    const middleware = createMetricsMiddleware();
    const recordRequest = vi.spyOn(MetricsCollector, "recordHttpRequest");
    let finishCallback: (() => void) | undefined;
    const req = {
      method: "GET",
      path: "/api/tokens/variable-address",
      headers: {},
      route: undefined,
    };
    const res = {
      statusCode: 404,
      on: (event: string, cb: () => void) => {
        if (event === "finish") finishCallback = cb;
      },
      getHeader: vi.fn().mockReturnValue(undefined),
    };

    middleware(req, res, vi.fn());
    finishCallback?.();

    expect(recordRequest).toHaveBeenCalledWith(
      "GET",
      "unmatched",
      404,
      expect.any(Number),
      undefined,
      undefined,
    );
    recordRequest.mockRestore();
  });

  it("records request bytes from content-length header", () => {
    const middleware = createMetricsMiddleware();
    const next = vi.fn();
    let finishCallback: (() => void) | undefined;
    const req = {
      method: "POST",
      path: "/api/tokens",
      headers: { "content-length": "1024" },
      route: { path: "/api/tokens" },
    };
    const res = {
      statusCode: 200,
      on: (event: string, cb: () => void) => {
        if (event === "finish") finishCallback = cb;
      },
      getHeader: vi.fn().mockReturnValue("2048"),
    };
    middleware(req, res, next);
    expect(() => finishCallback?.()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// metricsRegistry
// ---------------------------------------------------------------------------

describe("metricsRegistry", () => {
  it("has a metrics() method", () => {
    expect(typeof metricsRegistry.metrics).toBe("function");
  });

  it("metrics() returns a string", async () => {
    const output = await metricsRegistry.metrics();
    expect(typeof output).toBe("string");
  });

  it("metrics output contains nodejs default metrics", async () => {
    const output = await metricsRegistry.metrics();
    expect(output).toContain("nodejs_");
  });

  it("metrics output contains http_requests_total", async () => {
    const output = await metricsRegistry.metrics();
    expect(output).toContain("http_requests_total");
  });

  it("metrics output contains token_deployments_total", async () => {
    const output = await metricsRegistry.metrics();
    expect(output).toContain("token_deployments_total");
  });

  it("metrics output contains health_check_status", async () => {
    const output = await metricsRegistry.metrics();
    expect(output).toContain("health_check_status");
  });

  it("metrics output contains event_ingestion_lag_seconds", async () => {
    const output = await metricsRegistry.metrics();
    expect(output).toContain("event_ingestion_lag_seconds");
  });

  it("metrics output contains webhook_deliveries_total", async () => {
    const output = await metricsRegistry.metrics();
    expect(output).toContain("webhook_deliveries_total");
  });

  it("contentType is the Prometheus text format", () => {
    expect(metricsRegistry.contentType).toContain("text/plain");
  });
});
