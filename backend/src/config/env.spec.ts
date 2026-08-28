/**
 * Tests for validateEnv()'s production JWT-secret guard.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEnv } from "./env";

describe("validateEnv — production JWT secret guard", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.FACTORY_CONTRACT_ID =
      "C" + "A".repeat(55); // satisfies the FACTORY_CONTRACT_ID format check
    process.env.DATABASE_URL = "postgresql://user:pass@host:5432/db";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws when JWT_SECRET is unset in production", () => {
    delete process.env.JWT_SECRET;
    expect(() => validateEnv()).toThrow(
      "JWT_SECRET must be set to a secure value in production."
    );
  });

  it("throws when JWT_SECRET is explicitly set to this file's own dev-mode default", () => {
    process.env.JWT_SECRET = "dev-secret-key-change-me";
    expect(() => validateEnv()).toThrow(
      "JWT_SECRET must be set to a secure value in production."
    );
  });

  it("does not throw when JWT_SECRET is set to a real secret in production", () => {
    process.env.JWT_SECRET = "a-real-production-secret";
    expect(() => validateEnv()).not.toThrow();
  });

  it("does not throw when JWT_SECRET is unset outside production", () => {
    process.env.NODE_ENV = "development";
    delete process.env.JWT_SECRET;
    expect(() => validateEnv()).not.toThrow();
    expect(validateEnv().JWT_SECRET).toBe("dev-secret-key-change-me");
  });
});
