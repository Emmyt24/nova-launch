import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("Rate Limiter Config Validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear the require cache so we can reimport with different env vars
    delete require.cache[require.resolve("./rateLimiter")];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    delete require.cache[require.resolve("./rateLimiter")];
  });

  it("should throw error when RATE_LIMIT_WINDOW_MS is non-numeric", () => {
    process.env.RATE_LIMIT_WINDOW_MS = "abc";
    expect(() => {
      require("./rateLimiter");
    }).toThrow(/Invalid RATE_LIMIT_WINDOW_MS.*not a valid integer/);
  });

  it("should throw error when RATE_LIMIT_MAX_REQUESTS is non-numeric", () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = "xyz";
    expect(() => {
      require("./rateLimiter");
    }).toThrow(/Invalid RATE_LIMIT_MAX_REQUESTS.*not a valid integer/);
  });

  it("should use default values when env vars are unset", () => {
    delete process.env.RATE_LIMIT_WINDOW_MS;
    delete process.env.RATE_LIMIT_MAX_REQUESTS;
    expect(() => {
      require("./rateLimiter");
    }).not.toThrow();
  });

  it("should accept valid integer env vars", () => {
    process.env.RATE_LIMIT_WINDOW_MS = "600000";
    process.env.RATE_LIMIT_MAX_REQUESTS = "50";
    expect(() => {
      require("./rateLimiter");
    }).not.toThrow();
  });

  it("should throw error when RATE_LIMIT_WINDOW_MS is empty string", () => {
    process.env.RATE_LIMIT_WINDOW_MS = "";
    expect(() => {
      require("./rateLimiter");
    }).toThrow(/Invalid RATE_LIMIT_WINDOW_MS.*not a valid integer/);
  });

  it("should throw error when RATE_LIMIT_MAX_REQUESTS is empty string", () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = "";
    expect(() => {
      require("./rateLimiter");
    }).toThrow(/Invalid RATE_LIMIT_MAX_REQUESTS.*not a valid integer/);
  });
});
