/**
 * Regression Guard: Schema-Topic Correspondence
 *
 * Validates that subscription topics defined in resolvers.ts have matching
 * schema files in event-schemas/. Detects silent drift between the two
 * independently-managed lists.
 *
 * Closes #1900
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { SUBSCRIPTION_TOPICS } from "../graphql/resolvers";

// ---------------------------------------------------------------------------
// Load Schema Files
// ---------------------------------------------------------------------------

const SCHEMA_DIR = resolve(__dirname, "../../event-schemas");
const schemaFiles = readdirSync(SCHEMA_DIR).filter(
  (f) => f.endsWith(".schema.json") && f !== "example.generic.schema.json"
);

// Map schema filenames to event types
// Format: "governance.proposal.voteCast.schema.json" → "governance.proposal.voteCast"
const schemasByEventType = new Map<string, string>();
schemaFiles.forEach((file) => {
  const eventType = file.replace(".schema.json", "");
  schemasByEventType.set(eventType, file);
});

// Load and index schemas by eventType field for validation
const schemasByEventTypeField = new Map<string, Record<string, unknown>>();
schemaFiles.forEach((file) => {
  const schemaPath = resolve(SCHEMA_DIR, file);
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  if (schema.eventType) {
    schemasByEventTypeField.set(schema.eventType, schema);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Schema-Topic Correspondence Regression Guard (#1900)", () => {
  it("should have schema files for every subscription topic", () => {
    const topicValues = Object.values(SUBSCRIPTION_TOPICS);

    for (const topic of topicValues) {
      const hasSchema = schemasByEventType.has(topic);
      expect(hasSchema).toBe(
        true,
        `Subscription topic "${topic}" has no corresponding schema file. ` +
          `Expected to find: event-schemas/${topic}.schema.json`
      );
    }
  });

  it("should match eventType in schema files with subscription topics", () => {
    const topicValues = Object.values(SUBSCRIPTION_TOPICS);

    for (const topic of topicValues) {
      const schema = schemasByEventTypeField.get(topic);
      expect(schema).toBeDefined(
        `Subscription topic "${topic}" has no schema with matching eventType`
      );

      if (schema) {
        expect(schema.eventType).toBe(
          topic,
          `Schema for topic "${topic}" has mismatched eventType: "${schema.eventType}"`
        );
      }
    }
  });

  it("should not have orphaned schema files without matching topics", () => {
    const topicValues = new Set(Object.values(SUBSCRIPTION_TOPICS));

    for (const [eventType] of schemasByEventTypeField) {
      const hasTopic = topicValues.has(eventType);
      expect(hasTopic).toBe(
        true,
        `Schema event type "${eventType}" has no corresponding subscription topic. ` +
          `Orphaned schemas should either map to a topic or be removed.`
      );
    }
  });

  it("should have schemaVersion defined in all subscription schemas", () => {
    const topicValues = Object.values(SUBSCRIPTION_TOPICS);

    for (const topic of topicValues) {
      const schema = schemasByEventTypeField.get(topic);
      expect(schema?.schemaVersion).toBeDefined(
        `Schema for topic "${topic}" is missing schemaVersion field`
      );
      expect(typeof schema?.schemaVersion).toBe(
        "number",
        `Schema for topic "${topic}" has non-numeric schemaVersion`
      );
    }
  });

  it("should have eventType defined in all schemas", () => {
    const topicValues = Object.values(SUBSCRIPTION_TOPICS);

    for (const topic of topicValues) {
      const schema = schemasByEventTypeField.get(topic);
      expect(schema?.eventType).toBeDefined(
        `Schema for topic "${topic}" is missing eventType field`
      );
      expect(schema?.eventType).toBe(
        topic,
        `Schema for topic "${topic}" has eventType: "${schema?.eventType}"`
      );
    }
  });
});
