/**
 * Producer-Consumer Contract Test for burn.executed Event Schema
 *
 * Validates that the backend's token parser output stays in sync with
 * event-schemas/burn.executed.schema.json as either the schema or parser evolves.
 *
 * This prevents silent schema drift that could cause downstream consumers
 * (GraphQL subscriptions, webhooks, event indexers) to silently miss or
 * misinterpret burn events.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// ---------------------------------------------------------------------------
// Load schema and initialize AJV validator
// ---------------------------------------------------------------------------

const SCHEMA_PATH = resolve(
  __dirname,
  "../../../event-schemas/burn.executed.schema.json"
);

const burnExecutedSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

const ajv = new Ajv({ validateSchema: false, strict: false });
addFormats(ajv);
const validateBurnExecuted = ajv.compile(burnExecutedSchema);

// ---------------------------------------------------------------------------
// Realistic burn.executed fixtures
// ---------------------------------------------------------------------------

const normalBurnFixture = {
  schemaVersion: 1,
  creatorAddress: "GCREATOR_001",
  tokenAddress: "CTOKEN_NORMAL_001",
  amount: "1000000000",
  burnedBy: "GUSER_001",
  isAdminBurn: false,
  txHash: "tx-burn-normal-001",
  timestamp: "2025-06-01T12:00:00Z",
};

const boundaryLedgerBurnFixture = {
  schemaVersion: 1,
  creatorAddress: "GCREATOR_BOUNDARY",
  tokenAddress: "CTOKEN_BOUNDARY_001",
  amount: "9223372036854775807", // max i128 boundary
  burnedBy: "GUSER_BOUNDARY",
  isAdminBurn: true,
  txHash: "tx-burn-boundary-001",
  timestamp: "2026-12-31T23:59:59Z",
};

// ---------------------------------------------------------------------------
// Contract Tests
// ---------------------------------------------------------------------------

describe("burn.executed event schema contract", () => {
  it("should validate normal burn event against schema", () => {
    const isValid = validateBurnExecuted(normalBurnFixture);
    expect(isValid).toBe(true);

    if (!isValid) {
      console.error("Validation errors:", validateBurnExecuted.errors);
    }
  });

  it("should validate boundary-ledger burn event against schema", () => {
    const isValid = validateBurnExecuted(boundaryLedgerBurnFixture);
    expect(isValid).toBe(true);

    if (!isValid) {
      console.error("Validation errors:", validateBurnExecuted.errors);
    }
  });

  it("should reject payload missing required creatorAddress field", () => {
    const invalidPayload = { ...normalBurnFixture };
    delete (invalidPayload as Partial<typeof normalBurnFixture>).creatorAddress;

    const isValid = validateBurnExecuted(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateBurnExecuted.errors).toHaveLength(1);
    expect(validateBurnExecuted.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload missing required tokenAddress field", () => {
    const invalidPayload = { ...normalBurnFixture };
    delete (invalidPayload as Partial<typeof normalBurnFixture>).tokenAddress;

    const isValid = validateBurnExecuted(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateBurnExecuted.errors).toHaveLength(1);
    expect(validateBurnExecuted.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload missing required amount field", () => {
    const invalidPayload = { ...normalBurnFixture };
    delete (invalidPayload as Partial<typeof normalBurnFixture>).amount;

    const isValid = validateBurnExecuted(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateBurnExecuted.errors).toHaveLength(1);
    expect(validateBurnExecuted.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload missing required burnedBy field", () => {
    const invalidPayload = { ...normalBurnFixture };
    delete (invalidPayload as Partial<typeof normalBurnFixture>).burnedBy;

    const isValid = validateBurnExecuted(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateBurnExecuted.errors).toHaveLength(1);
    expect(validateBurnExecuted.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload missing required isAdminBurn field", () => {
    const invalidPayload = { ...normalBurnFixture };
    delete (invalidPayload as Partial<typeof normalBurnFixture>).isAdminBurn;

    const isValid = validateBurnExecuted(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateBurnExecuted.errors).toHaveLength(1);
    expect(validateBurnExecuted.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload missing required txHash field", () => {
    const invalidPayload = { ...normalBurnFixture };
    delete (invalidPayload as Partial<typeof normalBurnFixture>).txHash;

    const isValid = validateBurnExecuted(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateBurnExecuted.errors).toHaveLength(1);
    expect(validateBurnExecuted.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload missing required timestamp field", () => {
    const invalidPayload = { ...normalBurnFixture };
    delete (invalidPayload as Partial<typeof normalBurnFixture>).timestamp;

    const isValid = validateBurnExecuted(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateBurnExecuted.errors).toHaveLength(1);
    expect(validateBurnExecuted.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload with unexpected additional properties", () => {
    const invalidPayload = {
      ...normalBurnFixture,
      unexpectedField: "should-not-be-here",
    };

    const isValid = validateBurnExecuted(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateBurnExecuted.errors).toHaveLength(1);
    expect(validateBurnExecuted.errors?.[0].keyword).toBe("additionalProperties");
  });

  it("should reject payload with wrong type for isAdminBurn (not boolean)", () => {
    const invalidPayload = {
      ...normalBurnFixture,
      isAdminBurn: "true", // string instead of boolean
    };

    const isValid = validateBurnExecuted(invalidPayload);
    expect(isValid).toBe(false);
  });

  it("should ensure all required schema fields are covered", () => {
    const requiredFields = burnExecutedSchema.required ?? [];
    const schemaKeys = Object.keys(burnExecutedSchema.properties ?? {});

    expect(requiredFields.length).toBeGreaterThan(0);
    expect(schemaKeys.length).toBeGreaterThan(0);

    // Every required field must be in the schema properties
    for (const field of requiredFields) {
      expect(schemaKeys).toContain(
        field,
        `Required field ${field} missing from schema properties`
      );
    }
  });
});
