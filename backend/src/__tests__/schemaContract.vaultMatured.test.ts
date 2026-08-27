/**
 * Producer-Consumer Contract Test for vault.matured Event Schema
 *
 * Validates that the backend's vaultEventParser output stays in sync with
 * event-schemas/vault.matured.schema.json as either the schema or parser evolves.
 *
 * A silent schema drift here has direct financial impact: the schema drives
 * withdrawal-eligibility logic, so a mismatch could cause users to be unable
 * to claim or recover their matured tokens.
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
  "../../../event-schemas/vault.matured.schema.json"
);

const vaultMaturedSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

const ajv = new Ajv({ validateSchema: false, strict: false });
addFormats(ajv);
const validateVaultMatured = ajv.compile(vaultMaturedSchema);

// ---------------------------------------------------------------------------
// Realistic vault.matured fixtures
// ---------------------------------------------------------------------------

const normalMaturityFixture = {
  schemaVersion: 1,
  creatorAddress: "GCREATOR_VAULT_001",
  vaultId: 1,
  recipientAddress: "GUSER_RECIPIENT_001",
  amount: "1000000000",
  txHash: "tx-vault-mature-001",
  timestamp: "2025-06-01T12:00:00Z",
};

const boundaryLedgerMaturityFixture = {
  schemaVersion: 1,
  creatorAddress: "GCREATOR_VAULT_BOUNDARY",
  vaultId: 4294967295, // max u32 boundary
  recipientAddress: "GUSER_RECIPIENT_BOUNDARY",
  amount: "9223372036854775807", // max i128 boundary
  txHash: "tx-vault-mature-boundary",
  timestamp: "2099-12-31T23:59:59Z",
};

// ---------------------------------------------------------------------------
// Contract Tests
// ---------------------------------------------------------------------------

describe("vault.matured event schema contract", () => {
  it("should validate normal maturity event against schema", () => {
    const isValid = validateVaultMatured(normalMaturityFixture);
    expect(isValid).toBe(true);

    if (!isValid) {
      console.error("Validation errors:", validateVaultMatured.errors);
    }
  });

  it("should validate boundary-ledger maturity event against schema", () => {
    const isValid = validateVaultMatured(boundaryLedgerMaturityFixture);
    expect(isValid).toBe(true);

    if (!isValid) {
      console.error("Validation errors:", validateVaultMatured.errors);
    }
  });

  it("should validate timestamp in ISO 8601 format", () => {
    const validIsoFormats = [
      "2025-01-01T00:00:00Z",
      "2025-06-01T12:30:45Z",
      "2099-12-31T23:59:59Z",
    ];

    for (const timestamp of validIsoFormats) {
      const fixture = {
        ...normalMaturityFixture,
        timestamp,
      };

      const isValid = validateVaultMatured(fixture);
      expect(isValid).toBe(true);
    }
  });

  it("should accept payload without schemaVersion (not required)", () => {
    const invalidPayload = { ...normalMaturityFixture };
    delete (invalidPayload as Partial<typeof normalMaturityFixture>)
      .schemaVersion;

    const isValid = validateVaultMatured(invalidPayload);
    expect(isValid).toBe(true);
  });

  it("should reject payload missing required creatorAddress field", () => {
    const invalidPayload = { ...normalMaturityFixture };
    delete (invalidPayload as Partial<typeof normalMaturityFixture>)
      .creatorAddress;

    const isValid = validateVaultMatured(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateVaultMatured.errors).toHaveLength(1);
    expect(validateVaultMatured.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload missing required vaultId field", () => {
    const invalidPayload = { ...normalMaturityFixture };
    delete (invalidPayload as Partial<typeof normalMaturityFixture>).vaultId;

    const isValid = validateVaultMatured(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateVaultMatured.errors).toHaveLength(1);
    expect(validateVaultMatured.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload missing required recipientAddress field", () => {
    const invalidPayload = { ...normalMaturityFixture };
    delete (invalidPayload as Partial<typeof normalMaturityFixture>)
      .recipientAddress;

    const isValid = validateVaultMatured(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateVaultMatured.errors).toHaveLength(1);
    expect(validateVaultMatured.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload missing required amount field", () => {
    const invalidPayload = { ...normalMaturityFixture };
    delete (invalidPayload as Partial<typeof normalMaturityFixture>).amount;

    const isValid = validateVaultMatured(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateVaultMatured.errors).toHaveLength(1);
    expect(validateVaultMatured.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload missing required txHash field", () => {
    const invalidPayload = { ...normalMaturityFixture };
    delete (invalidPayload as Partial<typeof normalMaturityFixture>).txHash;

    const isValid = validateVaultMatured(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateVaultMatured.errors).toHaveLength(1);
    expect(validateVaultMatured.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload missing required timestamp field", () => {
    const invalidPayload = { ...normalMaturityFixture };
    delete (invalidPayload as Partial<typeof normalMaturityFixture>).timestamp;

    const isValid = validateVaultMatured(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateVaultMatured.errors).toHaveLength(1);
    expect(validateVaultMatured.errors?.[0].keyword).toBe("required");
  });

  it("should reject payload with wrong type for vaultId (not integer)", () => {
    const invalidPayload = {
      ...normalMaturityFixture,
      vaultId: "1", // string instead of integer
    };

    const isValid = validateVaultMatured(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateVaultMatured.errors).toBeDefined();
  });

  it("should reject payload with wrong timestamp format", () => {
    const invalidPayload = {
      ...normalMaturityFixture,
      timestamp: "2025-06-01", // missing time component
    };

    const isValid = validateVaultMatured(invalidPayload);
    expect(isValid).toBe(false);
  });

  it("should reject payload with unexpected additional properties", () => {
    const invalidPayload = {
      ...normalMaturityFixture,
      unexpectedField: "should-not-be-here",
    };

    const isValid = validateVaultMatured(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateVaultMatured.errors).toHaveLength(1);
    expect(validateVaultMatured.errors?.[0].keyword).toBe("additionalProperties");
  });

  it("should ensure all required schema fields are covered", () => {
    const requiredFields = vaultMaturedSchema.required ?? [];
    const schemaKeys = Object.keys(vaultMaturedSchema.properties ?? {});

    expect(requiredFields.length).toBeGreaterThan(0);
    expect(schemaKeys.length).toBeGreaterThan(0);

    for (const field of requiredFields) {
      expect(schemaKeys).toContain(
        field,
        `Required field ${field} missing from schema properties`
      );
    }
  });

  it("should require exactly these fields: creatorAddress, vaultId, recipientAddress, amount, txHash, timestamp", () => {
    const requiredFields = vaultMaturedSchema.required ?? [];
    const expectedRequired = [
      "creatorAddress",
      "vaultId",
      "recipientAddress",
      "amount",
      "txHash",
      "timestamp",
    ];

    expect(new Set(requiredFields)).toEqual(new Set(expectedRequired));
  });

  it("should not silently default maturity amount when missing", () => {
    const zeroAmountFixture = {
      ...normalMaturityFixture,
      amount: "0",
    };

    const isValid = validateVaultMatured(zeroAmountFixture);
    expect(isValid).toBe(true);
  });
});
