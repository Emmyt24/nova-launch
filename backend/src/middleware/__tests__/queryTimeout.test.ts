import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer } from "http";
import express, { Request, Response } from "express";
import request from "supertest";
import {
  createQueryTimeoutMiddleware,
  withQueryTimeout,
  withQueryTimeoutRace,
  getQueryTimeoutMs,
  QueryTimeoutError,
  DEFAULT_QUERY_TIMEOUT_MS,
} from "../queryTimeout";

describe("QueryTimeoutError", () => {
  it("carries the timeout and operation name", () => {
    const err = new QueryTimeoutError(5000, "fetchCampaign");
    expect(err.message).toContain("5000ms");
    expect(err.message).toContain("fetchCampaign");
    expect(err.name).toBe("QueryTimeoutError");
  });

  it("works without an operation label", () => {
    const err = new QueryTimeoutError(3000);
    expect(err.message).toContain("3000ms");
  });
});

describe("createQueryTimeoutMiddleware / getQueryTimeoutMs", () => {
  it("attaches DEFAULT_QUERY_TIMEOUT_MS when no arg is passed", () => {
    const app = express();
    app.use(createQueryTimeoutMiddleware());
    app.get("/", (_req: Request, res: Response) => {
      res.json({ timeout: getQueryTimeoutMs(res) });
    });

    return request(app)
      .get("/")
      .expect(200)
      .then((r) => expect(r.body.timeout).toBe(DEFAULT_QUERY_TIMEOUT_MS));
  });

  it("attaches a custom timeout when provided", () => {
    const app = express();
    app.use(createQueryTimeoutMiddleware(10_000));
    app.get("/", (_req: Request, res: Response) => {
      res.json({ timeout: getQueryTimeoutMs(res) });
    });

    return request(app)
      .get("/")
      .expect(200)
      .then((r) => expect(r.body.timeout).toBe(10_000));
  });
});

describe("withQueryTimeout (per-route override)", () => {
  it("overrides the global timeout for a specific route", () => {
    const app = express();
    app.use(createQueryTimeoutMiddleware(30_000));
    app.get("/heavy", withQueryTimeout(120_000), (_req: Request, res: Response) => {
      res.json({ timeout: getQueryTimeoutMs(res) });
    });
    app.get("/normal", (_req: Request, res: Response) => {
      res.json({ timeout: getQueryTimeoutMs(res) });
    });

    return Promise.all([
      request(app).get("/heavy").expect(200).then((r) => expect(r.body.timeout).toBe(120_000)),
      request(app).get("/normal").expect(200).then((r) => expect(r.body.timeout).toBe(30_000)),
    ]);
  });
});

describe("withQueryTimeoutRace", () => {
  it("resolves with the operation result when it completes in time", async () => {
    const result = await withQueryTimeoutRace(() => Promise.resolve(42), 1000, "test");
    expect(result).toBe(42);
  });

  it("throws QueryTimeoutError when the operation exceeds the timeout", async () => {
    const slow = () => new Promise<never>((resolve) => setTimeout(resolve, 500));
    await expect(withQueryTimeoutRace(slow, 50, "slowOp")).rejects.toBeInstanceOf(QueryTimeoutError);
  });

  it("clears the timer on success so there are no leaks", async () => {
    vi.useFakeTimers();
    const op = async () => "done";
    const p = withQueryTimeoutRace(op, 5000, "fast");
    vi.runAllTimers();
    await expect(p).resolves.toBe("done");
    vi.useRealTimers();
  });
});
