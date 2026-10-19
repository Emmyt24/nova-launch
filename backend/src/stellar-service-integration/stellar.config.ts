export type ExplorerProvider = "stellar.expert" | "stellarchain";

export interface ExplorerConfig {
  provider: ExplorerProvider;
  baseUrl: string;
}

export interface StellarConfig {
  network: "testnet" | "mainnet";
  horizonUrl: string;
  sorobanRpcUrl: string;
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
  circuitBreaker: {
    failureThreshold: number;
    successThreshold: number;
    timeoutMs: number;
  };
  explorer: ExplorerConfig;
}

export const DEFAULT_STELLAR_CONFIG: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  sorobanRpcUrl: "https://soroban-testnet.stellar.org",
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
  circuitBreaker: {
    failureThreshold: 5,
    successThreshold: 2,
    timeoutMs: 60000, // 1 minute
  },
  explorer: {
    provider: "stellar.expert",
    baseUrl: "https://stellar.expert/explorer/testnet",
  },
};