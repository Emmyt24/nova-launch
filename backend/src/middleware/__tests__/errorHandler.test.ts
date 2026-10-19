/**
 * Tests for issue #2187 — structured error response format.
 *
 * Every error body must follow the shared schema:
 *   { success: false, error: { code, message, details?, requestId }, requestId, timestamp }
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { body } from "express-validator";
import { requestLoggingMiddleware } from "../request-logging.middleware";
import { errorHandler, normaliseError, notFoundHandler } from "../errorHandler";
import { validate } from "../validation";
import { authenticateAdmin, requireRole } from "../auth";
import { createTimeoutMiddleware } from "../timeout";
import { NotFoundError, ValidationError, ErrorCode, DatabaseError } from "../../lib/errors";
import { errorResponse, sendError } from "../../utils/response";
import { runWithContext } from "../../lib/async-context";
import eventsRouter from "../../routes/events";

function buildApp(configure: (app: express.Express) => void) {
  const app = express();
  app.use(requestLoggingMiddleware);
  app.use(express.json());
  configure(app);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Assert that a response body follows the shared error schema. */
function expectStructuredError(body: any, code: string, requestId?: string) {
  expect(body.success).toBe(false);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  expect(typeof body.timestamp).toBe("string");
  expect(typeof body.requestId).toBe("string");
  expect(body.error.requestId).toBe(body.requestId);
  if (requestId) expect(body.requestId).toBe(requestId);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("errorResponse / sendError", () => {
  it("fills requestId and correlationId from the request context", () => {
    const body = runWithContext(
      "corr-1",
      () => errorResponse({ code: "X", message: "m" }),
      "tx-1",
      undefined,
      "req-1"
    );
    expect(body.error).toEqual({ code: "X", message: "m", requestId: "req-1", correlationId: "corr-1" });
    expect(body.requestId).toBe("req-1");
    expect(body.transactionId).toBe("tx-1");
  });

  it("omits optional fields outside a request context", () => {
    const body = errorResponse({ code: "X", message: "m" });
    expect(body.error).toEqual({ code: "X", message: "m" });
    expect(body).not.toHaveProperty("requestId");
  });

  it("sendError sets the status and structured body", async () => {
    const app = buildApp((a) =>
      a.get("/x", (_req, res) => sendError(res, 409, "CONFLICT", "dup", { field: "name" }))
    );
    const res = await request(app).get("/x").set("X-Request-Id", "send-1");
    expect(res.status).toBe(409);
    expectStructuredError(res.body, "CONFLICT", "send-1");
    expect(res.body.error.details).toEqual({ field: "name" });
  });
});

describe("normaliseError", () => {
  it("maps ZodError to VALIDATION_ERROR with issues as details", () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    const err = normaliseError(!parsed.success && parsed.error);
    expect(err.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(err.httpStatus).toBe(422);
    expect(Array.isArray(err.details)).toBe(true);
  });

  it("maps body-parser failures to BAD_REQUEST", () => {
    const err = normaliseError(Object.assign(new Error("Unexpected token"), { type: "entity.parse.failed", status: 400 }));
    expect(err.code).toBe(ErrorCode.BAD_REQUEST);
    expect(err.httpStatus).toBe(400);
  });

  it("keeps the client status of http-errors style errors", () => {
    const err = normaliseError(Object.assign(new Error("Gone"), { status: 410 }));
    expect(err.httpStatus).toBe(410);
    expect(err.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it("maps unknown errors to INTERNAL_SERVER_ERROR", () => {
    expect(normaliseError(new Error("boom")).code).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
  });
});

describe("errorHandler", () => {
  it("serialises AppErrors with code, message, details and requestId", async () => {
    const app = buildApp((a) =>
      a.get("/x", () => {
        throw new NotFoundError("Token", "abc");
      })
    );
    const res = await request(app).get("/x").set("X-Request-Id", "app-err-1");
    expect(res.status).toBe(404);
    expectStructuredError(res.body, "NOT_FOUND", "app-err-1");
    expect(res.body.error.details).toEqual({ resource: "Token", identifier: "abc" });
  });

  it("handles errors forwarded with next(err) from async handlers", async () => {
    const app = buildApp((a) =>
      a.get("/x", async (_req, _res, next) => next(new ValidationError("bad input", { field: "q" })))
    );
    const res = await request(app).get("/x");
    expect(res.status).toBe(422);
    expectStructuredError(res.body, "VALIDATION_ERROR");
  });

  it("returns BAD_REQUEST for malformed JSON bodies", async () => {
    const app = buildApp((a) => a.post("/x", (_req, res) => res.json({ ok: true })));
    const res = await request(app).post("/x").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expectStructuredError(res.body, "BAD_REQUEST");
  });

  it("hides unexpected 5xx messages outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = buildApp((a) =>
      a.get("/x", () => {
        throw new Error("password=hunter2 leaked");
      })
    );
    const res = await request(app).get("/x");
    expect(res.status).toBe(500);
    expectStructuredError(res.body, "INTERNAL_SERVER_ERROR");
    expect(res.body.error.message).toBe("An unexpected error occurred");
  });

  it("strips details from 5xx AppErrors outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = buildApp((a) =>
      a.get("/x", () => {
        throw new DatabaseError("Database unavailable", new Error("conn refused"));
      })
    );
    const res = await request(app).get("/x");
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("Database unavailable");
    expect(res.body.error).not.toHaveProperty("details");
  });
});

describe("notFoundHandler", () => {
  it("returns a structured 404 for unknown routes", async () => {
    const app = buildApp(() => {});
    const res = await request(app).get("/does-not-exist").set("X-Request-Id", "nf-1");
    expect(res.status).toBe(404);
    expectStructuredError(res.body, "NOT_FOUND", "nf-1");
    expect(res.body.error.details).toEqual({ method: "GET", path: "/does-not-exist" });
  });
});

// ---------------------------------------------------------------------------
// Route groups
// ---------------------------------------------------------------------------

describe("route group: validation middleware", () => {
  it("returns VALIDATION_ERROR with validator errors as details", async () => {
    const app = buildApp((a) =>
      a.post("/x", body("name").isString().notEmpty(), validate, (_req, res) => res.json({ ok: true }))
    );
    const res = await request(app).post("/x").send({});
    expect(res.status).toBe(400);
    expectStructuredError(res.body, "VALIDATION_ERROR");
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });
});

describe("route group: admin auth middleware", () => {
  it("returns UNAUTHORIZED when no token is sent", async () => {
    const app = buildApp((a) => a.get("/admin", authenticateAdmin as any, (_req, res) => res.json({ ok: true })));
    const res = await request(app).get("/admin");
    expect(res.status).toBe(401);
    expectStructuredError(res.body, "UNAUTHORIZED");
  });

  it("returns FORBIDDEN with required roles as details", async () => {
    const app = buildApp((a) =>
      a.get(
        "/admin",
        (req: any, _res, next) => {
          req.admin = { id: "1", role: "admin" };
          next();
        },
        requireRole("super_admin" as any) as any,
        (_req, res) => res.json({ ok: true })
      )
    );
    const res = await request(app).get("/admin");
    expect(res.status).toBe(403);
    expectStructuredError(res.body, "FORBIDDEN");
    expect(res.body.error.details).toEqual({ required: ["super_admin"], current: "admin" });
  });
});

describe("route group: events", () => {
  it("returns INVALID_PARAMETERS for a bad 'since' query", async () => {
    const app = buildApp((a) => a.use("/api/events", eventsRouter));
    const res = await request(app).get("/api/events/catchup?since=-1");
    expect(res.status).toBe(400);
    expectStructuredError(res.body, "INVALID_PARAMETERS");
  });
});

describe("route group: request timeout", () => {
  it("returns REQUEST_TIMEOUT in the shared schema", async () => {
    const app = buildApp((a) => {
      a.use(createTimeoutMiddleware(20));
      a.get("/slow", async (_req, res) => {
        await new Promise((r) => setTimeout(r, 60));
        if (!res.headersSent) res.json({ ok: true });
      });
    });
    const res = await request(app).get("/slow");
    expect(res.status).toBe(503);
    expectStructuredError(res.body, "REQUEST_TIMEOUT");
  });
});
