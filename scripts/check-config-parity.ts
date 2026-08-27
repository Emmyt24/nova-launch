/**
 * Cross-service config parity check.
 *
 * Backend, gateway, and frontend each declare their own `.env.example`, but
 * nothing verifies they agree on the values that must be consistent across
 * services (shared Redis instance, CORS origin, proxy target ports, Stellar
 * network) to avoid silent misconfiguration in a deployed environment.
 *
 * Usage:
 *   npx tsx scripts/check-config-parity.ts
 *
 * Issue: #1618
 */

import { readFileSync } from "fs";
import { join } from "path";

export type EnvMap = Record<string, string>;

export interface ParityMismatch {
  rule: string;
  message: string;
}

export interface ServiceEnvs {
  backend: EnvMap;
  gateway: EnvMap;
  frontend: EnvMap;
}

/** Parses a `.env.example`-style file (KEY=VALUE per line, `#` comments, blank lines ignored). */
export function parseEnvExample(contents: string): EnvMap {
  const env: EnvMap = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

export function loadServiceEnv(absolutePath: string): EnvMap {
  return parseEnvExample(readFileSync(absolutePath, "utf-8"));
}

function hostPort(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return url;
  }
}

type Rule = (envs: ServiceEnvs) => ParityMismatch | null;

const RULES: Rule[] = [
  // Backend and gateway must talk to the same Redis instance — rate limiting,
  // idempotency keys, and leader-election locks share keyspaces there and
  // silently diverge if the two services point at different instances.
  ({ backend, gateway }) => {
    if (backend.REDIS_URL !== gateway.REDIS_URL) {
      return {
        rule: "redis_url",
        message:
          `backend.REDIS_URL (${backend.REDIS_URL}) !== gateway.REDIS_URL (${gateway.REDIS_URL}). ` +
          `Both services must point at the same Redis instance.`,
      };
    }
    return null;
  },

  // The gateway's CORS allowlist must include the origin the backend expects
  // the frontend to be served from, or browser requests proxied through the
  // gateway get rejected.
  ({ backend, gateway }) => {
    const allowed = (gateway.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    if (backend.FRONTEND_URL && !allowed.includes(backend.FRONTEND_URL)) {
      return {
        rule: "frontend_origin",
        message:
          `backend.FRONTEND_URL (${backend.FRONTEND_URL}) is not present in ` +
          `gateway.ALLOWED_ORIGINS (${allowed.join(", ") || "<empty>"}).`,
      };
    }
    return null;
  },

  // The gateway's upstream BACKEND_URL must actually point at the port the
  // backend listens on, or the proxy silently talks to nothing.
  ({ backend, gateway }) => {
    const backendPort = backend.PORT ?? "3001";
    const expected = `localhost:${backendPort}`;
    const actual = hostPort(gateway.BACKEND_URL ?? "");
    if (actual !== expected) {
      return {
        rule: "gateway_backend_url",
        message:
          `gateway.BACKEND_URL (${gateway.BACKEND_URL}) resolves to "${actual}", ` +
          `but backend.PORT is ${backendPort} (expected "${expected}").`,
      };
    }
    return null;
  },

  // The frontend must call the API through the gateway (which owns auth,
  // CORS, and rate limiting) rather than a hard-coded, possibly stale port.
  ({ gateway, frontend }) => {
    const gatewayPort = gateway.GATEWAY_PORT ?? "4000";
    const expected = `localhost:${gatewayPort}`;
    const apiVars = [
      "VITE_API_BASE_URL",
      "VITE_TOKEN_INFO_API_URL",
      "VITE_LEADERBOARD_API_URL",
      "VITE_GOVERNANCE_API_URL",
    ];
    for (const key of apiVars) {
      const value = frontend[key];
      if (!value) continue;
      const actual = hostPort(value);
      if (actual !== expected) {
        return {
          rule: "frontend_api_base_url",
          message:
            `frontend.${key} (${value}) resolves to "${actual}", but gateway.GATEWAY_PORT is ` +
            `${gatewayPort} (expected "${expected}"). The frontend must call the API through the gateway.`,
        };
      }
    }
    return null;
  },

  // Frontend and backend must agree on which Stellar network they target —
  // a mismatch means the UI silently renders against the wrong ledger.
  ({ backend, frontend }) => {
    if (
      backend.STELLAR_NETWORK &&
      frontend.VITE_NETWORK &&
      backend.STELLAR_NETWORK !== frontend.VITE_NETWORK
    ) {
      return {
        rule: "stellar_network",
        message:
          `backend.STELLAR_NETWORK (${backend.STELLAR_NETWORK}) !== frontend.VITE_NETWORK ` +
          `(${frontend.VITE_NETWORK}).`,
      };
    }
    return null;
  },
];

export function checkParity(envs: ServiceEnvs): ParityMismatch[] {
  const mismatches: ParityMismatch[] = [];
  for (const rule of RULES) {
    const result = rule(envs);
    if (result) mismatches.push(result);
  }
  return mismatches;
}

function main(): void {
  const repoRoot = join(__dirname, "..");
  const envs: ServiceEnvs = {
    backend: loadServiceEnv(join(repoRoot, "backend", ".env.example")),
    gateway: loadServiceEnv(join(repoRoot, "gateway", ".env.example")),
    frontend: loadServiceEnv(join(repoRoot, "frontend", ".env.example")),
  };

  const mismatches = checkParity(envs);

  if (mismatches.length === 0) {
    console.log("Cross-service config parity check passed — all shared variables agree.");
    return;
  }

  console.error(`Cross-service config parity check failed — ${mismatches.length} mismatch(es):\n`);
  for (const mismatch of mismatches) {
    console.error(`  [${mismatch.rule}] ${mismatch.message}`);
  }
  console.error("\nFix the .env.example values above so all services agree, then re-run this check.");
  process.exitCode = 1;
}

if (require.main === module) {
  main();
}
