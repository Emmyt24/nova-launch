export interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  admin: string;
}

export interface BurnEvent {
  txHash: string;
  ledger: number;
  timestamp: string;
  from: string;
  amount: string;
  tokenAddress: string;
}

export interface FactoryState {
  contractId: string;
  admin: string;
  totalTokens: number;
  tokens: string[];
  isPaused: boolean;
}

export interface ParsedContractEvent {
  type: string;
  contractId: string;
  topics: unknown[];
  data: unknown;
  ledger: number;
  txHash: string;
  timestamp: string;
}

export interface TransactionDetails {
  hash: string;
  ledger: number;
  createdAt: string;
  sourceAccount: string;
  fee: string;
  status: TransactionStatus;
  memo?: string;
  operationCount: number;
  envelopeXdr: string;
  resultXdr: string;
  resultMetaXdr: string;
}

export type TransactionStatus = "pending" | "success" | "failed" | "not_found";

export interface MonitorTransactionResult {
  hash: string;
  status: TransactionStatus;
  ledger?: number;
  createdAt?: string;
  errorMessage?: string;
  attempts: number;
}

export interface StellarError {
  code: StellarErrorCode;
  message: string;
  details?: unknown;
}

export enum StellarErrorCode {
  NETWORK_ERROR = "NETWORK_ERROR",
  INVALID_ADDRESS = "INVALID_ADDRESS",
  CONTRACT_ERROR = "CONTRACT_ERROR",
  TRANSACTION_FAILED = "TRANSACTION_FAILED",
  RATE_LIMITED = "RATE_LIMITED",
  TIMEOUT = "TIMEOUT",
  NOT_FOUND = "NOT_FOUND",
  PARSE_ERROR = "PARSE_ERROR",
  UNKNOWN = "UNKNOWN",
}

export interface ContractCallOptions {
  timeout?: number;
  retries?: number;
}

export interface TokenCreationFeeQuoteOptions {
  /** Account that would pay the creation fee. */
  creator?: string;
  /** Token name used for the quote (may affect metadata-based pricing). */
  name?: string;
  /** Token symbol used for the quote. */
  symbol?: string;
  /** Token decimals used for the quote. */
  decimals?: number;
  /** Initial supply used for the quote. */
  initialSupply?: string;
}

export interface TokenCreationFeeQuote {
  /** Total fee charged for token creation, in stroops. */
  feeStroops: string;
  /** Total fee charged for token creation, in XLM (decimal string). */
  feeXlm: string;
  /** Base fee component, in stroops. */
  baseFeeStroops: string;
  /** Additional fee component (e.g. metadata/supply based), in stroops. */
  additionalFeeStroops: string;
  /** Asset used to pay the fee. */
  asset: string;
  /** Whether the fee is currently waived (e.g. promotions or paused state). */
  waived: boolean;
  /** Ledger timestamp at which the quote was produced. */
  quotedAt: string;
}

export type RpcEndpointKind = "horizon" | "soroban";

export type EndpointHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface RpcEndpointConfig {
  url: string;
  kind: RpcEndpointKind;
  network: string;
  weight?: number;
}

export interface EndpointHealth {
  url: string;
  kind: RpcEndpointKind;
  network: string;
  status: EndpointHealthStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  latencyMs?: number;
  circuitState?: string;
}

export interface EndpointPoolStatus {
  network: string;
  kind: RpcEndpointKind;
  activeEndpoint?: string;
  endpoints: EndpointHealth[];
}

export interface EndpointPoolOptions {
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  failureThreshold?: number;
  recoveryThreshold?: number;
  circuitBreakerNamePrefix?: string;
}
