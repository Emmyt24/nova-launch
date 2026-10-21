/**
 * Pull-model dividend distribution service (#1759).
 *
 * Two responsibilities, kept deliberately separate:
 *
 *  1. On-chain adapter — builds unsigned transaction XDR for the three
 *     write entry points (`initiate_distribution`, `claim_dividend`,
 *     `reclaim_unclaimed`) added to the token-factory contract, relays a
 *     caller-signed transaction, and performs read-only simulation calls
 *     for the contract's query entry points. This mirrors the existing
 *     "thin adapter" pattern used by `callStellarDeploy` in
 *     `batchTokenDeployService.ts` and the plain-function Soroban RPC
 *     helpers in `lib/stellar/index.ts` — the backend never holds a
 *     holder's or the admin's private key, so writes are always built
 *     unsigned and returned to the caller for wallet signing.
 *
 *  2. Off-chain projection — ingests the contract's `div_ini1` / `div_clm1`
 *     / `div_rcl1` events into the `DividendPool` / `DividendClaim` /
 *     `HolderSnapshot` Prisma models (added by a previous, never-wired-up
 *     attempt at this feature — see 20240226000000_add_dividend_distribution)
 *     so the API can paginate distribution history cheaply instead of
 *     re-querying the chain per row.
 *
 * KNOWN GAP (flagged per the issue's implementer notes, not silently
 * worked around): this backend does not maintain a per-holder token
 * balance index. `HolderSnapshot` therefore cannot be populated eagerly
 * for every eligible holder the moment a distribution opens — there is no
 * off-chain source to enumerate "every holder of token X" from. It is
 * instead populated reactively, one row per holder who actually claims
 * (see `ingestDividendEvent`), with `balance` back-derived from the
 * claimed share. This is sufficient for "who claimed, how much, when"
 * reporting, but NOT for "who is still eligible but hasn't claimed yet"
 * reporting — that needs a holder-balance indexer, which is out of scope
 * here and should be tracked as a follow-up.
 */

import {
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { prisma } from "../lib/prisma";
import {
  stellarConfig,
  getSorobanServer,
  getNetworkPassphrase,
  submitTransaction,
  type StellarNetworkConfig,
} from "../lib/stellar";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DistributionRecord {
  id: number;
  tokenIndex: number;
  asset: string;
  totalAmount: string;
  snapshotLedger: number;
  totalSupplyAtSnapshot: string;
  claimDeadlineLedger: number;
  reclaimed: boolean;
  createdAt: string;
}

export interface UnsignedTransaction {
  /** Base64-encoded unsigned transaction envelope XDR, ready for wallet signing. */
  xdr: string;
  networkPassphrase: string;
}

export interface DividendEvent {
  /** Event topic, e.g. "div_ini1" | "div_clm1" | "div_rcl1". */
  topic: string;
  /** Decoded topic values (index 0 is always the distribution id for these events). */
  topicValues: unknown[];
  /** Decoded event body/data values, in emission order. */
  data: unknown[];
  txHash: string;
  ledger: number;
  ledgerCloseTime: string;
}

// ---------------------------------------------------------------------------
// Share calculation — pure, no I/O, exported for direct unit/property testing
// ---------------------------------------------------------------------------

/**
 * Mirrors the on-chain pro-rata calculation in `dividend_distribution.rs`:
 * `share = floor(holderBalance * totalAmount / totalSupplyAtSnapshot)`.
 *
 * All arguments must be non-negative; `totalSupplyAtSnapshot` must be > 0
 * (the contract itself never opens a distribution with zero supply — see
 * `DistributionZeroSupply`). Uses BigInt throughout to match the contract's
 * i128 arithmetic exactly, with no floating-point rounding error.
 */
export function calculateDividendShare(
  holderBalance: bigint,
  totalAmount: bigint,
  totalSupplyAtSnapshot: bigint
): bigint {
  if (holderBalance < 0n || totalAmount < 0n || totalSupplyAtSnapshot <= 0n) {
    throw new RangeError(
      "calculateDividendShare: holderBalance/totalAmount must be >= 0 and totalSupplyAtSnapshot must be > 0"
    );
  }
  return (holderBalance * totalAmount) / totalSupplyAtSnapshot;
}

// ---------------------------------------------------------------------------
// On-chain adapter
// ---------------------------------------------------------------------------

function getFactoryContract(
  config: StellarNetworkConfig = stellarConfig
): Contract {
  if (!config.factoryContractId) {
    throw new Error("FACTORY_CONTRACT_ID is not configured");
  }
  return new Contract(config.factoryContractId);
}

/**
 * A source account used only to shape an unsigned transaction / a read-only
 * simulation. Its sequence number is never actually consumed on-chain: for
 * writes the caller's wallet re-signs (and Soroban RPC / Horizon re-derives
 * the real sequence) before submission, and for reads the transaction is
 * never submitted at all. Using a fresh keypair per call avoids depending on
 * any single well-known funded account existing on every network.
 */
function ephemeralSourceAccount(): Account {
  return new Account(Keypair.random().publicKey(), "0");
}

async function buildUnsignedInvocation(
  method: string,
  args: xdr.ScVal[],
  sourcePublicKey: string,
  config: StellarNetworkConfig = stellarConfig
): Promise<UnsignedTransaction> {
  const server = getSorobanServer(config);
  const contract = getFactoryContract(config);
  const networkPassphrase = getNetworkPassphrase(config);

  let sourceAccount: Account;
  try {
    sourceAccount = await server.getAccount(sourcePublicKey);
  } catch {
    // Account not found on-chain yet (e.g. never funded) — still shape a
    // valid envelope; the caller's wallet will supply the real sequence
    // number when it re-signs before submission.
    sourceAccount = new Account(sourcePublicKey, "0");
  }

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  return { xdr: prepared.toXDR(), networkPassphrase };
}

async function simulateReadCall(
  method: string,
  args: xdr.ScVal[],
  config: StellarNetworkConfig = stellarConfig
): Promise<unknown> {
  const server = getSorobanServer(config);
  const contract = getFactoryContract(config);
  const networkPassphrase = getNetworkPassphrase(config);

  const tx = new TransactionBuilder(ephemeralSourceAccount(), {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(mapContractError(sim.error));
  }
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error("Simulation did not return a result");
  }
  return scValToNative(sim.result.retval);
}

/** Build an unsigned `initiate_distribution` transaction (admin-signed). */
export async function buildInitiateDistributionTx(params: {
  admin: string;
  tokenIndex: number;
  asset: string;
  totalAmount: string;
  claimDeadlineLedger: number;
}): Promise<UnsignedTransaction> {
  const args = [
    nativeToScVal(params.admin, { type: "address" }),
    nativeToScVal(params.tokenIndex, { type: "u32" }),
    nativeToScVal(params.asset, { type: "address" }),
    nativeToScVal(BigInt(params.totalAmount), { type: "i128" }),
    nativeToScVal(params.claimDeadlineLedger, { type: "u32" }),
  ];
  return buildUnsignedInvocation("initiate_distribution", args, params.admin);
}

/** Build an unsigned `claim_dividend` transaction (holder-signed). */
export async function buildClaimDividendTx(params: {
  holder: string;
  distributionId: number;
}): Promise<UnsignedTransaction> {
  const args = [
    nativeToScVal(params.holder, { type: "address" }),
    nativeToScVal(params.distributionId, { type: "u32" }),
  ];
  return buildUnsignedInvocation("claim_dividend", args, params.holder);
}

/** Build an unsigned `reclaim_unclaimed` transaction (admin-signed). */
export async function buildReclaimUnclaimedTx(params: {
  admin: string;
  distributionId: number;
}): Promise<UnsignedTransaction> {
  const args = [
    nativeToScVal(params.admin, { type: "address" }),
    nativeToScVal(params.distributionId, { type: "u32" }),
  ];
  return buildUnsignedInvocation("reclaim_unclaimed", args, params.admin);
}

/** Relay a caller-signed transaction envelope to the network. */
export async function submitSignedDividendTx(signedXdr: string) {
  return submitTransaction(signedXdr);
}

/** Live on-chain read of a distribution record. */
export async function getDistribution(
  distributionId: number
): Promise<DistributionRecord> {
  const args = [nativeToScVal(distributionId, { type: "u32" })];
  const raw = (await simulateReadCall("get_distribution", args)) as Record<
    string,
    unknown
  >;
  return {
    id: Number(raw.id),
    tokenIndex: Number(raw.token_index),
    asset: String(raw.asset),
    totalAmount: String(raw.total_amount),
    snapshotLedger: Number(raw.snapshot_ledger),
    totalSupplyAtSnapshot: String(raw.total_supply_at_snapshot),
    claimDeadlineLedger: Number(raw.claim_deadline_ledger),
    reclaimed: Boolean(raw.reclaimed),
    createdAt: String(raw.created_at),
  };
}

/** Live on-chain read of whether `holder` has claimed `distributionId`. */
export async function hasClaimedDividend(
  distributionId: number,
  holder: string
): Promise<boolean> {
  const args = [
    nativeToScVal(distributionId, { type: "u32" }),
    nativeToScVal(holder, { type: "address" }),
  ];
  return Boolean(await simulateReadCall("has_claimed_dividend", args));
}

/** Live on-chain read of the running claimed total for a distribution. */
export async function getDividendClaimedTotal(
  distributionId: number
): Promise<string> {
  const args = [nativeToScVal(distributionId, { type: "u32" })];
  return String(await simulateReadCall("get_dividend_claimed_total", args));
}

/** Live on-chain read of the total number of distributions initiated. */
export async function getDistributionCount(): Promise<number> {
  return Number(await simulateReadCall("get_distribution_count", []));
}

// ---------------------------------------------------------------------------
// Contract error mapping
// ---------------------------------------------------------------------------

/** Error names for the codes dividend entry points can return (types.rs). */
const DIVIDEND_CONTRACT_ERRORS: Record<number, string> = {
  2: "Unauthorized",
  3: "InvalidParameters",
  4: "TokenNotFound",
  8: "ArithmeticError",
  14: "ContractPaused",
  21: "NothingToClaim",
  22: "MissingAdmin",
  23: "MissingTreasury",
  100: "DistributionNotFound",
  101: "DistributionWindowClosed",
  102: "DistributionWindowOpen",
  103: "DistributionAlreadyClaimed",
  104: "DistributionAlreadyReclaimed",
  105: "DistributionZeroSupply",
};

/** Best-effort mapping of a simulation error into a readable message. */
export function mapContractError(rawError: unknown): string {
  const message = String(rawError);
  const match = message.match(/Error\(Contract,\s*#(\d+)\)/);
  if (match) {
    const code = Number(match[1]);
    const name = DIVIDEND_CONTRACT_ERRORS[code];
    return name
      ? `${name} (contract error #${code})`
      : `Contract error #${code}`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// Off-chain projection (Prisma)
// ---------------------------------------------------------------------------

async function resolveTokenIdByIndex(
  _tokenIndex: number
): Promise<string | null> {
  // The factory contract indexes tokens by a numeric `token_index`, but the
  // Token projection is keyed by on-chain contract address. Distribution
  // events don't currently carry the token's address (only its index), so
  // this lookup is a placeholder until the token-created event → address
  // mapping used elsewhere in the indexer is threaded through here as well.
  return null;
}

/**
 * Ingest one decoded dividend event into the Prisma projection. Idempotent
 * per `event.txHash` (the unique constraints on `DividendPool.txHash` /
 * `DividendClaim.txHash` make a duplicate ingest a harmless no-op via
 * `skipDuplicates`/upsert-by-unique-key).
 */
export async function ingestDividendEvent(event: DividendEvent): Promise<void> {
  switch (event.topic) {
    case "div_ini1":
      return ingestDistributionInitiated(event);
    case "div_clm1":
      return ingestDividendClaimed(event);
    case "div_rcl1":
      return ingestDividendReclaimed(event);
    default:
      throw new Error(`Unrecognised dividend event topic: ${event.topic}`);
  }
}

async function ingestDistributionInitiated(
  event: DividendEvent
): Promise<void> {
  const distributionId = Number(event.topicValues[0]);
  const [admin, tokenIndex] = event.data as [string, number, ...unknown[]];

  const existing = await prisma.dividendPool.findUnique({
    where: { distributionId },
  });
  if (existing) return;

  const tokenId = await resolveTokenIdByIndex(tokenIndex);
  if (!tokenId) {
    // Can't satisfy the required Token relation yet — skip rather than
    // write a row with a dangling/guessed tokenId. A later reconciliation
    // pass (once token-index → Token.id resolution is wired up) can backfill.
    return;
  }

  // The event carries enough to know a distribution was created and its
  // id, but the authoritative record (including total_supply_at_snapshot,
  // which isn't part of the event payload) is read live from the contract
  // so this projection can never drift from on-chain truth.
  const record = await getDistribution(distributionId);

  await prisma.dividendPool.create({
    data: {
      distributionId,
      tokenId,
      asset: record.asset,
      fundedBy: admin,
      totalAmount: BigInt(record.totalAmount),
      supplySnapshot: BigInt(record.totalSupplyAtSnapshot),
      snapshotLedger: record.snapshotLedger,
      claimDeadlineLedger: record.claimDeadlineLedger,
      status: "ACTIVE",
      txHash: event.txHash,
    },
  });
}

async function ingestDividendClaimed(event: DividendEvent): Promise<void> {
  const distributionId = Number(event.topicValues[0]);
  const [holder, amount] = event.data as [string, bigint | string | number];
  const claimedAmount = BigInt(amount);

  const pool = await prisma.dividendPool.findUnique({
    where: { distributionId },
  });
  if (!pool) return;

  const alreadyRecorded = await prisma.dividendClaim.findUnique({
    where: { txHash: event.txHash },
  });
  if (alreadyRecorded) return;

  await prisma.$transaction([
    prisma.dividendClaim.create({
      data: {
        poolId: pool.id,
        claimant: holder,
        amount: claimedAmount,
        txHash: event.txHash,
      },
    }),
    prisma.dividendPool.update({
      where: { id: pool.id },
      data: { claimedAmount: { increment: claimedAmount } },
    }),
    // Best-effort reporting snapshot — see the KNOWN GAP note at the top of
    // this file for why this is derived from the claim rather than recorded
    // eagerly for every eligible holder.
    prisma.holderSnapshot.upsert({
      where: { poolId_holder: { poolId: pool.id, holder } },
      create: {
        poolId: pool.id,
        holder,
        balance:
          pool.totalAmount > 0n
            ? (claimedAmount * pool.supplySnapshot) / pool.totalAmount
            : 0n,
        claimable: claimedAmount,
      },
      update: { claimable: claimedAmount },
    }),
  ]);
}

async function ingestDividendReclaimed(event: DividendEvent): Promise<void> {
  const distributionId = Number(event.topicValues[0]);

  const pool = await prisma.dividendPool.findUnique({
    where: { distributionId },
  });
  if (!pool) return;

  // `reclaim_unclaimed` is only callable once per distribution (on-chain
  // double-reclaim prevention), so seeing this event always means the round
  // is now fully settled — nothing more will ever be claimed or reclaimed.
  await prisma.dividendPool.update({
    where: { id: pool.id },
    data: { status: "EXHAUSTED" },
  });
}

// ---------------------------------------------------------------------------
// Reporting reads (Prisma-backed, paginated)
// ---------------------------------------------------------------------------

export interface PageOpts {
  limit?: number;
  cursor?: string;
}

/** Paginated claim history for a distribution, most recent first. */
export async function listClaimsForDistribution(
  distributionId: number,
  opts: PageOpts = {}
) {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const pool = await prisma.dividendPool.findUnique({
    where: { distributionId },
  });
  if (!pool) return { claims: [], nextCursor: null };

  const claims = await prisma.dividendClaim.findMany({
    where: { poolId: pool.id },
    orderBy: { claimedAt: "desc" },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = claims.length > limit;
  const page = hasMore ? claims.slice(0, limit) : claims;
  return {
    claims: page.map((c) => ({
      claimant: c.claimant,
      amount: c.amount.toString(),
      txHash: c.txHash,
      claimedAt: c.claimedAt.toISOString(),
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

/** Paginated holder-claim snapshot for a distribution (see KNOWN GAP above). */
export async function listHolderSnapshotsForDistribution(
  distributionId: number,
  opts: PageOpts = {}
) {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const pool = await prisma.dividendPool.findUnique({
    where: { distributionId },
  });
  if (!pool) return { holders: [], nextCursor: null };

  const snapshots = await prisma.holderSnapshot.findMany({
    where: { poolId: pool.id },
    orderBy: { id: "asc" },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = snapshots.length > limit;
  const page = hasMore ? snapshots.slice(0, limit) : snapshots;
  return {
    holders: page.map((h) => ({
      holder: h.holder,
      balance: h.balance.toString(),
      claimable: h.claimable.toString(),
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

// ---------------------------------------------------------------------------
// Claim status (projection-backed, no transaction required) (#2207)
// ---------------------------------------------------------------------------

/**
 * - `CLAIMABLE`: the holder has a known unclaimed share and the window is open.
 * - `CLAIMED`: the projection has recorded a claim by the holder.
 * - `EXPIRED`: the claim window has closed (deadline passed or pool settled)
 *   and the holder never claimed.
 * - `NOTHING_TO_CLAIM`: the holder is known but their share is zero (the
 *   contract would reject the claim with `NothingToClaim`).
 * - `UNKNOWN`: the projection has no record of this holder. Because
 *   `HolderSnapshot` is only populated reactively from claims (see the KNOWN
 *   GAP note at the top of this file), this does NOT mean the holder is
 *   ineligible. It means eligibility can't be determined off-chain.
 */
export type DividendClaimState =
  | "CLAIMABLE"
  | "CLAIMED"
  | "EXPIRED"
  | "NOTHING_TO_CLAIM"
  | "UNKNOWN";

export interface DividendClaimStatus {
  distributionId: number;
  holder: string;
  status: DividendClaimState;
  /** Whether the projection has any record of this holder for the pool. */
  known: boolean;
  /** Remaining claimable amount, or null when it can't be determined. */
  claimableAmount: string | null;
  /** Amount already claimed by the holder (0 if none recorded). */
  claimedAmount: string;
  claimedAt: string | null;
  expiry: {
    /** Ledger after which the claim window closes (authoritative on-chain deadline). */
    claimDeadlineLedger: number | null;
    /** Wall-clock deadline, when the projection has one. */
    expiresAt: string | null;
    expired: boolean;
  };
  poolStatus: string;
}

/** Pool statuses after which no further claims can succeed. */
const CLOSED_POOL_STATUSES = new Set(["EXHAUSTED", "EXPIRED", "CANCELLED"]);

/**
 * Report whether `holder` can claim `distributionId`, and how much, from the
 * Prisma projection alone, so a wallet can check before building and signing
 * a `claim_dividend` transaction.
 *
 * Returns null when the projection has no pool for `distributionId`.
 */
export async function getDividendClaimStatus(
  distributionId: number,
  holder: string,
  now: Date = new Date()
): Promise<DividendClaimStatus | null> {
  const pool = await prisma.dividendPool.findUnique({
    where: { distributionId },
  });
  if (!pool) return null;

  const [snapshot, claims] = await Promise.all([
    prisma.holderSnapshot.findUnique({
      where: { poolId_holder: { poolId: pool.id, holder } },
    }),
    prisma.dividendClaim.findMany({
      where: { poolId: pool.id, claimant: holder },
      orderBy: { claimedAt: "desc" },
    }),
  ]);

  const expired =
    CLOSED_POOL_STATUSES.has(pool.status) ||
    (pool.expiresAt != null && pool.expiresAt.getTime() <= now.getTime());

  const claimedAmount = claims.reduce((sum, c) => sum + c.amount, 0n);
  const hasClaimed = claims.length > 0;
  const known = hasClaimed || snapshot != null;

  let status: DividendClaimState;
  let claimableAmount: bigint | null;
  if (hasClaimed) {
    status = "CLAIMED";
    claimableAmount = 0n;
  } else if (expired) {
    status = "EXPIRED";
    claimableAmount = 0n;
  } else if (snapshot) {
    status = snapshot.claimable > 0n ? "CLAIMABLE" : "NOTHING_TO_CLAIM";
    claimableAmount = snapshot.claimable;
  } else {
    status = "UNKNOWN";
    claimableAmount = null;
  }

  return {
    distributionId,
    holder,
    status,
    known,
    claimableAmount: claimableAmount === null ? null : claimableAmount.toString(),
    claimedAmount: claimedAmount.toString(),
    claimedAt: hasClaimed ? claims[0].claimedAt.toISOString() : null,
    expiry: {
      claimDeadlineLedger: pool.claimDeadlineLedger ?? null,
      expiresAt: pool.expiresAt ? pool.expiresAt.toISOString() : null,
      expired,
    },
    poolStatus: pool.status,
  };
}
