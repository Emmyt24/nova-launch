/**
 * Retry utilities for Stellar API calls
 */

export interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffFactor: number;
  jitterFactor?: number;
  timeout?: number;
}

export const USER_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelay: 500,
  maxDelay: 5000,
  backoffFactor: 2,
  jitterFactor: 0.1,
  timeout: 30000,
};

export const BACKGROUND_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 10,
  initialDelay: 2000,
  maxDelay: 60000,
  backoffFactor: 2,
  jitterFactor: 0.2,
  timeout: 120000,
};

export const DEFAULT_RETRY_CONFIG = USER_RETRY_CONFIG;

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

  // Fetch API errors
  if (error.name === 'TypeError' && error.message.includes('fetch')) {
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

  // Check status property directly (for Response objects)
  if (error.status) {
    const status = error.status;
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
  }

  // Stellar-specific errors
  if (error.message) {
    const msg = error.message.toLowerCase();
    if (msg.includes('timeout')) return true;
    if (msg.includes('network')) return true;
    if (msg.includes('failed to fetch')) return true;
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

/**
 * Wrap an async operation with retry logic
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = USER_RETRY_CONFIG,
  operationName: string = 'operation'
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      // Apply timeout if configured
      if (config.timeout) {
        const result = await Promise.race<T>([
          operation(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`${operationName} timeout after ${config.timeout}ms`)),
              config.timeout
            )
          ),
        ]);
        
        if (attempt > 1) {
          console.log(`${operationName} succeeded on attempt ${attempt}/${config.maxAttempts}`);
        }
        
        return result;
      } else {
        const result = await operation();
        
        if (attempt > 1) {
          console.log(`${operationName} succeeded on attempt ${attempt}/${config.maxAttempts}`);
        }
        
        return result;
      }
    } catch (error) {
      lastError = error;

      // Check if error is retryable
      const retryable = isRetryableError(error);
      
      if (!retryable || attempt === config.maxAttempts) {
        if (!retryable) {
          console.error(`${operationName} failed with terminal error (not retryable)`, error);
        } else {
          console.error(`${operationName} failed after ${config.maxAttempts} attempts`, error);
        }
        throw error;
      }

      const delay = calculateBackoffDelay(attempt, config);
      console.warn(
        `${operationName} failed (attempt ${attempt}/${config.maxAttempts}). ` +
        `Retrying in ${Math.round(delay)}ms...`,
        error instanceof Error ? error.message : String(error)
      );
      await sleep(delay);
    }
  }

  console.error(`${operationName} failed after ${config.maxAttempts} attempts`);
  throw lastError;
}

/**
 * Rate limiter for frontend
 */
export class RateLimiter {
  private requests: number[] = [];

  constructor(
    private maxRequests: number,
    private windowMs: number
  ) {}

  checkLimit(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Remove requests outside the window
    this.requests = this.requests.filter((ts) => ts >= windowStart);

    if (this.requests.length >= this.maxRequests) {
      throw new Error('Rate limit exceeded. Please try again later.');
    }

    this.requests.push(now);
  }

  getRemainingRequests(): number {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const active = this.requests.filter((ts) => ts >= windowStart);
    return Math.max(0, this.maxRequests - active.length);
  }

  reset(): void {
    this.requests = [];
  }
}
