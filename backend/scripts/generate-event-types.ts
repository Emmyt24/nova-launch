/**
 * Event Schema -> TypeScript Codegen
 *
 * Reads every `*.schema.json` file in the monorepo-root `event-schemas/`
 * directory and generates a single TypeScript module containing one
 * `interface` per event schema, plus an `EventPayloadMap` lookup type keyed by
 * `eventType` and an `EVENT_SCHEMA_VERSIONS` const map (a real runtime value,
 * which is why the output is a `.ts` module rather than a `.d.ts` ambient
 * declaration file).
 *
 * The generated output is written to `event-schemas/generated/events.ts` so
 * it can be imported via a plain relative path from both `backend/` and
 * `frontend/` (the monorepo has no npm workspaces, so this avoids any
 * package-name import).
 *
 * Usage:
 *   npx tsx scripts/generate-event-types.ts
 *
 * Issue: #1406
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types describing the (intentionally small) subset of JSON Schema we support
// ---------------------------------------------------------------------------

export interface JsonSchemaProperty {
  type?: string | string[];
  const?: unknown;
  description?: string;
  format?: string;
  minimum?: number;
  enum?: unknown[];
  /**
   * Nested object properties. Used by schemas that embed a sub-object (e.g.
   * the `previous`/`new` fee parameter snapshots in the v2 fee-change event).
   */
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/** A nested object schema, used standalone or as one branch of a top-level `anyOf`. */
export interface ObjectSubSchema {
  type: "object";
  description?: string;
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface EventJsonSchema {
  $schema?: string;
  $id?: string;
  title: string;
  description?: string;
  type: "object";
  schemaVersion: number;
  eventType: string;
  /**
   * Most schemas declare properties directly at the root. A schema may
   * instead (or additionally) declare `anyOf` — a list of alternative object
   * shapes — to document known payload drift between multiple publishers of
   * the same event type (see token.deployed.schema.json). When `anyOf` is
   * present, codegen emits a TypeScript union of one interface per branch.
   */
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: ObjectSubSchema[];
  /**
   * Optional list of prior schema versions this event type still accepts on
   * the wire. Each entry is a full schema (with its own `schemaVersion`) and
   * is emitted as a versioned interface plus a union member, so parsers can
   * discriminate on `schemaVersion` while keeping backward compatibility.
   *
   * Example: the v2 fee-change event lists its v1 schema here so both
   * `FeeParameterChangedEventPayloadV1` and `...V2` are generated.
   */
  previousVersions?: EventJsonSchema[];
}

// ---------------------------------------------------------------------------
// JSON Schema (draft 2020-12 subset) -> TypeScript type mapping
// ---------------------------------------------------------------------------

/**
 * Maps a single JSON Schema property definition to a TypeScript type string.
 * Supports the subset of draft 2020-12 used by event-schemas/*.schema.json:
 * string, integer, number, boolean, null, array-of-types (unions), const, and
 * enum.
 */
export function jsonSchemaTypeToTs(prop: JsonSchemaProperty): string {
  if (prop.const !== undefined) {
    return JSON.stringify(prop.const);
  }

  if (prop.enum) {
    return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  const types = Array.isArray(prop.type) ? prop.type : [prop.type];

  const mapped = types.map((t) => {
    switch (t) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "object":
        // Inline nested object schemas are rendered structurally so callers
        // get real field types (e.g. `previous: { feeBps: number; ... }`).
        if (prop.properties) {
          const required = new Set(prop.required ?? []);
          const fields = Object.entries(prop.properties)
            .map(([key, sub]) => {
              const optional = required.has(key) ? "" : "?";
              return `${key}${optional}: ${jsonSchemaTypeToTs(sub)}`;
            })
            .join("; ");
          return `{ ${fields} }`;
        }
        return "Record<string, unknown>";
      case "array":
        return "unknown[]";
      default:
        return "unknown";
    }
  });

  return mapped.join(" | ");
}

/** Converts a dotted/camelCase event type string into a PascalCase identifier. */
export function eventTypeToInterfaceName(eventType: string): string {
  const pascal = eventType
    .split(/[.\-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${pascal}EventPayload`;
}

/** Renders the `{ key: type; ... }` body lines for one object (sub-)schema. */
function renderObjectBody(
  properties: Record<string, JsonSchemaProperty>,
  required: Set<string>
): string[] {
  const lines: string[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    const optional = required.has(key) ? "" : "?";
    const tsType = jsonSchemaTypeToTs(prop);
    if (prop.description) {
      lines.push(`  /** ${prop.description} */`);
    }
    lines.push(`  ${key}${optional}: ${tsType};`);
  }
  return lines;
}

/**
 * Generates the TypeScript declaration(s) for one event schema.
 *
 * - Schemas with root-level `properties` produce a single `interface`.
 * - Schemas with `anyOf` (multiple alternative shapes — see
 *   token.deployed.schema.json) produce one numbered interface per branch
 *   plus a union `type` alias with the schema's canonical name.
 *
 * `schemaVersion` is included as a literal field on each generated shape
 * since every event-schemas/*.schema.json requires it on the payload.
 */
export function generateInterfaceForSchema(schema: EventJsonSchema): string {
  const interfaceName = eventTypeToInterfaceName(schema.eventType);
  const docBlock = schema.description
    ? [`/**`, ` * ${schema.description}`, ` *`, ` * Event type: \`${schema.eventType}\``, ` */`]
    : [`/** Event type: \`${schema.eventType}\` */`];

  // Versioned interfaces: when a schema declares `previousVersions`, emit one
  // interface per version (V1, V2, ...) and a union alias with the canonical
  // name. This keeps older wire payloads parseable while exposing the new
  // fields (e.g. previous/new fee values) on the latest version.
  const versions = [...(schema.previousVersions ?? []), schema];
  if (versions.length > 1) {
    const versionedNames = versions.map(
      (v) => `${interfaceName}V${v.schemaVersion}`
    );

    const versionedInterfaces = versions.map((v, i) => {
      const required = new Set(v.required ?? []);
      const lines: string[] = [];
      const versionDoc = v.description
        ? `/** ${v.description} (schemaVersion ${v.schemaVersion}) */`
        : `/** schemaVersion ${v.schemaVersion} */`;
      lines.push(versionDoc);
      lines.push(`export interface ${versionedNames[i]} {`);
      lines.push(...renderObjectBody(v.properties ?? {}, required));
      lines.push(`}`);
      return lines.join("\n");
    });

    const unionAlias = [
      ...docBlock,
      `export type ${interfaceName} = ${versionedNames.join(" | ")};`,
    ].join("\n");

    return [...versionedInterfaces, unionAlias].join("\n\n");
  }

  if (schema.anyOf && schema.anyOf.length > 0) {
    const branchNames = schema.anyOf.map((_, i) => `${interfaceName}Variant${i + 1}`);

    const branchInterfaces = schema.anyOf.map((branch, i) => {
      const required = new Set(branch.required ?? []);
      const lines: string[] = [];
      if (branch.description) lines.push(`/** ${branch.description} */`);
      lines.push(`export interface ${branchNames[i]} {`);
      lines.push(...renderObjectBody(branch.properties, required));
      lines.push(`}`);
      return lines.join("\n");
    });

    const unionAlias = [
      ...docBlock,
      `export type ${interfaceName} = ${branchNames.join(" | ")};`,
    ].join("\n");

    return [...branchInterfaces, unionAlias].join("\n\n");
  }

  const required = new Set(schema.required ?? []);
  const lines: string[] = [...docBlock, `export interface ${interfaceName} {`];
  lines.push(...renderObjectBody(schema.properties ?? {}, required));
  lines.push(`}`);
  return lines.join("\n");
}

/**
 * Generates the full `events.ts` file content for a set of event schemas:
 * one interface per schema, an `EventPayloadMap` keyed by event type string,
 * and an `EVENT_SCHEMA_VERSIONS` const map for runtime version lookups.
 */
export function generateEventTypesFile(schemas: EventJsonSchema[]): string {
  const sorted = [...schemas].sort((a, b) => a.eventType.localeCompare(b.eventType));

  const header = [
    `/**`,
    ` * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.`,
    ` *`,
    ` * Generated by backend/scripts/generate-event-types.ts from the JSON Schema`,
    ` * files in event-schemas/. Run \`npm run generate:event-types\` (from`,
    ` * backend/) after editing any *.schema.json file, and commit the result.`,
    ` *`,
    ` * Issue: #1406`,
    ` */`,
    ``,
  ].join("\n");

  const interfaces = sorted.map(generateInterfaceForSchema).join("\n\n");

  const mapEntries = sorted
    .map((s) => `  "${s.eventType}": ${eventTypeToInterfaceName(s.eventType)};`)
    .join("\n");

  const eventPayloadMap = [
    `/** Maps every known event type string to its payload interface. */`,
    `export interface EventPayloadMap {`,
    mapEntries,
    `}`,
  ].join("\n");

  const versionEntries = sorted
    .map((s) => `  "${s.eventType}": ${s.schemaVersion},`)
    .join("\n");

  const versionsMap = [
    `/** Current schemaVersion for each known event type. */`,
    `export const EVENT_SCHEMA_VERSIONS = {`,
    versionEntries,
    `} as const;`,
  ].join("\n");

  // All schema versions still accepted on the wire per event type, oldest
  // first. Parsers can use this to validate `schemaVersion` before narrowing
  // the payload union.
  const supportedVersionEntries = sorted
    .map((s) => {
      const all = [...(s.previousVersions ?? []), s].map((v) => v.schemaVersion);
      return `  "${s.eventType}": [${all.join(", ")}] as const,`;
    })
    .join("\n");

  const supportedVersionsMap = [
    `/** Every schemaVersion still accepted on the wire for each event type. */`,
    `export const EVENT_SUPPORTED_SCHEMA_VERSIONS = {`,
    supportedVersionEntries,
    `} as const;`,
  ].join("\n");

  return [
    header,
    interfaces,
    "",
    eventPayloadMap,
    "",
    versionsMap,
    "",
    supportedVersionsMap,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/** Reads and parses every `*.schema.json` file directly under `dir`. */
export function loadEventSchemas(dir: string): EventJsonSchema[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".schema.json"))
    .sort()
    .map((f) => {
      const raw = readFileSync(join(dir, f), "utf-8");
      try {
        return JSON.parse(raw) as EventJsonSchema;
      } catch (err) {
        throw new Error(`Failed to parse ${f} as JSON: ${(err as Error).message}`);
      }
    });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith("generate-event-types.ts")) {
  const schemasDir = join(__dirname, "..", "..", "event-schemas");
  const outDir = join(schemasDir, "generated");
  const outFile = join(outDir, "events.ts");

  console.log(`Reading event schemas from ${schemasDir}...`);
  const schemas = loadEventSchemas(schemasDir);
  console.log(`Found ${schemas.length} schema(s): ${schemas.map((s) => s.eventType).join(", ")}`);

  const output = generateEventTypesFile(schemas);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, output, "utf-8");
  console.log(`Event types written to ${outFile}`);
}
