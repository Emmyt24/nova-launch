/**
 * Tests for Vault Event Parser
 *
 * Covers:
 *   1. Valid-baseline: each vault event type parses correctly
 *   2. Malformed-payload table: bad/missing fields are handled gracefully
 *   3. Schema cross-check: VaultClaimedEvent output shape aligns with vault.matured.schema.json
 *   4. Schema-drift guard: fails loudly if the schema gains a required field the parser doesn't map
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  parseVaultCreatedEvent,
  parseVaultFundedEvent,
  parseVaultClaimedEvent,
  parseVaultCancelledEvent,
  parseVaultMetadataUpdatedEvent,
  parseVaultEvent,
  VAULT_EVENT_VERSIONS,
  VaultClaimedEvent,
} from "../services/vaultEventParser";
import {
  mockVaultEvents,
  expectedVaultParsedEvents,
} from "./fixtures/vaultEvents";

// ---------------------------------------------------------------------------
// Load and parse the JSON-Schema fixture once
// ---------------------------------------------------------------------------

const SCHEMA_PATH = resolve(
  __dirname,
  "../../../../event-schemas/vault.matured.schema.json"
);

const vaultMaturedSchema: {
  properties: Record<string, unknown>;
  required?: string[];
} = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

const SCHEMA_REQUIRED_KEYS: string[] = vaultMaturedSchema.required ?? [];
const SCHEMA_ALL_KEYS: string[] = Object.keys(vaultMaturedSchema.properties ?? {});

// ---------------------------------------------------------------------------
// Helper: build a mock Stellar-SDK event object
// ---------------------------------------------------------------------------

function createMockEvent(eventName: string, data: Record<string, unknown>) {
  return {
    topics: () => [
      {
        sym: () => ({
          toString: () => eventName,
        }),
      },
      {
        u32: () => data.streamId as number,
      },
    ],
    data: () => ({
      vec: () => {
        switch (eventName) {
          case VAULT_EVENT_VERSIONS.CREATED:
            return [
              createMockAddress(data.creator as string),
              createMockAddress(data.recipient as string),
              createMockI128(data.amount as string),
              createMockBool(data.hasMetadata as boolean),
            ];
          case VAULT_EVENT_VERSIONS.FUNDED:
            return [
              createMockAddress(data.funder as string),
              createMockI128(data.amount as string),
            ];
          case VAULT_EVENT_VERSIONS.CLAIMED:
            return [
              createMockAddress(data.recipient as string),
              createMockI128(data.amount as string),
            ];
          case VAULT_EVENT_VERSIONS.CANCELLED:
            return [
              createMockAddress(data.canceller as string),
              createMockI128(data.remainingAmount as string),
            ];
          case VAULT_EVENT_VERSIONS.METADATA_UPDATED:
            return [
              createMockAddress(data.updater as string),
              createMockBool(data.hasMetadata as boolean),
            ];
          default:
            return [];
        }
      },
    }),
  };
}

function createMockAddress(address: string) {
  return {
    address: () => ({
      toString: () => address,
    }),
  };
}

function createMockI128(amount: string) {
  const bigIntAmount = BigInt(amount);
  const hi = bigIntAmount / BigInt(2 ** 64);
  const lo = bigIntAmount % BigInt(2 ** 64);

  return {
    switch: () => ({ name: "scvI128" }),
    i128: () => ({
      hi: () => hi,
      lo: () => lo,
    }),
    toString: () => amount,
  };
}

function createMockBool(value: boolean) {
  return {
    b: () => value,
  };
}

// ---------------------------------------------------------------------------
// 1. Valid-baseline tests (original suite, preserved verbatim)
// ---------------------------------------------------------------------------

describe("Vault Event Parser", () => {
  describe("parseVaultCreatedEvent", () => {
    it("should parse vault created event correctly", () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CREATED,
        mockVaultEvents.created
      );

      const result = parseVaultCreatedEvent(
        mockEvent,
        mockVaultEvents.created.timestamp
      );

      expect(result).toEqual(expectedVaultParsedEvents.created);
    });

    it("should return null for invalid event name", () => {
      const mockEvent = createMockEvent(
        "invalid_event",
        mockVaultEvents.created
      );

      const result = parseVaultCreatedEvent(
        mockEvent,
        mockVaultEvents.created.timestamp
      );

      expect(result).toBeNull();
    });

    it("should handle parsing errors gracefully", () => {
      const invalidEvent = {
        topics: () => {
          throw new Error("Invalid topics");
        },
      };

      const result = parseVaultCreatedEvent(invalidEvent, 123456);

      expect(result).toBeNull();
    });
  });

  describe("parseVaultFundedEvent", () => {
    it("should parse vault funded event correctly", () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.FUNDED,
        mockVaultEvents.funded
      );

      const result = parseVaultFundedEvent(
        mockEvent,
        mockVaultEvents.funded.timestamp
      );

      expect(result).toEqual(expectedVaultParsedEvents.funded);
    });

    it("should return null for wrong event type", () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CREATED,
        mockVaultEvents.funded
      );

      const result = parseVaultFundedEvent(
        mockEvent,
        mockVaultEvents.funded.timestamp
      );

      expect(result).toBeNull();
    });
  });

  describe("parseVaultClaimedEvent", () => {
    it("should parse vault claimed event correctly", () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CLAIMED,
        mockVaultEvents.claimed
      );

      const result = parseVaultClaimedEvent(
        mockEvent,
        mockVaultEvents.claimed.timestamp
      );

      expect(result).toEqual(expectedVaultParsedEvents.claimed);
    });

    it("should handle large amounts correctly", () => {
      const largeAmountEvent = {
        ...mockVaultEvents.claimed,
        amount: "999999999999999999",
      };

      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CLAIMED,
        largeAmountEvent
      );

      const result = parseVaultClaimedEvent(
        mockEvent,
        largeAmountEvent.timestamp
      );

      expect(result?.amount).toBe("999999999999999999");
    });
  });

  describe("parseVaultCancelledEvent", () => {
    it("should parse vault cancelled event correctly", () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CANCELLED,
        mockVaultEvents.cancelled
      );

      const result = parseVaultCancelledEvent(
        mockEvent,
        mockVaultEvents.cancelled.timestamp
      );

      expect(result).toEqual(expectedVaultParsedEvents.cancelled);
    });

    it("should handle zero remaining amount", () => {
      const zeroAmountEvent = {
        ...mockVaultEvents.cancelled,
        remainingAmount: "0",
      };

      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CANCELLED,
        zeroAmountEvent
      );

      const result = parseVaultCancelledEvent(
        mockEvent,
        zeroAmountEvent.timestamp
      );

      expect(result?.remainingAmount).toBe("0");
    });
  });

  describe("parseVaultMetadataUpdatedEvent", () => {
    it("should parse vault metadata updated event correctly", () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.METADATA_UPDATED,
        mockVaultEvents.metadataUpdated
      );

      const result = parseVaultMetadataUpdatedEvent(
        mockEvent,
        mockVaultEvents.metadataUpdated.timestamp
      );

      expect(result).toEqual(expectedVaultParsedEvents.metadataUpdated);
    });

    it("should handle both true and false hasMetadata values", () => {
      const withMetadata = {
        ...mockVaultEvents.metadataUpdated,
        hasMetadata: true,
      };

      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.METADATA_UPDATED,
        withMetadata
      );

      const result = parseVaultMetadataUpdatedEvent(
        mockEvent,
        withMetadata.timestamp
      );

      expect(result?.hasMetadata).toBe(true);
    });
  });

  describe("parseVaultEvent", () => {
    it("should route to correct parser based on event name", () => {
      const testCases = [
        {
          version: VAULT_EVENT_VERSIONS.CREATED,
          data: mockVaultEvents.created,
          expected: expectedVaultParsedEvents.created,
        },
        {
          version: VAULT_EVENT_VERSIONS.FUNDED,
          data: mockVaultEvents.funded,
          expected: expectedVaultParsedEvents.funded,
        },
        {
          version: VAULT_EVENT_VERSIONS.CLAIMED,
          data: mockVaultEvents.claimed,
          expected: expectedVaultParsedEvents.claimed,
        },
        {
          version: VAULT_EVENT_VERSIONS.CANCELLED,
          data: mockVaultEvents.cancelled,
          expected: expectedVaultParsedEvents.cancelled,
        },
        {
          version: VAULT_EVENT_VERSIONS.METADATA_UPDATED,
          data: mockVaultEvents.metadataUpdated,
          expected: expectedVaultParsedEvents.metadataUpdated,
        },
      ];

      testCases.forEach(({ version, data, expected }) => {
        const mockEvent = createMockEvent(version, data);
        const result = parseVaultEvent(mockEvent, data.timestamp);
        expect(result).toEqual(expected);
      });
    });

    it("should return null for unknown event types", () => {
      const mockEvent = createMockEvent("unknown_event", mockVaultEvents.created);
      const result = parseVaultEvent(mockEvent, 123456);
      expect(result).toBeNull();
    });

    it("should handle malformed events gracefully", () => {
      const malformedEvent = {
        topics: () => {
          throw new Error("Malformed");
        },
      };

      const result = parseVaultEvent(malformedEvent, 123456);
      expect(result).toBeNull();
    });
  });

  describe("Schema Stability", () => {
    it("should maintain consistent event versions", () => {
      expect(VAULT_EVENT_VERSIONS.CREATED).toBe("vlt_cr_v1");
      expect(VAULT_EVENT_VERSIONS.FUNDED).toBe("vlt_fd_v1");
      expect(VAULT_EVENT_VERSIONS.CLAIMED).toBe("vlt_cl_v1");
      expect(VAULT_EVENT_VERSIONS.CANCELLED).toBe("vlt_cn_v1");
      expect(VAULT_EVENT_VERSIONS.METADATA_UPDATED).toBe("vlt_md_v1");
    });

    it("should parse events with consistent field names", () => {
      const mockEvent = createMockEvent(
        VAULT_EVENT_VERSIONS.CREATED,
        mockVaultEvents.created
      );

      const result = parseVaultCreatedEvent(
        mockEvent,
        mockVaultEvents.created.timestamp
      );

      // Verify all expected fields are present
      expect(result).toHaveProperty("version");
      expect(result).toHaveProperty("streamId");
      expect(result).toHaveProperty("creator");
      expect(result).toHaveProperty("recipient");
      expect(result).toHaveProperty("amount");
      expect(result).toHaveProperty("hasMetadata");
      expect(result).toHaveProperty("timestamp");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Malformed-payload table — vault event inputs
// ---------------------------------------------------------------------------

describe("Vault Event Parser — malformed-payload table", () => {
  /**
   * Each case exercises a degraded Stellar SDK object.
   * Parsers must return null and must NOT throw.
   */

  it.each([
    {
      description: "topics() throws — should return null gracefully",
      eventFactory: () => ({
        topics: () => {
          throw new Error("topics() exploded");
        },
        data: () => ({ vec: () => [] }),
      }),
      parserFn: (e: unknown) => parseVaultCreatedEvent(e, 0),
    },
    {
      description: "data() throws — should return null gracefully",
      eventFactory: () => ({
        topics: () => [
          { sym: () => ({ toString: () => VAULT_EVENT_VERSIONS.CREATED }) },
          { u32: () => 1 },
        ],
        data: () => {
          throw new Error("data() exploded");
        },
      }),
      parserFn: (e: unknown) => parseVaultCreatedEvent(e, 0),
    },
    {
      description: "topics array is empty — should return null gracefully",
      eventFactory: () => ({
        topics: () => [],
        data: () => ({ vec: () => [] }),
      }),
      parserFn: (e: unknown) => parseVaultClaimedEvent(e, 0),
    },
    {
      description: "data vec is empty — should return null gracefully",
      eventFactory: () => ({
        topics: () => [
          { sym: () => ({ toString: () => VAULT_EVENT_VERSIONS.CLAIMED }) },
          { u32: () => 99 },
        ],
        data: () => ({ vec: () => [] }),
      }),
      parserFn: (e: unknown) => parseVaultClaimedEvent(e, 0),
    },
    {
      description: "wrong event name for created — returns null without throwing",
      eventFactory: () =>
        createMockEvent("vlt_cr_WRONG", mockVaultEvents.created),
      parserFn: (e: unknown) => parseVaultCreatedEvent(e, mockVaultEvents.created.timestamp),
    },
    {
      description: "wrong event name for funded — returns null without throwing",
      eventFactory: () =>
        createMockEvent("vlt_fd_WRONG", mockVaultEvents.funded),
      parserFn: (e: unknown) => parseVaultFundedEvent(e, mockVaultEvents.funded.timestamp),
    },
    {
      description: "wrong event name for claimed — returns null without throwing",
      eventFactory: () =>
        createMockEvent("vlt_cl_WRONG", mockVaultEvents.claimed),
      parserFn: (e: unknown) => parseVaultClaimedEvent(e, mockVaultEvents.claimed.timestamp),
    },
    {
      description: "wrong event name for cancelled — returns null without throwing",
      eventFactory: () =>
        createMockEvent("vlt_cn_WRONG", mockVaultEvents.cancelled),
      parserFn: (e: unknown) => parseVaultCancelledEvent(e, mockVaultEvents.cancelled.timestamp),
    },
    {
      description: "wrong event name for metadata — returns null without throwing",
      eventFactory: () =>
        createMockEvent("vlt_md_WRONG", mockVaultEvents.metadataUpdated),
      parserFn: (e: unknown) =>
        parseVaultMetadataUpdatedEvent(e, mockVaultEvents.metadataUpdated.timestamp),
    },
    {
      description: "address() throws inside vec payload — returns null gracefully",
      eventFactory: () => ({
        topics: () => [
          { sym: () => ({ toString: () => VAULT_EVENT_VERSIONS.CLAIMED }) },
          { u32: () => 1 },
        ],
        data: () => ({
          vec: () => [
            {
              address: () => {
                throw new Error("bad address scval");
              },
            },
            createMockI128("0"),
          ],
        }),
      }),
      parserFn: (e: unknown) => parseVaultClaimedEvent(e, 0),
    },
    {
      description: "i128() throws inside vec payload — returns null gracefully",
      eventFactory: () => ({
        topics: () => [
          { sym: () => ({ toString: () => VAULT_EVENT_VERSIONS.CLAIMED }) },
          { u32: () => 1 },
        ],
        data: () => ({
          vec: () => [
            createMockAddress("GADDR123"),
            {
              switch: () => ({ name: "scvI128" }),
              i128: () => {
                throw new Error("bad i128 scval");
              },
            },
          ],
        }),
      }),
      parserFn: (e: unknown) => parseVaultClaimedEvent(e, 0),
    },
  ])("$description", ({ eventFactory, parserFn }) => {
    const event = eventFactory();
    let result: unknown;

    // Must not throw
    expect(() => {
      result = parserFn(event);
    }).not.toThrow();

    // Result must be null for all error paths
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Schema cross-check — VaultClaimedEvent output vs vault.matured.schema.json
// ---------------------------------------------------------------------------

describe("Vault Event Parser — schema cross-check against vault.matured.schema.json", () => {
  /**
   * vault.matured.schema.json describes the payload published when a vault reaches
   * maturity (VaultMaturedEvent).  The upstream publisher assembles this payload
   * from the VaultClaimedEvent produced by parseVaultClaimedEvent() plus
   * transaction-context fields (creatorAddress, txHash).
   *
   * We verify that every field the parser CAN supply is present and correctly
   * typed, and we document which fields are supplied by external context.
   */

  const TRANSACTION_CONTEXT_FIELDS = new Set(["creatorAddress", "txHash"]);

  // Mapping: vault.matured schema field → VaultClaimedEvent field
  const SCHEMA_TO_PARSER_FIELD: Record<string, keyof VaultClaimedEvent> = {
    vaultId: "streamId",        // streamId is surfaced as vaultId in the matured event
    recipientAddress: "recipient",
    amount: "amount",
    timestamp: "timestamp",
  };

  it("parseVaultClaimedEvent returns all fields required by vault.matured.schema.json (excluding context fields)", () => {
    const mockEvent = createMockEvent(
      VAULT_EVENT_VERSIONS.CLAIMED,
      mockVaultEvents.claimed
    );

    const result = parseVaultClaimedEvent(mockEvent, mockVaultEvents.claimed.timestamp);

    expect(result).not.toBeNull();

    for (const schemaField of SCHEMA_REQUIRED_KEYS) {
      if (TRANSACTION_CONTEXT_FIELDS.has(schemaField)) continue;

      const parserField = SCHEMA_TO_PARSER_FIELD[schemaField];
      expect(
        result,
        `Schema field "${schemaField}" maps to parser field "${parserField}" but it is missing from VaultClaimedEvent output`
      ).toHaveProperty(parserField!);
    }
  });

  it("VaultClaimedEvent.streamId can be mapped to vaultId (integer type)", () => {
    const mockEvent = createMockEvent(
      VAULT_EVENT_VERSIONS.CLAIMED,
      mockVaultEvents.claimed
    );

    const result = parseVaultClaimedEvent(mockEvent, mockVaultEvents.claimed.timestamp)!;

    expect(typeof result.streamId).toBe("number");
    // Schema specifies vaultId: integer
    expect(Number.isInteger(result.streamId)).toBe(true);
  });

  it("VaultClaimedEvent.recipient maps to recipientAddress (string type)", () => {
    const mockEvent = createMockEvent(
      VAULT_EVENT_VERSIONS.CLAIMED,
      mockVaultEvents.claimed
    );

    const result = parseVaultClaimedEvent(mockEvent, mockVaultEvents.claimed.timestamp)!;

    expect(typeof result.recipient).toBe("string");
    expect(result.recipient).toBe(mockVaultEvents.claimed.recipient);
  });

  it("VaultClaimedEvent.amount is a string (stringified bigint, schema: unconstrained)", () => {
    const mockEvent = createMockEvent(
      VAULT_EVENT_VERSIONS.CLAIMED,
      mockVaultEvents.claimed
    );

    const result = parseVaultClaimedEvent(mockEvent, mockVaultEvents.claimed.timestamp)!;

    expect(typeof result.amount).toBe("string");
    // Must be parseable as a non-negative integer
    expect(BigInt(result.amount)).toBeGreaterThanOrEqual(BigInt(0));
  });

  it("VaultClaimedEvent.timestamp is a number (unix epoch, maps to schema date-time after ISO conversion)", () => {
    const mockEvent = createMockEvent(
      VAULT_EVENT_VERSIONS.CLAIMED,
      mockVaultEvents.claimed
    );

    const result = parseVaultClaimedEvent(mockEvent, mockVaultEvents.claimed.timestamp)!;

    expect(typeof result.timestamp).toBe("number");
    expect(result.timestamp).toBe(mockVaultEvents.claimed.timestamp);
  });

  it("schemaVersion field is NOT produced by the parser (it is added by the publisher)", () => {
    const mockEvent = createMockEvent(
      VAULT_EVENT_VERSIONS.CLAIMED,
      mockVaultEvents.claimed
    );

    const result = parseVaultClaimedEvent(mockEvent, mockVaultEvents.claimed.timestamp)!;

    // The parser must NOT inject schemaVersion — that is the publisher's responsibility
    expect(result).not.toHaveProperty("schemaVersion");
  });
});

// ---------------------------------------------------------------------------
// 4. Schema-drift guard
// ---------------------------------------------------------------------------

describe("Vault Event Parser — schema-drift guard", () => {
  /**
   * This block INTENTIONALLY fails if vault.matured.schema.json gains a new
   * REQUIRED field that parseVaultClaimedEvent doesn't produce and that has
   * no documented external source.
   */

  it("snapshot of vault.matured.schema.json required fields — update parser if this fails", () => {
    /**
     * If this snapshot assertion fails, a new required field was added to the schema.
     * Steps to fix:
     *   1. Determine whether the field is produced by the parser or by the publisher.
     *   2. If by the parser → update parseVaultClaimedEvent (and this snapshot).
     *   3. If by the publisher → add it to TRANSACTION_CONTEXT_FIELDS in the cross-check above
     *      and update this snapshot.
     */
    expect(SCHEMA_REQUIRED_KEYS.sort()).toMatchInlineSnapshot(`
      [
        "amount",
        "creatorAddress",
        "recipientAddress",
        "timestamp",
        "txHash",
        "vaultId",
      ]
    `);
  });

  it("snapshot of vault.matured.schema.json all property keys — update parser if this fails", () => {
    expect(SCHEMA_ALL_KEYS.sort()).toMatchInlineSnapshot(`
      [
        "amount",
        "creatorAddress",
        "recipientAddress",
        "schemaVersion",
        "timestamp",
        "txHash",
        "vaultId",
      ]
    `);
  });

  it("every non-context required schema field has a documented mapping to parseVaultClaimedEvent output", () => {
    /**
     * This test fails if a required schema field is neither:
     *   - In the TRANSACTION_CONTEXT_FIELDS set (filled by the publisher), nor
     *   - In the SCHEMA_TO_PARSER_FIELD map (filled by the parser).
     *
     * Adding a required field to the schema without updating this file is
     * the definition of silent schema drift.
     */

    const TRANSACTION_CONTEXT_FIELDS = new Set(["creatorAddress", "txHash"]);
    const SCHEMA_TO_PARSER_FIELD: Record<string, string> = {
      vaultId: "streamId",
      recipientAddress: "recipient",
      amount: "amount",
      timestamp: "timestamp",
    };

    const unmapped = SCHEMA_REQUIRED_KEYS.filter(
      (field) =>
        !TRANSACTION_CONTEXT_FIELDS.has(field) &&
        !(field in SCHEMA_TO_PARSER_FIELD)
    );

    expect(
      unmapped,
      `Schema-drift detected in ${SCHEMA_PATH}!\n` +
        `The following REQUIRED fields in vault.matured.schema.json are not mapped:\n  ${unmapped.join(", ")}\n` +
        `Add them to SCHEMA_TO_PARSER_FIELD (parser-supplied) or TRANSACTION_CONTEXT_FIELDS (publisher-supplied) ` +
        `in this test, and update parseVaultClaimedEvent if they must come from the parser.`
    ).toHaveLength(0);
  });
});
