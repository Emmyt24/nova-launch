/**
 * Check Event Schema Codegen Drift
 *
 * Regenerates TypeScript event types from `event-schemas/*.schema.json` using
 * `backend/scripts/generate-event-types.ts` and compares the output against
 * the committed `event-schemas/generated/events.ts`.
 *
 * Exits with non-zero status if drift is detected.
 *
 * Issue: #1607
 */

import { readFileSync } from "fs";
import { join } from "path";
// @ts-ignore
import { loadEventSchemas, generateEventTypesFile } from "../backend/scripts/generate-event-types";

const rootDir = join(__dirname, "..");
const schemasDir = join(rootDir, "event-schemas");
const committedFile = join(schemasDir, "generated", "events.ts");

/**
 * Event schemas that must exist for versioned fee-change and allowlist events.
 * Issue: #2243 (fee parameter changes with old/new values)
 * Issue: #2245 (whitelist mode for token transfers)
 */
const REQUIRED_SCHEMA_FILES = [
  "fee-change.schema.json",
  "allowlist-mode-change.schema.json",
];

console.log("Checking event schema codegen drift...");

let schemas;
try {
  schemas = loadEventSchemas(schemasDir);
} catch (err) {
  console.error(`Failed to load event schemas from ${schemasDir}: ${(err as Error).message}`);
  process.exit(1);
}

// Ensure the versioned fee-change and allowlist event schemas are present so
// that generated types always include their old/new value payloads.
const loadedSchemaNames: string[] = (Array.isArray(schemas) ? schemas : Object.values(schemas ?? {}))
  .map((schema: any) => (typeof schema === "string" ? schema : schema?.file ?? schema?.name ?? ""))
  .filter((name: string) => typeof name === "string" && name.length > 0);

const missingSchemas = REQUIRED_SCHEMA_FILES.filter(
  (required) => !loadedSchemaNames.some((name) => name.endsWith(required)),
);

if (missingSchemas.length > 0) {
  console.error("ERROR: Missing required event schema files:");
  for (const missing of missingSchemas) {
    console.error(`  - event-schemas/${missing}`);
  }
  console.error("Fee-change and allowlist events must be versioned and include old/new values.");
  process.exit(1);
}

const generatedContent = generateEventTypesFile(schemas);

let committedContent = "";
try {
  committedContent = readFileSync(committedFile, "utf-8");
} catch (err) {
  console.error(`Error reading committed generated file at ${committedFile}: ${(err as Error).message}`);
  process.exit(1);
}

if (generatedContent !== committedContent) {
  console.error("ERROR: Event schema types are out of sync with event-schemas/*.schema.json!");
  console.error("Please run 'npx tsx backend/scripts/generate-event-types.ts' and commit the updated event-schemas/generated/events.ts.");
  process.exit(1);
}

console.log("SUCCESS: Event schema types are fully in sync.");
