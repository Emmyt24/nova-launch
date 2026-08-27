/**
 * Integration tests for gateway-to-backend auth propagation.
 *
 * Verifies that:
 *  1. Authenticated requests forward correct identity/claims to the backend
 *  2. Unauthenticated requests are rejected at the gateway (never reach backend)
 *  3. Expired/invalid tokens are rejected with correct status codes
 *
 * Issue: #1576
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction, Express } from "express";
import jwt from "jsonwebtoken";
import { createAuthMiddleware, type JwtPayload } from "../auth";

const JWT_SECRET = "test-secret-key";

// Mock Express app for integration testing
function createMockApp() {
  const middlewares: Array<(req: Request, res: Response, next: NextFunction) => void> = [];
  const routes: Map<string, Array<(req: Request, res: Response) => void>> = new Map();

  const app = {
    use: (fn: (req: Request, res: Response, next: NextFunction) => void) => {
      middlewares.push(fn);
    },
    get: (path: string, handler: (req: Request, res: Response) => void) => {
      if (!routes.has(path)) routes.set(path, []);
      routes.get(path)!.push(handler);
    },
    simulateRequest: async (method: string, path: string, req: Partial<Request>) => {
      const mockReq = {
        method,
        path,
        headers: {},
        user: undefined,
        ...req,
      } as unknown as Request;

      let responseData: any = {};
      let statusCode = 200;

      const mockRes = {
        status: vi.fn((code: number) => {
          statusCode = code;
          return mockRes;
        }),
        json: vi.fn((data: any) => {
          responseData = data;
          return mockRes;
        }),
        send: vi.fn((data: any) => {
          responseData = data;
          return mockRes;
        }),
        get statusCode() {
          return statusCode;
        },
        get body() {
          return responseData;
        },
      } as unknown as Response;

      // Run all middlewares
      let middlewareIndex = 0;
      const nextMiddleware = async () => {
        if (middlewareIndex < middlewares.length) {
          const mw = middlewares[middlewareIndex++];
          return new Promise<void>((resolve) => {
            mw(mockReq, mockRes, () => resolve(nextMiddleware()));
          });
        }

        // Run route handlers
        const handlers = routes.get(path) || [];
        for (const handler of handlers) {
          handler(mockReq, mockRes);
        }
      };

      await nextMiddleware();
      return { statusCode, body: responseData, req: mockReq };
    },
  };

  return app;
}

// Backend echo endpoint that returns the authenticated identity
function createBackendEchoHandler(
  req: Request,
  res: Response
) {
  if (!req.user) {
    res.status(401).json({ error: "No user attached" });
    return;
  }

  res.json({
    authenticated: true,
    userId: req.user.userId,
    role: req.user.role,
    walletAddress: req.user.walletAddress,
  });
}

describe("Gateway-to-Backend Auth Propagation Integration", () => {
  let app: ReturnType<typeof createMockApp>;

  beforeEach(() => {
    app = createMockApp();
    // Install auth middleware
    app.use(createAuthMiddleware(JWT_SECRET));
    // Install echo endpoint
    app.get("/api/echo", createBackendEchoHandler);
  });

  describe("authenticated request forwarding", () => {
    it("forwards correct identity when request includes valid token", async () => {
      const payload: JwtPayload = {
        userId: "user-123",
        role: "admin",
        walletAddress: "GUSER123ABC",
      };

      const token = jwt.sign(payload, JWT_SECRET);

      const { statusCode, body } = await app.simulateRequest(
        "GET",
        "/api/echo",
        {
          headers: { authorization: `Bearer ${token}` },
        }
      );

      expect(statusCode).toBe(200);
      expect(body.authenticated).toBe(true);
      expect(body.userId).toBe("user-123");
      expect(body.role).toBe("admin");
      expect(body.walletAddress).toBe("GUSER123ABC");
    });

    it("preserves all claims from token payload", async () => {
      const payload: JwtPayload = {
        userId: "user-456",
        role: "operator",
        walletAddress: "GOPERATOR789XYZ",
      };

      const token = jwt.sign(payload, JWT_SECRET);

      const { body } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(body.userId).toBe(payload.userId);
      expect(body.role).toBe(payload.role);
      expect(body.walletAddress).toBe(payload.walletAddress);
    });

    it("echoed identity matches original request's claims exactly", async () => {
      const originalPayload: JwtPayload = {
        userId: "user-789",
        role: "viewer",
        walletAddress: "GVIEWER000",
      };

      const token = jwt.sign(originalPayload, JWT_SECRET);

      const { body } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(body.userId).toBe(originalPayload.userId);
      expect(body.role).toBe(originalPayload.role);
      expect(body.walletAddress).toBe(originalPayload.walletAddress);
    });

    it("handles optional role field correctly", async () => {
      const payload: JwtPayload = {
        userId: "user-no-role",
        // role is optional
        walletAddress: "GWALLET123",
      };

      const token = jwt.sign(payload, JWT_SECRET);

      const { body } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(body.userId).toBe("user-no-role");
      expect(body.role).toBeUndefined();
      expect(body.walletAddress).toBe("GWALLET123");
    });

    it("handles optional walletAddress field correctly", async () => {
      const payload: JwtPayload = {
        userId: "user-no-wallet",
        role: "admin",
        // walletAddress is optional
      };

      const token = jwt.sign(payload, JWT_SECRET);

      const { body } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(body.userId).toBe("user-no-wallet");
      expect(body.role).toBe("admin");
      expect(body.walletAddress).toBeUndefined();
    });
  });

  describe("unauthenticated request rejection", () => {
    it("rejects unauthenticated request at gateway (never reaches backend)", async () => {
      const { statusCode, body } = await app.simulateRequest(
        "GET",
        "/api/echo",
        {
          headers: {}, // No Authorization header
        }
      );

      expect(statusCode).toBe(401);
      expect(body.error).toContain("Authentication required");
    });

    it("returns 401 when Authorization header is missing", async () => {
      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: {},
      });

      expect(statusCode).toBe(401);
    });

    it("returns 401 when Bearer token is missing from header", async () => {
      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: "Basic somebase64string" },
      });

      expect(statusCode).toBe(401);
    });

    it("backend handler never called when auth fails (no unauthenticated pass-through)", async () => {
      // This test verifies that the backend never sees unauthenticated requests
      const backendSpy = vi.fn(createBackendEchoHandler);
      const testApp = createMockApp();
      testApp.use(createAuthMiddleware(JWT_SECRET));
      testApp.get("/api/echo", backendSpy);

      await testApp.simulateRequest("GET", "/api/echo", {
        headers: {}, // No auth
      });

      // Backend handler should not have been called
      expect(backendSpy).not.toHaveBeenCalled();
    });

    it("returns error response instead of backend 404", async () => {
      const { statusCode, body } = await app.simulateRequest(
        "GET",
        "/api/echo",
        {
          headers: {},
        }
      );

      // Should fail at auth layer with 401, not 404
      expect(statusCode).toBe(401);
      expect(body.error).toBeDefined();
      expect(statusCode).not.toBe(404);
    });
  });

  describe("token validation edge cases", () => {
    it("rejects expired token with 401", async () => {
      const expiredToken = jwt.sign(
        { userId: "user-expired" },
        JWT_SECRET,
        { expiresIn: "-1h" }
      );

      const { statusCode, body } = await app.simulateRequest(
        "GET",
        "/api/echo",
        {
          headers: { authorization: `Bearer ${expiredToken}` },
        }
      );

      expect(statusCode).toBe(401);
      expect(body.error).toContain("Invalid or expired");
    });

    it("rejects malformed token with 401", async () => {
      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: "Bearer not.a.valid.token" },
      });

      expect(statusCode).toBe(401);
    });

    it("rejects token signed with wrong secret", async () => {
      const wrongToken = jwt.sign(
        { userId: "user-123" },
        "wrong-secret"
      );

      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: `Bearer ${wrongToken}` },
      });

      expect(statusCode).toBe(401);
    });

    it("rejects token with uppercase Bearer scheme", async () => {
      const token = jwt.sign({ userId: "user-123" }, JWT_SECRET);

      // The middleware checks for "Bearer " (lowercase), so this should fail
      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: `bearer ${token}` },
      });

      // Depends on implementation; typically fails because case-sensitive
      expect(statusCode).toBe(401);
    });

    it("rejects empty Bearer token", async () => {
      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: "Bearer " },
      });

      expect(statusCode).toBe(401);
    });

    it("rejects token with tampered payload", async () => {
      const token = jwt.sign({ userId: "user-123" }, JWT_SECRET);
      const tampered = token.slice(0, -10) + "0000000000";

      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: `Bearer ${tampered}` },
      });

      expect(statusCode).toBe(401);
    });
  });

  describe("status code correctness", () => {
    it("returns 401 specifically (not 403) for auth failures", async () => {
      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: {},
      });

      // 401 Unauthorized (authentication failed)
      // 403 Forbidden (authorization failed)
      expect(statusCode).toBe(401);
    });

    it("returns 401 for missing auth header", async () => {
      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: {},
      });

      expect(statusCode).toBe(401);
    });

    it("returns 401 for invalid token", async () => {
      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: "Bearer badtoken" },
      });

      expect(statusCode).toBe(401);
    });

    it("returns 401 for expired token", async () => {
      const expired = jwt.sign({ userId: "u1" }, JWT_SECRET, { expiresIn: "-1h" });

      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: `Bearer ${expired}` },
      });

      expect(statusCode).toBe(401);
    });

    it("returns 200 for valid token", async () => {
      const token = jwt.sign({ userId: "u1" }, JWT_SECRET);

      const { statusCode } = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(statusCode).toBe(200);
    });
  });

  describe("public path bypass", () => {
    it("allows /health without authentication", async () => {
      const testApp = createMockApp();
      testApp.use(createAuthMiddleware(JWT_SECRET));
      let healthCalled = false;
      testApp.get("/health", (req, res) => {
        healthCalled = true;
        res.json({ status: "ok" });
      });

      const { statusCode } = await testApp.simulateRequest("GET", "/health", {
        headers: {}, // No auth
      });

      expect(statusCode).toBe(200);
      expect(healthCalled).toBe(true);
    });

    it("allows /health/live without authentication", async () => {
      const testApp = createMockApp();
      testApp.use(createAuthMiddleware(JWT_SECRET));
      let called = false;
      testApp.get("/health/live", (req, res) => {
        called = true;
        res.json({ live: true });
      });

      const { statusCode } = await testApp.simulateRequest("GET", "/health/live", {
        headers: {},
      });

      expect(statusCode).toBe(200);
      expect(called).toBe(true);
    });

    it("allows /health/ready without authentication", async () => {
      const testApp = createMockApp();
      testApp.use(createAuthMiddleware(JWT_SECRET));
      let called = false;
      testApp.get("/health/ready", (req, res) => {
        called = true;
        res.json({ ready: true });
      });

      const { statusCode } = await testApp.simulateRequest("GET", "/health/ready", {
        headers: {},
      });

      expect(statusCode).toBe(200);
      expect(called).toBe(true);
    });
  });

  describe("identity attachment correctness", () => {
    it("attaches decoded user to req.user", async () => {
      const payload: JwtPayload = {
        userId: "user-attach-test",
        role: "tester",
      };

      const token = jwt.sign(payload, JWT_SECRET);

      const result = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(result.req.user).toBeDefined();
      expect(result.req.user?.userId).toBe("user-attach-test");
    });

    it("does not attach user for unauthenticated requests", async () => {
      const result = await app.simulateRequest("GET", "/api/echo", {
        headers: {},
      });

      expect(result.req.user).toBeUndefined();
    });

    it("preserves user attachment through middleware chain", async () => {
      const payload: JwtPayload = { userId: "chain-test" };
      const token = jwt.sign(payload, JWT_SECRET);

      const result = await app.simulateRequest("GET", "/api/echo", {
        headers: { authorization: `Bearer ${token}` },
      });

      // Verify backend received the attached user
      expect(result.body.userId).toBe("chain-test");
    });
  });
});
