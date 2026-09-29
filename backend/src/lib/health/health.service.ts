import { prisma } from "../prisma";
import {
  HealthStatus,
  ServiceHealth,
  HealthCheckResult,
  DetailedHealthCheckResult,
  HealthCheckOptions,
  DEFAULT_DEPENDENCY_GRAPH,
  ServiceDependencyGraph,
} from "./health.types";
import { validateEnv } from "../../config/env";
import { getCircuitBreakerRegistrySnapshot } from "../circuitBreaker";
import { dispatchAlert } from "../pagerduty";
import { checkDatabaseHealth } from "../db";

const _env = validateEnv();

/**
 * Health check service for monitoring application and dependency status
 */
export class HealthService {
  private static instance: HealthService;
  private readonly startTime: number;
  private readonly cache = new TTLCache(30_000);
  private readonly version: string;
  private requestCount = 0;
  private errorCount = 0;

  private constructor() {
    this.startTime = Date.now();
    this.version = process.env.npm_package_version || "0.1.0";
  }

  static getInstance(): HealthService {
    if (!HealthService.instance) {
      HealthService.instance = new HealthService();
    }
    return HealthService.instance;
  }

  /**
   * Increment request counter
   */
  incrementRequestCount(): void {
    this.requestCount++;
  }

  /**
   * Increment error counter
   */
  incrementErrorCount(): void {
    this.errorCount++;
  }

  /**
   * Get uptime in seconds
   */
  getUptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Get application version
   */
  getVersion(): string {
    return this.version;
  }

  /**
   * Perform basic health check
   */
  async checkHealth(
    options: HealthCheckOptions = {}
  ): Promise<HealthCheckResult> {
    const cacheKey = "health-check-basic";
    const cached = this.cache.get<HealthCheckResult>(cacheKey);

    if (cached) {
      return cached;
    }

    const timeout = options.timeout || 5000;
    const services = await this.checkAllServices(timeout);
    const overallStatus = this.determineOverallStatus(services);

    const result: HealthCheckResult = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: this.getUptime(),
      version: this.getVersion(),
      services,
    };

    this.cache.set<HealthCheckResult>(cacheKey, result);
    return result;
  }

  /**
   * Perform detailed health check with metrics
   */
  async checkDetailedHealth(
    options: HealthCheckOptions = {}
  ): Promise<DetailedHealthCheckResult> {
    const cacheKey = "health-check-detailed";
    const cached = this.cache.get<DetailedHealthCheckResult>(cacheKey);

    if (cached) {
      return cached;
    }

    const basicHealth = await this.checkHealth(options);
    const services = { ...basicHealth.services };
    const rootCauses = this.applyCascadingFailures(services, DEFAULT_DEPENDENCY_GRAPH);

    // Alert PagerDuty once per root cause (#1373)
    for (const svcName of rootCauses) {
      try {
        const message = (services as any)[svcName]?.error ?? "service down";
        await dispatchAlert("dependency-health-critical", {
          summary: `Nova Launch: ${svcName} is down (${message})`,
          dedupKey: `health-service-${svcName}`,
          source: "health.service",
          customDetails: { service: svcName, message },
        });
      } catch {
        // Non-fatal — alerting must not block the health response
      }
    }

    const metrics = await this.collectMetrics();
    const circuitBreakers = getCircuitBreakerRegistrySnapshot();

    const result: DetailedHealthCheckResult = {
      ...basicHealth,
      services,
      metrics,
      circuitBreakers,
      rootCauses,
    };

    this.cache.set<DetailedHealthCheckResult>(cacheKey, result);
    return result;
  }

  /**
   * Traverse the dependency graph and mark downstream services as cascaded.
   * Returns the list of root-cause service names (failed on their own).
   */
  applyCascadingFailures(
    services: Record<string, ServiceHealth>,
    graph: ServiceDependencyGraph = DEFAULT_DEPENDENCY_GRAPH
  ): string[] {
    const rootCauses: string[] = [];

    for (const [upstream, dependents] of Object.entries(graph)) {
      const upstreamHealth = services[upstream];
      if (!upstreamHealth || upstreamHealth.status === "up") continue;

      // This upstream service is a root cause
      rootCauses.push(upstream);

      for (const dep of dependents) {
        const depHealth = services[dep];
        if (!depHealth) continue;
        // Only mark as cascaded if it hasn't already failed on its own
        if (depHealth.status !== "up" && !depHealth.cascaded) {
          depHealth.cascaded = true;
          depHealth.rootCause = upstream;
        } else if (depHealth.status === "up") {
          // Cascade the failure down — this dependency is impacted even if
          // its own check succeeded (the check may not reflect the runtime impact yet)
          depHealth.status = "degraded";
          depHealth.cascaded = true;
          depHealth.rootCause = upstream;
          depHealth.message = `Cascaded failure from ${upstream}`;
        }
      }
    }

    // Any failing service not already marked cascaded is a root cause
    for (const [name, svc] of Object.entries(services)) {
      if (svc.status !== "up" && !svc.cascaded && !rootCauses.includes(name)) {
        rootCauses.push(name);
      }
    }

    return [...new Set(rootCauses)];
  }

  /**
   * Check all service dependencies
   */
  private async checkAllServices(
    timeout: number
  ): Promise<HealthCheckResult["services"]> {
    const [database, stellarHorizon, stellarSoroban, ipfs, cache] =
      await Promise.all([
        this.checkDatabase(timeout),
        this.checkStellarHorizon(timeout),
        this.checkStellarSoroban(timeout),
        this.checkIpfs(timeout),
        this.checkCache(timeout),
      ]);

    return {
      database,
      stellarHorizon,
      stellarSoroban,
      ipfs,
      cache,
    };
  }

  /**
   * Check database connectivity.
   *
   * Delegates to the single canonical Prisma `SELECT 1` probe in
   * `lib/db.ts` (`checkDatabaseHealth`) so the timeout/race logic and error
   * formatting live in exactly one place (#2062).
   */
  private async checkDatabase(timeout: number): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      const result = await checkDatabaseHealth({ timeout });

      if (!result.healthy) {
        return {
          status: "down",
          responseTime: Date.now() - start,
          error: result.error ?? "Database check failed",
        };
      }

      return {
        status: "up",
        responseTime: Date.now() - start,
      };
    } catch (error) {
      return {
        status: "down",
        responseTime: Date.now() - start,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Check Stellar Horizon API
   */
  private async checkStellarHorizon(timeout: number): Promise<ServiceHealth> {
    const start = Date.now();
    const horizonUrl = _env.STELLAR_HORIZON_URL;

    try {
      const response = await Promise.race([
        fetch(`${horizonUrl}/`),
        this.timeoutPromise(timeout, "Horizon check timeout"),
      ]);

      if (response.ok) {
        return {
          status: "up",
          responseTime: Date.now() - start,
        };
      }

      return {
        status: "degraded",
        responseTime: Date.now() - start,
        message: `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        status: "down",
        responseTime: Date.now() - start,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Check Stellar Soroban RPC
   */
  private async checkStellarSoroban(timeout: number): Promise<ServiceHealth> {
    const start = Date.now();
    const sorobanUrl = _env.STELLAR_SOROBAN_RPC_URL;

    try {
      const response = await Promise.race([
        fetch(sorobanUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getHealth",
            params: [],
          }),
        }),
        this.timeoutPromise(timeout, "Soroban check timeout"),
      ]);

      if (response.ok) {
        return {
          status: "up",
          responseTime: Date

/* … truncated 5407 chars — edit only what you need near the top … */
