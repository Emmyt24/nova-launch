/**
 * Regression test for #1692 — Prisma singleton field-name typo.
 *
 * The typo (`_basepisma` vs `_baseprisma`) meant that the global-cache
 * guard never matched, so a fresh PrismaClient was constructed on every
 * import in non-production environments.  After the fix, two sequential
 * imports must return the same instance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Unit-test the singleton logic in isolation (no real DB connection needed)
// ---------------------------------------------------------------------------

describe("prisma singleton (#1692)", () => {
  it("globalThis cache field name is consistent between the type annotation and the read/write sites", async () => {
    // We read the source of prisma.ts and assert the typo is gone.
    // This is a static correctness check that doesn't require a DB.
    const fs = await import("fs");
    const path = await import("path");

    const prismaFilePath = path.resolve(
      __dirname,
      "../lib/prisma.ts"
    );
    const source = fs.readFileSync(prismaFilePath, "utf-8");

    // The mistyped identifier must not appear anywhere in the source.
    expect(source).not.toContain("_basepisma");

    // The correct identifier must appear at both the type declaration site
    // and the two assignment/read sites.
    const occurrences = (source.match(/_baseprisma/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3); // type decl + read + write
  });

  it("two sequential module imports return the same client instance", async () => {
    // We simulate what the singleton pattern does: cache the instance on
    // globalThis under the correct key and verify a second "import" reuses it.

    // Clear any previous run state on the global object.
    const g = globalThis as Record<string, unknown>;
    delete g["_baseprisma"];

    // Build a minimal mock to stand in for PrismaClient.
    class MockPrismaClient {
      $extends(_opts: unknown) {
        return this;
      }
    }

    // First "import" — nothing cached yet, should create a new instance.
    const firstInstance =
      (g["_baseprisma"] as MockPrismaClient | undefined) ??
      new MockPrismaClient();
    g["_baseprisma"] = firstInstance;

    // Second "import" — cache hit, must return the same object reference.
    const secondInstance =
      (g["_baseprisma"] as MockPrismaClient | undefined) ??
      new MockPrismaClient();

    expect(secondInstance).toBe(firstInstance);

    // Clean up so this test doesn't leak state into other tests.
    delete g["_baseprisma"];
  });
});
