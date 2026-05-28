/**
 * Bounded exponential backoff with jitter for the Stellar event listener reconnect loop.
 *
 * Design:
 *  - Delay = min(initialDelay * factor^attempt, maxDelay) ± jitter
 *  - After HEALTH_RESET_THRESHOLD consecutive successes the attempt counter resets
 *    to prevent the window from drifting permanently after a transient outage.
 *  - Each attempt emits a structured log so observability tools can track reconnect cadence.
 */

export interface ListenerReconnectConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitterFraction: number;
  healthResetThreshold: number;
}

export const LISTENER_RECONNECT_CONFIG: ListenerReconnectConfig = {
  initialDelayMs: 1_000,
  maxDelayMs: 300_000,
  backoffFactor: 2,
  jitterFraction: 0.25,
  healthResetThreshold: 5,
};

export function calculateReconnectDelay(
  attempt: number,
  config: ListenerReconnectConfig = LISTENER_RECONNECT_CONFIG,
): number {
  const base = Math.min(
    config.initialDelayMs * Math.pow(config.backoffFactor, attempt),
    config.maxDelayMs,
  );
  const jitter = base * config.jitterFraction * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

export class ListenerBackoffState {
  private attempt = 0;
  private consecutiveSuccesses = 0;

  constructor(private readonly config: ListenerReconnectConfig = LISTENER_RECONNECT_CONFIG) {}

  recordFailure(): { delayMs: number; attempt: number } {
    this.consecutiveSuccesses = 0;
    this.attempt += 1;
    const delayMs = calculateReconnectDelay(this.attempt, this.config);
    console.warn(
      `[StellarEventListener] reconnect attempt ${this.attempt}, backing off ${Math.round(delayMs)}ms`,
    );
    return { delayMs, attempt: this.attempt };
  }

  recordSuccess(): void {
    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses >= this.config.healthResetThreshold && this.attempt > 0) {
      console.log(
        `[StellarEventListener] ${this.consecutiveSuccesses} consecutive successes — resetting backoff`,
      );
      this.attempt = 0;
      this.consecutiveSuccesses = 0;
    }
  }

  get currentAttempt(): number {
    return this.attempt;
  }

  get currentConsecutiveSuccesses(): number {
    return this.consecutiveSuccesses;
  }

  reset(): void {
    this.attempt = 0;
    this.consecutiveSuccesses = 0;
  }
}
