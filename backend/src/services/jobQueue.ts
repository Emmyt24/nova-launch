/**
 * In-process background job queue for asynchronous task processing.
 *
 * Design:
 *  - Jobs are enqueued with a type, payload, and optional priority (higher = sooner).
 *  - A configurable number of concurrent workers drain the queue.
 *  - Failed jobs are retried up to MAX_RETRIES times with exponential back-off.
 *  - After exhausting retries the job moves to a dead-letter list for inspection.
 *  - The queue is intentionally in-process (no Redis/DB dependency) so it works
 *    out of the box; swap the storage layer later if persistence is needed.
 *
 * Security / OWASP:
 *  - Payload size is capped at MAX_PAYLOAD_BYTES to prevent memory exhaustion.
 *  - Job handlers are registered by name; unknown job types are rejected.
 *  - Errors in handlers are caught and never propagate to callers.
 */

import { Gauge, Counter, Histogram, register } from "../lib/metrics";
import { getCorrelationId, runWithContext } from "../lib/async-context";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = "pending" | "running" | "completed" | "failed" | "dead";

export interface Job<T = unknown> {
  id: string;
  type: string;
  payload: T;
  /** Higher number = higher priority. Default 0. */
  priority: number;
  attempts: number;
  maxRetries: number;
  status: JobStatus;
  createdAt: Date;
  runAt: Date; // earliest time the job may be picked up
  startedAt?: Date;
  /** Timestamp of the most recent attempt, used by dashboard/stuck-job inspection. */
  lastAttemptAt?: Date;
  /** Set once a job crosses the configured stuck threshold. */
  stuck?: boolean;
  error?: string;
  /** Correlation ID from the originating HTTP request, for distributed tracing. */
  correlationId?: string;
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void>;

export interface EnqueueOptions {
  priority?: number;
  maxRetries?: number;
  /** Delay in ms before the job becomes eligible. Default 0. */
  delayMs?: number;
}

export interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  dead: number;
}

export interface QueueMetrics {
  pendingByPriority: Record<string, number>;
  oldestPendingAgeMs: number;
  pendingJobs: Array<{
    id: string;
    type: string;
    priority: number;
    attempts: number;
    status: JobStatus;
    ageMs: number;
    lastAttemptAt?: Date;
  }>;
  stuckJobs: Array<{
    id: string;
    type: string;
    priority: number;
    attempts: number;
    status: JobStatus;
    ageMs: number;
    lastAttemptAt?: Date;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB
const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
/** Maximum consecutive selections of a priority while a lower priority is ready. */
const FAIRNESS_HIGH_PRIORITY_STREAK = Math.max(
  1,
  parseInt(process.env.JOB_QUEUE_FAIRNESS_STREAK ?? "5", 10)
);
/** Jobs older than this are flagged; operators can tune it per deployment. */
const STUCK_THRESHOLD_MS = Math.max(
  1_000,
  parseInt(process.env.JOB_QUEUE_STUCK_THRESHOLD_MS ?? String(15 * 60 * 1000), 10)
);

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const queueDepthGauge = new Gauge({
  name: "job_queue_depth",
  help: "Number of pending jobs in the queue",
  registers: [register],
});

const queueInflightGauge = new Gauge({
  name: "job_queue_inflight",
  help: "Number of jobs currently being processed",
  registers: [register],
});

const queueFailedCounter = new Counter({
  name: "job_queue_failed_total",
  help: "Total number of jobs that failed (sent to dead letter)",
  labelNames: ["job_type"],
  registers: [register],
});

const jobProcessingHistogram = new Histogram({
  name: "job_processing_duration_seconds",
  help: "Duration of job processing in seconds",
  labelNames: ["job_type", "status"],
  registers: [register],
});

const queueDepthByPriorityGauge = new Gauge({
  name: "job_queue_depth_by_priority",
  help: "Number of pending jobs by priority",
  labelNames: ["priority"],
  registers: [register],
});

const queueOldestAgeGauge = new Gauge({
  name: "job_queue_oldest_age_seconds",
  help: "Age in seconds of the oldest pending job",
  registers: [register],
});

const queueAttemptsGauge = new Gauge({
  name: "job_queue_attempts",
  help: "Total attempts for pending and running jobs by type",
  labelNames: ["job_type"],
  registers: [register],
});

const queueStuckGauge = new Gauge({
  name: "job_queue_stuck_jobs",
  help: "Number of jobs flagged as stuck by priority",
  labelNames: ["priority"],
  registers: [register],
});

const queueStuckCounter = new Counter({
  name: "job_queue_stuck_total",
  help: "Total jobs flagged as stuck",
  labelNames: ["job_type"],
  registers: [register],
});

const jobEnqueuedCounter = new Counter({
  name: "job_enqueued_total",
  help: "Total number of jobs enqueued",
  labelNames: ["job_type"],
  registers: [register],
});

// ---------------------------------------------------------------------------
// JobQueue
// ---------------------------------------------------------------------------

export class JobQueue {
  private handlers = new Map<string, JobHandler<any>>();
  private pending: Job[] = [];
  private running = new Map<string, Job>();
  private completed: Job[] = [];
  private dead: Job[] = [];

  private concurrency: number;
  private activeWorkers = 0;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private recurringTimers = new Map<string, ReturnType<typeof setInterval>>();
  private consecutiveHighPriorityJobs = 0;

  /** Counts for completed/failed (kept separately to avoid unbounded arrays). */
  private completedCount = 0;
  private failedCount = 0;

  constructor(concurrency = 2) {
    this.concurrency = Math.max(1, concurrency);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Register a handler for a job type.
   * Throws if the type is already registered.
   */
  register<T>(type: string, handler: JobHandler<T>): void {
    if (this.handlers.has(type)) {
      throw new Error(`Handler for job type "${type}" is already registered`);
    }
    this.handlers.set(type, handler as JobHandler<unknown>);
  }

  /**
   * Enqueue a new job.
   * Returns the created Job object.
   * Throws if the payload exceeds MAX_PAYLOAD_BYTES or the type is unknown.
   */
  enqueue<T>(type: string, payload: T, opts: EnqueueOptions = {}): Job<T> {
    if (!this.handlers.has(type)) {
      throw new Error(`No handler registered for job type "${type}"`);
    }

    const payloadSize = Buffer.byteLength(JSON.stringify(payload));
    if (payloadSize > MAX_PAYLOAD_BYTES) {
      throw new Error(`Payload size ${payloadSize} bytes exceeds limit of ${MAX_PAYLOAD_BYTES} bytes`);
    }

    const job: Job<T> = {
      id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      type,
      payload,
      priority: opts.priority ?? 0,
      attempts: 0,
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      status: "pending",
      createdAt: new Date(),
      runAt: new Date(Date.now() + (opts.delayMs ?? 0)),
      correlationId: getCorrelationId(),
    };

    this.pending.push(job);
    this.pending.sort((a, b) => b.priority - a.priority); // highest priority first

    jobEnqueuedCounter.inc({ job_type: type });
    this.updateMetrics();
    this.scheduleTick();
    return job;
  }

  /** Start the queue (begins processing pending jobs). */
  start(): void {
    this.stopped = false;
    this.scheduleTick();
  }

  /** Stop accepting new work and drain in-flight jobs. */
  stop(): void {
    this.stopped = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * Stop accepting new work, then wait up to `timeoutMs` for in-flight jobs to
   * finish. Resolves with how many jobs were still running when it gave up.
   */
  async drain(timeoutMs = 10_000): Promise<{ drained: boolean; inFlight: number }> {
    this.stop();
    for (const type of [...this.recurringTimers.keys()]) this.stopRecurring(type);

    const deadline = Date.now() + timeoutMs;
    while (this.activeWorkers > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { drained: this.activeWorkers === 0, inFlight: this.activeWorkers };
  }

  /**
   * Enqueue a job of `type` on a recurring `intervalMs` cadence.
   * Calling this again for a `type` that's already scheduled is a no-op —
   * use `stopRecurring` first to change the interval.
   */
  scheduleRecurring<T>(
    type: string,
    payload: T,
    intervalMs: number,
    opts: EnqueueOptions = {}
  ): void {
    if (this.recurringTimers.has(type)) return;

    const timer = setInterval(() => {
      this.enqueue(type, payload, opts);
    }, intervalMs);
    timer.unref?.();
    this.recurringTimers.set(type, timer);
  }

  /** Stop a recurring schedule previously started with `scheduleRecurring`. */
  stopRecurring(type: string): void {
    const timer = this.recurringTimers.get(type);
    if (timer) {
      clearInterval(timer);
      this.recurringTimers.delete(type);
    }
  }

  /** Current queue statistics. Existing fields remain backward compatible. */
  stats(): QueueStats {
    return {
      pending: this.pending.length,
      running: this.running.size,
      completed: this.completedCount,
      failed: this.failedCount,
      dead: this.dead.length,
    };
  }

  /** Dashboard-safe queue metrics, including priority depth and stuck jobs. */
  metrics(now = Date.now()): QueueMetrics {
    this.updateMetrics(now);
    const pendingByPriority: Record<string, number> = {};
    for (const job of this.pending) {
      const key = String(job.priority);
      pendingByPriority[key] = (pendingByPriority[key] ?? 0) + 1;
    }
    const oldestPendingAgeMs = this.pending.length === 0
      ? 0
      : Math.max(0, now - Math.min(...this.pending.map((job) => job.createdAt.getTime())));
    const pendingJobs = [...this.pending, ...this.running.values()]
      .map((job) => ({
        id: job.id,
        type: job.type,
        priority: job.priority,
        attempts: job.attempts,
        status: job.status,
        ageMs: Math.max(0, now - job.createdAt.getTime()),
        ...(job.lastAttemptAt ? { lastAttemptAt: job.lastAttemptAt } : {}),
      }));
    const stuckIds = new Set([...this.pending, ...this.running.values()].filter((job) => job.stuck).map((job) => job.id));
    const stuckJobs = pendingJobs
      .filter((job) => stuckIds.has(job.id))
      .map((job) => ({
        id: job.id,
        type: job.type,
        priority: job.priority,
        attempts: job.attempts,
        status: job.status,
        ageMs: job.ageMs,
        ...(job.lastAttemptAt ? { lastAttemptAt: job.lastAttemptAt } : {}),
      }));
    return { pendingByPriority, oldestPendingAgeMs, pendingJobs, stuckJobs };
  }

  /** Returns only jobs currently flagged as stuck for operational tooling. */
  stuckJobs(now = Date.now()): QueueMetrics["stuckJobs"] {
    return this.metrics(now).stuckJobs;
  }

  /** Jobs in the dead-letter list (exhausted all retries). */
  deadLetterJobs(): Job[] {
    return [...this.dead];
  }

  /**
   * Return failed (dead-letter) jobs with optional filters.
   * Filters: jobType, errorCode (substring match on error message), startDate, endDate.
   */
  failedJobs(filters: {
    jobType?: string;
    errorCode?: string;
    startDate?: Date;
    endDate?: Date;
  } = {}): Job[] {
    let jobs = [...this.dead];

    if (filters.jobType) {
      jobs = jobs.filter((j) => j.type === filters.jobType);
    }
    if (filters.errorCode) {
      const needle = filters.errorCode.toLowerCase();
      jobs = jobs.filter((j) => j.error?.toLowerCase().includes(needle));
    }
    if (filters.startDate) {
      jobs = jobs.filter((j) => j.createdAt >= filters.startDate!);
    }
    if (filters.endDate) {
      jobs = jobs.filter((j) => j.createdAt <= filters.endDate!);
    }

    return jobs;
  }

  /**
   * Re-enqueue a dead-letter job: reset its retry counter and enqueue with
   * high priority so it runs as soon as a worker is free.
   * Returns the job, or null if no dead-letter job with that id exists.
   */
  retryJob(id: string): Job | null {
    const idx = this.dead.findIndex((j) => j.id === id);
    if (idx === -1) return null;

    const [job] = this.dead.splice(idx, 1);

    // Reset state for fresh execution
    job.attempts = 0;
    job.status = "pending";
    job.runAt = new Date();
    job.error = undefined;
    // Elevate priority so the retry runs before normal-priority work
    job.priority = Math.max(job.priority, 10);

    this.pending.push(job);
    this.pending.sort((a, b) => b.priority - a.priority);

    this.updateMetrics();
    this.scheduleTick();
    return job;
  }

  /**
   * Permanently discard a job from the dead-letter list.
   * Returns true if the job was found and removed, false otherwise.
   */
  discardJob(id: string): boolean {
    const idx = this.dead.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    this.dead.splice(idx, 1);
    return true;
  }

  /** Number of currently active workers. */
  get workerCount(): number {
    return this.activeWorkers;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private updateMetrics(now = Date.now()): void {
    queueDepthGauge.set(this.pending.length);
    queueInflightGauge.set(this.running.size);
    const byPriority: Record<string, number> = {};
    const attemptsByType: Record<string, number> = {};
    for (const job of this.pending) {
      const priority = String(job.priority);
      byPriority[priority] = (byPriority[priority] ?? 0) + 1;
      attemptsByType[job.type] = (attemptsByType[job.type] ?? 0) + job.attempts;
    }
    for (const job of this.running.values()) {
      attemptsByType[job.type] = (attemptsByType[job.type] ?? 0) + job.attempts;
    }
    for (const [priority, count] of Object.entries(byPriority)) {
      queueDepthByPriorityGauge.set({ priority }, count);
    }
    for (const [type, attempts] of Object.entries(attemptsByType)) {
      queueAttemptsGauge.set({ job_type: type }, attempts);
    }
    const oldest = this.pending.length === 0
      ? 0
      : Math.max(0, now - Math.min(...this.pending.map((job) => job.createdAt.getTime())));
    queueOldestAgeGauge.set(oldest / 1000);
    this.refreshStuckJobs(now);
  }

  private refreshStuckJobs(now = Date.now()): void {
    const candidates = [...this.pending, ...this.running.values()];
    const stuckByPriority: Record<string, number> = {};
    for (const job of candidates) {
      const ageMs = Math.max(0, now - job.createdAt.getTime());
      if (ageMs >= STUCK_THRESHOLD_MS) {
        const priority = String(job.priority);
        stuckByPriority[priority] = (stuckByPriority[priority] ?? 0) + 1;
        if (!job.stuck) {
          job.stuck = true;
          queueStuckCounter.inc({ job_type: job.type });
          logger.warn("job_queue_job_stuck", {
            jobId: job.id,
            jobType: job.type,
            priority: job.priority,
            attempts: job.attempts,
            ageMs,
            status: job.status,
            thresholdMs: STUCK_THRESHOLD_MS,
          });
        }
      }
    }
    for (const [priority, count] of Object.entries(stuckByPriority)) {
      queueStuckGauge.set({ priority }, count);
    }
  }

  private scheduleTick(): void {
    if (this.tickTimer || this.stopped) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this.tick();
    }, 0);
  }

  private tick(): void {
    if (this.stopped) return;

    const now = Date.now();

    while (
      this.activeWorkers < this.concurrency &&
      this.pending.length > 0
    ) {
      const idx = this.nextEligibleJobIndex(now);
      if (idx === -1) break;

      const [job] = this.pending.splice(idx, 1);
      this.updateFairnessState(job, now);
      this.updateMetrics();
      this.runJob(job);
    }

    // If there are delayed jobs still waiting, schedule another tick
    if (this.pending.length > 0) {
      const nextRunAt = Math.min(...this.pending.map((j) => j.runAt.getTime()));
      const delay = Math.max(0, nextRunAt - Date.now());
      this.tickTimer = setTimeout(() => {
        this.tickTimer = null;
        this.tick();
      }, delay);
    }
  }

  private nextEligibleJobIndex(now: number): number {
    const eligible = this.pending.filter((job) => job.runAt.getTime() <= now);
    if (eligible.length === 0) return -1;
    const highestPriority = Math.max(...eligible.map((job) => job.priority));
    const lowerPriorityReady = eligible.some((job) => job.priority < highestPriority);
    if (lowerPriorityReady && this.consecutiveHighPriorityJobs >= FAIRNESS_HIGH_PRIORITY_STREAK) {
      const nextLower = eligible.findIndex((job) => job.priority < highestPriority);
      return this.pending.indexOf(eligible[nextLower]);
    }
    return this.pending.indexOf(eligible[0]);
  }

  private updateFairnessState(job: Job, now: number): void {
    const lowerPriorityReady = this.pending.some(
      (candidate) => candidate.runAt.getTime() <= now && candidate.priority < job.priority
    );
    this.consecutiveHighPriorityJobs = lowerPriorityReady
      ? this.consecutiveHighPriorityJobs + 1
      : 0;
    if (job.priority <= Math.min(...this.pending.map((candidate) => candidate.priority), job.priority)) {
      this.consecutiveHighPriorityJobs = 0;
    }
  }

  private async runJob(job: Job): Promise<void> {
    job.status = "running";
    job.attempts += 1;
    job.startedAt = new Date();
    job.lastAttemptAt = job.startedAt;
    this.running.set(job.id, job);
    this.activeWorkers++;
    this.updateMetrics();

    const handler = this.handlers.get(job.type)!;
    const startTime = Date.now();

    // Wrap execution in the originating request's correlation ID context so that
    // all logs emitted inside the handler carry the same correlationId.
    const runHandler = job.correlationId
      ? () => runWithContext(job.correlationId!, () => handler(job))
      : () => handler(job);

    try {
      await runHandler();
      job.status = "completed";
      this.completedCount++;
      const duration = (Date.now() - startTime) / 1000;
      jobProcessingHistogram.observe(
        { job_type: job.type, status: "success" },
        duration
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      job.error = message;
      const duration = (Date.now() - startTime) / 1000;

      if (job.attempts < job.maxRetries) {
        jobProcessingHistogram.observe(
          { job_type: job.type, status: "retried" },
          duration
        );
        // Exponential back-off: 500ms, 1s, 2s, …
        const backoff = BASE_BACKOFF_MS * Math.pow(2, job.attempts - 1);
        job.status = "pending";
        job.runAt = new Date(Date.now() + backoff);
        this.pending.push(job);
        this.pending.sort((a, b) => b.priority - a.priority);
      } else {
        job.status = "dead";
        this.dead.push(job);
        this.failedCount++;
        queueFailedCounter.inc({ job_type: job.type });
        jobProcessingHistogram.observe(
          { job_type: job.type, status: "failed" },
          duration
        );
      }
    } finally {
      this.running.delete(job.id);
      this.activeWorkers--;
      this.updateMetrics();
      this.scheduleTick();
    }
  }
}

/** Singleton instance used by the application. */
export const jobQueue = new JobQueue(
  parseInt(process.env.JOB_QUEUE_CONCURRENCY || "2")
);

export default jobQueue;
