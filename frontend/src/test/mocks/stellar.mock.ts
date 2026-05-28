/**
 * Stellar Horizon RPC Mock Infrastructure
 *
 * Provides typed, composable mock factories for all Horizon/Soroban RPC
 * endpoints used by the platform. Mocks are parameterisable so tests can
 * construct realistic response shapes without hardcoding data inline.
 *
 * Covered endpoints:
 *  - Account (getAccount)
 *  - Transaction (getTransaction, sendTransaction)
 *  - Ledger (getLedger)
 *  - Simulation (simulateTransaction)
 *  - Contract state (getContractData)
 *
 * Usage:
 *  ```ts
 *  import { mockAccount, mockTransaction } from './stellar.mock';
 *
 *  vi.mock('@stellar/stellar-sdk', () => ({
 *    rpc: { Server: vi.fn().mockImplementation(() => ({
 *      getAccount: vi.fn().mockResolvedValue(mockAccount()),
 *      getTransaction: vi.fn().mockResolvedValue(mockTransaction()),
 *    })) },
 *  }));
 *  ```
 *
 * @see docs/stellar-horizon-mocking.md
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** A realistic Stellar public key (G-address). */
export const MOCK_PUBLIC_KEY =
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

/** A realistic Stellar transaction hash (64 hex chars). */
export const MOCK_TX_HASH =
  "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

/** A realistic Soroban contract ID (C-address). */
export const MOCK_CONTRACT_ID =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

// ---------------------------------------------------------------------------
// Account mock
// ---------------------------------------------------------------------------

export interface MockAccountOptions {
  publicKey?: string;
  sequence?: string;
  balances?: MockBalance[];
}

export interface MockBalance {
  asset_type: "native" | "credit_alphanum4" | "credit_alphanum12";
  balance: string;
  asset_code?: string;
  asset_issuer?: string;
}

/**
 * Build a mock Horizon account response.
 * Matches the shape returned by `server.getAccount(address)`.
 */
export function mockAccount(options: MockAccountOptions = {}): object {
  const {
    publicKey = MOCK_PUBLIC_KEY,
    sequence = "123456789",
    balances = [{ asset_type: "native", balance: "100.0000000" }],
  } = options;

  return {
    id: publicKey,
    account_id: publicKey,
    sequence,
    balances,
    // Minimal Account-like interface expected by TransactionBuilder
    accountId: () => publicKey,
    sequenceNumber: () => sequence,
    incrementSequenceNumber: () => {},
  };
}

// ---------------------------------------------------------------------------
// Transaction mock
// ---------------------------------------------------------------------------

export type MockTransactionStatus =
  | "SUCCESS"
  | "FAILED"
  | "NOT_FOUND"
  | "PENDING";

export interface MockTransactionOptions {
  hash?: string;
  status?: MockTransactionStatus;
  ledger?: number;
  createdAt?: string;
  fee?: string;
  returnValue?: unknown;
  errorResultXdr?: string;
}

/**
 * Build a mock Soroban `getTransaction` response.
 */
export function mockTransaction(
  options: MockTransactionOptions = {}
): object {
  const {
    hash = MOCK_TX_HASH,
    status = "SUCCESS",
    ledger = 50_000_000,
    createdAt = "2026-01-01T00:00:00Z",
    fee = "100",
    returnValue = null,
    errorResultXdr,
  } = options;

  return {
    hash,
    status,
    ledger,
    createdAt,
    fee,
    returnValue,
    ...(errorResultXdr ? { errorResultXdr } : {}),
  };
}

/**
 * Build a mock `sendTransaction` response.
 */
export interface MockSendTransactionOptions {
  hash?: string;
  status?: "PENDING" | "ERROR" | "DUPLICATE" | "TRY_AGAIN_LATER";
  errorResultXdr?: string;
}

export function mockSendTransaction(
  options: MockSendTransactionOptions = {}
): object {
  const { hash = MOCK_TX_HASH, status = "PENDING", errorResultXdr } = options;
  return {
    hash,
    status,
    ...(errorResultXdr ? { errorResultXdr } : {}),
  };
}

// ---------------------------------------------------------------------------
// Ledger mock
// ---------------------------------------------------------------------------

export interface MockLedgerOptions {
  sequence?: number;
  closedAt?: string;
  baseFeeInStroops?: number;
  baseReserveInStroops?: number;
  transactionCount?: number;
}

/**
 * Build a mock Horizon ledger response.
 */
export function mockLedger(options: MockLedgerOptions = {}): object {
  const {
    sequence = 50_000_000,
    closedAt = "2026-01-01T00:00:00Z",
    baseFeeInStroops = 100,
    baseReserveInStroops = 5_000_000,
    transactionCount = 42,
  } = options;

  return {
    id: sequence.toString(),
    sequence,
    closed_at: closedAt,
    base_fee_in_stroops: baseFeeInStroops,
    base_reserve_in_stroops: baseReserveInStroops,
    transaction_count: transactionCount,
    successful_transaction_count: transactionCount,
    failed_transaction_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Simulation mock
// ---------------------------------------------------------------------------

export interface MockSimulationOptions {
  success?: boolean;
  cost?: { cpuInsns: string; memBytes: string };
  minResourceFee?: string;
  returnValue?: unknown;
  error?: string;
}

/**
 * Build a mock `simulateTransaction` response.
 */
export function mockSimulation(options: MockSimulationOptions = {}): object {
  const {
    success = true,
    cost = { cpuInsns: "1000000", memBytes: "512000" },
    minResourceFee = "500",
    returnValue = null,
    error,
  } = options;

  if (!success || error) {
    return { error: error ?? "simulation failed", cost };
  }

  return {
    cost,
    minResourceFee,
    results: [{ auth: [], xdr: "AAAAAA==" }],
    returnValue,
    latestLedger: 50_000_000,
  };
}

// ---------------------------------------------------------------------------
// Contract data mock
// ---------------------------------------------------------------------------

export interface MockContractDataOptions {
  key?: string;
  value?: unknown;
  ledger?: number;
}

/**
 * Build a mock `getContractData` response.
 */
export function mockContractData(
  options: MockContractDataOptions = {}
): object {
  const { key = "state", value = {}, ledger = 50_000_000 } = options;
  return {
    key,
    val: value,
    lastModifiedLedgerSeq: ledger,
  };
}

// ---------------------------------------------------------------------------
// Composite: full RPC server mock
// ---------------------------------------------------------------------------

export interface MockServerOptions {
  account?: MockAccountOptions;
  transaction?: MockTransactionOptions;
  sendTransaction?: MockSendTransactionOptions;
  simulation?: MockSimulationOptions;
}

/**
 * Build a complete mock Soroban RPC server object.
 * Pass to `vi.fn().mockImplementation(() => mockSorobanServer())`.
 */
export function mockSorobanServer(options: MockServerOptions = {}): object {
  return {
    getAccount: async (_address: string) => mockAccount(options.account),
    getTransaction: async (_hash: string) =>
      mockTransaction(options.transaction),
    sendTransaction: async (_tx: unknown) =>
      mockSendTransaction(options.sendTransaction),
    simulateTransaction: async (_tx: unknown) =>
      mockSimulation(options.simulation),
    prepareTransaction: async (tx: unknown) => tx,
    getLatestLedger: async () => ({ sequence: 50_000_000 }),
  };
}
