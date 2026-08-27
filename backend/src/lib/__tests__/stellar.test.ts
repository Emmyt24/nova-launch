/**
 * Tests for lib/stellar operations (#1581)
 *
 * Covers:
 *  - Server initialization (Horizon and Soroban)
 *  - Account information fetching
 *  - Transaction submission
 *  - Network passphrase handling
 *  - Transaction builder creation
 *  - Address validation and existence checks
 *  - Balance retrieval
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as stellarLib from "../stellar/index";
import * as StellarSdk from "@stellar/stellar-sdk";

describe("Stellar SDK operations", () => {
  const testConfig: stellarLib.StellarNetworkConfig = {
    network: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    factoryContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  };

  const validPublicKey = "GBUQWP3BOUZX34LOCALCOMMUNITYBUSINESSEXCHANGE5G7GSTFSYYVD4";

  describe("server initialization", () => {
    it("creates Horizon server instance", () => {
      const horizon = stellarLib.getHorizonServer(testConfig);

      expect(horizon).toBeDefined();
      expect(horizon).toBeInstanceOf(StellarSdk.Horizon.Server);
    });

    it("creates Soroban RPC server instance", () => {
      const soroban = stellarLib.getSorobanServer(testConfig);

      expect(soroban).toBeDefined();
      expect(soroban).toBeInstanceOf(StellarSdk.rpc.Server);
    });

    it("uses default config when none provided", () => {
      const horizon = stellarLib.getHorizonServer();
      expect(horizon).toBeDefined();
    });
  });

  describe("network configuration", () => {
    it("returns correct testnet passphrase", () => {
      const testnetConfig: stellarLib.StellarNetworkConfig = {
        ...testConfig,
        network: "testnet",
      };

      const passphrase = stellarLib.getNetworkPassphrase(testnetConfig);

      expect(passphrase).toBe(StellarSdk.Networks.TESTNET_NETWORK_PASSPHRASE);
    });

    it("returns correct mainnet passphrase", () => {
      const mainnetConfig: stellarLib.StellarNetworkConfig = {
        ...testConfig,
        network: "mainnet",
      };

      const passphrase = stellarLib.getNetworkPassphrase(mainnetConfig);

      expect(passphrase).toBe(StellarSdk.Networks.PUBLIC_NETWORK_PASSPHRASE);
    });

    it("throws for unknown network", () => {
      const invalidConfig: any = {
        ...testConfig,
        network: "unknown",
      };

      expect(() => stellarLib.getNetworkPassphrase(invalidConfig)).toThrow(
        "Unknown network"
      );
    });
  });

  describe("transaction builder", () => {
    it("creates transaction builder with correct config", () => {
      const sourceAccount = new StellarSdk.Account(validPublicKey, "12345");

      const builder = stellarLib.createTransactionBuilder(
        sourceAccount,
        testConfig
      );

      expect(builder).toBeDefined();
      expect(builder).toBeInstanceOf(StellarSdk.TransactionBuilder);
    });

    it("sets correct network passphrase", () => {
      const sourceAccount = new StellarSdk.Account(validPublicKey, "12345");

      const builder = stellarLib.createTransactionBuilder(
        sourceAccount,
        testConfig
      );

      const tx = builder
        .addOperation(
          StellarSdk.Operation.payment({
            destination: validPublicKey,
            asset: StellarSdk.Asset.native(),
            amount: "1",
          })
        )
        .setTimeout(180)
        .build();

      expect(tx.networkPassphrase).toBe(
        StellarSdk.Networks.TESTNET_NETWORK_PASSPHRASE
      );
    });
  });

  describe("account operations", () => {
    it("validates public key format", async () => {
      const invalidKeys = ["invalid", "12345", "G" + "A".repeat(54), ""];

      for (const key of invalidKeys) {
        await expect(
          stellarLib.fetchAccountInfo(key, testConfig)
        ).rejects.toThrow("Invalid Stellar public key");
      }
    });

    it("fetches account info (mocked)", async () => {
      const mockResponse = {
        id: validPublicKey,
        account_id: validPublicKey,
        balances: [
          {
            balance: "100.5000000",
            asset_type: "native",
          },
        ],
        sequence: "123456789",
        subentry_count: 0,
        inflation_destination: undefined,
        home_domain: undefined,
        last_modified_ledger: 1000,
        last_modified_time: "2024-01-01T00:00:00Z",
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        signers: [
          {
            signer_key: validPublicKey,
            signer_type: "ed25519_public_key",
            weight: 1,
          },
        ],
        paging_token: "token",
      } as any;

      vi.spyOn(StellarSdk.Horizon.Server.prototype, "accounts").mockReturnValue({
        accountId: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue(mockResponse),
        }),
      } as any);

      const result = await stellarLib.fetchAccountInfo(validPublicKey, testConfig);

      expect(result.id).toBe(validPublicKey);
      expect(result.balances).toHaveLength(1);
    });
  });

  describe("transaction submission", () => {
    it("validates transaction XDR", async () => {
      await expect(
        stellarLib.submitTransaction("", testConfig)
      ).rejects.toThrow("Invalid transaction XDR");

      await expect(
        stellarLib.submitTransaction(null as any, testConfig)
      ).rejects.toThrow("Invalid transaction XDR");
    });

    it("submits transaction with valid XDR (mocked)", async () => {
      const sourceAccount = new StellarSdk.Account(validPublicKey, "1");
      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: validPublicKey,
            asset: StellarSdk.Asset.native(),
            amount: "1",
          })
        )
        .setTimeout(180)
        .build();

      const keypair = StellarSdk.Keypair.random();
      tx.sign(keypair);
      const txXdr = tx.toEnvelope().toXDR().toString("base64");

      const mockResponse = {
        hash: "abc123",
        status: "success",
        id: "id123",
        paging_token: "token",
      } as any;

      vi.spyOn(
        StellarSdk.Horizon.Server.prototype,
        "submitTransaction"
      ).mockResolvedValue(mockResponse);

      const result = await stellarLib.submitTransaction(txXdr, testConfig);

      expect(result).toBeDefined();
    });
  });

  describe("base fee operations", () => {
    it("gets current base fee (mocked)", async () => {
      const mockLedgerResponse = {
        records: [
          {
            sequence: "1000",
            base_fee_in_stroops: "100",
            max_tx_set_size: "1000",
          },
        ],
      } as any;

      const mockFeeStatsResponse = {
        last_ledger: "1000",
        last_ledger_base_fee: "100",
        ledger_capacity_usage: "0.5",
        fee_charged: { mode: "150" },
        max_fee: { mode: "200" },
      } as any;

      const mockLedgers = {
        limit: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            call: vi.fn().mockResolvedValue(mockLedgerResponse),
          }),
        }),
      };

      const mockFeeStats = {
        call: vi.fn().mockResolvedValue(mockFeeStatsResponse),
      };

      vi.spyOn(StellarSdk.Horizon.Server.prototype, "ledgers").mockReturnValue(
        mockLedgers as any
      );

      vi.spyOn(StellarSdk.Horizon.Server.prototype, "feeStats").mockReturnValue(
        mockFeeStats as any
      );

      const baseFee = await stellarLib.getCurrentBaseFee(testConfig);

      expect(baseFee).toBeGreaterThanOrEqual(StellarSdk.BASE_FEE);
    });

    it("returns default fee on error", async () => {
      vi.spyOn(StellarSdk.Horizon.Server.prototype, "ledgers").mockReturnValue({
        limit: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            call: vi.fn().mockRejectedValue(new Error("Network error")),
          }),
        }),
      } as any);

      const baseFee = await stellarLib.getCurrentBaseFee(testConfig);

      expect(baseFee).toBe(StellarSdk.BASE_FEE);
    });
  });

  describe("address operations", () => {
    it("checks if address exists", async () => {
      const mockResponse = {
        id: validPublicKey,
        account_id: validPublicKey,
        balances: [],
        sequence: "1",
      } as any;

      vi.spyOn(StellarSdk.Horizon.Server.prototype, "accounts").mockReturnValue({
        accountId: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue(mockResponse),
        }),
      } as any);

      const exists = await stellarLib.addressExists(validPublicKey, testConfig);

      expect(exists).toBe(true);
    });

    it("returns false for non-existent address", async () => {
      const notFoundError: any = new Error("Not found");
      notFoundError.status = 404;

      vi.spyOn(StellarSdk.Horizon.Server.prototype, "accounts").mockReturnValue({
        accountId: vi.fn().mockReturnValue({
          call: vi.fn().mockRejectedValue(notFoundError),
        }),
      } as any);

      const exists = await stellarLib.addressExists(validPublicKey, testConfig);

      expect(exists).toBe(false);
    });

    it("throws for other errors", async () => {
      const errorResponse: any = new Error("Server error");
      errorResponse.status = 500;

      vi.spyOn(StellarSdk.Horizon.Server.prototype, "accounts").mockReturnValue({
        accountId: vi.fn().mockReturnValue({
          call: vi.fn().mockRejectedValue(errorResponse),
        }),
      } as any);

      await expect(
        stellarLib.addressExists(validPublicKey, testConfig)
      ).rejects.toThrow("Server error");
    });
  });

  describe("balance operations", () => {
    it("retrieves account balances", async () => {
      const mockBalances = [
        {
          balance: "100.5000000",
          asset_type: "native",
        },
        {
          balance: "50.0000000",
          asset_type: "credit_alphanum4",
          asset_code: "TEST",
          asset_issuer: "GBUQWP3BOUZX34LOCALCOMMUNITYBUSINESSEXCHANGE5G7GSTFSYYVD4",
        },
      ] as any;

      const mockResponse = {
        id: validPublicKey,
        account_id: validPublicKey,
        balances: mockBalances,
        sequence: "1",
      } as any;

      vi.spyOn(StellarSdk.Horizon.Server.prototype, "accounts").mockReturnValue({
        accountId: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue(mockResponse),
        }),
      } as any);

      const balances = await stellarLib.getAccountBalances(
        validPublicKey,
        testConfig
      );

      expect(balances).toHaveLength(2);
      expect(balances[0].balance).toBe("100.5000000");
      expect(balances[1].asset_code).toBe("TEST");
    });
  });

  describe("error handling", () => {
    it("propagates network errors", async () => {
      const networkError = new Error("Network timeout");

      vi.spyOn(StellarSdk.Horizon.Server.prototype, "accounts").mockReturnValue({
        accountId: vi.fn().mockReturnValue({
          call: vi.fn().mockRejectedValue(networkError),
        }),
      } as any);

      await expect(
        stellarLib.fetchAccountInfo(validPublicKey, testConfig)
      ).rejects.toThrow("Network timeout");
    });
  });
});
