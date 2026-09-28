/**
 * Tests: events REST route (#2003)
 *
 * The shared eventBus is mocked so each test controls the history and
 * current sequence; no real event bus or network I/O is involved.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../services/eventBus", () => {
  const history: any[] = [];
  let seq = 0;
  return {
    eventBus: {
      get currentSequence() {
        return seq;
      },
      getHistory: vi.fn(() => [...history]),
      _setHistory: (evs: any[]) => {
        history.length = 0;
        history.push(...evs);
      },
      _setSequence: (n: number) => {
        seq = n;
      },
    },
  };
});

import eventsRouter, { CATCHUP_LIMIT } from "../events";
import { eventBus } from "../../services/eventBus";

const bus = eventBus as any;

function makeApp() {
  const app = express();
  app.use("/api/events", eventsRouter);
  return app;
}

function makeEvent(sequence: number, type = "token.created") {
  return {
    id: `evt-${sequence}`,
    type,
    payload: {},
    timestamp: "2026-01-01T00:00:00.000Z",
    sequence,
  };
}

let app: express.Express;

beforeEach(() => {
  bus._setHistory([]);
  bus._setSequence(0);
  bus.getHistory.mockClear();
  app = makeApp();
});

describe("CATCHUP_LIMIT", () => {
  it("is exported as 1000", () => {
    expect(CATCHUP_LIMIT).toBe(1000);
  });
});

describe("GET /api/events/catchup", () => {
  it("returns events after `since`, sorted ascending by sequence", async () => {
    bus._setHistory([makeEvent(5), makeEvent(3), makeEvent(2), makeEvent(4)]);
    bus._setSequence(5);

    const res = await request(app)
      .get("/api/events/catchup?since=2")
      .expect(200);

    expect(res.body.truncated).toBe(false);
    expect(res.body.currentSequence).toBe(5);
    expect(res.body.events.map((e: any) => e.sequence)).toEqual([3, 4, 5]);
  });

  it("returns an empty list when the client is already up to date", async () => {
    bus._setHistory([makeEvent(1), makeEvent(2)]);
    bus._setSequence(2);

    const res = await request(app)
      .get("/api/events/catchup?since=2")
      .expect(200);

    expect(res.body).toEqual({ truncated: false, events: [], currentSequence: 2 });
  });

  it("accepts since=0 on a fresh bus", async () => {
    const res = await request(app)
      .get("/api/events/catchup?since=0")
      .expect(200);

    expect(res.body).toEqual({ truncated: false, events: [], currentSequence: 0 });
  });

  it("still returns events when the gap equals CATCHUP_LIMIT exactly", async () => {
    bus._setHistory([makeEvent(CATCHUP_LIMIT)]);
    bus._setSequence(CATCHUP_LIMIT);

    const res = await request(app)
      .get("/api/events/catchup?since=0")
      .expect(200);

    expect(res.body.truncated).toBe(false);
    expect(res.body.events).toHaveLength(1);
  });

  it("returns truncated when the gap exceeds CATCHUP_LIMIT", async () => {
    bus._setSequence(CATCHUP_LIMIT + 1);

    const res = await request(app)
      .get("/api/events/catchup?since=0")
      .expect(200);

    expect(res.body).toEqual({
      truncated: true,
      currentSequence: CATCHUP_LIMIT + 1,
    });
    expect(bus.getHistory).not.toHaveBeenCalled();
  });

  it("flags a cursor ahead of the current sequence as a reset", async () => {
    bus._setSequence(3);

    const res = await request(app)
      .get("/api/events/catchup?since=50")
      .expect(200);

    expect(res.body).toEqual({
      truncated: true,
      reason: "cursor_reset",
      currentSequence: 3,
    });
  });

  it("returns 400 when `since` is missing", async () => {
    const res = await request(app).get("/api/events/catchup").expect(400);

    expect(res.body.error).toMatch(/non-negative integer/);
  });

  it("returns 400 when `since` is not numeric", async () => {
    await request(app).get("/api/events/catchup?since=abc").expect(400);
  });

  it("returns 400 when `since` is negative", async () => {
    await request(app).get("/api/events/catchup?since=-1").expect(400);
    expect(bus.getHistory).not.toHaveBeenCalled();
  });
});
