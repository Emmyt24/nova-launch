import { describe, expect, it } from "vitest";
import { isOriginAllowed } from "../allowedOrigins";

describe("isOriginAllowed", () => {
  it("allows requests without an Origin header", () => {
    expect(isOriginAllowed(undefined, [])).toBe(true);
  });

  it("allows an origin explicitly present in the allowlist", () => {
    expect(isOriginAllowed("https://app.example.com", ["https://app.example.com"])).toBe(true);
  });

  it("allows any origin when the allowlist contains a wildcard", () => {
    expect(isOriginAllowed("https://unlisted.example.com", ["*"])).toBe(true);
  });

  it("rejects origins that are not an exact allowlist match", () => {
    expect(isOriginAllowed("https://app.example.com.evil.test", ["https://app.example.com"])).toBe(false);
    expect(isOriginAllowed("https://app.example.com", [])).toBe(false);
  });
});