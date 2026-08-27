import { StellarRateLimitException } from "./stellar.exceptions";

export interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffFactor: number;
  jitterFactor?: number;
}

export const USER_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelay: 500,
  maxDelay: 5000,
  backoffFactor: 2,
  jitterFactor: 0.1,
};

export const BACKGROUND_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 10,
  initialDelay: 2000,
  maxDelay: 60000,
  backoffFactor: 2,
  jitterFactor: 0.2,
};

export class RateLimiter {
  private readonly requests: number[] = [];

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  /**
   * Checks if a request can proceed, throws StellarRateLimitException if not.
   */
  checkLimit(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Remove requests outside the window
    while (this.requests.length > 0 && this.requests[0] < windowStart) {
      this.requests.shift();
    }

    if (this.requests.length >= this.maxRequests) {
      throw new StellarRateLimitException();
    }

    this.requests.push(now);
  }

  /**
   * Returns remaining requests in the current window.
   */
  getRemainingRequests(): number {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const active = this.requests.filter((ts) => ts >= windowStart);
    return Math.max(0, this.maxRequests - active.length);
  }

  /**
   * Resets the rate limiter state.
   */
  reset(): void {
    this.requests.length = 0;
  }
}

/**
 * Calculate exponential backoff delay with jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  config: RetryConfig
): number {
  const exponentialDelay = Math.min(
    config.initialDelay * Math.pow(config.backoffFactor, attempt - 1),
    config.maxDelay
  );

  const jitter = config.jitterFactor || 0;
  const jitterAmount = exponentialDelay * jitter * (Math.random() * 2 - 1);

  return Math.max(0, exponentialDelay + jitterAmount);
}

/**
 * Determine if an error is retryable
 */
export function isRetryableError(error: any): boolean {
  // Network errors
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true;
  }

  // HTTP status codes
  if (error.response?.status) {
    const status = error.response.status;
    // 429 Too Many Requests
    if (status === 429) return true;
    // 5xx Server Errors
    if (status >= 500 && status < 600) return true;
  }

  // Stellar-specific errors
  if (error.message) {
    const msg = error.message.toLowerCase();
    if (msg.includes('timeout')) return true;
    if (msg.includes('network')) return true;
    // Sequence mismatch errors (TX_BAD_SEQ)
    if (msg.includes('bad_seq')) return true;
    if (msg.includes('tx_bad_seq')) return true;
    if (msg.includes('sequence') && msg.includes('mismatch')) return true;
  }

  return false;
}

/**
 * Sleep utility for backoff delays
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
