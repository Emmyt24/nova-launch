import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import cors from "cors";
import { corsOptions, validateCorsConfig } from "../config/cors";
import { isOriginAllowed } from "../config/allowedOrigins";

function buildApp(): express.Application {
  const app = express();
  app.use(cors(corsOptions));
  app.get("/test", (_req, res) => res.json({ ok: true }));
  app.post("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("CORS review: preflight and credentialed requests", () => {
  const app = buildApp();

  it("answers preflight with credentials, methods, headers and max-age", async () => {
    const res = await request(app)
      .options("/test")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type,Authorization");

    expect(res.status).toBe(204);
    expect(res.header["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.header["access-control-allow-credentials"]).toBe("true");
    expect(res.header["access-control-allow-methods"]).toContain("POST");
    expect(res.header["access-control-allow-headers"]).toContain("Authorization");
    expect(res.header["access-control-max-age"]).toBe("86400");
  });

  it("reflects the exact origin (never *) on credentialed requests", async () => {
    const res = await request(app)
      .get("/test")
      .set("Origin", "http://localhost:5173")
      .set("Authorization", "Bearer token");

    expect(res.status).toBe(200);
    expect(res.header["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.header["access-control-allow-origin"]).not.toBe("*");
    expect(res.header["access-control-allow-credentials"]).toBe("true");
  });

  it("does not grant CORS headers to an unlisted origin", async () => {
    const res = await request(app)
      .get("/test")
      .set("Origin", "https://evil.example");

    expect(res.header["access-control-allow-origin"]).toBeUndefined();
    expect(res.header["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("CORS review: isOriginAllowed", () => {
  it("allows missing Origin and exact matches only", () => {
    expect(isOriginAllowed(undefined, ["https://app.example"])).toBe(true);
    expect(isOriginAllowed("https://app.example", ["https://app.example"])).toBe(true);
    expect(isOriginAllowed("https://app.example.evil", ["https://app.example"])).toBe(false);
  });
});

describe("CORS review: validateCorsConfig (startup validation)", () => {
  it("rejects a wildcard origin in production", () => {
    expect(() =>
      validateCorsConfig({ NODE_ENV: "production", FRONTEND_URL: "*" } as NodeJS.ProcessEnv)
    ).toThrow(/wildcard/i);
  });

  it("rejects a wildcard mixed into a production list", () => {
    expect(() =>
      validateCorsConfig({
        NODE_ENV: "production",
        FRONTEND_URL: "https://app.example, *",
      } as NodeJS.ProcessEnv)
    ).toThrow(/wildcard/i);
  });

  it("requires FRONTEND_URL in production", () => {
    expect(() =>
      validateCorsConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv)
    ).toThrow(/FRONTEND_URL/);
  });

  it("accepts valid https origins in production", () => {
    expect(() =>
      validateCorsConfig({
        NODE_ENV: "production",
        FRONTEND_URL: "https://app.example,https://admin.example",
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it("allows defaults and localhost in development", () => {
    expect(() => validateCorsConfig({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() =>
      validateCorsConfig({
        NODE_ENV: "development",
        FRONTEND_URL: "http://localhost:5173",
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it("rejects malformed origins and non-http protocols", () => {
    expect(() =>
      validateCorsConfig({ NODE_ENV: "development", FRONTEND_URL: "not a url" } as NodeJS.ProcessEnv)
    ).toThrow(/Invalid CORS origin/);
    expect(() =>
      validateCorsConfig({ NODE_ENV: "development", FRONTEND_URL: "ftp://host" } as NodeJS.ProcessEnv)
    ).toThrow(/protocol/);
  });
});
