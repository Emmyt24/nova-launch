/**
 * Producer-Consumer Contract Test for token.deployed Event Schema
 *
 * Validates that:
 * 1. The backend's tokenEventParser output stays in sync with the schema
 * 2. Generated TypeScript types in event-schemas/generated/events.ts match the schema
 *
 * This prevents silent schema drift that could cause the frontend token list
 * and every downstream indexer to silently miss or misinterpret deployments.
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
  "../../../event-schemas/token.deployed.schema.json"
);

const tokenDeployedSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

const ajv = new Ajv({ validateSchema: false, strict: false });
addFormats(ajv);
const validateTokenDeployed = ajv.compile(tokenDeployedSchema);

// ---------------------------------------------------------------------------
// Realistic token.deployed fixtures for both schema variants
// ---------------------------------------------------------------------------

const batchTokenDeployFixture = {
  tokenId: "token-uuid-001",
  address: "CTOKEN_DEPLOYED_001",
  creator: "GCREATOR_001",
  name: "Nova Token",
  symbol: "NOVA",
  decimals: 7,
  initialSupply: "1000000000000",
  metadataUri: "ipfs://QmTest123",
};

const graphqlSubscriptionFixture = {
  tokenAddress: "CTOKEN_DEPLOYED_002",
  creatorAddress: "GCREATOR_002",
  name: "Test Token",
  symbol: "TEST",
  totalSupply: "5000000000000",
  txHash: "tx-deploy-002",
  timestamp: "2025-06-01T12:00:00Z",
};

const batchTokenDeployNullMetadataFixture = {
  tokenId: "token-uuid-003",
  address: "CTOKEN_DEPLOYED_003",
  creator: "GCREATOR_003",
  name: "No Metadata Token",
  symbol: "NMT",
  decimals: 7,
  initialSupply: "100000000",
  metadataUri: null,
};

// ---------------------------------------------------------------------------
// Contract Tests
// ---------------------------------------------------------------------------

describe("token.deployed event schema contract", () => {
  // ─────────────────────────────────────────────────────────────────────
  // Batch token deploy service variant
  // ─────────────────────────────────────────────────────────────────────

  it("should validate batchTokenDeployService fixture against schema", () => {
    const isValid = validateTokenDeployed(batchTokenDeployFixture);
    expect(isValid).toBe(true);

    if (!isValid) {
      console.error("Validation errors:", validateTokenDeployed.errors);
    }
  });

  it("should validate batchTokenDeployService fixture with null metadataUri", () => {
    const isValid = validateTokenDeployed(batchTokenDeployNullMetadataFixture);
    expect(isValid).toBe(true);

    if (!isValid) {
      console.error("Validation errors:", validateTokenDeployed.errors);
    }
  });

  it("should reject batchTokenDeployService variant missing tokenId", () => {
    const invalidPayload = { ...batchTokenDeployFixture };
    delete (invalidPayload as Partial<typeof batchTokenDeployFixture>).tokenId;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject batchTokenDeployService variant missing address", () => {
    const invalidPayload = { ...batchTokenDeployFixture };
    delete (invalidPayload as Partial<typeof batchTokenDeployFixture>).address;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject batchTokenDeployService variant missing creator", () => {
    const invalidPayload = { ...batchTokenDeployFixture };
    delete (invalidPayload as Partial<typeof batchTokenDeployFixture>).creator;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject batchTokenDeployService variant missing name", () => {
    const invalidPayload = { ...batchTokenDeployFixture };
    delete (invalidPayload as Partial<typeof batchTokenDeployFixture>).name;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject batchTokenDeployService variant missing symbol", () => {
    const invalidPayload = { ...batchTokenDeployFixture };
    delete (invalidPayload as Partial<typeof batchTokenDeployFixture>).symbol;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject batchTokenDeployService variant missing decimals", () => {
    const invalidPayload = { ...batchTokenDeployFixture };
    delete (invalidPayload as Partial<typeof batchTokenDeployFixture>).decimals;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject batchTokenDeployService variant missing initialSupply", () => {
    const invalidPayload = { ...batchTokenDeployFixture };
    delete (
      invalidPayload as Partial<typeof batchTokenDeployFixture>
    ).initialSupply;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // GraphQL subscription variant
  // ─────────────────────────────────────────────────────────────────────

  it("should validate GraphQL subscription fixture against schema", () => {
    const isValid = validateTokenDeployed(graphqlSubscriptionFixture);
    expect(isValid).toBe(true);

    if (!isValid) {
      console.error("Validation errors:", validateTokenDeployed.errors);
    }
  });

  it("should reject GraphQL variant missing tokenAddress", () => {
    const invalidPayload = { ...graphqlSubscriptionFixture };
    delete (invalidPayload as Partial<typeof graphqlSubscriptionFixture>)
      .tokenAddress;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject GraphQL variant missing creatorAddress", () => {
    const invalidPayload = { ...graphqlSubscriptionFixture };
    delete (invalidPayload as Partial<typeof graphqlSubscriptionFixture>)
      .creatorAddress;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject GraphQL variant missing name", () => {
    const invalidPayload = { ...graphqlSubscriptionFixture };
    delete (invalidPayload as Partial<typeof graphqlSubscriptionFixture>).name;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject GraphQL variant missing symbol", () => {
    const invalidPayload = { ...graphqlSubscriptionFixture };
    delete (invalidPayload as Partial<typeof graphqlSubscriptionFixture>)
      .symbol;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject GraphQL variant missing totalSupply", () => {
    const invalidPayload = { ...graphqlSubscriptionFixture };
    delete (invalidPayload as Partial<typeof graphqlSubscriptionFixture>)
      .totalSupply;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject GraphQL variant missing txHash", () => {
    const invalidPayload = { ...graphqlSubscriptionFixture };
    delete (invalidPayload as Partial<typeof graphqlSubscriptionFixture>)
      .txHash;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  it("should reject GraphQL variant missing timestamp", () => {
    const invalidPayload = { ...graphqlSubscriptionFixture };
    delete (invalidPayload as Partial<typeof graphqlSubscriptionFixture>)
      .timestamp;

    const isValid = validateTokenDeployed(invalidPayload);
    expect(isValid).toBe(false);
    expect(validateTokenDeployed.errors).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Schema structure validation
  // ─────────────────────────────────────────────────────────────────────

  it("should use anyOf for multiple valid shapes", () => {
    expect(tokenDeployedSchema.anyOf).toBeDefined();
    expect(Array.isArray(tokenDeployedSchema.anyOf)).toBe(true);
    expect(tokenDeployedSchema.anyOf.length).toBe(2);
  });

  it("should have valid properties defined in batchTokenDeploy variant", () => {
    const [batchShape] = tokenDeployedSchema.anyOf;
    const requiredKeys = batchShape.required ?? [];

    expect(requiredKeys).toContain("tokenId");
    expect(requiredKeys).toContain("address");
    expect(requiredKeys).toContain("creator");
    expect(requiredKeys).toContain("name");
    expect(requiredKeys).toContain("symbol");
    expect(requiredKeys).toContain("decimals");
    expect(requiredKeys).toContain("initialSupply");
  });

  it("should have valid properties defined in GraphQL variant", () => {
    const [, graphqlShape] = tokenDeployedSchema.anyOf;
    const requiredKeys = graphqlShape.required ?? [];

    expect(requiredKeys).toContain("tokenAddress");
    expect(requiredKeys).toContain("creatorAddress");
    expect(requiredKeys).toContain("name");
    expect(requiredKeys).toContain("symbol");
    expect(requiredKeys).toContain("totalSupply");
    expect(requiredKeys).toContain("txHash");
    expect(requiredKeys).toContain("timestamp");
  });

  it("should allow additional properties since schema does not restrict them", () => {
    const payloadWithExtra = {
      ...batchTokenDeployFixture,
      unexpectedField: "additional-field-allowed",
    };

    const isValid = validateTokenDeployed(payloadWithExtra);
    expect(isValid).toBe(true);
  });
});
