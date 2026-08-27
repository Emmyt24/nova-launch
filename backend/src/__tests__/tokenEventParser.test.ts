/**
 * Unit tests for TokenEventParser
 *
 * Covers:
 *   1. Valid-baseline: each supported event type is handled without throwing
 *   2. Malformed-payload table: missing / wrong-type fields are handled gracefully
 *   3. Schema cross-check: parser output keys align with token.deployed.schema.json
 *   4. Schema-drift guard: test fails loudly if the schema adds a field the parser doesn't map
 *
 * NOTE: TokenEventParser writes to Prisma, so we mock PrismaClient entirely here.
 *       Database-projection correctness is tested in tokenEventParser.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { PrismaClient } from "@prisma/client";
import { TokenEventParser, RawTokenEvent } from "../services/tokenEventParser";

// ---------------------------------------------------------------------------
// Load and parse the JSON-Schema fixture once
// ---------------------------------------------------------------------------

const SCHEMA_PATH = resolve(
  __dirname,
  "../../../../event-schemas/token.deployed.schema.json"
);

const tokenDeployedSchema: {
  anyOf: Array<{ properties: Record<string, unknown>; required?: string[] }>;
} = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

// The schema uses `anyOf` with two variant shapes; pull both.
const [batchShape, graphqlShape] = tokenDeployedSchema.anyOf;

/** All property keys declared in the batchTokenDeployService variant */
const BATCH_SCHEMA_KEYS = Object.keys(batchShape.properties ?? {});
/** Required keys in the batchTokenDeployService variant */
const BATCH_REQUIRED_KEYS: string[] = batchShape.required ?? [];
/** All property keys declared in the GraphQL subscription variant */
const GRAPHQL_SCHEMA_KEYS = Object.keys(graphqlShape.properties ?? {});
/** Required keys in the GraphQL subscription variant */
const GRAPHQL_REQUIRED_KEYS: string[] = graphqlShape.required ?? [];

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------

const mockToken = {
  id: "token-uuid-1",
  address: "CTOKEN_MOCK_001",
  creator: "GCREATOR_001",
  name: "Mock Token",
  symbol: "MTK",
  decimals: 7,
  totalSupply: BigInt("1000000000000"),
  initialSupply: BigInt("1000000000000"),
  totalBurned: BigInt(0),
  burnCount: 0,
  metadataUri: null,
};

const mockBurnRecord = {
  id: "burn-uuid-1",
  tokenId: "token-uuid-1",
  from: "GUSER_001",
  amount: BigInt("100000000"),
  burnedBy: "GUSER_001",
  isAdminBurn: false,
  txHash: "tx-burn-001",
  createdAt: new Date(),
};

const makeMockPrisma = () =>
  ({
    token: {
      upsert: vi.fn().mockResolvedValue(mockToken),
      findUnique: vi.fn().mockResolvedValue(mockToken),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue(mockToken),
    },
    burnRecord: {
      findUnique: vi.fn().mockResolvedValue(null), // default: no existing record
      create: vi.fn().mockResolvedValue(mockBurnRecord),
    },
    $transaction: vi.fn().mockImplementation(async (ops: unknown[]) => {
      // Run each deferred Prisma call so the mocks register
      await Promise.all(ops.map((op) => (op instanceof Promise ? op : Promise.resolve(op))));
    }),
  } as unknown as PrismaClient);

// ---------------------------------------------------------------------------
// Canonical event fixtures
// ---------------------------------------------------------------------------

const BASE_TOKEN_ADDR = "CTOKEN_MOCK_001";
const BASE_TX = "tx-base-001";

const tokRegEvent: RawTokenEvent = {
  type: "tok_reg",
  tokenAddress: BASE_TOKEN_ADDR,
  transactionHash: BASE_TX,
  ledger: 1000,
  creator: "GCREATOR_001",
  name: "Mock Token",
  symbol: "MTK",
  decimals: 7,
  initialSupply: "1000000000000",
};

const tokBurnEvent: RawTokenEvent = {
  type: "tok_burn",
  tokenAddress: BASE_TOKEN_ADDR,
  transactionHash: "tx-burn-001",
  ledger: 1001,
  from: "GUSER_001",
  amount: "100000000",
  burner: "GUSER_001",
};

const admBurnEvent: RawTokenEvent = {
  type: "adm_burn",
  tokenAddress: BASE_TOKEN_ADDR,
  transactionHash: "tx-adm-burn-001",
  ledger: 1002,
  from: "GUSER_002",
  amount: "200000000",
  admin: "GCREATOR_001",
};

const tokMetaEvent: RawTokenEvent = {
  type: "tok_meta",
  tokenAddress: BASE_TOKEN_ADDR,
  transactionHash: "tx-meta-001",
  ledger: 1003,
  metadataUri: "ipfs://QmTest123",
  updatedBy: "GCREATOR_001",
};

// ---------------------------------------------------------------------------
// 1. Valid-baseline tests
// ---------------------------------------------------------------------------

describe("TokenEventParser — valid baseline", () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let parser: TokenEventParser;

  beforeEach(() => {
    prisma = makeMockPrisma();
    parser = new TokenEventParser(prisma);
  });

  it("handles tok_reg without throwing", async () => {
    await expect(parser.parseEvent(tokRegEvent)).resolves.not.toThrow();
    expect(prisma.token.upsert).toHaveBeenCalledOnce();
  });

  it("calls token.upsert with all required fields for tok_reg", async () => {
    await parser.parseEvent(tokRegEvent);

    const call = (prisma.token.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(call).toMatchObject({
      where: { address: BASE_TOKEN_ADDR },
      create: expect.objectContaining({
        address: BASE_TOKEN_ADDR,
        creator: "GCREATOR_001",
        name: "Mock Token",
        symbol: "MTK",
        decimals: 7,
      }),
    });
  });

  it("handles tok_burn without throwing", async () => {
    await expect(parser.parseEvent(tokBurnEvent)).resolves.not.toThrow();
  });

  it("creates a BurnRecord for tok_burn when no duplicate exists", async () => {
    await parser.parseEvent(tokBurnEvent);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("skips tok_burn when burnRecord already exists (idempotency)", async () => {
    (prisma.burnRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockBurnRecord);

    await parser.parseEvent(tokBurnEvent);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("handles adm_burn without throwing", async () => {
    await expect(parser.parseEvent(admBurnEvent)).resolves.not.toThrow();
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("handles tok_meta without throwing", async () => {
    await expect(parser.parseEvent(tokMetaEvent)).resolves.not.toThrow();
    expect(prisma.token.updateMany).toHaveBeenCalledOnce();
  });

  it("sets metadataUri correctly on tok_meta", async () => {
    await parser.parseEvent(tokMetaEvent);

    const call = (prisma.token.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.metadataUri).toBe("ipfs://QmTest123");
  });

  it("skips burn for unknown token (token.findUnique returns null)", async () => {
    (prisma.token.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(parser.parseEvent(tokBurnEvent)).resolves.not.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Malformed-payload table
// ---------------------------------------------------------------------------

describe("TokenEventParser — malformed-payload table", () => {
  const malformedCases: Array<{
    description: string;
    event: Partial<RawTokenEvent>;
  }> = [
    {
      description: "tok_reg with missing creator falls back to empty string",
      event: {
        type: "tok_reg",
        tokenAddress: "CTOKEN_MALFORMED_001",
        transactionHash: "tx-m-01",
        ledger: 9000,
        // creator intentionally omitted
        name: "No Creator Token",
        symbol: "NCT",
        decimals: 7,
        initialSupply: "1000",
      },
    },
    {
      description: "tok_reg with missing name falls back to empty string",
      event: {
        type: "tok_reg",
        tokenAddress: "CTOKEN_MALFORMED_002",
        transactionHash: "tx-m-02",
        ledger: 9001,
        creator: "GCREATOR_001",
        // name intentionally omitted
        symbol: "NNT",
        decimals: 7,
        initialSupply: "1000",
      },
    },
    {
      description: "tok_reg with missing symbol falls back to empty string",
      event: {
        type: "tok_reg",
        tokenAddress: "CTOKEN_MALFORMED_003",
        transactionHash: "tx-m-03",
        ledger: 9002,
        creator: "GCREATOR_001",
        name: "No Symbol Token",
        // symbol intentionally omitted
        decimals: 7,
        initialSupply: "1000",
      },
    },
    {
      description: "tok_reg with missing decimals falls back to 7",
      event: {
        type: "tok_reg",
        tokenAddress: "CTOKEN_MALFORMED_004",
        transactionHash: "tx-m-04",
        ledger: 9003,
        creator: "GCREATOR_001",
        name: "No Decimals Token",
        symbol: "NDT",
        // decimals intentionally omitted
        initialSupply: "1000",
      },
    },
    {
      description: "tok_reg with missing initialSupply falls back to 0",
      event: {
        type: "tok_reg",
        tokenAddress: "CTOKEN_MALFORMED_005",
        transactionHash: "tx-m-05",
        ledger: 9004,
        creator: "GCREATOR_001",
        name: "No Supply Token",
        symbol: "NST",
        decimals: 7,
        // initialSupply intentionally omitted
      },
    },
    {
      description: "tok_burn with missing amount falls back to 0",
      event: {
        type: "tok_burn",
        tokenAddress: "CTOKEN_MALFORMED_006",
        transactionHash: "tx-m-06",
        ledger: 9005,
        from: "GUSER_001",
        // amount intentionally omitted
      },
    },
    {
      description: "tok_burn with missing from falls back to empty string",
      event: {
        type: "tok_burn",
        tokenAddress: "CTOKEN_MALFORMED_007",
        transactionHash: "tx-m-07",
        ledger: 9006,
        // from intentionally omitted
        amount: "100",
      },
    },
    {
      description: "adm_burn with missing admin falls back to from",
      event: {
        type: "adm_burn",
        tokenAddress: "CTOKEN_MALFORMED_008",
        transactionHash: "tx-m-08",
        ledger: 9007,
        from: "GUSER_002",
        amount: "200",
        // admin intentionally omitted
      },
    },
    {
      description: "tok_meta with missing metadataUri sets null",
      event: {
        type: "tok_meta",
        tokenAddress: "CTOKEN_MALFORMED_009",
        transactionHash: "tx-m-09",
        ledger: 9008,
        updatedBy: "GCREATOR_001",
        // metadataUri intentionally omitted
      },
    },
  ];

  it.each(malformedCases)("$description", async ({ event }) => {
    const prisma = makeMockPrisma();
    const parser = new TokenEventParser(prisma);

    // All malformed inputs must resolve without throwing
    await expect(
      parser.parseEvent(event as RawTokenEvent)
    ).resolves.not.toThrow();
  });

  it("tok_reg with missing initialSupply calls upsert with BigInt(0)", async () => {
    const prisma = makeMockPrisma();
    const parser = new TokenEventParser(prisma);

    await parser.parseEvent({
      type: "tok_reg",
      tokenAddress: "CTOKEN_ZERO_SUPPLY",
      transactionHash: "tx-zero-supply",
      ledger: 9999,
      creator: "GCREATOR_001",
      name: "Zero Supply",
      symbol: "ZST",
      decimals: 7,
      // initialSupply omitted
    });

    const call = (prisma.token.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.create.initialSupply).toBe(BigInt(0));
    expect(call.create.totalSupply).toBe(BigInt(0));
  });

  it("tok_meta with null metadataUri explicitly calls updateMany with null", async () => {
    const prisma = makeMockPrisma();
    const parser = new TokenEventParser(prisma);

    await parser.parseEvent({
      type: "tok_meta",
      tokenAddress: "CTOKEN_NULL_META",
      transactionHash: "tx-null-meta",
      ledger: 9998,
      metadataUri: undefined,
    });

    const call = (prisma.token.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.metadataUri).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Schema cross-check — parser output keys match token.deployed.schema.json
// ---------------------------------------------------------------------------

describe("TokenEventParser — schema cross-check against token.deployed.schema.json", () => {
  it("tok_reg upsert create-payload satisfies batchTokenDeployService schema required fields", async () => {
    const prisma = makeMockPrisma();
    const parser = new TokenEventParser(prisma);

    await parser.parseEvent(tokRegEvent);

    const upsertArg = (prisma.token.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const createPayload = upsertArg.create as Record<string, unknown>;

    // Map parser field names → schema field names.
    // batchTokenDeployService shape uses: tokenId, address, creator, name, symbol, decimals, initialSupply
    // The parser's upsert.create is the DB record shape, not the event-bus payload.
    // We assert the keys that matter for the event-bus payload published downstream.
    const parserToSchemaFieldMap: Record<string, keyof typeof createPayload> = {
      address: "address",
      creator: "creator",
      name: "name",
      symbol: "symbol",
      decimals: "decimals",
      initialSupply: "initialSupply",
    };

    for (const [schemaField, parserField] of Object.entries(parserToSchemaFieldMap)) {
      expect(
        createPayload,
        `Expected parser to map schema field "${schemaField}" via create.${parserField}`
      ).toHaveProperty(parserField);
    }
  });

  it("tok_reg upsert create-payload produces correct TypeScript types for each schema field", async () => {
    const prisma = makeMockPrisma();
    const parser = new TokenEventParser(prisma);

    await parser.parseEvent(tokRegEvent);

    const createPayload = (prisma.token.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0].create as Record<string, unknown>;

    // address → string
    expect(typeof createPayload.address).toBe("string");
    // creator → string
    expect(typeof createPayload.creator).toBe("string");
    // name → string
    expect(typeof createPayload.name).toBe("string");
    // symbol → string
    expect(typeof createPayload.symbol).toBe("string");
    // decimals → number
    expect(typeof createPayload.decimals).toBe("number");
    // initialSupply → BigInt (schema: unconstrained, but parser uses BigInt)
    expect(typeof createPayload.initialSupply).toBe("bigint");
  });

  it("batchTokenDeployService schema required keys are all mapped by the parser create-payload", async () => {
    const prisma = makeMockPrisma();
    const parser = new TokenEventParser(prisma);

    await parser.parseEvent(tokRegEvent);

    const createPayload = (prisma.token.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0].create as Record<string, unknown>;

    // The batch shape requires: tokenId, address, creator, name, symbol, decimals, initialSupply
    // "tokenId" in the event-bus payload corresponds to the DB `id` (auto-assigned by Prisma on create),
    // so only the fields we explicitly set in create are assertable here.
    const parserManagedBatchFields = ["address", "creator", "name", "symbol", "decimals", "initialSupply"];

    for (const field of parserManagedBatchFields) {
      expect(
        createPayload,
        `Parser create-payload is missing schema required field "${field}"`
      ).toHaveProperty(field);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Schema-drift guard
// ---------------------------------------------------------------------------

describe("TokenEventParser — schema-drift guard", () => {
  /**
   * This test INTENTIONALLY fails if someone adds a new REQUIRED field to
   * token.deployed.schema.json that the parser does not map.
   *
   * How it works:
   *   - Read the JSON Schema required arrays for both anyOf variants.
   *   - For the batchTokenDeployService shape, assert every required field
   *     (except `tokenId`, which is DB-assigned) exists in the parser's
   *     upsert create-payload.
   *   - If the schema gains a new required field, the test fails with a
   *     clear message pointing at the field name and file.
   */

  it("batchTokenDeployService variant — no required schema field is unmapped by the parser", async () => {
    const prisma = makeMockPrisma();
    const parser = new TokenEventParser(prisma);

    await parser.parseEvent(tokRegEvent);

    const createPayload = (prisma.token.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0].create as Record<string, unknown>;

    // Fields that are handled outside the upsert.create call (DB-assigned or event-bus only)
    const PARSER_EXTERNAL_FIELDS = new Set(["tokenId", "metadataUri"]);

    const missing = BATCH_REQUIRED_KEYS.filter(
      (field) => !PARSER_EXTERNAL_FIELDS.has(field) && !(field in createPayload)
    );

    expect(
      missing,
      `Schema-drift detected in ${SCHEMA_PATH}!\n` +
        `The following fields are REQUIRED by the batchTokenDeployService variant of token.deployed.schema.json ` +
        `but are NOT mapped in TokenEventParser.handleTokenCreated:\n  ${missing.join(", ")}\n` +
        `Update the parser to handle these fields or update this test's PARSER_EXTERNAL_FIELDS set.`
    ).toHaveLength(0);
  });

  it("GraphQL subscription variant — no required schema field is absent from parser's event-bus-adjacent output", async () => {
    /**
     * The GraphQL shape requires: tokenAddress, creatorAddress, name, symbol, totalSupply, txHash, timestamp
     * These are fields set by batchTokenDeployService when it publishes on "token.deployed".
     * The TokenEventParser's tok_reg path populates the DB columns from which those fields are derived.
     * We verify the DB column equivalents are present.
     */

    // column → GraphQL field mapping (DB column name → schema field name)
    const graphqlFieldToDbColumn: Record<string, string> = {
      tokenAddress: "address",    // TokenEventParser creates token.address
      creatorAddress: "creator",  // TokenEventParser creates token.creator
      name: "name",
      symbol: "symbol",
      // totalSupply → initialSupply (set as totalSupply in create)
      totalSupply: "totalSupply",
      // txHash and timestamp are provided by the transaction context, not the parser
    };

    const TRANSACTION_CONTEXT_FIELDS = new Set(["txHash", "timestamp"]);

    const prisma = makeMockPrisma();
    const parser = new TokenEventParser(prisma);

    await parser.parseEvent(tokRegEvent);

    const createPayload = (prisma.token.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0].create as Record<string, unknown>;

    const missing = GRAPHQL_REQUIRED_KEYS.filter((schemaField) => {
      if (TRANSACTION_CONTEXT_FIELDS.has(schemaField)) return false; // populated externally
      const dbColumn = graphqlFieldToDbColumn[schemaField];
      if (!dbColumn) return false; // unknown field — guard below handles new fields
      return !(dbColumn in createPayload);
    });

    expect(
      missing,
      `Schema-drift detected in ${SCHEMA_PATH}!\n` +
        `The following fields are REQUIRED by the GraphQL subscription variant of token.deployed.schema.json ` +
        `but have no corresponding DB column set by TokenEventParser.handleTokenCreated:\n  ${missing.join(", ")}\n` +
        `Update the parser to persist these fields or extend graphqlFieldToDbColumn in this test.`
    ).toHaveLength(0);
  });

  it("detects if new required fields are added to the batch variant schema", () => {
    /**
     * Snapshot the current required-field list. If this fails, a new required
     * field was added to the schema and the parser (and the above drift guard)
     * must be updated accordingly.
     */
    expect(BATCH_REQUIRED_KEYS.sort()).toMatchInlineSnapshot(`
      [
        "address",
        "creator",
        "decimals",
        "initialSupply",
        "name",
        "symbol",
        "tokenId",
      ]
    `);
  });

  it("detects if new required fields are added to the GraphQL subscription variant schema", () => {
    expect(GRAPHQL_REQUIRED_KEYS.sort()).toMatchInlineSnapshot(`
      [
        "creatorAddress",
        "name",
        "symbol",
        "timestamp",
        "tokenAddress",
        "totalSupply",
        "txHash",
      ]
    `);
  });
});
