/**
 * ⚠️ NO-OP STUB — NOT THE LIVE METRICS MODULE ⚠️
 *
 * Every export in this file (metrics, `register`, `IntegrationMetrics`,
 * `MetricsCollector`, `createMetricsMiddleware`) is a no-op: `.inc()`,
 * `.observe()`, `.set()` and the `record*` helpers do nothing, and
 * `register.metrics()` returns an empty string. Nothing recorded here is ever
 * scraped by Prometheus.
 *
 * The REAL, canonical Prometheus implementation (backed by `prom-client`, wired
 * into `index.ts` via `createMetricsMiddleware()` and exposed at `GET /metrics`)
 * lives in `backend/src/lib/metrics/index.ts`. Add or update metrics THERE.
 *
 * Why this stub still exists: three services still import `IntegrationMetrics`
 * from this path instead of the real module —
 *   - src/services/notificationService.ts
 *   - src/services/webhookDeliveryService.ts
 *   - src/services/stellarEventListener.ts
 * so their integration-metric calls are currently silently discarded. Wiring
 * those imports to `lib/metrics` is tracked by the companion "wire services to
 * real metrics" issue; once that lands this file has no importers and should be
 * deleted outright.
 *
 * Beware: export names here (`httpRequestDuration`, `errorTotal`, …) are nearly
 * identical to the real module's, so an import from the wrong path compiles
 * cleanly and produces a metric that is never recorded.
 */

type LabelValues = Record<string, string | number | boolean | undefined>;

class NoopMetric {
  inc(_labels?: LabelValues, _value?: number): void {}
  observe(_labelsOrValue?: LabelValues | number, _value?: number): void {}
  set(_labelsOrValue?: LabelValues | number, _value?: number): void {}
}

class NoopRegistry {
  setDefaultLabels(_labels: LabelValues): void {}
  async metrics(): Promise<string> {
    return "";
  }
}

const noopMetric = new NoopMetric();

export const register = new NoopRegistry();
export const metricsRegistry = register;

export const httpRequestDuration = noopMetric;
export const httpRequestTotal = noopMetric;
export const httpRequestSize = noopMetric;
export const httpResponseSize = noopMetric;
export const contractInteractionDuration = noopMetric;
export const contractInteractionTotal = noopMetric;
export const contractGasUsed = noopMetric;
export const tokenDeploymentTotal = noopMetric;
export const tokenDeploymentDuration = noopMetric;
export const tokenDeploymentFees = noopMetric;
export const rpcCallDuration = noopMetric;
export const rpcCallTotal = noopMetric;
export const rpcErrorTotal = noopMetric;
export const dbQueryDuration = noopMetric;
export const dbQueryTotal = noopMetric;
export const dbConnectionsActive = noopMetric;
export const dbConnectionsIdle = noopMetric;
export const walletInteractionTotal = noopMetric;
export const walletConnectionDuration = noopMetric;
export const walletSigningDuration = noopMetric;
export const ipfsOperationDuration = noopMetric;
export const ipfsOperationTotal = noopMetric;
export const ipfsFileSize = noopMetric;
export const activeUsers = noopMetric;
export const revenueTotal = noopMetric;
export const userConversionFunnel = noopMetric;
export const featureUsage = noopMetric;
export const errorTotal = noopMetric;
export const errorRate = noopMetric;
export const walletSubmissionTotal = noopMetric;
export const txConfirmationDuration = noopMetric;
export const eventIngestionLag = noopMetric;
export const eventsProcessedTotal = noopMetric;
export const webhookDeliveryTotal = noopMetric;
export const webhookRetryTotal = noopMetric;
export const webhookDeliveryDuration = noopMetric;
export const webhookDeliveryLatency = noopMetric;
export const notificationDeliveryTotal = noopMetric;
export const jobExecutionDuration = noopMetric;
export const jobExecutionTotal = noopMetric;
export const jobQueueSize = noopMetric;
export const healthCheckStatus = noopMetric;
export const healthCheckDuration = noopMetric;

export class IntegrationMetrics {
  static recordWalletSubmission(..._args: any[]): void {}
  static recordTxConfirmation(..._args: any[]): void {}
  static recordIngestionLag(..._args: any[]): void {}
  static recordEventProcessed(..._args: any[]): void {}
  static recordWebhookDelivery(..._args: any[]): void {}
  static recordWebhookDeadLetter(..._args: any[]): void {}
  static recordNotificationDelivery(..._args: any[]): void {}
}

export class MetricsCollector {
  static recordHttpRequest(..._args: any[]): void {}
  static recordContractInteraction(..._args: any[]): void {}
  static recordTokenDeployment(..._args: any[]): void {}
  static recordRPCCall(..._args: any[]): void {}
  static recordDatabaseQuery(..._args: any[]): void {}
  static recordWalletInteraction(..._args: any[]): void {}
  static recordIPFSOperation(..._args: any[]): void {}
  static recordBusinessMetric(..._args: any[]): void {}
  static recordError(..._args: any[]): void {}
  static recordBackgroundJob(..._args: any[]): void {}
  static recordHealthCheck(..._args: any[]): void {}
  static updateDatabaseConnections(..._args: any[]): void {}
  static updateJobQueueSize(..._args: any[]): void {}
  static updateErrorRate(..._args: any[]): void {}
}

export function createMetricsMiddleware() {
  return (_req: any, _res: any, next: any) => {
    next();
  };
}
