import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { prisma } from "../../../lib/prisma";
import {
  getIPFSCircuitBreakerMetrics,
  resetIPFSCircuitBreaker,
  rotatePinataCredentials,
} from "../../../lib/ipfs/pinata.js";
import operationalRouter from "../operational";

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    token: { count: vi.fn() },
    integrationState: { findUnique: vi.fn() },
  },
}));

vi.mock("../../../lib/ipfs/pinata.js", () => ({
  getIPFSCircuitBreakerMetrics: vi.fn(),
  resetIPFSCircuitBreaker: vi.fn(),
  rotatePinataCredentials: vi.fn(),
}));

vi.mock("../../../middleware/auth", () => ({
  authenticateAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  app = express();
  app.use(express.json());
  app.use("/api/admin/operational", operationalRouter);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/admin/operational", () => {
  it("returns token counts and the event cursor", async () => {
    const updatedAt = new Date("2026-01-02T03:04:05.000Z");
    vi.mocked(prisma.token.count).mockResolvedValueOnce(42);
    vi.mocked(prisma.integrationState.findUnique).mockResolvedValueOnce({
      key: "event_cursor",
      value: "cursor-123",
      updatedAt,
    } as any);

    const response = await request(app).get("/api/admin/operational");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      tokens: { total: 42 },
      eventListener: { cursor: "cursor-123", updatedAt: updatedAt.toISOString() },
    });
    expect(response.body.data.fetchedAt).toEqual(expect.any(String));
  });

  it("returns an internal error when the database lookup fails", async () => {
    vi.mocked(prisma.token.count).mockRejectedValueOnce(new Error("database unavailable"));
    vi.mocked(prisma.integrationState.findUnique).mockResolvedValueOnce(null);

    const response = await request(app).get("/api/admin/operational");

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("GET /api/admin/operational/circuit-breaker/ipfs", () => {
  it("returns IPFS circuit breaker metrics", async () => {
    vi.mocked(getIPFSCircuitBreakerMetrics).mockReturnValueOnce({ state: "closed" } as any);

    const response = await request(app).get("/api/admin/operational/circuit-breaker/ipfs");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      service: "ipfs",
      metrics: { state: "closed" },
    });
  });

  it("returns an internal error when metrics cannot be read", async () => {
    vi.mocked(getIPFSCircuitBreakerMetrics).mockImplementationOnce(() => {
      throw new Error("metrics unavailable");
    });

    const response = await request(app).get("/api/admin/operational/circuit-breaker/ipfs");

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("POST /api/admin/operational/circuit-breaker/ipfs/reset", () => {
  it("resets the circuit breaker", async () => {
    const response = await request(app).post(
      "/api/admin/operational/circuit-breaker/ipfs/reset",
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      service: "ipfs",
      message: "Circuit breaker reset successfully",
    });
    expect(resetIPFSCircuitBreaker).toHaveBeenCalledOnce();
  });

  it("returns an internal error when reset fails", async () => {
    vi.mocked(resetIPFSCircuitBreaker).mockImplementationOnce(() => {
      throw new Error("reset failed");
    });

    const response = await request(app).post(
      "/api/admin/operational/circuit-breaker/ipfs/reset",
    );

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("POST /api/admin/operational/pinata/credentials", () => {
  it("rejects a missing credential before rotating", async () => {
    const response = await request(app)
      .post("/api/admin/operational/pinata/credentials")
      .send({ apiKey: "key-only" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_REQUEST");
    expect(rotatePinataCredentials).not.toHaveBeenCalled();
  });

  it("rotates a complete credential pair", async () => {
    vi.mocked(rotatePinataCredentials).mockResolvedValueOnce(undefined);

    const response = await request(app)
      .post("/api/admin/operational/pinata/credentials")
      .send({ apiKey: "new-key", apiSecret: "new-secret" });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(rotatePinataCredentials).toHaveBeenCalledWith("new-key", "new-secret");
  });

  it("returns an internal error when credential validation fails", async () => {
    vi.mocked(rotatePinataCredentials).mockRejectedValueOnce(new Error("invalid credentials"));

    const response = await request(app)
      .post("/api/admin/operational/pinata/credentials")
      .send({ apiKey: "bad-key", apiSecret: "bad-secret" });

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});