/**
 * Tests for JobQueue – background job processing.
 *
 * Uses real timers via vi.useFakeTimers() where delay behaviour is tested,
 * and real async execution for the happy-path tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JobQueue, Job } from "../services/jobQueue";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for all pending microtasks + a short real delay. */
function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("JobQueue", () => {
  let q: JobQueue;

  beforeEach(() => {
    q = new JobQueue(2); // 2 concurrent workers
    q.start();
  });

  afterEach(() => {
    q.stop();
  });

  // ── Registration ──────────────────────────────────────────────────────────

  describe("register", () => {
    it("registers a handler without error", () => {
      expect(() => q.register("test.job", async () => {})).not.toThrow();
    });

    it("throws when registering the same type twice", () => {
      q.register("dup", async () => {});
      expect(() => q.register("dup", async () => {})).toThrow(/already registered/i);
    });
  });

  // ── Enqueue validation ────────────────────────────────────────────────────

  describe("enqueue validation", () => {
    it("throws when no handler is registered for the type", () => {
      expect(() => q.enqueue("unknown.type", {})).toThrow(/no handler registered/i);
    });

    it("throws when payload exceeds 64 KB", () => {
      q.register("big", async () => {});
      const huge = { data: "x".repeat(65 * 1024) };
      expect(() => q.enqueue("big", huge)).toThrow(/exceeds limit/i);
    });

    it("returns a job with expected shape", () => {
      q.register("shape.test", async () => {});
      const job = q.enqueue("shape.test", { value: 42 });

      expect(job.id).toMatch(/^job_/);
      expect(job.type).toBe("shape.test");
      expect(job.payload).toEqual({ value: 42 });
      expect(job.status).toBe("pending");
      expect(job.attempts).toBe(0);
      expect(job.priority).toBe(0);
    });
  });

  // ── Execution ─────────────────────────────────────────────────────────────

  describe("execution", () => {
    it("executes a job and marks it completed", async () => {
      const executed: unknown[] = [];
      q.register("exec.test", async (job) => { executed.push(job.payload); });

      q.enqueue("exec.test", { msg: "hello" });
      await flush();

      expect(executed).toEqual([{ msg: "hello" }]);
      expect(q.stats().completed).toBe(1);
    });

    it("runs multiple jobs", async () => {
      const results: number[] = [];
      q.register("multi", async (job: Job<{ n: number }>) => { results.push(job.payload.n); });

      q.enqueue("multi", { n: 1 });
      q.enqueue("multi", { n: 2 });
      q.enqueue("multi", { n: 3 });
      await flush(50);

      expect(results.sort()).toEqual([1, 2, 3]);
      expect(q.stats().completed).toBe(3);
    });

    it("respects concurrency limit", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      q.register("concurrent", async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent--;
      });

      // Enqueue 4 jobs on a queue with concurrency=2
      for (let i = 0; i < 4; i++) q.enqueue("concurrent", {});
      await flush(200);

      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(q.stats().completed).toBe(4);
    });
  });

  // ── Priority ──────────────────────────────────────────────────────────────

  describe("priority", () => {
    it("processes higher-priority jobs first", async () => {
      // Use concurrency=1 so order is deterministic
      const sq = new JobQueue(1);
      sq.start();

      const order: number[] = [];
      sq.register("prio", async (job: Job<{ n: number }>) => { order.push(job.payload.n); });

      // Enqueue all before the queue ticks
      sq.enqueue("prio", { n: 1 }, { priority: 1 });
      sq.enqueue("prio", { n: 3 }, { priority: 3 });
      sq.enqueue("prio", { n: 2 }, { priority: 2 });

      await flush(50);
      sq.stop();

      expect(order).toEqual([3, 2, 1]);
    });
  });

  // ── Retry & back-off ──────────────────────────────────────────────────────

  describe("retry", () => {
    it("retries a failing job up to maxRetries times", async () => {
      let calls = 0;
      q.register("retry.test", async () => {
        calls++;
        throw new Error("transient");
      });

      q.enqueue("retry.test", {}, { maxRetries: 3 });

      // Initial attempt runs immediately; retries are delayed by back-off.
      // Flush initial attempt, then advance time past each back-off window.
      await flush(20);          // attempt 1
      await flush(600);         // attempt 2 (back-off ~500ms)
      await flush(1100);        // attempt 3 (back-off ~1000ms)
      await flush(20);          // settle

      expect(calls).toBe(3);
      expect(q.stats().dead).toBe(1);
    }, 10_000);

    it("moves job to dead-letter after exhausting retries", async () => {
      q.register("dead.test", async () => { throw new Error("always fails"); });
      q.enqueue("dead.test", {}, { maxRetries: 1 });

      await flush(20);   // attempt 1
      await flush(600);  // attempt 2 (back-off ~500ms)
      await flush(20);   // settle

      const dead = q.deadLetterJobs();
      expect(dead).toHaveLength(1);
      expect(dead[0].type).toBe("dead.test");
      expect(dead[0].status).toBe("dead");
      expect(dead[0].error).toMatch(/always fails/);
    }, 5_000);

    it("succeeds on retry after initial failure", async () => {
      let calls = 0;
      q.register("flaky", async () => {
        calls++;
        if (calls < 2) throw new Error("first attempt fails");
      });

      q.enqueue("flaky", {}, { maxRetries: 3 });

      await flush(20);   // attempt 1 (fails)
      await flush(600);  // attempt 2 (succeeds, back-off ~500ms)
      await flush(20);   // settle

      expect(calls).toBe(2);
      expect(q.stats().completed).toBe(1);
      expect(q.stats().dead).toBe(0);
    }, 5_000);
  });

  // ── Delayed jobs ──────────────────────────────────────────────────────────

  describe("delayed jobs", () => {
    it("does not run a job before its delay expires", async () => {
      const executed: boolean[] = [];
      q.register("delayed", async () => { executed.push(true); });

      q.enqueue("delayed", {}, { delayMs: 10_000 });
      await flush(30); // well before 10 s

      expect(executed).toHaveLength(0);
    });

    it("runs a delayed job after the delay", async () => {
      const executed: boolean[] = [];
      q.register("delayed.run", async () => { executed.push(true); });

      q.enqueue("delayed.run", {}, { delayMs: 50 });
      await flush(10);  // before delay
      expect(executed).toHaveLength(0);

      await flush(100); // after delay
      expect(executed).toHaveLength(1);
    });
  });

  // ── Stats ─────────────────────────────────────────────────────────────────

  describe("stats", () => {
    it("returns zero counts on a fresh queue", () => {
      const s = q.stats();
      expect(s).toEqual({ pending: 0, running: 0, completed: 0, failed: 0, dead: 0 });
    });

    it("increments completed count after successful job", async () => {
      q.register("stats.ok", async () => {});
      q.enqueue("stats.ok", {});
      await flush();
      expect(q.stats().completed).toBe(1);
    });

    it("increments dead count after exhausted retries", async () => {
      q.register("stats.fail", async () => { throw new Error("x"); });
      q.enqueue("stats.fail", {}, { maxRetries: 1 });

      await flush(20);   // attempt 1
      await flush(600);  // attempt 2 (back-off ~500ms)
      await flush(20);   // settle

      expect(q.stats().dead).toBe(1);
    }, 5_000);
  });

  // ── Stop / start ──────────────────────────────────────────────────────────

  describe("stop / start", () => {
    it("stop prevents new ticks from being scheduled", async () => {
      const executed: boolean[] = [];
      q.register("stop.test", async () => { executed.push(true); });

      q.stop();
      q.enqueue("stop.test", {});
      await flush(30);

      // Job was enqueued but queue is stopped — should not have run
      expect(executed).toHaveLength(0);
    });

    it("start resumes processing after stop", async () => {
      const executed: boolean[] = [];
      q.register("resume.test", async () => { executed.push(true); });

      q.stop();
      q.enqueue("resume.test", {});
      await flush(10);
      expect(executed).toHaveLength(0);

      q.start();
      await flush(30);
      expect(executed).toHaveLength(1);
    });
  });

  // ── Dead-letter ───────────────────────────────────────────────────────────

  describe("deadLetterJobs", () => {
    it("returns a copy of the dead-letter list", async () => {
      q.register("dl", async () => { throw new Error("fail"); });
      q.enqueue("dl", { x: 1 }, { maxRetries: 1 });

      await flush(20);   // attempt 1
      await flush(600);  // attempt 2 (back-off ~500ms)
      await flush(20);   // settle

      const dl = q.deadLetterJobs();
      expect(dl).toHaveLength(1);
      // Mutating the returned array should not affect internal state
      dl.pop();
      expect(q.deadLetterJobs()).toHaveLength(1);
    }, 5_000);
  });

  // ── Recurring schedule ────────────────────────────────────────────────────

  describe("scheduleRecurring", () => {
    it("enqueues a job on each interval tick", async () => {
      q.register("recur", async () => {});
      q.scheduleRecurring("recur", { x: 1 }, 20);

      await flush(70); // ~3 ticks

      expect(q.stats().completed).toBeGreaterThanOrEqual(2);
      q.stopRecurring("recur");
    });

    it("is a no-op when called twice for the same type", async () => {
      let calls = 0;
      q.register("recur.once", async () => {
        calls++;
      });

      q.scheduleRecurring("recur.once", {}, 20);
      q.scheduleRecurring("recur.once", {}, 20);

      await flush(50);
      const callsAfterFirstWindow = calls;
      q.stopRecurring("recur.once");
      await flush(50);

      // A duplicate schedule would have doubled the calls in the same window.
      expect(callsAfterFirstWindow).toBeLessThan(4);
      expect(calls).toBe(callsAfterFirstWindow);
    });
  });

  describe("stopRecurring", () => {
    it("stops enqueuing further jobs once stopped", async () => {
      q.register("recur.stop", async () => {});
      q.scheduleRecurring("recur.stop", {}, 20);

      await flush(50);
      q.stopRecurring("recur.stop");
      const completedAtStop = q.stats().completed;

      await flush(60);
      expect(q.stats().completed).toBe(completedAtStop);
    });
  });

  // ── Payload size guard ────────────────────────────────────────────────────

  describe("payload size guard", () => {
    it("accepts payloads just under the 64 KB limit", () => {
      q.register("size.ok", async () => {});
      // ~63 KB string
      const payload = { data: "a".repeat(63 * 1024) };
      expect(() => q.enqueue("size.ok", payload)).not.toThrow();
    });

    it("handles BigInt payload fields without crashing (Issue #1975)", () => {
      q.register("bigint.test", async () => {});
      // Payload containing BigInt should not throw TypeError during serialization check
      const payload = {
        amount: BigInt("12345678901234567890"),
        description: "large number",
      };
      expect(() => q.enqueue("bigint.test", payload)).not.toThrow();
      expect(q.stats().pending).toBe(1);
    });

    it("accepts payloads with nested BigInt values", () => {
      q.register("bigint.nested", async () => {});
      const payload = {
        transaction: {
          tokenAmount: BigInt("999999999999999999"),
          burnedAmount: BigInt("1000000000000"),
        },
        metadata: "test",
      };
      expect(() => q.enqueue("bigint.nested", payload)).not.toThrow();
      expect(q.stats().pending).toBe(1);
    });

    it("still rejects payloads that are genuinely too large", () => {
      q.register("size.fail", async () => {});
      const hugePayload = { data: "x".repeat(65 * 1024) };
      expect(() => q.enqueue("size.fail", hugePayload)).toThrow(/exceeds limit/i);
    });
  });

  // ── failedJobs ────────────────────────────────────────────────────────────

  describe("failedJobs", () => {
    async function seedDeadJob(type: string, errorMsg = "boom"): Promise<void> {
      q.register(type, async () => { throw new Error(errorMsg); });
      q.enqueue(type, {}, { maxRetries: 1 });
      await flush(20);   // attempt 1
      await flush(600);  // attempt 2 (back-off ~500ms)
      await flush(20);   // settle
    }

    it("returns all dead-letter jobs when no filters given", async () => {
      await seedDeadJob("fj.all");
      const jobs = q.failedJobs();
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      expect(jobs.every((j) => j.status === "dead")).toBe(true);
    }, 5_000);

    it("filters by jobType", async () => {
      await seedDeadJob("fj.type.a");
      await seedDeadJob("fj.type.b");

      const jobs = q.failedJobs({ jobType: "fj.type.a" });
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      expect(jobs.every((j) => j.type === "fj.type.a")).toBe(true);
    }, 10_000);

    it("filters by errorCode substring", async () => {
      await seedDeadJob("fj.err.match", "unique-error-xyz");
      await seedDeadJob("fj.err.nomatch", "something-else");

      const jobs = q.failedJobs({ errorCode: "unique-error-xyz" });
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      expect(jobs.every((j) => j.error?.includes("unique-error-xyz"))).toBe(true);
    }, 10_000);

    it("filters by startDate", async () => {
      const before = new Date();
      await seedDeadJob("fj.date.start");
      const after = new Date();

      const withStart = q.failedJobs({ startDate: before });
      const withFuture = q.failedJobs({ startDate: after });

      expect(withStart.some((j) => j.type === "fj.date.start")).toBe(true);
      expect(withFuture.some((j) => j.type === "fj.date.start")).toBe(false);
    }, 5_000);

    it("filters by endDate", async () => {
      await seedDeadJob("fj.date.end");
      const now = new Date();
      const past = new Date(Date.now() - 60_000);

      const withinRange = q.failedJobs({ endDate: now });
      const beforeRange = q.failedJobs({ endDate: past });

      expect(withinRange.some((j) => j.type === "fj.date.end")).toBe(true);
      expect(beforeRange.some((j) => j.type === "fj.date.end")).toBe(false);
    }, 5_000);

    it("returns empty array when no jobs match filters", async () => {
      const jobs = q.failedJobs({ jobType: "nonexistent.type.xyz" });
      expect(jobs).toEqual([]);
    });
  });

  // ── retryJob ──────────────────────────────────────────────────────────────

  describe("retryJob", () => {
    it("returns null for unknown job id", () => {
      expect(q.retryJob("nonexistent-id")).toBeNull();
    });

    it("removes the job from dead-letter and re-enqueues it", async () => {
      let calls = 0;
      q.register("retry.dl", async () => {
        calls++;
        if (calls === 1) throw new Error("fail first");
        // succeed on retry
      });

      q.enqueue("retry.dl", {}, { maxRetries: 1 });
      await flush(20);   // attempt 1 fails
      await flush(600);  // attempt 2 fails → goes dead
      await flush(20);

      const dead = q.deadLetterJobs();
      const deadJob = dead.find((j) => j.type === "retry.dl");
      expect(deadJob).toBeDefined();

      const requeued = q.retryJob(deadJob!.id);
      expect(requeued).not.toBeNull();
      expect(requeued!.status).toBe("pending");
      expect(requeued!.attempts).toBe(0);

      // No longer in dead-letter
      expect(q.deadLetterJobs().find((j) => j.id === deadJob!.id)).toBeUndefined();
    }, 5_000);

    it("re-enqueued job eventually completes", async () => {
      let calls = 0;
      // Fail only on the first call; succeed on any subsequent call.
      q.register("retry.complete", async () => {
        calls++;
        if (calls === 1) throw new Error("first call fails");
        // calls >= 2: succeed
      });

      // maxRetries=1 means 1 attempt total before going dead (attempts >= maxRetries)
      q.enqueue("retry.complete", {}, { maxRetries: 1 });
      await flush(20);   // attempt 1 fails → dead (attempts === maxRetries)
      await flush(20);   // settle

      const deadJob = q.deadLetterJobs().find((j) => j.type === "retry.complete");
      expect(deadJob).toBeDefined();

      // Retry resets attempts to 0, so maxRetries=1 allows one fresh attempt
      q.retryJob(deadJob!.id);
      await flush(50);   // the re-queued job runs and succeeds

      expect(calls).toBeGreaterThanOrEqual(2);
      expect(q.deadLetterJobs().find((j) => j.id === deadJob!.id)).toBeUndefined();
    }, 5_000);

    it("elevates the job priority to at least 10", async () => {
      q.register("retry.prio", async () => { throw new Error("fail"); });
      q.enqueue("retry.prio", {}, { maxRetries: 1 });

      await flush(20);
      await flush(600);
      await flush(20);

      const deadJob = q.deadLetterJobs().find((j) => j.type === "retry.prio");
      const requeued = q.retryJob(deadJob!.id);
      expect(requeued!.priority).toBeGreaterThanOrEqual(10);
    }, 5_000);
  });

  // ── discardJob ────────────────────────────────────────────────────────────

  describe("discardJob", () => {
    it("returns false for unknown job id", () => {
      expect(q.discardJob("nonexistent-id")).toBe(false);
    });

    it("removes the job from dead-letter and returns true", async () => {
      q.register("discard.dl", async () => { throw new Error("fail"); });
      q.enqueue("discard.dl", {}, { maxRetries: 1 });

      await flush(20);
      await flush(600);
      await flush(20);

      const dead = q.deadLetterJobs();
      const deadJob = dead.find((j) => j.type === "discard.dl");
      expect(deadJob).toBeDefined();

      const result = q.discardJob(deadJob!.id);
      expect(result).toBe(true);
      expect(q.deadLetterJobs().find((j) => j.id === deadJob!.id)).toBeUndefined();
    }, 5_000);

    it("does not affect other jobs in the dead-letter list", async () => {
      q.register("discard.keep", async () => { throw new Error("fail"); });
      q.register("discard.remove", async () => { throw new Error("fail"); });

      q.enqueue("discard.keep", {}, { maxRetries: 1 });
      q.enqueue("discard.remove", {}, { maxRetries: 1 });

      await flush(20);
      await flush(600);
      await flush(20);

      const before = q.deadLetterJobs();
      const toRemove = before.find((j) => j.type === "discard.remove");
      const toKeep = before.find((j) => j.type === "discard.keep");
      expect(toRemove).toBeDefined();
      expect(toKeep).toBeDefined();

      q.discardJob(toRemove!.id);

      const after = q.deadLetterJobs();
      expect(after.find((j) => j.id === toRemove!.id)).toBeUndefined();
      expect(after.find((j) => j.id === toKeep!.id)).toBeDefined();
    }, 5_000);
  });
});
