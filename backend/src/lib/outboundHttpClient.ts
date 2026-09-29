/**
 * OutboundHttpClient (#1154, #1389)
 *
 * A thin wrapper around `fetch` that automatically propagates the current
 * request's correlation ID and transaction ID into outbound HTTP calls.
 *
 * All backend service-to-service calls should use this helper so that
 * distributed traces can be joined by the same IDs across service boundaries.
 *
 * Header reference
 * ─────────────────
 *   X-Correlation-Id   — per-request trace ID (backend-generated if absent)
 *   X-Transaction-Id   — logical transaction ID originated at the frontend page load
 *   X-Request-Id       — unique ID for each individual HTTP call
 *   traceparent         — W3C distributed-trace context (#1333)
 *
 * Usage
 * ──────
 *   import { outboundFetch } from '../lib/outboundHttpClient.js';
 *   const data = await outboundFetch('https://other-service/api/foo');
 *
 * `OutboundHttpClient` additionally wraps a single outbound call (`execute`)
 * with retry (exponential backoff + jitter, skipping 4xx client errors) and
 * circuit-breaker protection, self-registering with the shared circuit
 * breaker registry so its state is visible via `/health/detailed`.
 *
 *   const client = new OutboundHttpClient({ serviceName: 'horizon' });
 *   const events = await client.execute(() => axios.get(url, { params }));
 *
 * ## Multiple retry implementations — which one to use
 *
 * The backend has three independent retry/backoff implementations. This one
 * (`OutboundHttpClient.execute`) is **the default for outbound HTTP calls to
 * external APIs and internal services**. See `docs/RETRY_BACKOFF_GUIDE.md`
 * for a full comparison:
 *
 *   - Outbound HTTP calls to external APIs → `src/lib/outboundHttpClient.ts` ← you are here
 *   - Stellar event-listener reconnect    → `src/services/listenerBackoff.ts`
 *   - Webhook delivery                    → `src/services/webhookRetry.ts`
 */

import { context, propagation } from '@opentelemetry/api';
import { getCorrelationId, getTransactionId, getTraceContext } from './async-context.js';
import {
  HEADER_CORRELATION_ID,
  HEADER_TRANSACTION_ID,
  HEADER_REQUEST_ID,
} from '../middleware/request-logging.middleware.js';
import { CircuitBreaker, CircuitBreakerOptions, registerCircuitBreaker } from './circuitBreaker.js';

const HEADER_TRACEPARENT = 'traceparent';

/**
 * Build the `traceparent` header for the active trace context.
 *
 * Prefers the live OpenTelemetry context (so a span created by the auto
 * instrumentations for this call shows up as the parent), falling back to
 * the raw `traceparent` parsed off the inbound request when OTel is
 * disabled (e.g. `OTEL_SDK_DISABLED=true` in tests) so propagation still
 * works without a running SDK.
 */
function buildTraceParentHeader(): string | undefined {
  const injected: Record<string, string> = {};
  propagation.inject(context.active(), injected);
  if (injected[HEADER_TRACEPARENT]) {
    return injected[HEADER_TRACEPARENT];
  }

  return getTraceContext()?.raw;
}

/**
 * Propagation headers built from the current async context.
 * Returns an empty object when called outside a request context.
 */
export function buildPropagationHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  const correlationId = getCorrelationId();
  if (correlationId) {
    headers[HEADER_CORRELATION_ID] = correlationId;
  }

  const transactionId = getTransactionId();
  if (transactionId) {
    headers[HEADER_TRANSACTION_ID] = transactionId;
  }

  const traceParent = buildTraceParentHeader();
  if (traceParent) {
    headers[HEADER_TRACEPARENT] = traceParent;
  }

  // Generate a fresh per-call request ID so individual hops are traceable
  headers[HEADER_REQUEST_ID] =
    `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  return headers;
}

/**
 * Drop-in replacement for `fetch` that injects propagation headers into
 * every outbound request.
 *
 * @param url     The URL to fetch.
 * @param init    Standard `RequestInit` options (headers are merged, not overwritten).
 */
export async function outboundFetch(
  url: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  const propagation = buildPropagationHeaders();

  const mergedHeaders = new Headers(init.headers);
  for (const [key, value] of Object.entries(propagation)) {
    // Only inject if the caller has not already set the header
    if (!mergedHeaders.has(key)) {
      mergedHeaders.set(key, value);
    }
  }

  return fetch(url, { ...init, headers: mergedHeaders });
}

// ---------------------------------------------------------------------------
// OutboundHttpClient: retry + circuit breaker for a single outbound call
// ---------------------------------------------------------------------------

export interface OutboundRetryConfig {
  /** Maximum number of attempts, including the first. Default: 3 */
  maxAttempts: number;
  /** Base delay in ms before the first retry. Default: 200 */
  baseDelayMs: number;
  /** Multiplier applied to the delay on each retry. Default: 2 */
  backoffMultiplier: number;
  /** Maximum delay cap in ms. Default: 5000 */
  maxDelayMs: number;
}

export const DEFAULT_OUTBOUND_RETRY_CONFIG: OutboundRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 200,
  backoffMultiplier: 2,
  maxDelayMs: 5000,
};

const DEFAULT_OUTBOUND_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  successThreshold: 2,
  timeoutMs: 30000,
};

export interface OutboundHttpClientOptions {
  /** Name this client is registered under in the circuit breaker registry (e.g. "horizon"). */
  serviceName: string;
  retry?: Partial<OutboundRetryConfig>;
  circuitBreaker?: CircuitBreakerOptions;
}

/**
 * Compute the delay (in ms) before attempt number `attempt` (1-indexed).
 * Formula: min(base * 2^(attempt-1) + jitter, ceiling), jitter ∈ [0, base).
 */
function computeOutboundBackoffDelay(attempt: number, config: OutboundRetryConfig): number {
  const exponential = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
  const jitter = Math.random() * config.baseDelayMs;
  return Math.min(exponential + jitter, config.maxDelayMs);
}

/** Extract an HTTP status code from a thrown error, if any (axios-style or a plain `status` field). */
function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const anyError = error as { status?: unknown; response?: { status?: unknown } };
  if (typeof anyError.status === 'number') return anyError.status;
  if (typeof anyError.response?.status === 'number') return anyError.response.status;
  return undefined;
}

/** 4xx errors are the caller's fault — retrying won't help. */
function isNonRetryableClientError(error: unknown): boolean {
  const status = statusOf(error);
  return status !== undefined && status >= 400 && status < 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a single outbound HTTP call with retry (exponential backoff +
 * jitter, skipping 4xx) and circuit-breaker protection. One instance should
 * be created per external service and reused for the life of the process.
 */
export class OutboundHttpClient {
  readonly serviceName: string;
  private readonly retryConfig: OutboundRetryConfig;
  private readonly breaker: CircuitBreaker;

  constructor(options: OutboundHttpClientOptions) {
    this.serviceName = options.serviceName;
    this.retryConfig = { ...DEFAULT_OUTBOUND_RETRY_CONFIG, ...options.retry };
    this.breaker = new CircuitBreaker(options.circuitBreaker ?? DEFAULT_OUTBOUND_CIRCUIT_BREAKER_OPTIONS);
    registerCircuitBreaker(this.serviceName, this.breaker);
  }

  getCircuitBreakerState() {
    return this.breaker.getState();
  }

  getCircuitBreakerMetrics() {
    return this.breaker.getMetrics();
  }

  /**
   * Execute one logical outbound call. `fn` should perform exactly one HTTP
   * attempt and throw on failure (axios calls do this by default). If the
   * circuit is open, fails immediately without invoking `fn`. Retries up to
   * `retry.maxAttempts` times with jittered exponential backoff, except for
   * 4xx client errors, which are never retried.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return this.breaker.execute(async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt++) {
        try {
          return await fn();
        } catch (error) {
          lastError = error;
          if (isNonRetryableClientError(error) || attempt === this.retryConfig.maxAttempts) {
            throw error;
          }
          await sleep(computeOutboundBackoffDelay(attempt, this.retryConfig));
        }
      }
      // Unreachable: the loop always returns or throws.
      throw lastError;
    });
  }
}
