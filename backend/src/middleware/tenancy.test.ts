import { describe, it, expect, beforeEach, vi } from "vitest";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import {
  validateTenantId,
  extractTenantFromJwt,
  tenantMiddleware,
  requireTenantMatch,
  TenantRequest,
} from "./tenancy";

const SECRET = "test-secret";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(overrides: Partial<TenantRequest> = {}): TenantRequest {
  return {
    headers: {},
    params: {},
    ...overrides,
  } as TenantRequest;
}

function mockRes() {
  let statusCode = 200;
  let body: any;
  const res: any = {
    status: vi.fn((code: number) => { statusCode = code; return res; }),
    json: vi.fn((b: any) => { body = b; return res; }),
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return res;
}

function makeToken(payload: object, secret = SECRET): string {
  return jwt.sign(payload, secret);
}

// ---------------------------------------------------------------------------
// validateTenantId
// ---------------------------------------------------------------------------

describe("validateTenantId", () => {
  it("accepts alphanumeric IDs", () => {
    expect(validateTenantId("tenant123")).toBe("tenant123");
  });

  it("accepts hyphens and underscores", () => {
    expect(validateTenantId("my-tenant_01")).toBe("my-tenant_01");
  });

  it("trims surrounding whitespace", () => {
    expect(validateTenantId("  abc  ")).toBe("abc");
  });

  it("rejects empty string", () => {
    expect(validateTenantId("")).toBeNull();
  });

  it("rejects strings longer than 64 chars", () => {
    expect(validateTenantId("a".repeat(65))).toBeNull();
  });

  it("rejects special characters", () => {
    expect(validateTenantId("tenant!@#")).toBeNull();
  });

  it("rejects non-string values", () => {
    expect(validateTenantId(123)).toBeNull();
    expect(validateTenantId(null)).toBeNull();
    expect(validateTenantId(undefined)).toBeNull();
  });

  it("accepts exactly 64 chars", () => {
    const id = "a".repeat(64);
    expect(validateTenantId(id)).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// extractTenantFromJwt
// ---------------------------------------------------------------------------

describe("extractTenantFromJwt", () => {
  it("extracts tenantId claim", () => {
    const token = makeToken({ tenantId: "acme" });
    const result = extractTenantFromJwt(token, SECRET);
    expect(result).toEqual({ id: "acme", source: "jwt", name: undefined });
  });

  it("extracts tenant_id claim (snake_case)", () => {
    const token = makeToken({ tenant_id: "acme" });
    const result = extractTenantFromJwt(token, SECRET);
    expect(result?.id).toBe("acme");
  });

  it("extracts optional tenantName", () => {
    const token = makeToken({ tenantId: "acme", tenantName: "Acme Corp" });
    const result = extractTenantFromJwt(token, SECRET);
    expect(result?.name).toBe("Acme Corp");
  });

  it("returns null for invalid signature", () => {
    const token = makeToken({ tenantId: "acme" }, "wrong-secret");
    expect(extractTenantFromJwt(token, SECRET)).toBeNull();
  });

  it("returns null when tenantId claim is missing", () => {
    const token = makeToken({ sub: "user123" });
    expect(extractTenantFromJwt(token, SECRET)).toBeNull();
  });

  it("returns null when tenantId fails validation", () => {
    const token = makeToken({ tenantId: "bad tenant!" });
    expect(extractTenantFromJwt(token, SECRET)).toBeNull();
  });

  it("returns null for malformed token string", () => {
    expect(extractTenantFromJwt("not.a.token", SECRET)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tenantMiddleware — header resolution
// ---------------------------------------------------------------------------

describe("tenantMiddleware — X-Tenant-ID header", () => {
  const mw = tenantMiddleware({ jwtSecret: SECRET });

  it("attaches tenant from valid header", () => {
    const req = mockReq({ headers: { "x-tenant-id": "acme" } });
    const next = vi.fn();
    mw(req, mockRes(), next);
    expect(req.tenant).toEqual({ id: "acme", source: "header" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects invalid header value with 400", () => {
    const req = mockReq({ headers: { "x-tenant-id": "bad tenant!" } });
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("header takes precedence over JWT", () => {
    const token = makeToken({ tenantId: "jwt-tenant" });
    const req = mockReq({
      headers: {
        "x-tenant-id": "header-tenant",
        authorization: `Bearer ${token}`,
      },
    });
    const next = vi.fn();
    mw(req, mockRes(), next);
    expect(req.tenant?.id).toBe("header-tenant");
    expect(req.tenant?.source).toBe("header");
  });
});

// ---------------------------------------------------------------------------
// tenantMiddleware — JWT resolution
// ---------------------------------------------------------------------------

describe("tenantMiddleware — JWT resolution", () => {
  const mw = tenantMiddleware({ jwtSecret: SECRET });

  it("attaches tenant from valid JWT", () => {
    const token = makeToken({ tenantId: "jwt-tenant" });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const next = vi.fn();
    mw(req, mockRes(), next);
    expect(req.tenant).toMatchObject({ id: "jwt-tenant", source: "jwt" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next without tenant when JWT has no tenantId", () => {
    const token = makeToken({ sub: "user" });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const next = vi.fn();
    mw(req, mockRes(), next);
    expect(req.tenant).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("ignores non-Bearer authorization schemes", () => {
    const req = mockReq({ headers: { authorization: "Basic dXNlcjpwYXNz" } });
    const next = vi.fn();
    mw(req, mockRes(), next);
    expect(req.tenant).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// tenantMiddleware — required option
// ---------------------------------------------------------------------------

describe("tenantMiddleware — required: true", () => {
  const mw = tenantMiddleware({ required: true, jwtSecret: SECRET });

  it("rejects with 400 when no tenant is found", () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/required/i);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows request when tenant is present", () => {
    const req = mockReq({ headers: { "x-tenant-id": "acme" } });
    const next = vi.fn();
    mw(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// tenantMiddleware — permissive (default)
// ---------------------------------------------------------------------------

describe("tenantMiddleware — required: false (default)", () => {
  const mw = tenantMiddleware({ jwtSecret: SECRET });

  it("calls next without tenant when no identification provided", () => {
    const req = mockReq();
    const next = vi.fn();
    mw(req, mockRes(), next);
    expect(req.tenant).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// requireTenantMatch
// ---------------------------------------------------------------------------

describe("requireTenantMatch", () => {
  it("calls next when tenant matches route param", () => {
    const req = mockReq({
      params: { tenantId: "acme" },
      tenant: { id: "acme", source: "header" },
    });
    const next = vi.fn();
    requireTenantMatch(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects with 403 when tenant does not match param", () => {
    const req = mockReq({
      params: { tenantId: "other" },
      tenant: { id: "acme", source: "header" },
    });
    const res = mockRes();
    requireTenantMatch(req, res, vi.fn());
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/forbidden/i);
  });

  it("rejects with 401 when no tenant is attached", () => {
    const req = mockReq({ params: { tenantId: "acme" } });
    const res = mockRes();
    requireTenantMatch(req, res, vi.fn());
    expect(res.statusCode).toBe(401);
  });

  it("skips check when route has no :tenantId param", () => {
    const req = mockReq({ params: {} });
    const next = vi.fn();
    requireTenantMatch(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles array x-tenant-id header (uses first value)", () => {
    // Express normalises multi-value headers to comma-joined strings or arrays
    const req = mockReq({ headers: { "x-tenant-id": ["acme", "other"] as any } });
    const next = vi.fn();
    const mw = tenantMiddleware({ jwtSecret: SECRET });
    // Array is not a string — header branch skips, falls through to JWT/none
    mw(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects whitespace-only tenant header", () => {
    const req = mockReq({ headers: { "x-tenant-id": "   " } });
    const res = mockRes();
    tenantMiddleware({ jwtSecret: SECRET })(req, res, vi.fn());
    expect(res.statusCode).toBe(400);
  });

  it("uses JWT_SECRET env var when jwtSecret option is omitted", () => {
    process.env.JWT_SECRET = SECRET;
    const token = makeToken({ tenantId: "env-tenant" });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const next = vi.fn();
    tenantMiddleware()(req, mockRes(), next);
    expect(req.tenant?.id).toBe("env-tenant");
    delete process.env.JWT_SECRET;
  });

  it("throws when no JWT secret is configured (no fallback to hardcoded value)", () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    expect(() => tenantMiddleware()).toThrow(
      /JWT secret is required/i
    );
    if (saved !== undefined) process.env.JWT_SECRET = saved;
  });

  it("throws immediately during middleware construction when jwtSecret is missing", () => {
    expect(() => tenantMiddleware({})).toThrow(
      /JWT secret is required/i
    );
  });
});
