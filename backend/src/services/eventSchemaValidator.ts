/**
 * Event Schema Validator
 *
 * Loads the JSON Schema files from the monorepo-root `event-schemas/`
 * directory (see #1406) and validates `eventBus` payloads against them using
 * `ajv`. Validation is intentionally restricted to non-production
 * environments — see `eventBus.ts` for how this module is wired into
 * `EventBus.publish()`.
 *
 * ## Naming convention: `eventBus.publish` strings ↔ `event-schemas/` files
 *
 * Schemas are keyed by each file's own `eventType` field (not by filename),
 * and `EventBus.publish(eventType, payload)` looks up a validator by the exact
 * string literal it is passed. For a publish call to have a chance of being
 * schema-validated, the string literal passed to `eventBus.publish(...)` must
 * be byte-for-byte identical to the `eventType` field of some
 * `event-schemas/*.schema.json` file — same casing, same separators, no
 * whitespace. The convention used throughout the codebase is a dotted,
 * lower-case, `<domain>.<action>` form (e.g. `"token.burned"`), and the
 * corresponding file is conventionally named after that event type (e.g.
 * `event-schemas/token.burned.schema.json`), though only the `eventType`
 * field is authoritative for lookup.
 *
 * ## What happens when a schema is missing
 *
 * Schemas without a registered entry are treated as "unschematized" and are
 * skipped (logged at debug level) rather than failing — the registry is
 * expected to grow incrementally and should never block publishing of an
 * event type that simply hasn't been schematized yet. So a contributor who
 * adds a new `eventBus.publish("foo.bar", ...)` call but forgets to add a
 * matching `event-schemas/foo.bar.schema.json` will not see an error: the
 * event publishes normally and is silently unvalidated. Adding the schema
 * file (with a matching `eventType`) is what opts the event into validation.
 *
 * ## Deliberate exceptions
 *
 * - Validation only runs in non-production environments (see
 *   `EventBus.publish`), so production publishes are never schema-checked
 *   regardless of whether a schema exists.
 * - Event types that are intentionally unschematized (e.g. internal or
 *   best-effort telemetry events) are left without a schema file on purpose;
 *   the skip-not-fail behavior above is what makes that safe.
 *
 * ## Suggested follow-up
 *
 * A lint rule or test could enumerate every string literal passed to
 * `eventBus.publish(...)` across the codebase and flag any that has no
 * corresponding `eventType` in `event-schemas/`, catching the "forgot to add
 * a schema" case at CI time instead of relying on this documentation. Not
 * implemented here.
 *
 * Issue: #1406, #2087
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import Ajv, { ValidateFunction } from "ajv";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

/**
 * Directory containing `*.schema.json` files. Resolved relative to this
 * compiled file's location: `backend/dist/services/` (or
 * `backend/src/services/` under tsx) → repo root → `event-schemas/`.
 */
const EVENT_SCHEMAS_DIR = join(__dirname, "..", "..", "..", "event-schemas");

// `strict: false` is required because our schemas use a top-level
// `schemaVersion`/`eventType` keyword that isn't part of vanilla JSON Schema
// (ajv would otherwise throw "strict mode: unknown keyword"). It also means
// the `format: "date-time"` hints in our schemas are informational only —
// ajv does not validate formats unless the `ajv-formats` package is added.
const ajv = new Ajv({ allErrors: true, strict: false });

let validators: Map<string, ValidateFunction> | null = null;

/**
 * Lazily loads and compiles every `*.schema.json` file under
 * `event-schemas/`, keyed by each schema's `eventType` field. Compilation
 * happens once per process; call `resetEventSchemaCache()` in tests that need
 * a fresh read of the schema files.
 */
function loadValidators(): Map<string, ValidateFunction> {
  if (validators) return validators;

  const map = new Map<string, ValidateFunction>();

  let files: string[];
  try {
    files = readdirSync(EVENT_SCHEMAS_DIR).filter((f) => f.endsWith(".schema.json"));
  } catch (err) {
    // event-schemas/ missing entirely (e.g. unexpected deployment layout) —
    // degrade to "no schemas known" rather than crashing the process.
    logger.warn("[eventSchemaValidator] could not read event-schemas directory", {
      dir: EVENT_SCHEMAS_DIR,
      error: err instanceof Error ? err.message : String(err),
    });
    validators = map;
    return map;
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(EVENT_SCHEMAS_DIR, file), "utf-8");
      const schema = JSON.parse(raw) as { eventType?: string };
      if (!schema.eventType) {
        logger.warn(`[eventSchemaValidator] schema file missing eventType, skipping`, {
          file,
        });
        continue;
      }
      map.set(schema.eventType, ajv.compile(schema));
    } catch (err) {
      logger.warn(`[eventSchemaValidator] failed to load schema file, skipping`, {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  validators = map;
  return map;
}

/**
 * Clears the in-memory compiled-schema cache so the next validation call
 * re-reads `event-schemas/` from disk. Intended for tests only.
 */
export function resetEventSchemaCache(): void {
  validators = null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class EventSchemaValidationError extends Error {
  constructor(
    public readonly eventType: string,
    public readonly errors: string
  ) {
    super(`Event payload for "${eventType}" failed schema validation: ${errors}`);
    this.name = "EventSchemaValidationError";
  }
}

/**
 * Validates `payload` against the JSON Schema registered for `eventType`.
 *
 * - If no schema is registered for `eventType`, this is a no-op (events
 *   without a schema yet are not failed — see module docstring).
 * - If a schema is registered and the payload does not satisfy it, throws an
 *   `EventSchemaValidationError`.
 *
 * Callers decide whether/when to invoke this (e.g. only in non-production —
 * see `EventBus.publish`); this function itself always validates when called.
 */
export function validateEventPayload(eventType: string, payload: unknown): void {
  const map = loadValidators();
  const validate = map.get(eventType);
  if (!validate) return; // unschematized event type — not an error.

  const valid = validate(payload);
  if (!valid) {
    const errors = ajv.errorsText(validate.errors, { separator: "; " });
    throw new EventSchemaValidationError(eventType, errors);
  }
}
