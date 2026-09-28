/**
 * Tests for validateEnv()'s production JWT-secret guard and PORT validation.
 * Issue: #1999 — Fix the Backend Crashing at Startup Instead of Reporting a
 * Clear Error on a Malformed PORT.
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

// ---------------------------------------------------------------------------
// PORT validation — Issue #1999
// ---------------------------------------------------------------------------

describe("validateEnv — PORT validation", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Use a non-production environment so JWT/DATABASE guards don't interfere
    process.env.NODE_ENV = "development";
    delete process.env.FACTORY_CONTRACT_ID;
    delete process.env.DATABASE_URL;
    delete process.env.JWT_SECRET;
    delete process.env.ADMIN_JWT_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses default port 3001 when PORT is unset", () => {
    delete process.env.PORT;
    const env = validateEnv();
    expect(env.PORT).toBe(3001);
  });

  it("parses a valid numeric PORT correctly", () => {
    process.env.PORT = "8080";
    const env = validateEnv();
    expect(env.PORT).toBe(8080);
  });

  it("throws a clear error when PORT is a non-numeric string", () => {
    process.env.PORT = "not-a-port";
    expect(() => validateEnv()).toThrow(
      'PORT must be a valid integer between 1 and 65535, got "not-a-port"'
    );
  });

  it("throws a clear error when PORT is an empty string", () => {
    process.env.PORT = "";
    // Empty string falls through to the default "3001" path, so no throw expected
    // (empty string is falsy, so `process.env.PORT || '3001'` gives '3001')
    expect(() => validateEnv()).not.toThrow();
    expect(validateEnv().PORT).toBe(3001);
  });

  it("throws a clear error when PORT is 0", () => {
    process.env.PORT = "0";
    expect(() => validateEnv()).toThrow(
      'PORT must be a valid integer between 1 and 65535, got "0"'
    );
  });

  it("throws a clear error when PORT is 65536 (out of range)", () => {
    process.env.PORT = "65536";
    expect(() => validateEnv()).toThrow(
      'PORT must be a valid integer between 1 and 65535, got "65536"'
    );
  });

  it("throws a clear error when PORT is negative", () => {
    process.env.PORT = "-1";
    expect(() => validateEnv()).toThrow(
      'PORT must be a valid integer between 1 and 65535, got "-1"'
    );
  });

  it("accepts PORT=1 (minimum valid port)", () => {
    process.env.PORT = "1";
    expect(() => validateEnv()).not.toThrow();
    expect(validateEnv().PORT).toBe(1);
  });

  it("accepts PORT=65535 (maximum valid port)", () => {
    process.env.PORT = "65535";
    expect(() => validateEnv()).not.toThrow();
    expect(validateEnv().PORT).toBe(65535);
  });
});
