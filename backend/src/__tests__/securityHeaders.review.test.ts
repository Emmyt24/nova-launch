import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";

// Mirrors the wiring in src/index.ts: `app.use(helmet())` with defaults.
function buildApp(): express.Application {
  const app = express();
  app.use(helmet());
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  const spec = { openapi: "3.0.0", info: { title: "t", version: "1" }, paths: {} };
  app.use("/docs", swaggerUi.serve);
  app.get("/docs", swaggerUi.setup(spec));
  return app;
}

describe("Security headers (helmet defaults)", () => {
  const app = buildApp();

  it("sets core hardening headers on API responses", async () => {
    const res = await request(app).get("/api/ping");

    expect(res.status).toBe(200);
    expect(res.header["x-content-type-options"]).toBe("nosniff");
    expect(res.header["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.header["strict-transport-security"]).toContain("max-age=");
    expect(res.header["referrer-policy"]).toBe("no-referrer");
    expect(res.header["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.header["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("does not leak the framework via X-Powered-By", async () => {
    const res = await request(app).get("/api/ping");
    expect(res.header["x-powered-by"]).toBeUndefined();
  });

  it("sends a restrictive CSP", async () => {
    const res = await request(app).get("/api/ping");
    const csp = res.header["content-security-policy"] as string;

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("serves the API docs UI under the same CSP with no script exceptions", async () => {
    const res = await request(app).get("/docs");
    const csp = res.header["content-security-policy"] as string;

    expect(res.status).toBe(200);
    expect(res.header["content-type"]).toContain("text/html");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});
