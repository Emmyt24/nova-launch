/**
 * Retry budget for the Stellar RPC client (#2201).
 *
 * Per-call retry limits alone cannot stop a fleet of callers from multiplying
 * load during an RPC outage: N in-flight operations × M attempts each. The
 * retry budget is a token bucket shared by every call made through one
 * client — each retry spends a token, tokens refill slowly over time and
 * successful calls deposit a fraction of a token back. When the bucket is
 * empty, retryable failures fail fast instead of retrying.
 *
 * First attempts are never gated by the budget; only retries are.
 */

import { Counter, Gauge } from "prom-client";
import { register } from "../lib/metrics";
import {
  StellarRateLimitException,
  StellarTimeoutException,
  StellarException,
} from "./stellar.exceptions";

// ── Metrics ──────────────────────────────────────────────────────────────────

export const retryBudgetTokensGauge = new Gauge({
  name: "stellar_rpc_retry_budget_tokens",
  help: "Tokens currently available in the Stellar RPC retry budget.",
  labelNames: ["client"],
  registers: [register],
});

export const retryBudgetExhaustedCounter = new Counter({
  name: "stellar_rpc_retry_budget_exhausted_total",
  help: "Retries skipped because the Stellar RPC retry budget was exhausted.",
  labelNames: ["client", "operation"],
  registers: [register],
});

export const rpcRetriesCounter = new Counter({
  name: "stellar_rpc_retries_total",
  help: "Retries performed by the Stellar RPC client, by error reason.",
  labelNames: ["client", "operation", "reason"],
  registers: [register],
});

export const rpcNonRetryableErrorsCounter = new Counter({
  name: "stellar_rpc_non_retryable_errors_total",
  help: "Stellar RPC failures that were not retried, by error reason.",
  labelNames: ["client", "operation", "reason"],
  registers: [register],
});

// ── Error classification ─────────────────────────────────────────────────────

export type RetryReason =
  | "network"
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "bad_sequence"
  | "http_error"
  | "local_rate_limit"
  | "application"
  | "unknown";

export interface ErrorClassification {
  retryable: boolean;
  reason: RetryReason;
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

/** HTTP statuses that indicate a transient upstream problem. */
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function httpStatusOf(error: any): number | undefined {
  const status = error?.response?.status ?? error?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Decide whether an RPC failure is worth retrying.
 *
 * Retryable: network failures, timeouts, 408/429/5xx (except 501/505),
 * bad-sequence errors. Terminal: other 4xx, our own client-side rate limit
 * (retrying would just trip it again), and application-level Stellar
 * exceptions (not found, invalid address, contract errors, ...).
 */
export function classifyRpcError(error: unknown): ErrorClassification {
  if (error instanceof StellarTimeoutException) {
    return { retryable: true, reason: "timeout" };
  }
  if (error instanceof StellarRateLimitException) {
    return { retryable: false, reason: "local_rate_limit" };
  }

  const err = error as any;

  if (err?.code && typeof err.code === "string" && RETRYABLE_NETWORK_CODES.has(err.code)) {
    return { retryable: true, reason: err.code === "ETIMEDOUT" ? "timeout" : "network" };
  }

  const status = httpStatusOf(err);
  if (status !== undefined && !(error instanceof StellarException)) {
    if (status === 429) return { retryable: true, reason: "rate_limited" };
    if (status === 408) return { retryable: true, reason: "timeout" };
    if (RETRYABLE_HTTP_STATUSES.has(status)) return { retryable: true, reason: "server_error" };
    if (status >= 400 && status < 600) return { retryable: false, reason: "http_error" };
  }

  const msg = typeof err?.message === "string" ? err.message.toLowerCase() : "";
  if (msg.includes("bad_seq") || (msg.includes("sequence") && msg.includes("mismatch"))) {
    return { retryable: true, reason: "bad_sequence" };
  }

  if (error instanceof StellarException) {
    return { retryable: false, reason: "application" };
  }

  if (msg.includes("timeout") || msg.includes("timed out")) {
    return { retryable: true, reason: "timeout" };
  }
  if (msg.includes("network") || msg.includes("socket hang up")) {
    return { retryable: true, reason: "network" };
  }

  return { retryable: false, reason: "unknown" };
}

// ── Token bucket ─────────────────────────────────────────────────────────────

export interface RetryBudgetConfig {
  /** Maximum tokens the bucket can hold (burst of retries allowed). */
  capacity: number;
  /** Tokens added per second while not full. */
  refillPerSecond: number;
  /** Tokens deposited for each successful call (0 disables). */
  depositPerSuccess: number;
}

export const DEFAULT_RETRY_BUDGET_CONFIG: RetryBudgetConfig = {
  capacity: 20,
  refillPerSecond: 1,
  depositPerSuccess: 0.1,
};

export class RetryBudget {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly config: RetryBudgetConfig = DEFAULT_RETRY_BUDGET_CONFIG,
    private readonly clientName = "stellar",
    private readonly now: () => number = Date.now,
  ) {
    if (!(config.capacity > 0)) throw new Error("RetryBudget capacity must be > 0");
    if (config.refillPerSecond < 0) throw new Error("RetryBudget refillPerSecond must be >= 0");
    if (config.depositPerSuccess < 0) throw new Error("RetryBudget depositPerSuccess must be >= 0");

    this.tokens = config.capacity;
    this.lastRefill = now();
    this.publish();
  }

  /**
   * Spend one token for a retry. Returns false (and records exhaustion) when
   * the budget is empty — the caller must then give up instead of retrying.
   */
  tryAcquire(operation = "unknown"): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.publish();
      return true;
    }
    retryBudgetExhaustedCounter.inc({ client: this.clientName, operation });
    return false;
  }

  /** Deposit a fraction of a token after a successful call. */
  recordSuccess(): void {
    if (this.config.depositPerSuccess === 0) return;
    this.refill();
    this.tokens = Math.min(this.config.capacity, this.tokens + this.config.depositPerSuccess);
    this.publish();
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  reset(): void {
    this.tokens = this.config.capacity;
    this.lastRefill = this.now();
    this.publish();
  }

  private refill(): void {
    const t = this.now();
    const elapsedSec = Math.max(0, t - this.lastRefill) / 1000;
    this.lastRefill = t;
    if (elapsedSec > 0 && this.config.refillPerSecond > 0) {
      this.tokens = Math.min(this.config.capacity, this.tokens + elapsedSec * this.config.refillPerSecond);
    }
  }

  private publish(): void {
    retryBudgetTokensGauge.set({ client: this.clientName }, this.tokens);
  }
}

export function recordRetry(clientName: string, operation: string, reason: RetryReason): void {
  rpcRetriesCounter.inc({ client: clientName, operation, reason });
}

export function recordNonRetryable(clientName: string, operation: string, reason: RetryReason): void {
  rpcNonRetryableErrorsCounter.inc({ client: clientName, operation, reason });
}
