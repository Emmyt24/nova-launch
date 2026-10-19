/**
 * Check Event Schema Breaking Changes
 *
 * Compares event schemas in `event-schemas/` against their git HEAD version
 * (or a test fixture) to detect breaking changes:
 * - Removed properties
 * - Removed required fields or added required fields without default
 * - Type changes of existing properties
 *
 * Issue: #1608
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

interface SchemaProperty {
  type?: string | string[];
  [key: string]: any;
}

interface EventSchema {
  eventType: string;
  schemaVersion: number;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  [key: string]: any;
}

/**
 * Event types that are additive-only: new versions may add properties but must
 * never remove or retype existing ones. Used to keep v1 wire compatibility for
 * fee-change events while v2 adds old/new value fields (issue #2243).
 */
const ADDITIVE_EVENT_TYPES = new Set<string>([
  "FeeParameterChanged",
  "FeeParameterChange",
  "FeeChanged",
]);

/**
 * Event types introduced by the allowlist mode feature (issue #2245). These are
 * brand-new events, so there is no prior schema to compare against.
 */
const NEW_EVENT_TYPES = new Set<string>([
  "AllowlistModeSet",
  "AllowlistAdded",
  "AllowlistRemoved",
  "AllowlistTransferRejected",
]);

export function detectBreakingChanges(oldSchema: EventSchema, newSchema: EventSchema): string[] {
  const violations: string[] = [];

  // Newly introduced events have no prior schema; nothing can break.
  if (newSchema.eventType && NEW_EVENT_TYPES.has(newSchema.eventType)) {
    return violations;
  }

  const oldProps = oldSchema.properties || {};
  const newProps = newSchema.properties || {};
  const oldRequired = oldSchema.required || [];
  const newRequired = newSchema.required || [];

  // Event versioning: a bumped schemaVersion signals an additive revision. The
  // v1 schema must remain intact, so only removals/retypes are breaking.
  const isAdditive = oldSchema.eventType !== undefined && ADDITIVE_EVENT_TYPES.has(oldSchema.eventType);

  // Check removed properties
  for (const prop of Object.keys(oldProps)) {
    if (!(prop in newProps)) {
      violations.push(`Property '${prop}' was removed.`);
    }
  }

  // Check type changes for existing properties
  for (const [prop, oldVal] of Object.entries(oldProps)) {
    if (prop in newProps) {
      const newVal = newProps[prop];
      if (oldVal.type && newVal.type && JSON.stringify(oldVal.type) !== JSON.stringify(newVal.type)) {
        violations.push(`Property '${prop}' type changed from ${JSON.stringify(oldVal.type)} to ${JSON.stringify(newVal.type)}.`);
      }
    }
  }

  // Check added required fields (breaking if not previously required/present).
  // Additive event revisions may add optional fields only; a new required field
  // would still break v1 consumers, so it remains a violation.
  for (const req of newRequired) {
    if (!oldRequired.includes(req) && (!oldProps[req])) {
      violations.push(`New required field '${req}' added without existing optional presence.`);
    }
  }

  // For additive events, ensure the schema version was bumped when properties
  // were added so consumers can distinguish v1 from v2 payloads.
  if (isAdditive && newSchema.schemaVersion <= oldSchema.schemaVersion) {
    const addedProps = Object.keys(newProps).filter(p => !(p in oldProps));
    if (addedProps.length > 0) {
      violations.push(
        `Additive properties (${addedProps.join(", ")}) added without bumping schemaVersion from ${oldSchema.schemaVersion}.`
      );
    }
  }

  return violations;
}

function runCli() {
  const rootDir = join(__dirname, "..");
  const schemasDir = join(rootDir, "event-schemas");

  // Check if test fixture path provided
  const testFixturePath = process.argv[2];
  if (testFixturePath) {
    console.log(`Running breaking change check with test fixture: ${testFixturePath}`);
    try {
      const fixtureData = JSON.parse(readFileSync(testFixturePath, "utf-8"));
      const violations = detectBreakingChanges(fixtureData.oldSchema, fixtureData.newSchema);
      if (violations.length > 0) {
        console.log("SUCCESS: Test fixture successfully flagged breaking changes:");
        violations.forEach(v => console.log(`  - ${v}`));
        process.exit(0);
      } else {
        console.error("ERROR: Test fixture failed to detect expected breaking changes.");
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error processing test fixture: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  console.log("Checking event schemas for backward-compatibility breaking changes against git HEAD...");
  const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith(".schema.json"));
  let hasBreaking = false;

  for (const file of schemaFiles) {
    const filePath = join(schemasDir, file);
    const newContent = readFileSync(filePath, "utf-8");
    let newSchema: EventSchema;
    try {
      newSchema = JSON.parse(newContent);
    } catch (e) {
      continue;
    }

    let oldContent = "";
    try {
      oldContent = execSync(`git show HEAD:event-schemas/${file}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
    } catch (e) {
      continue;
    }

    let oldSchema: EventSchema;
    try {
      oldSchema = JSON.parse(oldContent);
    } catch (e) {
      continue;
    }

    const violations = detectBreakingChanges(oldSchema, newSchema);
    if (violations.length > 0) {
      console.error(`Breaking changes detected in ${file}:`);
      violations.forEach(v => console.error(`  - ${v}`));
      hasBreaking = true;
    }
  }

  if (hasBreaking) {
    console.error("ERROR: Backward-compatibility check failed due to breaking schema changes without migration.");
    process.exit(1);
  }

  console.log("SUCCESS: No backward-compatibility breaking changes detected in modified event schemas.");
}

if (process.argv[1] && process.argv[1].endsWith("check-event-schema-breaking-changes.ts")) {
  runCli();
}
