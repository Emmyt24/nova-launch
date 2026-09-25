/**
 * Tests for contract address validation against the active Soroban network.
 *
 * Verifies that validateContractOnNetwork correctly detects existing contracts,
 * rejects missing contracts, and retries on transient RPC failures.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nock from "nock";
import {
  validateContractOnNetwork,
  ContractAddressError,
} from "../lib/contractAddressValidator";
import { RetryConfig } from "../stellar-service-integration/rate-limiter";

const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
const SOROBAN_HOST = "https://soroban-testnet.stellar.org";
const NETWORK = "testnet";

// A valid 56-char Soroban contract ID (generated with proper CRC16 checksum)
// This is a contract ID for a 32-byte hash of all zeros
const VALID_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXGI";

// Fast retry config for tests
const FAST_RETRY: RetryConfig = {
  maxAttempts: 2,
  initialDelay: 10,
  maxDelay: 50,
  backoffFactor: 2,
  jitterFactor: 0,
};

beforeEach(() => {
  nock.cleanAll();
});

afterEach(() => {
  nock.cleanAll();
});

describe("validateContractOnNetwork", () => {
  describe("valid contract — exists on network", () => {
    it("resolves when the Soroban RPC returns a non-empty entries array", async () => {
      nock(SOROBAN_HOST)
        .post("/")
        .reply(200, {
          jsonrpc: "2.0",
          id: 1,
          result: { entries: [{ xdr: "AAAA" }] },
        });

      await expect(
        validateContractOnNetwork(
          VALID_CONTRACT_ID,
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).resolves.toBeUndefined();
    });
  });

  describe("missing contract — not on network", () => {
    it("throws ContractAddressError when entries is an empty array", async () => {
      nock(SOROBAN_HOST)
        .post("/")
        .reply(200, {
          jsonrpc: "2.0",
          id: 1,
          result: { entries: [] },
        });

      await expect(
        validateContractOnNetwork(
          VALID_CONTRACT_ID,
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).rejects.toThrow(ContractAddressError);
    });

    it("error message names the contract ID and network", async () => {
      nock(SOROBAN_HOST)
        .post("/")
        .reply(200, { jsonrpc: "2.0", id: 1, result: { entries: [] } });

      await expect(
        validateContractOnNetwork(
          VALID_CONTRACT_ID,
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).rejects.toThrow(VALID_CONTRACT_ID);
    });

    it("error message names the network for operator diagnosis", async () => {
      nock(SOROBAN_HOST)
        .post("/")
        .reply(200, { jsonrpc: "2.0", id: 1, result: { entries: [] } });

      await expect(
        validateContractOnNetwork(
          VALID_CONTRACT_ID,
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).rejects.toThrow(`STELLAR_NETWORK="${NETWORK}"`);
    });

    it("throws ContractAddressError when result has no entries field", async () => {
      nock(SOROBAN_HOST)
        .post("/")
        .reply(200, { jsonrpc: "2.0", id: 1, result: {} });

      await expect(
        validateContractOnNetwork(
          VALID_CONTRACT_ID,
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).rejects.toThrow(ContractAddressError);
    });
  });

  describe("malformed contract ID", () => {
    it("throws ContractAddressError for a contract ID not starting with C", async () => {
      await expect(
        validateContractOnNetwork(
          "G" + "A".repeat(55),
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).rejects.toThrow(ContractAddressError);
    });

    it("throws ContractAddressError for a short contract ID", async () => {
      await expect(
        validateContractOnNetwork("CSHORT", SOROBAN_RPC_URL, NETWORK, FAST_RETRY)
      ).rejects.toThrow(ContractAddressError);
    });

    it("does not make any RPC call for a malformed contract ID", async () => {
      const scope = nock(SOROBAN_HOST).post("/").reply(200, {});

      await expect(
        validateContractOnNetwork("INVALID", SOROBAN_RPC_URL, NETWORK, FAST_RETRY)
      ).rejects.toThrow(ContractAddressError);

      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });

    it("throws ContractAddressError when CRC16 checksum is invalid", async () => {
      // Create a contract ID with one character flipped
      // VALID_CONTRACT_ID is "C" + "A".repeat(55)
      // Flip one character from A to B to create invalid checksum
      const invalidCrcContractId =
        "C" + "A".repeat(54) + "B"; // Last char changed from A to B

      await expect(
        validateContractOnNetwork(
          invalidCrcContractId,
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).rejects.toThrow(ContractAddressError);

      // Verify the error mentions checksum
      await expect(
        validateContractOnNetwork(
          invalidCrcContractId,
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).rejects.toThrow(/checksum|CRC/i);
    });

    it("does not make an RPC call when CRC16 checksum is invalid", async () => {
      const scope = nock(SOROBAN_HOST).post("/").reply(200, {});
      const invalidCrcContractId =
        "C" + "A".repeat(54) + "B";

      await expect(
        validateContractOnNetwork(
          invalidCrcContractId,
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).rejects.toThrow(ContractAddressError);

      expect(scope.isDone()).toBe(false);
      nock.cleanAll();
    });
  });

  describe("transient RPC failures — retry behaviour", () => {
    it("succeeds on a second attempt after a transient 500 error", async () => {
      nock(SOROBAN_HOST).post("/").replyWithError({ code: "ETIMEDOUT" });
      nock(SOROBAN_HOST)
        .post("/")
        .reply(200, {
          jsonrpc: "2.0",
          id: 1,
          result: { entries: [{ xdr: "BBBB" }] },
        });

      await expect(
        validateContractOnNetwork(
          VALID_CONTRACT_ID,
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).resolves.toBeUndefined();
    });

    it("throws ContractAddressError after exhausting all retry attempts", async () => {
      nock(SOROBAN_HOST).post("/").replyWithError({ code: "ECONNRESET" });
      nock(SOROBAN_HOST).post("/").replyWithError({ code: "ECONNRESET" });

      await expect(
        validateContractOnNetwork(
          VALID_CONTRACT_ID,
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).rejects.toThrow(ContractAddressError);
    });

    it("does not retry non-retryable 4xx RPC errors", async () => {
      nock(SOROBAN_HOST).post("/").reply(403, { error: "Forbidden" });
      // Second intercept — should NOT be reached
      const secondScope = nock(SOROBAN_HOST).post("/").reply(200, {
        result: { entries: [{ xdr: "CCCC" }] },
      });

      await expect(
        validateContractOnNetwork(
          VALID_CONTRACT_ID,
          SOROBAN_RPC_URL,
          NETWORK,
          FAST_RETRY
        )
      ).rejects.toThrow(ContractAddressError);

      expect(secondScope.isDone()).toBe(false);
      nock.cleanAll();
    });
  });

  describe("sends correct JSON-RPC request", () => {
    it("calls getLedgerEntries with a base64-encoded key", async () => {
      let capturedBody: any;
      nock(SOROBAN_HOST)
        .post("/", (body) => {
          capturedBody = body;
          return true;
        })
        .reply(200, {
          jsonrpc: "2.0",
          id: 1,
          result: { entries: [{ xdr: "DDDD" }] },
        });

      await validateContractOnNetwork(
        VALID_CONTRACT_ID,
        SOROBAN_RPC_URL,
        NETWORK,
        FAST_RETRY
      );

      expect(capturedBody.method).toBe("getLedgerEntries");
      expect(capturedBody.params.keys).toHaveLength(1);
      expect(typeof capturedBody.params.keys[0]).toBe("string");
      // The key must be a non-empty base64 string
      expect(capturedBody.params.keys[0].length).toBeGreaterThan(0);
    });
  });
});
