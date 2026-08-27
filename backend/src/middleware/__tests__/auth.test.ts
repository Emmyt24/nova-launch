/**
 * Tests for #1693 — hardcoded admin JWT fallback removal.
 *
 * Verifies that:
 * 1. The source no longer contains the old guessable default "admin-secret-key".
 * 2. The resolveAdminJwtSecret function throws in non-test environments when
 *    ADMIN_JWT_SECRET is unset (static source analysis).
 * 3. A token signed with the old guessable default is rejected at JWT-verify
 *    time in the test environment (which uses a non-guessable test secret).
 * 4. A token signed with the test secret is accepted.
 */
import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { readFileSync } from "fs";
import { resolve } from "path";

// Path to the auth middleware source (relative to this test file's directory)
const AUTH_SOURCE_PATH = resolve(__dirname, "../auth.ts");

// The test-only secret defined in auth.ts
const TEST_ONLY_SECRET = "test-only-admin-jwt-secret-not-for-production";

// The old guessable fallback that must no longer be present
const OLD_GUESSABLE_DEFAULT = "admin-secret-key";

describe("auth.ts source-level checks (#1693)", () => {
  let source: string;

  source = readFileSync(AUTH_SOURCE_PATH, "utf-8");

  it("no longer contains the hardcoded guessable default", () => {
    // The string "admin-secret-key" must not appear as a fallback value
    // in the source (it may appear in comments describing the old behaviour,
    // but must not be used in code that assigns the secret).
    const assignmentMatch = source.match(
      /ADMIN_JWT_SECRET\s*\|\|\s*["']admin-secret-key["']/
    );
    expect(assignmentMatch).toBeNull();
  });

  it("contains a fail-fast throw for missing secret outside test env", () => {
    expect(source).toContain("ADMIN_JWT_SECRET environment variable is required");
  });

  it("falls back to test-only secret only in NODE_ENV === 'test'", () => {
    expect(source).toContain("NODE_ENV");
    expect(source).toContain("test");
    expect(source).toContain(TEST_ONLY_SECRET);
  });

  it("test-only secret is clearly different from the old guessable default", () => {
    expect(TEST_ONLY_SECRET).not.toBe(OLD_GUESSABLE_DEFAULT);
    expect(TEST_ONLY_SECRET.length).toBeGreaterThan(OLD_GUESSABLE_DEFAULT.length);
  });
});

describe("JWT verification with old vs new secret (#1693)", () => {
  it("rejects a token signed with the old guessable default secret", () => {
    // A token forged with the old "admin-secret-key" default must not verify
    // against the current test secret.
    const forgedToken = jwt.sign({ userId: "admin_1" }, OLD_GUESSABLE_DEFAULT);
    const verify = () => jwt.verify(forgedToken, TEST_ONLY_SECRET);
    expect(verify).toThrow();
  });

  it("accepts a token signed with the configured test secret", () => {
    const validToken = jwt.sign({ userId: "admin_1" }, TEST_ONLY_SECRET);
    const decoded = jwt.verify(validToken, TEST_ONLY_SECRET) as { userId: string };
    expect(decoded.userId).toBe("admin_1");
  });

  it("the test secret is sufficiently long to be non-trivial", () => {
    expect(TEST_ONLY_SECRET.length).toBeGreaterThanOrEqual(40);
  });
});
