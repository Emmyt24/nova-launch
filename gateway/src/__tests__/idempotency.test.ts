import { describe, it, expect, vi } from "vitest";
import { Request, Response, NextFunction } from "express";
import { createIdempotencyMiddleware, IDEMPOTENCY_HEADER } from "../idempotency";

function next(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    path: "/api/tokens",
    headers: {},
    body: {},
    ...overrides,
  } as any;
}

function mockRes(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("createIdempotencyMiddleware", () => {
  const middleware = createIdempotencyMiddleware();

  it("generates an Idempotency-Key on POST requests without one", () => {
    const req = mockReq();
    middleware(req, mockRes(), next());
    const key = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];
    expect(key).toBeDefined();
    expect(key).toMatch(uuidRegex);
  });

  it("generates an Idempotency-Key on PUT requests without one", () => {
    const req = mockReq({ method: "PUT" });
    middleware(req, mockRes(), next());
    const key = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];
    expect(key).toBeDefined();
    expect(key).toMatch(uuidRegex);
  });

  it("generates an Idempotency-Key on PATCH requests without one", () => {
    const req = mockReq({ method: "PATCH" });
    middleware(req, mockRes(), next());
    const key = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];
    expect(key).toBeDefined();
    expect(key).toMatch(uuidRegex);
  });

  it("generates an Idempotency-Key on DELETE requests without one", () => {
    const req = mockReq({ method: "DELETE" });
    middleware(req, mockRes(), next());
    const key = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];
    expect(key).toBeDefined();
    expect(key).toMatch(uuidRegex);
  });

  it("does not generate a key on GET requests", () => {
    const req = mockReq({ method: "GET" });
    middleware(req, mockRes(), next());
    expect(req.headers[IDEMPOTENCY_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("does not generate a key on HEAD requests", () => {
    const req = mockReq({ method: "HEAD" });
    middleware(req, mockRes(), next());
    expect(req.headers[IDEMPOTENCY_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("forwards an existing client-supplied Idempotency-Key", () => {
    const clientKey = "client-supplied-key-123";
    const req = mockReq({ headers: { [IDEMPOTENCY_HEADER.toLowerCase()]: clientKey } });
    middleware(req, mockRes(), next());
    expect(req.headers[IDEMPOTENCY_HEADER.toLowerCase()]).toBe(clientKey);
  });

  it("reuses the same key when retried on the same request object", () => {
    const req = mockReq();

    middleware(req, mockRes(), vi.fn());
    const firstKey = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];

    middleware(req, mockRes(), vi.fn());
    const secondKey = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];

    expect(firstKey).toBeDefined();
    expect(secondKey).toBeDefined();
    expect(firstKey).toBe(secondKey);
  });

  it("calls next()", () => {
    const n = next();
    middleware(mockReq(), mockRes(), n);
    expect(n).toHaveBeenCalledOnce();
  });

  // ── Deterministic fallback key (issue #1885) ────────────────────────────────

  const keyOf = (req: Request) =>
    req.headers[IDEMPOTENCY_HEADER.toLowerCase()] as string | undefined;

  const run = (overrides: Partial<Request> = {}): string => {
    const req = mockReq(overrides);
    middleware(req, mockRes(), next());
    return keyOf(req)!;
  };

  it("synthesises the SAME key for two structurally-identical retries with no client key", () => {
    const shape: Partial<Request> = {
      method: "POST",
      path: "/api/tokens",
      headers: { authorization: "Bearer user-a-token" },
      body: { amount: 100, to: "GABC" },
    };

    const first = run({ ...shape, headers: { ...shape.headers } });
    const retry = run({ ...shape, headers: { ...shape.headers } });

    expect(first).toBeDefined();
    expect(first).toBe(retry);
  });

  it("is insensitive to body property ordering", () => {
    const a = run({ body: { amount: 100, to: "GABC", memo: "x" } });
    const b = run({ body: { memo: "x", to: "GABC", amount: 100 } });
    expect(a).toBe(b);
  });

  it("synthesises DIFFERENT keys when body, path or method differ", () => {
    const base: Partial<Request> = {
      method: "POST",
      path: "/api/tokens",
      body: { amount: 100 },
    };

    const keys = [
      run(base),
      run({ ...base, body: { amount: 200 } }),
      run({ ...base, path: "/api/vaults" }),
      run({ ...base, method: "DELETE" }),
    ];

    expect(new Set(keys).size).toBe(4);
  });

  it("synthesises DIFFERENT keys for different callers making the same request", () => {
    const shape: Partial<Request> = {
      method: "POST",
      path: "/api/tokens",
      body: { amount: 100 },
    };
    const userA = run({ ...shape, headers: { authorization: "Bearer aaa" } });
    const userB = run({ ...shape, headers: { authorization: "Bearer bbb" } });
    expect(userA).not.toBe(userB);
  });

  it("synthesised fallback key is UUID-shaped", () => {
    expect(run()).toMatch(uuidRegex);
  });
});
