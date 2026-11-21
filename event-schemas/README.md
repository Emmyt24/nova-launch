# Event schemas

The files in this directory are producer-consumer contracts for events exchanged between the backend, event listeners, projections, and other consumers. Each production event schema is a JSON Schema document named `<event-type>.schema.json`. The schema identifies the event with `eventType`, carries an explicit integer `schemaVersion`, declares its `required` fields, and sets `additionalProperties` deliberately. Keep payload examples and documentation synthetic: never commit credentials, tokens, personal data, private keys, or production event dumps.

Generated TypeScript interfaces are committed at [`generated/events.ts`](generated/events.ts). Treat the JSON schemas as the source of truth; generated types must be regenerated and committed whenever a schema in the generated surface changes.

## Prerequisites

- Node.js 18+ and npm.
- Backend dependencies installed (`cd backend && npm install`).
- `tsx` available through the backend development dependencies.
- A clean, local checkout of the repository so the breaking-change check can compare modified schemas with `git HEAD`.

## Add or change a schema

1. Choose a stable event type and create `<event-type>.schema.json` in this directory. Copy [`example.generic.schema.json`](example.generic.schema.json) only as a starting point; it is not a substitute for a production contract.
2. Define `eventType`, `schemaVersion`, `properties`, `required`, and `additionalProperties` explicitly. Keep field names and JSON types aligned with the producer and consumer code.
3. Update the producer/parser and add a representative, synthetic payload to the backend event-schema contract coverage. Include positive validation and, for strict schemas, an unknown-field rejection case. See [`docs/EVENT_SCHEMA_CONTRACT_TESTS.md`](../docs/EVENT_SCHEMA_CONTRACT_TESTS.md).
4. Regenerate the committed TypeScript types from `backend/`:

   ```bash
   cd backend
   npm run generate:event-types
   ```

   Expected output includes a successful generation message and an updated `../event-schemas/generated/events.ts` when the schema is part of the generated surface. Review the generated diff and commit it with the schema change.

5. Review the version and compatibility rules below, then run the drift and breaking-change commands from the repository root.

## Compatibility and versioning

Additive, optional fields are generally backward-compatible. Removing an existing property, changing its JSON type, or adding a new required field can break consumers. For an additive revision, bump `schemaVersion` so consumers can distinguish the new payload shape. Do not silently repurpose an existing field; introduce a new field or publish a deliberately versioned contract with a migration plan. A new event type has no previous contract, but it still needs a complete schema and consumer coverage before publication.

The breaking-change check compares each schema that exists at `HEAD` with the working-tree version and reports removed properties, type changes, and incompatible required fields. For additive-only versioned event types, it also reports added properties without a version bump. A breaking change must be accompanied by a compatible migration; do not bypass the check by weakening the schema.

## Drift check

From the repository root, compare generated types with the schema source:

```bash
npx tsx scripts/check-event-schema-drift.ts
```

Expected successful output:

```text
Checking event schema codegen drift...
SUCCESS: Event schema types are fully in sync.
```

If the check reports that types are out of sync, run `cd backend && npm run generate:event-types`, inspect the generated file, and commit the resulting update. If it reports missing required versioned schemas, add the required schema before proceeding.

## Breaking-change check

Run the normal comparison against the last commit from the repository root:

```bash
npx tsx scripts/check-event-schema-breaking-changes.ts
```

Expected successful output:

```text
Checking event schemas for backward-compatibility breaking changes against git HEAD...
SUCCESS: No backward-compatibility breaking changes detected in modified event schemas.
```

The repository also includes a synthetic fixture for exercising the detector without production data:

```bash
npx tsx scripts/check-event-schema-breaking-changes.ts event-schemas/breaking-fixture.json
```

Expected output is a successful detection report containing one or more sanitized violation descriptions, for example:

```text
Running breaking change check with test fixture: event-schemas/breaking-fixture.json
SUCCESS: Test fixture successfully flagged breaking changes:
  - Property '...' was removed.
```

A failed normal check means the change needs a compatibility-preserving design, a schema-version/migration update, or both. Keep all fixtures and examples free of secrets and PII.
