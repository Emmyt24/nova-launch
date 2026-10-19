/**
 * Keeps the environment catalog (envSchema.ts) and its generated reference
 * (docs/ENVIRONMENT.md) in sync with the code (#2211).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { ENV_GROUPS, ENV_SCHEMA } from "./envSchema";
import { renderEnvReference, escapeCell } from "./envDocs";
import { REQUIRED_SCHEMAS, OPTIONAL_VARS } from "./startupValidation";

const SRC_DIR = join(__dirname, "..");
const DOC_PATH = join(__dirname, "..", "..", "docs", "ENVIRONMENT.md");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      out.push(...listSourceFiles(full));
    } else if (
      /\.ts$/.test(entry) &&
      !/\.(test|spec)\.ts$/.test(entry) &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Env var names read via `process.env.NAME` outside comments. */
function envVarsReadInSource(): Set<string> {
  const names = new Set<string>();
  for (const file of listSourceFiles(SRC_DIR)) {
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const m of code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

const byName = new Map(ENV_SCHEMA.map((s) => [s.name, s]));

describe("ENV_SCHEMA", () => {
  it("has unique names", () => {
    expect(byName.size).toBe(ENV_SCHEMA.length);
  });

  it("uses only declared groups", () => {
    for (const spec of ENV_SCHEMA) {
      expect(ENV_GROUPS).toContain(spec.group);
    }
  });

  it("documents every environment variable read under src/", () => {
    const missing = [...envVarsReadInSource()].filter((n) => !byName.has(n));
    expect(missing, `Add these to src/config/envSchema.ts`).toEqual([]);
  });

  it("has no stale entries for variables no longer read", () => {
    const read = envVarsReadInSource();
    const stale = ENV_SCHEMA.map((s) => s.name).filter((n) => !read.has(n));
    expect(stale, `Remove these from src/config/envSchema.ts`).toEqual([]);
  });

  it("marks every startup-manifest variable as required", () => {
    for (const shape of Object.values(REQUIRED_SCHEMAS)) {
      for (const name of Object.keys(shape.shape)) {
        expect(byName.get(name)?.required, name).not.toBe("optional");
      }
    }
  });

  it("includes every optional variable from the startup manifest", () => {
    for (const name of Object.keys(OPTIONAL_VARS)) {
      expect(byName.has(name), name).toBe(true);
    }
  });

  it("never ships an example value for secrets", () => {
    for (const spec of ENV_SCHEMA.filter((s) => s.secret)) {
      expect(spec.example ?? "", spec.name).not.toMatch(
        /^[A-Za-z0-9+/=_-]{24,}$/
      );
    }
  });

  it("gives every non-secret optional variable a default or example", () => {
    for (const spec of ENV_SCHEMA) {
      if (spec.secret || spec.required !== "optional") continue;
      expect(spec.default ?? spec.example, spec.name).toBeDefined();
    }
  });
});

describe("renderEnvReference", () => {
  const doc = renderEnvReference();

  it("is deterministic", () => {
    expect(renderEnvReference()).toBe(doc);
  });

  it("marks the file as generated", () => {
    expect(doc).toContain("GENERATED FILE — DO NOT EDIT");
  });

  it("lists every variable", () => {
    for (const spec of ENV_SCHEMA) {
      expect(doc).toContain(`\`${spec.name}\``);
    }
  });

  it("shows defaults and required flags", () => {
    expect(doc).toMatch(/\| `PORT` \| No \| 3001 \| `3001` \|/);
    expect(doc).toMatch(/\| `JWT_SECRET` 🔒 \| \*\*Production\*\* \|/);
  });

  it("never renders example values for secrets", () => {
    expect(doc).toMatch(
      /\| `SENDGRID_API_KEY` 🔒 \| Deployment \| — \| _secret_ \|/
    );
  });

  it("escapes pipes in table cells", () => {
    expect(escapeCell("a|b")).toBe("a\\|b");
  });

  it("matches the committed docs/ENVIRONMENT.md", () => {
    expect(existsSync(DOC_PATH), "run `npm run docs:env`").toBe(true);
    expect(readFileSync(DOC_PATH, "utf8")).toBe(doc);
  });
});
