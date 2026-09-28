/**
 * Tests: idempotency middleware — non-JSON response cleanup (#2001)
 *
 * The in-flight lock used to be released only from the patched res.json, so
 * responses sent via res.send()/res.sendStatus()/res.end() or through
 * Express's default error handler left the key stuck in PROCESSING.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import request from "supertest";
import {
  IdempotencyStore,
  createIdempotencyMiddleware,
  IDEMPOTENCY_HEADER,
} from "../idempotency";

function makeApp(
  store: IdempotencyStore,
  handler: (req: Request, res: Response, next: NextFunction) => void
) {
  const app = express();
  app.use(express.json());
  app.post("/resource", createIdempotencyMiddleware(store), handler);
  return app;
}

describe("idempotency middleware — non-JSON responses", () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    store = new IdempotencyStore();
  });

  it("clears the lock and stores the result when the handler uses res.send()", async () => {
    let calls = 0;
    const app = makeApp(store, (_req, res) => {
      calls++;
      res.status(201).send("created");
    });

    const first = await request(app)
      .post("/resource")
      .set(IDEMPOTENCY_HEADER, "send-key")
      .expect(201);
    expect(first.text).toBe("created");

    expect(store.isInFlight("send-key")).toBe(false);
    expect(store.get("send-key")).toMatchObject({
      statusCode: 201,
      body: "created",
    });

    const retry = await request(app)
      .post("/resource")
      .set(IDEMPOTENCY_HEADER, "send-key");
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotency-status"]).toBe("replayed");
    expect(calls).toBe(1);
  });

  it("clears the lock when the handler uses res.sendStatus()", async () => {
    const app = makeApp(store, (_req, res) => {
      res.sendStatus(204);
    });

    await request(app)
      .post("/resource")
      .set(IDEMPOTENCY_HEADER, "status-key")
      .expect(204);

    expect(store.isInFlight("status-key")).toBe(false);

    const retry = await request(app)
      .post("/resource")
      .set(IDEMPOTENCY_HEADER, "status-key");
    expect(retry.status).not.toBe(409);
  });

  it("clears the lock without caching when a non-2xx is sent via res.send()", async () => {
    let calls = 0;
    const app = makeApp(store, (_req, res) => {
      calls++;
      res.status(503).send("unavailable");
    });

    await request(app)
      .post("/resource")
      .set(IDEMPOTENCY_HEADER, "fail-key")
      .expect(503);

    expect(store.isInFlight("fail-key")).toBe(false);
    expect(store.get("fail-key")).toBeUndefined();

    await request(app)
      .post("/resource")
      .set(IDEMPOTENCY_HEADER, "fail-key")
      .expect(503);
    expect(calls).toBe(2);
  });

  it("clears the lock when the handler throws into Express's error handler", async () => {
    let calls = 0;
    const app = makeApp(store, () => {
      calls++;
      throw new Error("boom");
    });

    await request(app)
      .post("/resource")
      .set(IDEMPOTENCY_HEADER, "throw-key")
      .expect(500);

    expect(store.isInFlight("throw-key")).toBe(false);
    expect(store.get("throw-key")).toBeUndefined();

    // A retry is processed again rather than rejected as PROCESSING.
    const retry = await request(app)
      .post("/resource")
      .set(IDEMPOTENCY_HEADER, "throw-key");
    expect(retry.status).toBe(500);
    expect(calls).toBe(2);
  });

  it("keeps the documented res.json contract (2xx cached, replayed)", async () => {
    let calls = 0;
    const app = makeApp(store, (_req, res) => {
      calls++;
      res.status(201).json({ id: 1 });
    });

    await request(app)
      .post("/resource")
      .set(IDEMPOTENCY_HEADER, "json-key")
      .expect(201);

    const retry = await request(app)
      .post("/resource")
      .set(IDEMPOTENCY_HEADER, "json-key")
      .expect(201);
    expect(retry.body).toEqual({ id: 1 });
    expect(retry.headers["idempotency-status"]).toBe("replayed");
    expect(calls).toBe(1);
  });
});
