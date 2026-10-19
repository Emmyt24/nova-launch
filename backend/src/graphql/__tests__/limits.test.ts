/**
 * GraphQL query depth and complexity limits (#2205).
 *
 * Covers queries just under / at / over each limit, the error payloads
 * returned to clients, and how per-tenant complexity budgets interact with
 * the global default.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { parse } from "graphql";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    token: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    burnRecord: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

const getBudgetForTenant = vi.hoisted(() => vi.fn());
vi.mock("../../services/tenantComplexityBudgetService", () => ({
  tenantComplexityBudgetService: { getBudgetForTenant },
}));

const DEFAULT_BUDGET = 100;
const TENANT_BUDGETS: Record<string, number> = { "heavy-tenant": 500, "tiny-tenant": 20 };

/** `token { ... on Token { ... { id } } }` — depth = levels + 2. */
function nestedQuery(levels: number): string {
  let inner = "id";
  for (let i = 0; i < levels; i++) inner = `... on Token { ${inner} }`;
  return `query { token(address: "x") { ${inner} } }`;
}

/** Same depth as nestedQuery but via named fragments, one per level. */
function nestedFragmentQuery(levels: number): string {
  const frags: string[] = [];
  for (let i = 0; i < levels; i++) {
    const body = i === levels - 1 ? "id" : `...F${i + 1}`;
    frags.push(`fragment F${i} on Token { ${body} }`);
  }
  return `query { token(address: "x") { ...F0 } } ${frags.join(" ")}`;
}

/**
 * `n` aliased `token(address) { id }` fields (cost 2 each) plus `extra`
 * additional scalars on the last alias.
 */
function costQuery(n: number, extra = 0): string {
  const extras = ["address", "name", "symbol", "creator"].slice(0, extra).join(" ");
  const fields = Array.from({ length: n }, (_, i) =>
    i === n - 1 && extra ? `t${i}: token(address: "x") { id ${extras} }` : `t${i}: token(address: "x") { id }`
  );
  return `query { ${fields.join(" ")} }`;
}

async function loadApp(tenantId?: string) {
  vi.resetModules();
  const mod = await import("../index");
  const app = express();
  app.use(express.json());
  if (tenantId) {
    app.use((req, _res, next) => {
      (req as any).tenant = { id: tenantId, source: "header" };
      next();
    });
  }
  app.use("/graphql", mod.default);
  return { app, mod };
}

const post = (app: express.Express, query: string) =>
  request(app).post("/graphql").set("Accept", "application/json").send({ query });

describe("GraphQL limits (#2205)", () => {
  const originalDepth = process.env.GRAPHQL_MAX_DEPTH;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.GRAPHQL_MAX_DEPTH;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getBudgetForTenant.mockReset();
    getBudgetForTenant.mockImplementation(async (tenant?: { id?: string }) =>
      tenant?.id ? TENANT_BUDGETS[tenant.id] ?? DEFAULT_BUDGET : DEFAULT_BUDGET
    );
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalDepth === undefined) delete process.env.GRAPHQL_MAX_DEPTH;
    else process.env.GRAPHQL_MAX_DEPTH = originalDepth;
  });

  describe("configured limits", () => {
    it("exposes the documented defaults", async () => {
      const { mod } = await loadApp();
      expect(mod.GRAPHQL_LIMITS).toEqual({
        maxDepth: 6,
        defaultMaxComplexity: 100,
        listFieldCost: 10,
      });
    });

    it("honours GRAPHQL_MAX_DEPTH", async () => {
      process.env.GRAPHQL_MAX_DEPTH = "3";
      const { mod } = await loadApp();
      expect(mod.GRAPHQL_LIMITS.maxDepth).toBe(3);
    });
  });

  describe("depth limit", () => {
    it("computes depth for fields and inline fragments", async () => {
      const { mod } = await loadApp();
      expect(mod.computeQueryDepth(parse(nestedQuery(0)))).toBe(2);
      expect(mod.computeQueryDepth(parse(nestedQuery(4)))).toBe(6);
    });

    it("expands named fragments when computing depth", async () => {
      const { mod } = await loadApp();
      expect(mod.computeQueryDepth(parse(nestedFragmentQuery(4)))).toBe(6);
      expect(mod.computeQueryDepth(parse(nestedFragmentQuery(5)))).toBe(7);
    });

    it("accepts a query exactly at the depth limit", async () => {
      const { app } = await loadApp();
      const res = await post(app, nestedQuery(4)); // depth 6
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
    });

    it("rejects a query one level over the depth limit with a clear error", async () => {
      const { app } = await loadApp();
      const res = await post(app, nestedQuery(5)); // depth 7
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toBe(
        "Query depth 7 exceeds maximum allowed depth of 6. Reduce nesting of fields and fragments."
      );
      expect(res.body.errors[0].extensions).toEqual({ code: "QUERY_TOO_DEEP", depth: 7, maxDepth: 6 });
      expect(res.body.extensions).toEqual({ depth: 7, maxDepth: 6 });
    });

    it("cannot be bypassed with named fragments", async () => {
      const { app } = await loadApp();
      const under = await post(app, nestedFragmentQuery(4));
      const over = await post(app, nestedFragmentQuery(5));
      expect(under.status).toBe(200);
      expect(over.status).toBe(400);
      expect(over.body.errors[0].extensions.code).toBe("QUERY_TOO_DEEP");
    });

    it("rejects too-deep queries before computing complexity or budgets", async () => {
      const { app } = await loadApp();
      await post(app, nestedQuery(10));
      expect(getBudgetForTenant).not.toHaveBeenCalled();
    });
  });

  describe("complexity limit", () => {
    it("scores the fixtures as expected", async () => {
      const { mod } = await loadApp();
      expect(mod.computeQueryComplexity(parse(costQuery(50)))).toBe(100);
      expect(mod.computeQueryComplexity(parse(costQuery(50, 1)))).toBe(101);
      expect(mod.computeQueryComplexity(parse("query { tokens(limit: 10) { id address name symbol } }"))).toBe(14);
    });

    it("accepts a query exactly at the budget and echoes the score", async () => {
      const { app } = await loadApp();
      const res = await post(app, costQuery(50)); // 100
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.extensions).toEqual({ complexity: 100, maxComplexity: 100 });
    });

    it("accepts a query just under the budget", async () => {
      const { app } = await loadApp();
      const res = await post(app, costQuery(49)); // 98
      expect(res.status).toBe(200);
      expect(res.body.extensions.complexity).toBe(98);
    });

    it("rejects a query one point over the budget with a clear error", async () => {
      const { app } = await loadApp();
      const res = await post(app, costQuery(50, 1)); // 101
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toBe(
        "Query complexity 101 exceeds maximum allowed budget of 100 (default budget). " +
          "Request fewer list fields, lower nesting or split the query."
      );
      expect(res.body.errors[0].extensions).toEqual({
        code: "QUERY_TOO_COMPLEX",
        complexity: 101,
        maxComplexity: 100,
        budgetSource: "default",
      });
      expect(res.body.extensions).toEqual({ complexity: 101, maxComplexity: 100 });
    });
  });

  describe("tenant complexity budget interaction", () => {
    it("looks the budget up for the tenant attached by tenancy middleware", async () => {
      const { app } = await loadApp("heavy-tenant");
      await post(app, costQuery(1));
      expect(getBudgetForTenant).toHaveBeenCalledWith(
        expect.objectContaining({ id: "heavy-tenant" })
      );
    });

    it("lets a tenant with a larger budget run queries over the default", async () => {
      const { app } = await loadApp("heavy-tenant");
      const res = await post(app, costQuery(50, 1)); // 101 > default, < 500
      expect(res.status).toBe(200);
      expect(res.body.extensions).toEqual({ complexity: 101, maxComplexity: 500 });
    });

    it("rejects a heavy tenant just over its own budget", async () => {
      // 250 aliases × 2 = 500 (at budget), +1 scalar = 501
      const { app } = await loadApp("heavy-tenant");
      const at = await post(app, costQuery(250));
      const over = await post(app, costQuery(250, 1));
      expect(at.status).toBe(200);
      expect(over.status).toBe(400);
      expect(over.body.errors[0].extensions).toMatchObject({
        code: "QUERY_TOO_COMPLEX",
        complexity: 501,
        maxComplexity: 500,
        budgetSource: "tenant",
      });
      expect(over.body.errors[0].message).toContain("(tenant budget)");
    });

    it("applies a smaller tenant budget even when the default would allow it", async () => {
      const { app } = await loadApp("tiny-tenant");
      const res = await post(app, costQuery(11)); // 22 > 20
      expect(res.status).toBe(400);
      expect(res.body.errors[0].extensions.maxComplexity).toBe(20);
      expect(res.body.errors[0].extensions.budgetSource).toBe("tenant");
    });

    it("falls back to the default budget for tenants without an override", async () => {
      const { app } = await loadApp("plain-tenant");
      const res = await post(app, costQuery(50, 1));
      expect(res.status).toBe(400);
      expect(res.body.errors[0].extensions.maxComplexity).toBe(100);
      expect(res.body.errors[0].extensions.budgetSource).toBe("default");
    });

    it("enforces the depth limit regardless of tenant budget", async () => {
      const { app } = await loadApp("heavy-tenant");
      const res = await post(app, nestedQuery(5));
      expect(res.status).toBe(400);
      expect(res.body.errors[0].extensions.code).toBe("QUERY_TOO_DEEP");
    });
  });
});

describe("resolveDefaultComplexityBudget (#2205)", () => {
  it("parses GRAPHQL_MAX_COMPLEXITY and falls back on bad values", async () => {
    const { resolveDefaultComplexityBudget } = await import("../limits");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDefaultComplexityBudget(undefined)).toBe(100);
    expect(resolveDefaultComplexityBudget("250")).toBe(250);
    expect(resolveDefaultComplexityBudget("abc")).toBe(100);
    expect(resolveDefaultComplexityBudget("0")).toBe(100);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
