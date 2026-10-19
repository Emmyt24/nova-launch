/**
 * Idempotency-Key support on POST /api/tokens/batch (#2197)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import tokenRoutes from "../tokens";
import { batchDeployTokens } from "../../services/batchTokenDeployService";

vi.mock("../../lib/prisma", () => ({
  prisma: { token: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() }, $transaction: vi.fn() },
}));
vi.mock("../../services/batchTokenDeployService", () => ({
  batchDeployTokens: vi.fn(),
  BATCH_MAX_SIZE: 10,
}));

const app = express();
app.use(express.json());
app.use("/api/tokens", tokenRoutes);

const body = {
  tokens: [
    { creator: "GCREATORABC123", name: "Test Token", symbol: "TEST", decimals: 7, initialSupply: "1000000" },
  ],
};

// Each test uses its own key, so the shared in-memory store needs no reset.
const post = (key?: string, tenant = "GCREATOR1") => {
  const r = request(app).post("/api/tokens/batch").set("X-Tenant-ID", tenant);
  if (key) r.set("Idempotency-Key", key);
  return r.send(body);
};

let deployCount = 0;

beforeEach(() => {
  vi.clearAllMocks();
  deployCount = 0;
  (batchDeployTokens as any).mockImplementation(async () => {
    const n = ++deployCount;
    await new Promise((r) => setTimeout(r, 40));
    return { succeeded: [{ id: `tok-${n}` }], failed: [] };
  });
});

describe("POST /api/tokens/batch — Idempotency-Key", () => {
  it("replays the original response without deploying again", async () => {
    const first = await post("key-replay");
    const second = await post("key-replay");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers["idempotency-status"]).toBe("replayed");
    expect(second.body).toEqual(first.body);
    expect(batchDeployTokens).toHaveBeenCalledTimes(1);
  });

  it("deploys every time when no key is supplied", async () => {
    await post();
    await post();
    expect(batchDeployTokens).toHaveBeenCalledTimes(2);
  });

  it("deploys once for concurrent requests sharing a key", async () => {
    const results = await Promise.all([post("key-concurrent"), post("key-concurrent"), post("key-concurrent")]);

    expect(batchDeployTokens).toHaveBeenCalledTimes(1);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    expect(conflict.body).toEqual({ status: "PROCESSING", requestId: "key-concurrent" });
  });

  it("does not share a key between tenants", async () => {
    await post("key-shared", "TENANT-A");
    const other = await post("key-shared", "TENANT-B");

    expect(other.headers["idempotency-status"]).toBeUndefined();
    expect(batchDeployTokens).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures, so the client can retry with the same key", async () => {
    (batchDeployTokens as any).mockRejectedValueOnce(new Error("rpc down"));
    const failed = await post("key-retry");
    const retried = await post("key-retry");

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect(batchDeployTokens).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed key with 400 before deploying", async () => {
    const res = await post("x".repeat(300));
    expect(res.status).toBe(400);
    expect(batchDeployTokens).not.toHaveBeenCalled();
  });
});
