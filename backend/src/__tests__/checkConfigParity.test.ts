import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  parseEnvExample,
  loadServiceEnv,
  checkParity,
  type ServiceEnvs,
} from "../../../scripts/check-config-parity";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function loadRealEnvs(): ServiceEnvs {
  return {
    backend: loadServiceEnv(join(REPO_ROOT, "backend", ".env.example")),
    gateway: loadServiceEnv(join(REPO_ROOT, "gateway", ".env.example")),
    frontend: loadServiceEnv(join(REPO_ROOT, "frontend", ".env.example")),
  };
}

describe("parseEnvExample", () => {
  it("parses KEY=VALUE pairs and ignores comments/blank lines", () => {
    const parsed = parseEnvExample(
      ["# a comment", "", "FOO=bar", "  BAZ=qux  ", "# EMPTY=ignored"].join("\n")
    );
    expect(parsed).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("preserves '=' characters inside values", () => {
    const parsed = parseEnvExample("DATABASE_URL=postgresql://user:pass@host:5432/db?schema=public");
    expect(parsed.DATABASE_URL).toBe("postgresql://user:pass@host:5432/db?schema=public");
  });
});

describe("checkParity against real .env.example files", () => {
  it("passes with zero mismatches on current config", () => {
    const mismatches = checkParity(loadRealEnvs());
    expect(mismatches).toEqual([]);
  });
});

describe("checkParity flags deliberately introduced mismatches", () => {
  it("flags a Redis URL divergence between backend and gateway", () => {
    const envs = loadRealEnvs();
    envs.gateway = { ...envs.gateway, REDIS_URL: "redis://some-other-host:6380" };

    const mismatches = checkParity(envs);
    expect(mismatches.some((m) => m.rule === "redis_url")).toBe(true);
  });

  it("flags a gateway BACKEND_URL that no longer matches backend.PORT", () => {
    const envs = loadRealEnvs();
    envs.gateway = { ...envs.gateway, BACKEND_URL: "http://localhost:9999" };

    const mismatches = checkParity(envs);
    expect(mismatches.some((m) => m.rule === "gateway_backend_url")).toBe(true);
  });

  it("flags a frontend API URL that bypasses the gateway port", () => {
    const envs = loadRealEnvs();
    envs.frontend = { ...envs.frontend, VITE_API_BASE_URL: "http://localhost:3000/api" };

    const mismatches = checkParity(envs);
    expect(mismatches.some((m) => m.rule === "frontend_api_base_url")).toBe(true);
  });

  it("flags a Stellar network mismatch between backend and frontend", () => {
    const envs = loadRealEnvs();
    envs.frontend = { ...envs.frontend, VITE_NETWORK: "mainnet" };

    const mismatches = checkParity(envs);
    expect(mismatches.some((m) => m.rule === "stellar_network")).toBe(true);
  });

  it("flags a missing frontend origin in the gateway's CORS allowlist", () => {
    const envs = loadRealEnvs();
    envs.gateway = { ...envs.gateway, ALLOWED_ORIGINS: "http://example.com" };

    const mismatches = checkParity(envs);
    expect(mismatches.some((m) => m.rule === "frontend_origin")).toBe(true);
  });
});
