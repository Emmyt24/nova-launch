import { describe, it, expect, vi } from "vitest";
import { Request, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { createAuthMiddleware } from "../auth";

const next = (): NextFunction => vi.fn() as unknown as NextFunction;

const SECRET = "test-secret";

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, path: "/api/tokens", ...overrides } as any;
}

function mockRes() {
  let statusCode = 200;
  let body: any;
  const res: any = {
    status: vi.fn((c: number) => { statusCode = c; return res; }),
    json:   vi.fn((b: any)   => { body = b; return res; }),
    get statusCode() { return statusCode; },
    get body()       { return body; },
  };
  return res;
}

describe("createAuthMiddleware", () => {
  const auth = createAuthMiddleware(SECRET);

  it("calls next() for /health without a token", () => {
    const n = next();
    auth(mockReq({ path: "/health" }), mockRes(), n);
    expect(n).toHaveBeenCalledOnce();
  });

  it("calls next() for /health/live without a token", () => {
    const n = next();
    auth(mockReq({ path: "/health/live" }), mockRes(), n);
    expect(n).toHaveBeenCalledOnce();
  });

  it("calls next() for /health/ready without a token", () => {
    const n = next();
    auth(mockReq({ path: "/health/ready" }), mockRes(), n);
    expect(n).toHaveBeenCalledOnce();
  });

  it("returns 401 when Authorization header is missing", () => {
    const res = mockRes();
    auth(mockReq(), res, next());
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/authentication required/i);
  });

  it("returns 401 when Authorization header is not Bearer", () => {
    const res = mockRes();
    auth(mockReq({ headers: { authorization: "Basic abc" } }), res, next());
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an invalid token", () => {
    const res = mockRes();
    auth(
      mockReq({ headers: { authorization: "Bearer invalid.token.here" } }),
      res,
      next()
    );
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it("returns 401 for an expired token", () => {
    const expired = jwt.sign({ userId: "u1" }, SECRET, { expiresIn: -1 });
    const res = mockRes();
    auth(
      mockReq({ headers: { authorization: `Bearer ${expired}` } }),
      res,
      next()
    );
    expect(res.statusCode).toBe(401);
  });

  it("calls next() and attaches user for a valid token", () => {
    const token = jwt.sign({ userId: "u1", role: "admin" }, SECRET);
    const n = next();
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    auth(req, mockRes(), n);
    expect(n).toHaveBeenCalledOnce();
    expect((req as any).user?.userId).toBe("u1");
  });

  it("attaches walletAddress from token payload", () => {
    const token = jwt.sign({ userId: "u2", walletAddress: "GWALLET" }, SECRET);
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    auth(req, mockRes(), next());
    expect((req as any).user?.walletAddress).toBe("GWALLET");
  });

  it("does not call next() when token is invalid", () => {
    const n = next();
    auth(
      mockReq({ headers: { authorization: "Bearer bad" } }),
      mockRes(),
      n
    );
    expect(n).not.toHaveBeenCalled();
  });

  describe("algorithm pinning", () => {
    it("accepts a token explicitly signed with HS256", () => {
      const token = jwt.sign({ userId: "u1" }, SECRET, { algorithm: "HS256" });
      const n = next();
      auth(mockReq({ headers: { authorization: `Bearer ${token}` } }), mockRes(), n);
      expect(n).toHaveBeenCalledOnce();
    });

    it.each(["HS384", "HS512"] as const)(
      "rejects a token signed with %s even when the secret is correct",
      (algorithm) => {
        const token = jwt.sign({ userId: "u1" }, SECRET, { algorithm });
        const res = mockRes();
        const n = next();
        auth(mockReq({ headers: { authorization: `Bearer ${token}` } }), res, n);
        expect(res.statusCode).toBe(401);
        expect(res.body.error).toMatch(/invalid or expired/i);
        expect(n).not.toHaveBeenCalled();
      }
    );

    it('rejects an unsigned token using alg "none"', () => {
      const encode = (obj: object) =>
        Buffer.from(JSON.stringify(obj)).toString("base64url");
      const token = `${encode({ alg: "none", typ: "JWT" })}.${encode({ userId: "attacker" })}.`;
      const res = mockRes();
      const n = next();
      const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
      auth(req, res, n);
      expect(res.statusCode).toBe(401);
      expect(n).not.toHaveBeenCalled();
      expect((req as any).user).toBeUndefined();
    });
  });
});
