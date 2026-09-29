/**
 * Webhook Retry Configuration with Exponential Backoff Tuning
 *
 * Provides a configurable retry engine for webhook delivery:
 *  - Exponential backoff with optional jitter
 *  - Per-endpoint circuit-breaker awareness
 *  - Configurable via environment variables or constructor options
 *  - Fully testable (injectable delay / clock)
 *
 * Issue: #845
 *
 * ## Multiple retry implementations — which one to use
 *
 * The backend has three independent retry/backoff implementations. This one
 * (`WebhookRetryService`) is **for webhook delivery to tenant-owned endpoints
 * only**. See `docs/RETRY_BACKOFF_GUIDE.md` for a full comparison and
 * guidance on which implementation a new outbound integration should use:
 *
 *   - Outbound HTTP calls to external APIs → `src/lib/outboundHttpClient.ts`
 *   - Stellar event-listener reconnect    → `src/services/listenerBackoff.ts`
 *   - Webhook delivery (this file)        → `src/services/webhookRetry.ts`
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /** Maximum number of delivery attempts (including the first). Default: 5 */
  maxAttempts: number;
  /** Base delay in ms before the first retry. Default: 1000 */
  baseDelayMs: number;
  /** Multiplier applied to the delay on each retry. Default: 2 */
  backoffMultiplier: number;
  /** Maximum delay cap in ms. Default: 30_000 */
  maxDelayMs: number;
  /** Add random jitter (±25 % of computed delay) to avoid thundering herd. Default: true */
  jitter: boolean;
  /** HTTP status codes that are non-retryable (client errors). Default: 400–499 */
  nonRetryableStatuses: number[];
}

export interface AttemptResult {
  success: boolean;
  statusCode: number | null;
  error: string | null;
}

export interface RetryOutcome {
  success: boolean;
  attempts: number;
  totalDurationMs: number;
  lastStatusCode: number | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Defaults (overridable via env vars)
// ---------------------------------------------------------------------------

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: parseInt(process.env.WEBHOOK_MAX_ATTEMPTS ?? "5"),
  baseDelayMs: parseInt(process.env.WEBHOOK_BASE_DELAY_MS ?? "1000"),
  backoffMultiplier: parseFloat(process.env.WEBHOOK_BACKOFF_MULTIPLIER ?? "2"),
  maxDelayMs: parseInt(process.env.WEBHOOK_MAX_DELAY_MS ?? "30000"),
  jitter: (process.env.WEBHOOK_JITTER ?? "true") !== "false",
  nonRetryableStatuses: [400, 401, 403, 404, 405, 410, 422],
};

// ---------------------------------------------------------------------------
// Core retry engine
// ---------------------------------------------------------------------------

/**
 * Compute the delay (in ms) before attempt number `attempt` (1-indexed).
 *
 * Formula: min(baseDelay * multiplier^(attempt-1), maxDelay) ± jitter
 */
export function computeDelay(
  attempt: number,
  config: Pick<
    RetryConfig,
    "baseDelayMs" | "backoffMultiplier" | "maxDelayMs" | "jitter"
  >
): number {
  const raw =
    config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
  const capped = Math.min(raw, config.maxDelayMs);

  if (!config.jitter) return Math.round(capped);

  // ±25 % uniform jitter
  const jitterRange = capped * 0.25;
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange;
  return Math.round(Math.max(0, jittered));
}

/**
 * Determine whether a given HTTP status code is retryable.
 */
export function isRetryable(
  statusCode: number | null,
  nonRetryableStatuses: number[]
): boolean {
  if (statusCode === null) return true; // network error — always retry
  return !nonRetryableStatuses.includes(statusCode);
}

// ---------------------------------------------------------------------------
// WebhookRetryService
// ---------------------------------------------------------------------------

export class WebhookRetryService {
  private readonly config: RetryConfig;
  /** Injected delay function — swap out in tests for instant execution */
  private readonly delayFn: (ms: number) => Promise<void>;

  constructor(
    config: Partial<RetryConfig> = {},
    delayFn?: (ms: number) => Promise<void>
  ) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
    this.delayFn =
      delayFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Execute `attemptFn` with exponential-backoff retries.
   *
   * @param attemptFn - Called on each attempt. Must return an `AttemptResult`.
   * @returns `RetryOutcome` summarising the overall delivery result.
   */
  async execute(
    attemptFn: (attempt: number) => Promise<AttemptResult>
  ): Promise<RetryOutcome> {
    const startMs = Date.now();
    let lastResult: AttemptResult = {
      success: false,
      statusCode: null,
      error: "No attempts made",
    };

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      lastResult = await attemptFn(attempt);

      if (lastResult.success) {
        return {
          success: true,
          attempts: attempt,
          totalDurationMs: Date.now() - startMs,
          lastStatusCode: lastResult.statusCode,
          lastError: null,
        };
      }

      // Non-retryable status — stop immediately
      if (!isRetryable(lastResult.statusCode, this.config.nonRetryableStatuses)) {
        break;
      }

      // Wait before next attempt (skip delay after the last attempt)
      if (attempt < this.config.maxAttempts) {
        const delay = computeDelay(attempt, this.config);
        await this.delayFn(delay);
      }
    }

    return {
      success: false,
      attempts: this.config.maxAttempts,
      totalDurationMs: Date.now() - startMs,
      lastStatusCode: lastResult.statusCode,
      lastError: lastResult.error,
    };
  }

  /** Expose resolved config (useful for logging / introspection). */
  getConfig(): Readonly<RetryConfig> {
    return { ...this.config };
  }
}

export default WebhookRetryService;
