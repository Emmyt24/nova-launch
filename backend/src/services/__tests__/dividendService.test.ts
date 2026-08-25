/**
 * Tests for dividendService.ts (#1759) — the on-chain adapter (build/submit
 * transactions, live reads) and the Prisma-backed event projection.
 *
 * Pure share-calculation correctness has its own property-based suite in
 * dividendService.property.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrKey, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

const FACTORY_CONTRACT_ID = vi.hoisted(() =>
  require("@stellar/stellar-sdk").StrKey.encodeContract(Buffer.alloc(32, 1))
);
const ADMIN = Keypair.random().publicKey();
const HOLDER = Keypair.random().publicKey();
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 2));
const TREASURY = Keypair.random().publicKey();

// ---------------------------------------------------------------------------
// Mock lib/stellar — real SDK classes (Contract, TransactionBuilder,
// nativeToScVal, scValToNative) stay real; only the network-facing server
// and config are stubbed.
// ---------------------------------------------------------------------------

const mockServer = vi.hoisted(() => ({
  getAccount: vi.fn(),
  prepareTransaction: vi.fn(),
  simulateTransaction: vi.fn(),
}));

const mockSubmitTransaction = vi.hoisted(() => vi.fn());

vi.mock("../../lib/stellar", () => ({
  stellarConfig: {
    network: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    factoryContractId: FACTORY_CONTRACT_ID,
  },
  getSorobanServer: () => mockServer,
  getNetworkPassphrase: () => "Test SDF Network ; September 2015",
  submitTransaction: mockSubmitTransaction,
}));

// ---------------------------------------------------------------------------
// Mock lib/prisma
// ---------------------------------------------------------------------------

const mockPrisma = vi.hoisted(() => ({
  dividendPool: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  dividendClaim: {
    findUnique: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  },
  holderSnapshot: {
    upsert: vi.fn(),
    findMany: vi.fn(),
  },
  $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
}));

vi.mock("../../lib/prisma", () => ({ prisma: mockPrisma }));

import * as dividendService from "../dividendService";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (ops: any[]) =>
    Promise.all(ops)
  );
});

// ---------------------------------------------------------------------------
// Build-transaction helpers
// ---------------------------------------------------------------------------

describe("build*Tx", () => {
  beforeEach(() => {
    mockServer.getAccount.mockRejectedValue(new Error("account not found"));
    mockServer.prepareTransaction.mockImplementation(async (tx: any) => tx);
  });

  it("buildInitiateDistributionTx returns an unsigned XDR envelope", async () => {
    const result = await dividendService.buildInitiateDistributionTx({
      admin: ADMIN,
      tokenIndex: 0,
      asset: ASSET,
      totalAmount: "1000000",
      claimDeadlineLedger: 999999,
    });
    expect(typeof result.xdr).toBe("string");
    expect(result.xdr.length).toBeGreaterThan(0);
    expect(result.networkPassphrase).toBe("Test SDF Network ; September 2015");
  });

  it("buildClaimDividendTx returns an unsigned XDR envelope", async () => {
    const result = await dividendService.buildClaimDividendTx({
      holder: HOLDER,
      distributionId: 1,
    });
    expect(typeof result.xdr).toBe("string");
  });

  it("buildReclaimUnclaimedTx returns an unsigned XDR envelope", async () => {
    const result = await dividendService.buildReclaimUnclaimedTx({
      admin: ADMIN,
      distributionId: 1,
    });
    expect(typeof result.xdr).toBe("string");
  });

  it("submitSignedDividendTx delegates to lib/stellar's submitTransaction", async () => {
    mockSubmitTransaction.mockResolvedValue({
      hash: "deadbeef",
      successful: true,
    });
    const result = await dividendService.submitSignedDividendTx("AAAA...");
    expect(mockSubmitTransaction).toHaveBeenCalledWith("AAAA...");
    expect(result).toEqual({ hash: "deadbeef", successful: true });
  });
});

// ---------------------------------------------------------------------------
// Live reads (simulateTransaction)
// ---------------------------------------------------------------------------

function simSuccess(retval: ReturnType<typeof nativeToScVal>) {
  return { transactionData: {}, result: { retval } };
}

function simError(message: string) {
  return { error: message };
}

describe("live reads", () => {
  it("getDistribution decodes the on-chain record", async () => {
    const record = {
      id: 1,
      token_index: 0,
      asset: ASSET,
      total_amount: 1_000_000n,
      snapshot_ledger: 100,
      total_supply_at_snapshot: 1_000n,
      claim_deadline_ledger: 200,
      reclaimed: false,
      created_at: 1_700_000_000n,
    };
    mockServer.simulateTransaction.mockResolvedValue(
      simSuccess(nativeToScVal(record))
    );

    const result = await dividendService.getDistribution(1);
    expect(result).toMatchObject({
      id: 1,
      tokenIndex: 0,
      asset: ASSET,
      totalAmount: "1000000",
      snapshotLedger: 100,
      totalSupplyAtSnapshot: "1000",
      claimDeadlineLedger: 200,
      reclaimed: false,
    });
  });

  it("hasClaimedDividend decodes a boolean", async () => {
    mockServer.simulateTransaction.mockResolvedValue(
      simSuccess(nativeToScVal(true))
    );
    expect(await dividendService.hasClaimedDividend(1, HOLDER)).toBe(true);
  });

  it("getDividendClaimedTotal decodes an i128 as a string", async () => {
    mockServer.simulateTransaction.mockResolvedValue(
      simSuccess(nativeToScVal(500_000n, { type: "i128" }))
    );
    expect(await dividendService.getDividendClaimedTotal(1)).toBe("500000");
  });

  it("getDistributionCount decodes a u32", async () => {
    mockServer.simulateTransaction.mockResolvedValue(
      simSuccess(nativeToScVal(3, { type: "u32" }))
    );
    expect(await dividendService.getDistributionCount()).toBe(3);
  });

  it("surfaces a mapped contract error on simulation failure", async () => {
    mockServer.simulateTransaction.mockResolvedValue(
      simError("HostError: Error(Contract, #100)")
    );
    await expect(dividendService.getDistribution(999)).rejects.toThrow(
      /DistributionNotFound/
    );
  });
});

describe("mapContractError", () => {
  it("maps a known contract error code to its name", () => {
    expect(dividendService.mapContractError("Error(Contract, #103)")).toMatch(
      /DistributionAlreadyClaimed/
    );
  });

  it("falls back to the raw code for an unrecognised error", () => {
    expect(dividendService.mapContractError("Error(Contract, #7)")).toBe(
      "Contract error #7"
    );
  });

  it("passes through a message with no contract error pattern", () => {
    expect(dividendService.mapContractError("network timeout")).toBe(
      "network timeout"
    );
  });
});

// ---------------------------------------------------------------------------
// Event ingestion
// ---------------------------------------------------------------------------

describe("ingestDividendEvent", () => {
  const baseEvent = {
    txHash: "tx-init-1",
    ledger: 100,
    ledgerCloseTime: "2026-08-24T00:00:00.000Z",
  };

  it("div_ini1: skips ingestion when the token index can't be resolved to a Token row", async () => {
    mockPrisma.dividendPool.findUnique.mockResolvedValue(null);

    await dividendService.ingestDividendEvent({
      ...baseEvent,
      topic: "div_ini1",
      topicValues: [1],
      data: [ADMIN, 0, ASSET, 1_000_000n, 100, 200],
    });

    // resolveTokenIdByIndex is currently a stub returning null (documented
    // KNOWN GAP) — the ingester must not write a dangling Token relation.
    expect(mockPrisma.dividendPool.create).not.toHaveBeenCalled();
  });

  it("div_ini1: is a no-op when the pool already exists (idempotent re-ingest)", async () => {
    mockPrisma.dividendPool.findUnique.mockResolvedValue({
      id: "pool-1",
      distributionId: 1,
    });

    await dividendService.ingestDividendEvent({
      ...baseEvent,
      topic: "div_ini1",
      topicValues: [1],
      data: [ADMIN, 0, ASSET, 1_000_000n, 100, 200],
    });

    expect(mockPrisma.dividendPool.create).not.toHaveBeenCalled();
  });

  it("div_clm1: records the claim, increments the pool total, and upserts a holder snapshot", async () => {
    mockPrisma.dividendPool.findUnique.mockResolvedValue({
      id: "pool-1",
      distributionId: 1,
      totalAmount: 1_000_000n,
      supplySnapshot: 1_000n,
      claimedAmount: 0n,
    });
    mockPrisma.dividendClaim.findUnique.mockResolvedValue(null);

    await dividendService.ingestDividendEvent({
      ...baseEvent,
      txHash: "tx-claim-1",
      topic: "div_clm1",
      topicValues: [1],
      data: [HOLDER, 300_000n],
    });

    expect(mockPrisma.dividendClaim.create).toHaveBeenCalledWith({
      data: {
        poolId: "pool-1",
        claimant: HOLDER,
        amount: 300_000n,
        txHash: "tx-claim-1",
      },
    });
    expect(mockPrisma.dividendPool.update).toHaveBeenCalledWith({
      where: { id: "pool-1" },
      data: { claimedAmount: { increment: 300_000n } },
    });
    expect(mockPrisma.holderSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { poolId_holder: { poolId: "pool-1", holder: HOLDER } },
        create: expect.objectContaining({
          poolId: "pool-1",
          holder: HOLDER,
          claimable: 300_000n,
        }),
      })
    );
  });

  it("div_clm1: is idempotent for a duplicate txHash", async () => {
    mockPrisma.dividendPool.findUnique.mockResolvedValue({
      id: "pool-1",
      distributionId: 1,
      totalAmount: 1_000_000n,
      supplySnapshot: 1_000n,
      claimedAmount: 300_000n,
    });
    mockPrisma.dividendClaim.findUnique.mockResolvedValue({
      id: "claim-1",
      txHash: "tx-claim-1",
    });

    await dividendService.ingestDividendEvent({
      ...baseEvent,
      txHash: "tx-claim-1",
      topic: "div_clm1",
      topicValues: [1],
      data: [HOLDER, 300_000n],
    });

    expect(mockPrisma.dividendClaim.create).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("div_rcl1: marks the pool EXHAUSTED", async () => {
    mockPrisma.dividendPool.findUnique.mockResolvedValue({
      id: "pool-1",
      distributionId: 1,
    });

    await dividendService.ingestDividendEvent({
      ...baseEvent,
      txHash: "tx-reclaim-1",
      topic: "div_rcl1",
      topicValues: [1],
      data: [TREASURY, 400_000n],
    });

    expect(mockPrisma.dividendPool.update).toHaveBeenCalledWith({
      where: { id: "pool-1" },
      data: { status: "EXHAUSTED" },
    });
  });

  it("rejects an unrecognised event topic", async () => {
    await expect(
      dividendService.ingestDividendEvent({
        ...baseEvent,
        topic: "unknown_evt",
        topicValues: [],
        data: [],
      })
    ).rejects.toThrow(/Unrecognised dividend event topic/);
  });
});

// ---------------------------------------------------------------------------
// Paginated reporting reads
// ---------------------------------------------------------------------------

describe("listClaimsForDistribution", () => {
  it("returns an empty page when the distribution has no pool row", async () => {
    mockPrisma.dividendPool.findUnique.mockResolvedValue(null);
    const page = await dividendService.listClaimsForDistribution(999);
    expect(page).toEqual({ claims: [], nextCursor: null });
  });

  it("paginates and reports nextCursor when more rows exist", async () => {
    mockPrisma.dividendPool.findUnique.mockResolvedValue({ id: "pool-1" });
    mockPrisma.dividendClaim.findMany.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        id: `claim-${i}`,
        claimant: HOLDER,
        amount: BigInt(i),
        txHash: `tx-${i}`,
        claimedAt: new Date("2026-08-24T00:00:00.000Z"),
      }))
    );

    const page = await dividendService.listClaimsForDistribution(1, {
      limit: 2,
    });
    expect(page.claims).toHaveLength(2);
    expect(page.nextCursor).toBe("claim-1");
  });
});
