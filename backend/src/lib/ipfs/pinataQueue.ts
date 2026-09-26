/**
 * PinataQueue — client-side request queue for the Pinata IPFS API (#1153).
 *
 * Features
 * ────────
 *  • Token-bucket throttle (configurable rps + max-burst).
 *  • Concurrency cap — at most N requests in-flight at once.
 *  • Automatic 429 back-off with exponential delay (jittered, capped).
 *  • Observable metrics: queueDepth, inFlight, throttledCount, retried429Count,
 *    avgLatencyMs.
 *
 * Configuration (env vars → PinataQueueOptions)
 * ─────────────────────────────────────────────
 *  PINATA_RPS               Requests allowed per second      (default 5)
 *  PINATA_MAX_CONCURRENT    Max parallel in-flight requests  (default 3)
 *  PINATA_MAX_BURST         Token-bucket burst capacity      (default 10)
 *  PINATA_MAX_RETRIES_429   Max 429 retries per request      (default 5)
 *  PINATA_RETRY_BASE_MS     Base delay for backoff (ms)      (default 1000)
 *  PINATA_RETRY_CAP_MS      Max delay cap for backoff (ms)   (default 60000)
 */

export class PinataRateLimitError extends Error {
  constructor(retries: number) {
    super(
      `Pinata rate limit exceeded after ${retries} retries (HTTP 429). ` +
        `Adjust PINATA_RPS / PINATA_MAX_RETRIES_429 or retry later.`
    );
    this.name = "PinataRateLimitError";
  }
}

export interface PinataQueueOptions {
  /** Allowed requests per second (token-bucket refill rate). */
  requestsPerSecond: number;
  /** Token-bucket burst capacity — allows short spikes above rps. */
  maxBurst: number;
  /** Maximum concurrent in-flight Pinata requests. */
  maxConcurrent: number;
  /** Maximum number of times a single request is retried on HTTP 429. */
  maxRetries429: number;
  /** Base delay (ms) for exponential 429 back-off. */
  retryBaseMs: number;
  /** Upper cap (ms) for exponential 429 back-off delay. */
  retryCapMs: number;
}

export interface PinataQueueMetrics {
  /** Number of tasks waiting in the queue (not yet started). */
  queueDepth: number;
  /** Number of tasks currently executing. */
  inFlight: number;
  /** Total number of tasks that had to wait for a token. */
  throttledCount: number;
  /** Total number of 429 retries across all requests since creation. */
  retried429Count: number;
  /** Rolling average latency (ms) of the last 100 completed requests. */
  avgLatencyMs: number;
}

interface QueuedTask<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  retries: number;
  /** Timestamp (ms) when the task was first enqueued. */
  enqueuedAt: number;
}

const DEFAULT_OPTIONS: PinataQueueOptions = {
  requestsPerSecond: Number(process.env.PINATA_RPS ?? 5),
  maxBurst: Number(process.env.PINATA_MAX_BURST ?? 10),
  maxConcurrent: Number(process.env.PINATA_MAX_CONCURRENT ?? 3),
  maxRetries429: Number(process.env.PINATA_MAX_RETRIES_429 ?? 5),
  retryBaseMs: Number(process.env.PINATA_RETRY_BASE_MS ?? 1000),
  retryCapMs: Number(process.env.PINATA_RETRY_CAP_MS ?? 60_000),
};

/**
 * Token-bucket + concurrency-limited queue for outgoing Pinata API calls.
 *
 * ## Why PinataQueue doesn't reuse WorkerPool
 *
 * `WorkerPool` (see `../../lib/WorkerPool.ts`) is the project's established
 * generic bounded-concurrency primitive used, e.g., by `webhookDeliveryService.ts`
 * for fan-out work.  PinataQueue solves a related but strictly *super-set* problem:
 *
 *   1. **Token-bucket rate limiting** — WorkerPool caps *concurrency*; a
 *      token-bucket limits *throughput* (requests per second). These are
 *      orthogonal concerns.  Pinata's API enforces an rps ceiling independent
 *      of how many requests are in-flight, so both constraints must be applied
 *      simultaneously.
 *
 *   2. **HTTP 429 retry with exponential back-off** — WorkerPool has no
 *      concept of 429 responses; it resolves/rejects immediately when the
 *      worker function settles.  PinataQueue intercepts 429 errors and
 *      re-queues the task with jittered exponential back-off, capped at
 *      `retryCapMs`, without surfacing the transient failure to the caller.
 *
 *   3. **Observable metrics** — `queueDepth`, `inFlight`, `throttledCount`,
 *      `retried429Count`, and `avgLatencyMs` are tracked here for Pinata-specific
 *      monitoring.  WorkerPool exposes only depth and running-count; it has no
 *      awareness of 429 retries.
 *
 * **Future consolidation path** — if WorkerPool is extended with a
 * pluggable "should-retry" hook (similar to `OutboundHttpClient`'s retry
 * predicate) and a pluggable rate-gate (à la a token-bucket `acquire()`), the
 * concurrency half of PinataQueue could be collapsed onto it, keeping only
 * the token-bucket layer here.  Until then, the two implementations MUST
 * remain consistent in their drain-loop shape: any bug found in one should be
 * reviewed in the other.  Cross-reference: `WorkerPool.drain()` ↔
 * `PinataQueue.drain()`.
 *
 * Usage
 * ─────
 *   const result = await pinataQueue.enqueue(() => pinata.pinJSONToIPFS(data));
 */
export class PinataQueue {
  private readonly opts: PinataQueueOptions;

  // ── token bucket ──────────────────────────────────────────────────────────
  private tokens: number;
  private lastRefillAt: number;

  // ── queue state ───────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly queue: QueuedTask<any>[] = [];
  private inFlight = 0;

  // ── metrics ───────────────────────────────────────────────────────────────
  private throttledCount = 0;
  private retried429Count = 0;
  /** Circular buffer of recent latency samples (last 100). */
  private readonly latencySamples: number[] = [];

  constructor(opts: Partial<PinataQueueOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.tokens = this.opts.maxBurst;
    this.lastRefillAt = Date.now();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Enqueue an async task.  Returns a promise that resolves / rejects with the
   * same value the task would have, but after throttle & retry logic is applied.
   *
   * The supplied `fn` must be a *factory* — it will be called (possibly
   * multiple times on 429) by the queue, not immediately.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn,
        resolve,
        reject,
        retries: 0,
        enqueuedAt: Date.now(),
      });
      this.drain();
    });
  }

  /** Snapshot of current queue metrics (non-blocking). */
  getMetrics(): PinataQueueMetrics {
    const avgLatencyMs =
      this.latencySamples.length === 0
        ? 0
        : this.latencySamples.reduce((a, b) => a + b, 0) /
          this.latencySamples.length;

    return {
      queueDepth: this.queue.length,
      inFlight: this.inFlight,
      throttledCount: this.throttledCount,
      retried429Count: this.retried429Count,
      avgLatencyMs: Math.round(avgLatencyMs),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────────────────

  /** Refill the token bucket based on elapsed wall-clock time. */
  private refillTokens(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillAt;
    const refill = (elapsedMs / 1000) * this.opts.requestsPerSecond;
    this.tokens = Math.min(this.opts.maxBurst, this.tokens + refill);
    this.lastRefillAt = now;
  }

  /**
   * Process as many queued tasks as the token bucket and concurrency cap allow.
   * Called after every enqueue, task completion, or retry re-schedule.
   */
  private drain(): void {
    this.refillTokens();

    while (
      this.queue.length > 0 &&
      this.inFlight < this.opts.maxConcurrent &&
      this.tokens >= 1
    ) {
      const task = this.queue.shift()!;
      this.tokens -= 1;
      this.inFlight++;
      this.run(task);
    }

    if (this.queue.length > 0 && this.inFlight < this.opts.maxConcurrent) {
      // Queue has tasks but tokens are exhausted — schedule a re-drain after
      // the next token becomes available.
      this.throttledCount++;
      const msUntilNextToken = Math.ceil(1000 / this.opts.requestsPerSecond);
      setTimeout(() => this.drain(), msUntilNextToken);
    }
  }

  /** Execute a single task, applying 429 retry logic. */
  private async run<T>(task: QueuedTask<T>): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await task.fn();
      task.resolve(result);
      this.recordLatency(task.enqueuedAt, startedAt);
    } catch (err) {
      if (this.is429(err) && task.retries < this.opts.maxRetries429) {
        task.retries++;
        this.retried429Count++;
        const delay = this.backoffDelay(task.retries);
        setTimeout(() => {
          this.queue.unshift(task); // push to front so it runs next
          this.drain();
        }, delay);
      } else if (this.is429(err)) {
        task.reject(new PinataRateLimitError(task.retries));
      } else {
        task.reject(err);
      }
    } finally {
      this.inFlight--;
      this.drain(); // check whether the next task can be started
    }
  }

  /**
   * Returns true when the thrown value is an HTTP 429 response.
   * Handles both raw `Response` objects and objects with a numeric `status`.
   */
  private is429(err: unknown): boolean {
    if (err instanceof Response) return err.status === 429;
    if (
      err != null &&
      typeof err === "object" &&
      "status" in err &&
      (err as { status: unknown }).status === 429
    ) {
      return true;
    }
    // Some SDKs throw an Error whose message contains "429"
    if (err instanceof Error && /\b429\b/.test(err.message)) return true;
    return false;
  }

  /**
   * Full jitter exponential back-off capped at `retryCapMs`.
   * delay = random(0, min(cap, base * 2^attempt))
   */
  private backoffDelay(attempt: number): number {
    const exponential = Math.min(
      this.opts.retryCapMs,
      this.opts.retryBaseMs * Math.pow(2, attempt)
    );
    return Math.floor(Math.random() * exponential);
  }

  /** Maintain a rolling window of the last 100 latency samples. */
  private recordLatency(enqueuedAt: number, startedAt: number): void {
    // Use total elapsed from enqueue (includes queue-wait + execution).
    const latency = Date.now() - enqueuedAt;
    void startedAt; // kept for future per-phase breakdown
    if (this.latencySamples.length >= 100) {
      this.latencySamples.shift();
    }
    this.latencySamples.push(latency);
  }
}

// ── Singleton used by pinata.ts ──────────────────────────────────────────────
export const pinataQueue = new PinataQueue();
