import { describe, it, expect } from "vitest";
import { ROUTES, RATE_LIMIT_TIERS, RateLimitTier } from "../routes";

describe("RATE_LIMIT_TIERS", () => {
  const tiers: RateLimitTier[] = ["strict", "default", "relaxed"];

  it.each(tiers)("tier '%s' has positive windowMs and max", (tier) => {
    expect(RATE_LIMIT_TIERS[tier].windowMs).toBeGreaterThan(0);
    expect(RATE_LIMIT_TIERS[tier].max).toBeGreaterThan(0);
  });

  it("strict max < default max < relaxed max", () => {
    expect(RATE_LIMIT_TIERS.strict.max).toBeLessThan(RATE_LIMIT_TIERS.default.max);
    expect(RATE_LIMIT_TIERS.default.max).toBeLessThan(RATE_LIMIT_TIERS.relaxed.max);
  });
});

describe("ROUTES", () => {
  it("every route has a non-empty prefix", () => {
    ROUTES.forEach((r) => expect(r.prefix.length).toBeGreaterThan(0));
  });

  it("every route prefix starts with /api", () => {
    ROUTES.forEach((r) => expect(r.prefix.startsWith("/api")).toBe(true));
  });

  it("admin routes require auth", () => {
    const admin = ROUTES.find((r) => r.prefix === "/api/admin");
    expect(admin?.requiresAuth).toBe(true);
  });

  it("governance routes require auth", () => {
    const gov = ROUTES.find((r) => r.prefix === "/api/governance");
    expect(gov?.requiresAuth).toBe(true);
  });

  it("webhook routes require auth", () => {
    const wh = ROUTES.find((r) => r.prefix === "/api/webhooks");
    expect(wh?.requiresAuth).toBe(true);
  });

  it("webhook dead-letter admin routes require auth and use the strict tier", () => {
    const dl = ROUTES.find((r) => r.prefix === "/api/webhooks-deadletter");
    expect(dl).toBeDefined();
    expect(dl?.requiresAuth).toBe(true);
    expect(dl?.tier).toBe("strict");
  });

  it("registers /api/webhooks-deadletter before the more general /api/webhooks", () => {
    const dlIndex = ROUTES.findIndex((r) => r.prefix === "/api/webhooks-deadletter");
    const whIndex = ROUTES.findIndex((r) => r.prefix === "/api/webhooks");
    expect(dlIndex).toBeGreaterThanOrEqual(0);
    expect(whIndex).toBeGreaterThanOrEqual(0);
    expect(dlIndex).toBeLessThan(whIndex);
  });

  it("leaderboard routes do not require auth", () => {
    const lb = ROUTES.find((r) => r.prefix === "/api/leaderboard");
    expect(lb?.requiresAuth).toBe(false);
  });

  it("admin routes use strict tier", () => {
    const admin = ROUTES.find((r) => r.prefix === "/api/admin");
    expect(admin?.tier).toBe("strict");
  });

  it("leaderboard routes use relaxed tier", () => {
    const lb = ROUTES.find((r) => r.prefix === "/api/leaderboard");
    expect(lb?.tier).toBe("relaxed");
  });

  it("no duplicate prefixes", () => {
    const prefixes = ROUTES.map((r) => r.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
