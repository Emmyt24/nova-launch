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

console.log("Checking event schema codegen drift...");

let schemas;
try {
  schemas = loadEventSchemas(schemasDir);
} catch (err) {
  console.error(`Failed to load event schemas from ${schemasDir}: ${(err as Error).message}`);
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
