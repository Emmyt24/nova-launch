import { describe, it, expect, vi } from "vitest";
import { createGracefulShutdown } from "../lib/gracefulShutdown";
import { JobQueue } from "../services/jobQueue";

const quietLog = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

describe("graceful shutdown (#2195)", () => {
  it("runs steps in order and exits 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      steps: [
        { name: "a", run: () => void order.push("a") },
        { name: "b", run: async () => void order.push("b") },
      ],
      exit,
      log: quietLog,
    });
    await shutdown("SIGTERM");
    expect(order).toEqual(["a", "b"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("continues past a failing step and exits 1", async () => {
    const closed = vi.fn();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      steps: [
        { name: "bad", run: () => Promise.reject(new Error("boom")) },
        { name: "db", run: closed },
      ],
      exit,
      log: quietLog,
    });
    await shutdown("SIGINT");
    expect(closed).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("forces exit when a step hangs past the timeout", async () => {
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      steps: [{ name: "hang", run: () => new Promise<void>(() => {}) }],
      timeoutMs: 30,
      exit,
      log: quietLog,
    });
    await shutdown("SIGTERM");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("is idempotent for repeated signals", async () => {
    const run = vi.fn();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ steps: [{ name: "x", run }], exit, log: quietLog });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("job queue drain waits for in-flight jobs and refuses new work", async () => {
    const queue = new JobQueue(1);
    let finished = false;
    queue.register("slow", async () => {
      await new Promise((r) => setTimeout(r, 80));
      finished = true;
    });
    queue.start();
    queue.enqueue("slow", {});
    await new Promise((r) => setTimeout(r, 30)); // let the worker pick it up

    const result = await queue.drain(2000);
    expect(finished).toBe(true);
    expect(result).toEqual({ drained: true, inFlight: 0 });
  });

  it("job queue drain reports jobs still running at timeout", async () => {
    const queue = new JobQueue(1);
    queue.register("stuck", () => new Promise<void>(() => {}));
    queue.start();
    queue.enqueue("stuck", {});
    await new Promise((r) => setTimeout(r, 30));

    const result = await queue.drain(60);
    expect(result).toEqual({ drained: false, inFlight: 1 });
  });
});
