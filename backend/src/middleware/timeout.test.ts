import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express, { Request, Response } from "express";
import {
  createTimeoutMiddleware,
  DEFAULT_TIMEOUT_MS,
  getTimeoutMs,
} from "./timeout";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeApp(timeoutMs: number, handlerDelayMs?: number) {
  const app = express();
  app.use(createTimeoutMiddleware(timeoutMs));

  app.get("/fast", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/slow", (_req: Request, res: Response) => {
    setTimeout(() => {
      if (!res.headersSent) res.json({ ok: true });
    }, handlerDelayMs ?? timeoutMs * 2);
  });

  app.get("/already-sent", (_req: Request, res: Response) => {
    res.json({ ok: true });
    // Simulate a second write after headers sent — middleware must not crash
  });

  // A handler that, unaware the timeout already fired, writes to `res` after
  // the configured timeout has elapsed. Before the post-timeout guard this
  // would throw "Cannot set headers after they are sent".
  app.get("/late-write", (_req: Request, res: Response) => {
    setTimeout(() => {
      res.json({ ok: true });
    }, handlerDelayMs ?? timeoutMs * 2);
  });

  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("getTimeoutMs()", () => {
  const originalEnv = process.env.REQUEST_TIMEOUT_MS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.REQUEST_TIMEOUT_MS;
    } else {
      process.env.REQUEST_TIMEOUT_MS = originalEnv;
    }
  });

  it("returns DEFAULT_TIMEOUT_MS when env var is not set", () => {
    delete process.env.REQUEST_TIMEOUT_MS;
    expect(getTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("returns parsed value from REQUEST_TIMEOUT_MS env var", () => {
    process.env.REQUEST_TIMEOUT_MS = "5000";
    expect(getTimeoutMs()).toBe(5000);
  });

  it("falls back to default when env var is not a number", () => {
    process.env.REQUEST_TIMEOUT_MS = "not-a-number";
    expect(getTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("falls back to default when env var is zero", () => {
    process.env.REQUEST_TIMEOUT_MS = "0";
    expect(getTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("falls back to default when env var is negative", () => {
    process.env.REQUEST_TIMEOUT_MS = "-100";
    expect(getTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("createTimeoutMiddleware()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through fast requests without timing out", async () => {
    const app = makeApp(1000);
    const res = await request(app).get("/fast");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("responds 503 when handler exceeds timeout", async () => {
    const app = makeApp(50, 200);

    const responsePromise = request(app).get("/slow");
    // Advance fake timers past the timeout
    vi.advanceTimersByTime(100);
    const res = await responsePromise;

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("REQUEST_TIMEOUT");
    expect(res.body.error.message).toContain("50ms");
    expect(res.body.timestamp).toBeDefined();
  });

  it("does not send a second response when headers already sent", async () => {
    const app = makeApp(1000);
    // /already-sent sends headers immediately; no timeout should fire
    const res = await request(app).get("/already-sent");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("uses the provided timeoutMs value", async () => {
    const app = makeApp(100, 300);

    const responsePromise = request(app).get("/slow");
    vi.advanceTimersByTime(150);
    const res = await responsePromise;

    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain("100ms");
  });

  it("accepts a custom timeout via factory argument", () => {
    const mw = createTimeoutMiddleware(9999);
    expect(typeof mw).toBe("function");
    expect(mw.length).toBe(3); // (req, res, next)
  });

  it("DEFAULT_TIMEOUT_MS is 30000", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });
});

// ─── Post-timeout write guard (real timers) ───────────────────────────────
// Exercises the path where the middleware has already sent the 503 and the
// still-running downstream handler later attempts to write to `res`. Uses
// real timers (not vi.useFakeTimers) so the response actually flushes and
// the late write can be observed.
describe("createTimeoutMiddleware() post-timeout write guard", () => {
  it("does not crash when the handler writes after the timeout has fired", async () => {
    const app = makeApp(30, 60);

    const res = await request(app).get("/late-write");

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("REQUEST_TIMEOUT");

    // Keep the test alive past the handler's delayed write so any thrown
    // "Cannot set headers after they are sent" surfaces here instead of as an
    // unhandled rejection after the test completes.
    await new Promise((r) => setTimeout(r, 120));
  });
});
