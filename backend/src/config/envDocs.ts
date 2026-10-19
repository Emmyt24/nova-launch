/**
 * Renders the environment variable catalog (`envSchema.ts`) as Markdown.
 *
 * Pure and deterministic — no timestamps — so `generate-env-docs.ts --check`
 * can byte-compare the committed reference against a fresh render.
 *
 * Issue: #2211
 */

import {
  ENV_GROUPS,
  ENV_SCHEMA,
  type EnvRequirement,
  type EnvVarSpec,
} from "./envSchema";

const REQUIREMENT_LABELS: Record<EnvRequirement, string> = {
  production: "**Production**",
  manifest: "Deployment",
  optional: "No",
};

/** Escape a value for a Markdown table cell. */
export function escapeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function code(value: string): string {
  // Backtick spans cannot contain a backtick; none of our values do, but
  // fall back to plain text rather than emit broken Markdown.
  return value.includes("`") ? escapeCell(value) : `\`${escapeCell(value)}\``;
}

function groupAnchor(group: string): string {
  return group
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ /g, "-");
}

function renderRow(spec: EnvVarSpec): string {
  const name = code(spec.name) + (spec.secret ? " 🔒" : "");
  const def = spec.default !== undefined ? escapeCell(spec.default) : "—";
  const example = spec.secret
    ? "_secret_"
    : spec.example !== undefined
      ? code(spec.example)
      : "—";
  return `| ${name} | ${REQUIREMENT_LABELS[spec.required]} | ${def} | ${example} | ${escapeCell(spec.description)} |`;
}

/** Render the full environment reference document. */
export function renderEnvReference(
  schema: readonly EnvVarSpec[] = ENV_SCHEMA
): string {
  const lines: string[] = [
    "<!--",
    "  GENERATED FILE — DO NOT EDIT.",
    "  Source: backend/src/config/envSchema.ts",
    "  Regenerate: cd backend && npm run docs:env",
    "-->",
    "",
    "# Backend Environment Variables",
    "",
    "Reference for every environment variable read by the backend. It is generated",
    "from `backend/src/config/envSchema.ts`, and CI fails when this file is out of date.",
    "",
    "**Required** column:",
    "",
    "- **Production** — `validateEnv()` (`src/config/env.ts`) throws at startup when unset",
    "  with `NODE_ENV=production`; a development default applies otherwise.",
    "- **Deployment** — listed as required in the deployment manifest",
    "  (`REQUIRED_SCHEMAS` in `src/config/startupValidation.ts`); set it in every",
    "  deployed environment.",
    "- **No** — optional; the default or a graceful fallback applies.",
    "",
    "🔒 marks credentials: load them from a secret store (see the Vault group) and never commit them.",
    "",
  ];

  const required = schema.filter((s) => s.required !== "optional");
  lines.push("## Required at a glance", "");
  lines.push("| Variable | Required | Group |", "|---|---|---|");
  for (const spec of required) {
    lines.push(
      `| ${code(spec.name)} | ${REQUIREMENT_LABELS[spec.required]} | [${spec.group}](#${groupAnchor(spec.group)}) |`
    );
  }
  lines.push("");

  lines.push("## Contents", "");
  for (const group of ENV_GROUPS) {
    const count = schema.filter((s) => s.group === group).length;
    if (count > 0)
      lines.push(`- [${group}](#${groupAnchor(group)}) (${count})`);
  }
  lines.push("");

  for (const group of ENV_GROUPS) {
    const specs = schema.filter((s) => s.group === group);
    if (specs.length === 0) continue;
    lines.push(`## ${group}`, "");
    lines.push(
      "| Variable | Required | Default | Example | Description |",
      "|---|---|---|---|---|"
    );
    for (const spec of specs) lines.push(renderRow(spec));
    lines.push("");
  }

  lines.push(
    "## Example `.env`",
    "",
    "Every required variable for a deployed environment (all others use their defaults).",
    "Replace each `<set-me>` with a value from your secret store:",
    "",
    "```env"
  );
  for (const spec of schema) {
    if (spec.required === "optional" || spec.secret) continue;
    const value = spec.example ?? spec.default ?? "";
    lines.push(`${spec.name}=${value}`);
  }
  for (const spec of schema) {
    if (spec.required !== "optional" && spec.secret) {
      lines.push(`${spec.name}=<set-me>`);
    }
  }
  lines.push("```", "");

  return lines.join("\n");
}
