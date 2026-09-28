import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { StellarService } from "./stellar.service";
import {
  StellarContractException,
  StellarInvalidAddressException,
  StellarNotFoundException,
} from "./stellar.exceptions";

// ---------------------------------------------------------------------------
// Mock @stellar/stellar-sdk
// ---------------------------------------------------------------------------
const mockSimulateSuccess = jest.fn();
const mockGetEvents = jest.fn();
const mockGetAccount = jest.fn();
const mockTransactionCall = jest.fn();

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");

  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({
            call: mockTransactionCall,
          }),
        }),
      })),
    },
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulateSuccess,
        getEvents: mockGetEvents,
        getAccount: mockGetAccount,
      })),
      Api: actual.rpc?.Api ?? {
        isSimulationError: jest.fn().mockReturnValue(false),
        SimulateTransactionSuccessResponse: {},
        EventResponse: {},
      },
    },
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn().mockReturnValue({}),
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
    Keypair: {
      random: jest.fn().mockReturnValue({
        publicKey: jest
          .fn()
          .mockReturnValue(
            "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
          ),
      }),
    },
    Networks: {
      TESTNET: "Test SDF Network ; September 2015",
      PUBLIC: "Public Global Stellar Network ; September 2015",
    },
    BASE_FEE: "100",
    scValToNative: jest.fn((val) => val?._value ?? val),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const VALID_G_ADDRESS =
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const VALID_C_ADDRESS =
  "CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const FACTORY_CONTRACT = VALID_C_ADDRESS;
const TX_HASH =
  "abc123def456abc123def456abc123def456abc123def456abc123def456abcd";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("StellarService", () => {
  let service: StellarService;

  const configValues: Record<string, any> = {
    STELLAR_NETWORK: "testnet",
    STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    STELLAR_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    STELLAR_FACTORY_CONTRACT_ID: FACTORY_CONTRACT,
    STELLAR_REQUEST_TIMEOUT: 30000,
    STELLAR_RETRY_MAX_ATTEMPTS: 1, // disable retries in unit tests
    STELLAR_RETRY_INITIAL_DELAY: 0,
    STELLAR_RETRY_MAX_DELAY: 0,
    STELLAR_RETRY_BACKOFF_FACTOR: 1,
    STELLAR_RATE_LIMIT_MAX: 100,
    STELLAR_RATE_LIMIT_WINDOW_MS: 60000,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) =>
              key in configValues ? configValues[key] : defaultValue
            ),
          },
        },
      ],
    }).compile();

    service = module.get<StellarService>(StellarService);
    service.onModuleInit();

    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // validateAddress
  // -------------------------------------------------------------------------
  describe("validateAddress", () => {
    it("returns true for a valid G address", () => {
      expect(service.validateAddress(VALID_G_ADDRESS)).toBe(true);
    });

    it("returns true for a valid C address", () => {
      expect(service.validateAddress(VALID_C_ADDRESS)).toBe(true);
    });

    it("returns false for an invalid address", () => {
      expect(service.validateAddress("not-valid")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getTokenInfo
  // -------------------------------------------------------------------------
  describe("getTokenInfo", () => {
    beforeEach(() => {
      const StellarSdk = require("@stellar/stellar-sdk");
      StellarSdk.rpc.Api.isSimulationError = jest.fn().mockReturnValue(false);
      StellarSdk.scValToNative = jest
        .fn()
        .mockReturnValueOnce("TestToken")
        .mockReturnValueOnce("TT")
        .mockReturnValueOnce(7)
        .mockReturnValueOnce("1000000000")
        .mockReturnValueOnce(VALID_G_ADDRESS);

      mockGetAccount.mockResolvedValue({});
      mockSimulateSuccess.mockResolvedValue({
        result: { retval: "mock" },
      });
    });

    it("throws StellarInvalidAddressException for invalid address", async () => {
      await expect(service.getTokenInfo("bad")).rejects.toThrow(
        StellarInvalidAddressException
      );
    });

    it("returns token info for valid address", async () => {
      const info = await service.getTokenInfo(VALID_C_ADDRESS);
      expect(info.address).toBe(VALID_C_ADDRESS);
      expect(info).toHaveProperty("name");
      expect(info).toHaveProperty("symbol");
      expect(info).toHaveProperty("decimals");
    });

    it("throws StellarContractException when contract call fails", async () => {
      mockSimulateSuccess.mockRejectedValue(new Error("RPC error"));
      await expect(service.getTokenInfo(VALID_C_ADDRESS)).rejects.toThrow(
        StellarContractException
      );
    });
  });

  // -------------------------------------------------------------------------
  // getBurnHistory
  // -------------------------------------------------------------------------
  describe("getBurnHistory", () => {
    it("throws for invalid address", async () => {
      await expect(service.getBurnHistory("bad-addr")).rejects.toThrow(
        StellarInvalidAddressException
      );
    });

    it("returns parsed burn events", async () => {
      const StellarSdk = require("@stellar/stellar-sdk");
      StellarSdk.scValToNative = jest
        .fn()
        .mockImplementation((v) => (v === "topic" ? "burn" : v));

      mockGetEvents.mockResolvedValue({
        events: [
          {
            contractId: VALID_C_ADDRESS,
            topic: ["topic"],
            value: "value",
            ledger: 100,
            txHash: TX_HASH,
            ledgerClosedAt: new Date().toISOString(),
          },
        ],
      });

      const history = await service.getBurnHistory(VALID_C_ADDRESS);
      expect(Array.isArray(history)).toBe(true);
    });

    it("throws StellarContractException on RPC error", async () => {
      mockGetEvents.mockRejectedValue(new Error("RPC error"));
      await expect(service.getBurnHistory(VALID_C_ADDRESS)).rejects.toThrow(
        StellarContractException
      );
    });
  });

  // -------------------------------------------------------------------------
  // getFactoryState
  // -------------------------------------------------------------------------
  describe("getFactoryState", () => {
    it("throws when factory contract ID is not configured", async () => {
      // Override config to return no factory contract ID
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StellarService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockReturnValue(undefined),
            },
          },
        ],
      }).compile();
      const svc = module.get<StellarService>(StellarService);
      svc.onModuleInit();
      await expect(svc.getFactoryState()).rejects.toThrow(
        StellarContractException
      );
    });

    it("returns factory state on success", async () => {
      const StellarSdk = require("@stellar/stellar-sdk");
      StellarSdk.rpc.Api.isSimulationError = jest.fn().mockReturnValue(false);
      StellarSdk.scValToNative = jest
        .fn()
        .mockReturnValueOnce(VALID_G_ADDRESS) // admin
        .mockReturnValueOnce(2) // totalTokens
        .mockReturnValueOnce([VALID_C_ADDRESS]) // tokens
        .mockReturnValueOnce(false); // isPaused

      mockGetAccount.mockResolvedValue({});
      mockSimulateSuccess.mockResolvedValue({ result: { retval: "mock" } });

      const state = await service.getFactoryState();
      expect(state.contractId).toBe(FACTORY_CONTRACT);
    });
  });

  // -------------------------------------------------------------------------
  // parseContractEvent
  // -------------------------------------------------------------------------
  describe("parseContractEvent", () => {
    it("parses a valid event", () => {
      const StellarSdk = require("@stellar/stellar-sdk");
      StellarSdk.scValToNative = jest
        .fn()
        .mockReturnValueOnce("transfer") // topic[0] = type
        .mockReturnValueOnce(VALID_G_ADDRESS) // topic[1]
        .mockReturnValueOnce("1000"); // data

      const rawEvent = {
        contractId: VALID_C_ADDRESS,
        topic: ["t1", "t2"],
        value: "v",
        ledger: 200,
        txHash: TX_HASH,
        ledgerClosedAt: new Date().toISOString(),
      } as any;

      const parsed = service.parseContractEvent(rawEvent);
      expect(parsed.contractId).toBe(VALID_C_ADDRESS);
      expect(parsed.ledger).toBe(200);
      expect(parsed.txHash).toBe(TX_HASH);
    });

    it("throws StellarParseException on malformed event", () => {
      const StellarSdk = require("@stellar/stellar-sdk");
      StellarSdk.scValToNative = jest.fn().mockImplementation(() => {
        throw new Error("bad xdr");
      });

      expect(() => service.parseContractEvent({} as any)).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getTransaction
  // -------------------------------------------------------------------------
  describe("getTransaction", () => {
    it("returns transaction details on success", async () => {
      mockTransactionCall.mockResolvedValue({
        hash: TX_HASH,
        ledger_attr: 1000,
        created_at: "2024-01-01T00:00:00Z",
        source_account: VALID_G_ADDRESS,
        fee_charged: "100",
        successful: true,
        memo: undefined,
        operation_count: 1,
        envelope_xdr: "env_xdr",
        result_xdr: "res_xdr",
        result_meta_xdr: "meta_xdr",
      });

      const tx = await service.getTransaction(TX_HASH);
      expect(tx.hash).toBe(TX_HASH);
      expect(tx.status).toBe("success");
    });

    it("throws StellarNotFoundException for 404", async () => {
      mockTransactionCall.mockRejectedValue({ response: { status: 404 } });
      await expect(service.getTransaction(TX_HASH)).rejects.toThrow(
        StellarNotFoundException
      );
    });

    it("throws StellarNetworkException for other errors", async () => {
      const { StellarNetworkException: Ex } = require("./stellar.exceptions");
      mockTransactionCall.mockRejectedValue(new Error("network error"));
      await expect(service.getTransaction(TX_HASH)).rejects.toThrow();
    });

    it("throws for missing txHash", async () => {
      await expect(service.getTransaction("")).rejects.toThrow(
        StellarNotFoundException
      );
    });
  });

  // -------------------------------------------------------------------------
  // monitorTransaction
  // -------------------------------------------------------------------------
  describe("monitorTransaction", () => {
    it("returns success when transaction is found immediately", async () => {
      mockTransactionCall.mockResolvedValue({
        hash: TX_HASH,
        ledger_attr: 1000,
        created_at: "2024-01-01T00:00:00Z",
        successful: true,
        result_xdr: "",
      });

      const result = await service.monitorTransaction(TX_HASH, 3, 0);
      expect(result.status).toBe("success");
      expect(result.hash).toBe(TX_HASH);
    });

    it("returns not_found after max attempts", async () => {
      mockTransactionCall.mockRejectedValue({ response: { status: 404 } });

      const result = await service.monitorTransaction(TX_HASH, 2, 0);
      expect(result.status).toBe("not_found");
      expect(result.attempts).toBe(2);
    });

    it("returns failed when transaction is unsuccessful", async () => {
      mockTransactionCall.mockResolvedValue({
        hash: TX_HASH,
        ledger_attr: 999,
        created_at: "2024-01-01T00:00:00Z",
        successful: false,
        result_xdr: "AAAABf////8AAAAA",
      });

      const result = await service.monitorTransaction(TX_HASH, 3, 0);
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBeDefined();
    });

    it("retries on transient errors and eventually returns pending", async () => {
      mockTransactionCall.mockRejectedValue(new Error("transient"));

      const result = await service.monitorTransaction(TX_HASH, 2, 0);
      expect(result.status).toBe("pending");
    });
  });

  // -------------------------------------------------------------------------
  // getAccountWithSequence (#1718)
  // -------------------------------------------------------------------------
  describe("getAccountWithSequence", () => {
    it("throws StellarInvalidAddressException for an invalid address", async () => {
      const { StellarInvalidAddressException: Ex } = require("./stellar.exceptions");
      await expect(service.getAccountWithSequence("bad-address")).rejects.toThrow(Ex);
    });

    it("returns the account from Horizon on success", async () => {
      const StellarSdk = require("@stellar/stellar-sdk");

      // Rebuild the Horizon mock to expose loadAccount on the instance
      const mockLoadAccount = jest.fn().mockResolvedValue({
        accountId: () => VALID_G_ADDRESS,
        sequenceNumber: () => "1234",
        incrementSequenceNumber: jest.fn(),
      });

      StellarSdk.Horizon.Server.mockImplementation(() => ({
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({
            call: mockTransactionCall,
          }),
        }),
        loadAccount: mockLoadAccount,
        submitTransaction: jest.fn(),
      }));

      // Re-init so the new mock is wired up
      service.onModuleInit();

      const account = await service.getAccountWithSequence(VALID_G_ADDRESS);
      expect(mockLoadAccount).toHaveBeenCalledWith(VALID_G_ADDRESS);
      expect(account).toBeDefined();
    });

    it("propagates errors thrown by Horizon.loadAccount", async () => {
      const StellarSdk = require("@stellar/stellar-sdk");

      StellarSdk.Horizon.Server.mockImplementation(() => ({
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({ call: mockTransactionCall }),
        }),
        loadAccount: jest.fn().mockRejectedValue(new Error("Horizon unavailable")),
        submitTransaction: jest.fn(),
      }));

      service.onModuleInit();

      await expect(
        service.getAccountWithSequence(VALID_G_ADDRESS)
      ).rejects.toThrow("Horizon unavailable");
    });
  });

  // -------------------------------------------------------------------------
  // executeTransaction (#1718)
  // -------------------------------------------------------------------------
  describe("executeTransaction", () => {
    it("throws StellarInvalidAddressException for an invalid account", async () => {
      const { StellarInvalidAddressException: Ex } = require("./stellar.exceptions");
      await expect(
        service.executeTransaction("bad-address", async (acc) => acc as any)
      ).rejects.toThrow(Ex);
    });

    it("returns hash and result on a successful submission", async () => {
      const StellarSdk = require("@stellar/stellar-sdk");

      const fakeTransaction = { sign: jest.fn() };
      const buildTransaction = jest.fn().mockResolvedValue(fakeTransaction);
      const mockSubmitTransaction = jest.fn().mockResolvedValue({
        hash: TX_HASH,
        successful: true,
      });
      const mockLoadAccount = jest.fn().mockResolvedValue({
        accountId: () => VALID_G_ADDRESS,
        sequenceNumber: () => "5678",
        incrementSequenceNumber: jest.fn(),
      });

      StellarSdk.Horizon.Server.mockImplementation(() => ({
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({ call: mockTransactionCall }),
        }),
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
      }));

      service.onModuleInit();

      const result = await service.executeTransaction(VALID_G_ADDRESS, buildTransaction);

      expect(buildTransaction).toHaveBeenCalled();
      expect(mockSubmitTransaction).toHaveBeenCalledWith(fakeTransaction);
      expect(result.hash).toBe(TX_HASH);
    });

    it("propagates errors thrown during transaction build", async () => {
      const StellarSdk = require("@stellar/stellar-sdk");

      StellarSdk.Horizon.Server.mockImplementation(() => ({
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({ call: mockTransactionCall }),
        }),
        loadAccount: jest.fn().mockResolvedValue({
          accountId: () => VALID_G_ADDRESS,
          sequenceNumber: () => "9999",
          incrementSequenceNumber: jest.fn(),
        }),
        submitTransaction: jest.fn(),
      }));

      service.onModuleInit();

      await expect(
        service.executeTransaction(VALID_G_ADDRESS, async () => {
          throw new Error("build failed");
        })
      ).rejects.toThrow("build failed");
    });

    it("propagates errors thrown by Horizon.submitTransaction", async () => {
      const StellarSdk = require("@stellar/stellar-sdk");

      StellarSdk.Horizon.Server.mockImplementation(() => ({
        transactions: jest.fn().mockReturnValue({
          transaction: jest.fn().mockReturnValue({ call: mockTransactionCall }),
        }),
        loadAccount: jest.fn().mockResolvedValue({
          accountId: () => VALID_G_ADDRESS,
          sequenceNumber: () => "9999",
          incrementSequenceNumber: jest.fn(),
        }),
        submitTransaction: jest.fn().mockRejectedValue(new Error("submission failed")),
      }));

      service.onModuleInit();

      await expect(
        service.executeTransaction(VALID_G_ADDRESS, async (acc) => ({}) as any)
      ).rejects.toThrow("submission failed");
    });
  });
});
