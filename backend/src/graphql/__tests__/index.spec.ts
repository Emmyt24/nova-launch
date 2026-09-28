/**
 * Tests for the GraphQL query-depth limit configuration.
 *
 * A malformed GRAPHQL_MAX_DEPTH must never silently disable depth
 * enforcement (parseInt → NaN, and `depth > NaN` is always false).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    token: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    burnRecord: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("../../services/tenantComplexityBudgetService", () => ({
  tenantComplexityBudgetService: {
    getBudgetForTenant: vi.fn().mockResolvedValue(1_000),
  },
}));

/** Builds a schema-valid query nested `levels` inline fragments deep. */
function deeplyNestedQuery(levels: number): string {
  let inner = "id";
  for (let i = 0; i < levels; i++) {
    inner = `... on Token { ${inner} }`;
  }
  return `query { token(address: "x") { ${inner} } }`;
}

async function loadRouter() {
  vi.resetModules();
  const mod = await import("../index");
  const app = express();
  app.use(express.json());
  app.use("/graphql", mod.default);
  return { app, mod };
}

describe("GraphQL MAX_DEPTH configuration", () => {
  const original = process.env.GRAPHQL_MAX_DEPTH;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (original === undefined) delete process.env.GRAPHQL_MAX_DEPTH;
    else process.env.GRAPHQL_MAX_DEPTH = original;
  });

  it("resolveMaxDepth defaults to 6 when unset", async () => {
    const { mod } = await loadRouter();
    expect(mod.resolveMaxDepth(undefined)).toBe(6);
  });

  it("resolveMaxDepth falls back to 6 with a warning on a non-numeric value", async () => {
    const { mod } = await loadRouter();
    warnSpy.mockClear();
    expect(mod.resolveMaxDepth("not-a-number")).toBe(mod.DEFAULT_MAX_DEPTH);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid GRAPHQL_MAX_DEPTH")
    );
  });

  it("still rejects a deeply-nested query when GRAPHQL_MAX_DEPTH is malformed", async () => {
    process.env.GRAPHQL_MAX_DEPTH = "not-a-number";
    const { app } = await loadRouter();

    const res = await request(app)
      .post("/graphql")
      .set("Accept", "application/json")
      .send({ query: deeplyNestedQuery(20) });

    expect(JSON.stringify(res.body)).toMatch(
      /exceeds maximum allowed depth of 6/
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid GRAPHQL_MAX_DEPTH")
    );
  });
});
