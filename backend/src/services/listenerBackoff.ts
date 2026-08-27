/**
 * Bounded exponential backoff with jitter for the Stellar event listener reconnect loop.
 *
 * Design:
 *  - Delay = min(initialDelay * factor^attempt, maxDelay) ± jitter
 *  - Jitter: full range jitter = [-jitterFraction*base, +jitterFraction*base]
 *    This prevents thundering herd on reconnects after shared outages.
 *  - After HEALTH_RESET_THRESHOLD consecutive successes the attempt counter resets
 *    to prevent the window from drifting permanently after a transient outage.
 *  - Each attempt emits a structured log so observability tools can track reconnect cadence.
 *
 * Jitter algorithm rationale: full-range jitter is used because it provides the most
 * variance while staying within deterministic bounds, ensuring no single retry window
 * dominates the retry pattern. Decorrelated jitter alternatives add more complexity
 * without significant benefit for a 2-factor exponential backoff schedule.
 */

/** Type for injectable random number generator */
export type RNG = () => number;

/** Default RNG using Math.random() */
function defaultRNG(): number {
  return Math.random();
}

export interface ListenerReconnectConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitterFraction: number;
  healthResetThreshold: number;
  maxRetries: number;
}

export const LISTENER_RECONNECT_CONFIG: ListenerReconnectConfig = {
  initialDelayMs: 1_000,
  maxDelayMs: 300_000,
  backoffFactor: 2,
  jitterFraction: 0.25,
  healthResetThreshold: 5,
  maxRetries: 10,
};

/**
 * Calculate reconnect delay with bounded exponential backoff and full-range jitter.
 *
 * @param attempt Zero-indexed attempt number
 * @param config Backoff configuration (uses defaults if omitted)
 * @param rng Injectable random number generator for testing; defaults to Math.random()
 * @returns Delay in milliseconds
 */
export function calculateReconnectDelay(
  attempt: number,
  config: ListenerReconnectConfig = LISTENER_RECONNECT_CONFIG,
  rng: RNG = defaultRNG,
): number {
  const base = Math.min(
    config.initialDelayMs * Math.pow(config.backoffFactor, attempt),
    config.maxDelayMs,
  );
  // Full-range jitter: uniformly distributed in [-jitterFraction*base, +jitterFraction*base]
  const jitter = base * config.jitterFraction * (rng() * 2 - 1);
  return Math.max(0, base + jitter);
}

export class ListenerBackoffState {
  private attempt = 0;
  private consecutiveSuccesses = 0;
  private rng: RNG;

  constructor(
    private readonly config: ListenerReconnectConfig = LISTENER_RECONNECT_CONFIG,
    rng?: RNG,
  ) {
    this.rng = rng || defaultRNG;
  }

  recordFailure(): { delayMs: number; attempt: number } {
    this.consecutiveSuccesses = 0;
    this.attempt += 1;
    const delayMs = calculateReconnectDelay(this.attempt, this.config, this.rng);
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
