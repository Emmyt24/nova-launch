/**
 * Health check types and interfaces
 */

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export type ServiceStatus = "up" | "down" | "degraded";

export interface ServiceHealth {
  status: ServiceStatus;
  responseTime?: number;
  message?: string;
  error?: string;
  /**
   * When true this service failed because a dependency failed, not on its own.
   * The name of the root-cause service is in `rootCause`. (#1373)
   */
  cascaded?: boolean;
  /** Name of the upstream service that caused this failure, if cascaded. */
  rootCause?: string | null;
}

/**
 * Dependency graph for cascading failure detection (#1373).
 * Key: service name. Value: list of service names that depend on it
 * (i.e. if the key fails, the values are marked cascaded).
 */
export type ServiceDependencyGraph = Record<string, string[]>;

/**
 * Default dependency graph for Nova Launch services.
 *
 * Redis (cache) failure cascades to leaderboard, webhook delivery, and
 * notifications.  Database failure cascades to all data-layer services.
 */
export const DEFAULT_DEPENDENCY_GRAPH: ServiceDependencyGraph = {
  // cache = Redis
  cache: ["stellarHorizon", "stellarSoroban", "ipfs"],
  // database failure leaves ipfs/stellar still independently checkable,
  // but data-layer reads fail
  database: ["ipfs"],
};

export interface HealthCheckResult {
  status: HealthStatus;
  timestamp: string;
  uptime: number;
  version: string;
  services: {
    database: ServiceHealth;
    stellarHorizon: ServiceHealth;
    stellarSoroban: ServiceHealth;
    ipfs: ServiceHealth;
    cache: ServiceHealth;
    redis: ServiceHealth;
  };
}

export interface DetailedHealthCheckResult extends HealthCheckResult {
  metrics: {
    memory: {
      used: number;
      total: number;
      percentage: number;
    };
    cpu: {
      usage: number;
    };
    database: {
      poolSize?: number;
      activeConnections?: number;
      idleConnections?: number;
    };
    requests: {
      total: number;
      errorRate: number;
    };
  };
  /**
   * Per-service circuit breaker state (Pinata, SendGrid, Twilio, Horizon,
   * ...), keyed by service name. Populated from the shared registry in
   * `lib/circuitBreaker.ts` — services register themselves on construction,
   * so an empty object here means no outbound client has been initialized
   * yet (e.g. cold start before the first call to that service).
   */
  circuitBreakers: Record<
    string,
    {
      state: "closed" | "open" | "half-open";
      failureCount: number;
      successCount: number;
      lastFailureTime: number;
      timeSinceLastFailure: number;
    }
  >;
  /** Root-cause service names (services that failed on their own). */
  rootCauses: string[];
}

export interface HealthCheckOptions {
  timeout?: number;
  includeMetrics?: boolean;
}
