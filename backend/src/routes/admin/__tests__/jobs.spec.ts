import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { jobQueue } from "../../../services/jobQueue";
import jobsRouter from "../jobs";

vi.mock("../../../services/jobQueue", () => ({
  jobQueue: {
    failedJobs: vi.fn(),
    retryJob: vi.fn(),
    discardJob: vi.fn(),
  },
}));

vi.mock("../../../middleware/auth", () => ({
  authenticateAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const failedJob = {
  id: "job-1",
  type: "token-deploy",
  payload: { token: "NOVA" },
  priority: 0,
  attempts: 3,
  maxRetries: 3,
  status: "dead",
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
  runAt: new Date("2026-01-02T03:04:05.000Z"),
  error: "RPC timeout",
};

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  app = express();
  app.use(express.json());
  app.use("/api/admin/jobs", jobsRouter);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/admin/jobs/failed", () => {
  it("filters and paginates failed jobs", async () => {
    vi.mocked(jobQueue.failedJobs).mockReturnValueOnce([failedJob, { ...failedJob, id: "job-2" }] as any);

    const response = await request(app)
      .get("/api/admin/jobs/failed")
      .query({ jobType: "token-deploy", errorCode: "timeout", limit: "1", offset: "0" });

    expect(response.status).toBe(200);
    expect(response.body.data.jobs).toHaveLength(1);
    expect(response.body.data.pagination).toEqual({
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
    });
    expect(jobQueue.failedJobs).toHaveBeenCalledWith({
      jobType: "token-deploy",
      errorCode: "timeout",
    });
  });

  it("rejects invalid pagination parameters", async () => {
    const response = await request(app)
      .get("/api/admin/jobs/failed")
      .query({ limit: "-1" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(jobQueue.failedJobs).not.toHaveBeenCalled();
  });

  it("returns an internal error when the queue lookup fails", async () => {
    vi.mocked(jobQueue.failedJobs).mockImplementationOnce(() => {
      throw new Error("queue unavailable");
    });

    const response = await request(app).get("/api/admin/jobs/failed");

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("POST /api/admin/jobs/:id/retry", () => {
  it("returns the retried job", async () => {
    vi.mocked(jobQueue.retryJob).mockReturnValueOnce(failedJob as any);

    const response = await request(app).post("/api/admin/jobs/job-1/retry");

    expect(response.status).toBe(200);
    expect(response.body.data.job.id).toBe("job-1");
    expect(jobQueue.retryJob).toHaveBeenCalledWith("job-1");
  });

  it("returns not found when the job is absent", async () => {
    vi.mocked(jobQueue.retryJob).mockReturnValueOnce(null);

    const response = await request(app).post("/api/admin/jobs/missing/retry");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("JOB_NOT_FOUND");
  });

  it("returns an internal error when retrying throws", async () => {
    vi.mocked(jobQueue.retryJob).mockImplementationOnce(() => {
      throw new Error("retry failed");
    });

    const response = await request(app).post("/api/admin/jobs/job-1/retry");

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("DELETE /api/admin/jobs/:id", () => {
  it("discards a dead-letter job", async () => {
    vi.mocked(jobQueue.discardJob).mockReturnValueOnce(true);

    const response = await request(app).delete("/api/admin/jobs/job-1");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ discarded: true, id: "job-1" });
    expect(jobQueue.discardJob).toHaveBeenCalledWith("job-1");
  });

  it("returns not found when the job is absent", async () => {
    vi.mocked(jobQueue.discardJob).mockReturnValueOnce(false);

    const response = await request(app).delete("/api/admin/jobs/missing");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("JOB_NOT_FOUND");
  });

  it("returns an internal error when discarding throws", async () => {
    vi.mocked(jobQueue.discardJob).mockImplementationOnce(() => {
      throw new Error("discard failed");
    });

    const response = await request(app).delete("/api/admin/jobs/job-1");

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});