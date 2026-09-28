/**
 * Tests for wiring the DB_POOL_* env vars into the Prisma connection string.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@prisma/client", () => {
  class PrismaClient {
    $extends() {
      return this;
    }
  }
  return { PrismaClient };
});

import { buildConnectionString } from "../prisma";

const BASE = "postgresql://user:pass@localhost:5432/nova?schema=public";

describe("buildConnectionString", () => {
  it("appends connection_limit when DB_POOL_MAX is set", () => {
    const url = new URL(buildConnectionString(BASE, { DB_POOL_MAX: "50" }));
    expect(url.searchParams.get("connection_limit")).toBe("50");
  });

  it("appends pool_timeout in seconds from DB_CONNECT_TIMEOUT_MS", () => {
    const url = new URL(
      buildConnectionString(BASE, { DB_CONNECT_TIMEOUT_MS: "7500" })
    );
    expect(url.searchParams.get("pool_timeout")).toBe("8");
  });

  it("preserves DATABASE_URL's existing query parameters", () => {
    const url = new URL(
      buildConnectionString(BASE, {
        DB_POOL_MAX: "50",
        DB_CONNECT_TIMEOUT_MS: "5000",
      })
    );
    expect(url.searchParams.get("schema")).toBe("public");
    expect(url.searchParams.get("connection_limit")).toBe("50");
    expect(url.searchParams.get("pool_timeout")).toBe("5");
  });

  it("never overrides pool parameters already set on DATABASE_URL", () => {
    const url = new URL(
      buildConnectionString(`${BASE}&connection_limit=5&pool_timeout=2`, {
        DB_POOL_MAX: "50",
        DB_CONNECT_TIMEOUT_MS: "9000",
      })
    );
    expect(url.searchParams.get("connection_limit")).toBe("5");
    expect(url.searchParams.get("pool_timeout")).toBe("2");
  });

  it("leaves the URL untouched when no pool env vars are set", () => {
    expect(buildConnectionString(BASE, {})).toBe(BASE);
  });

  it("ignores malformed or non-positive pool env values", () => {
    const url = new URL(
      buildConnectionString(BASE, {
        DB_POOL_MAX: "lots",
        DB_CONNECT_TIMEOUT_MS: "0",
      })
    );
    expect(url.searchParams.has("connection_limit")).toBe(false);
    expect(url.searchParams.has("pool_timeout")).toBe(false);
  });
});
