export type ExplorerProvider = "stellar.expert" | "stellarchain";

export interface ExplorerConfig {
  provider: ExplorerProvider;
  baseUrl: string;
}

export interface EndpointHealthCheckConfig {
  /** How often to probe each endpoint, in milliseconds. */
  intervalMs: number;
  /** Per-probe request timeout, in milliseconds. */
  timeoutMs: number;
  /** Consecutive failures before an endpoint is marked unhealthy. */
  failureThreshold: number;
  /** Consecutive successes before an unhealthy endpoint is marked healthy again. */
  successThreshold: number;
}

export interface StellarConfig {
  network: "testnet" | "mainnet";
  horizonUrl: string;
  sorobanRpcUrl: string;
  /** All Horizon endpoints for the network, in failover order. */
  horizonUrls: string[];
  /** All Soroban RPC endpoints for the network, in failover order. */
  sorobanRpcUrls: string[];
  factoryContractId: string;
  requestTimeout: number;
  retry: {
    maxAttempts: number;
    initialDelay: number;
    maxDelay: number;
    backoffFactor: number;
  };
  rateLimit: {
    maxRequests: number;
    windowMs: number;
  };
  /** Shared token bucket limiting retries across all RPC calls (#2201). */
  retryBudget: {
    capacity: number;
    refillPerSecond: number;
    depositPerSuccess: number;
  };
  circuitBreaker: {
    failureThreshold: number;
    successThreshold: number;
    timeoutMs: number;
  };
  explorer: ExplorerConfig;
  endpointHealthCheck: EndpointHealthCheckConfig;
}

export const DEFAULT_STELLAR_CONFIG: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  sorobanRpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrls: ["https://horizon-testnet.stellar.org"],
  sorobanRpcUrls: ["https://soroban-testnet.stellar.org"],
  factoryContractId: "",
  requestTimeout: 30000,
  retry: {
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffFactor: 2,
  },
  rateLimit: {
    maxRequests: 100,
    windowMs: 60000,
  },
  retryBudget: {
    capacity: 20,
    refillPerSecond: 1,
    depositPerSuccess: 0.1,
  },
  circuitBreaker: {
    failureThreshold: 5,
    successThreshold: 2,
    timeoutMs: 60000, // 1 minute
  },
  explorer: {
    provider: "stellar.expert",
    baseUrl: "https://stellar.expert/explorer/testnet",
  },
  endpointHealthCheck: {
    intervalMs: 30000,
    timeoutMs: 5000,
    failureThreshold: 3,
    successThreshold: 2,
  },
};

/**
 * Parse a comma-separated list of endpoint URLs from an environment value.
 * Falls back to the provided default when the value is empty or undefined.
 * Duplicates and blank entries are removed while preserving order.
 */
export function parseEndpointList(
  value: string | undefined | null,
  fallback: string | string[],
): string[] {
  const fallbackList = Array.isArray(fallback) ? fallback : [fallback];
  const parsed = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const result = parsed.length > 0 ? parsed : fallbackList;
  return Array.from(new Set(result));
}

function parsePositiveInt(value: string | undefined | null, fallback: number): number {
  if (value === undefined || value === null || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Build a StellarConfig from environment variables, supporting multiple
 * comma-separated endpoints per network for failover.
 *
 * Recognised variables:
 * - STELLAR_NETWORK
 * - STELLAR_HORIZON_URL / STELLAR_HORIZON_URLS
 * - STELLAR_SOROBAN_RPC_URL / STELLAR_SOROBAN_RPC_URLS
 * - STELLAR_FACTORY_CONTRACT_ID
 * - STELLAR_REQUEST_TIMEOUT
 * - STELLAR_HEALTH_CHECK_INTERVAL_MS
 * - STELLAR_HEALTH_CHECK_TIMEOUT_MS
 * - STELLAR_HEALTH_CHECK_FAILURE_THRESHOLD
 * - STELLAR_HEALTH_CHECK_SUCCESS_THRESHOLD
 */
export function loadStellarConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): StellarConfig {
  const network = env.STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const defaults = DEFAULT_STELLAR_CONFIG;

  const horizonUrls = parseEndpointList(
    env.STELLAR_HORIZON_URLS ?? env.STELLAR_HORIZON_URL,
    defaults.horizonUrls,
  );
  const sorobanRpcUrls = parseEndpointList(
    env.STELLAR_SOROBAN_RPC_URLS ?? env.STELLAR_SOROBAN_RPC_URL,
    defaults.sorobanRpcUrls,
  );

  return {
    ...defaults,
    network,
    horizonUrl: horizonUrls[0],
    sorobanRpcUrl: sorobanRpcUrls[0],
    horizonUrls,
    sorobanRpcUrls,
    factoryContractId: env.STELLAR_FACTORY_CONTRACT_ID ?? defaults.factoryContractId,
    requestTimeout: parsePositiveInt(env.STELLAR_REQUEST_TIMEOUT, defaults.requestTimeout),
    endpointHealthCheck: {
      intervalMs: parsePositiveInt(
        env.STELLAR_HEALTH_CHECK_INTERVAL_MS,
        defaults.endpointHealthCheck.intervalMs,
      ),
      timeoutMs: parsePositiveInt(
        env.STELLAR_HEALTH_CHECK_TIMEOUT_MS,
        defaults.endpointHealthCheck.timeoutMs,
      ),
      failureThreshold: parsePositiveInt(
        env.STELLAR_HEALTH_CHECK_FAILURE_THRESHOLD,
        defaults.endpointHealthCheck.failureThreshold,
      ),
      successThreshold: parsePositiveInt(
        env.STELLAR_HEALTH_CHECK_SUCCESS_THRESHOLD,
        defaults.endpointHealthCheck.successThreshold,
      ),
    },
  };
}
