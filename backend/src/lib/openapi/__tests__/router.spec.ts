/**
 * Tests for the OpenAPI documentation router — GET /json and GET / (Swagger UI).
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import router from "../router";
import { openApiSpec } from "../spec";

function buildApp() {
  const app = express();
  app.use("/api/docs", router);
  return app;
}

describe("OpenAPI router", () => {
  describe("GET /json", () => {
    it("returns application/json content type", async () => {
      const app = buildApp();
      const res = await request(app).get("/api/docs/json");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });

    it("returns a body matching the openApiSpec shape", async () => {
      const app = buildApp();
      const res = await request(app).get("/api/docs/json");

      expect(res.body).toMatchObject({
        openapi: openApiSpec.openapi,
        info: openApiSpec.info,
      });
      expect(res.body.paths).toBeDefined();
      expect(res.body.components).toBeDefined();
    });
  });

  describe("GET /", () => {
    it("returns a 200 HTML response from Swagger UI", async () => {
      const app = buildApp();
      const res = await request(app).get("/api/docs/");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
    });
  });
});
