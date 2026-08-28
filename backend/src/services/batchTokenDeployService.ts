/**
 * Batch token deployment service.
 *
 * Orchestrates multi-token deployments against the Stellar Soroban token-factory
 * contract and persists results atomically in Prisma.  Because Soroban does not
 * support multi-contract atomic transactions across separate token addresses, atomicity
 * is enforced at the application layer: every on-chain call is attempted first, and
 * only when *all* succeed does a single Prisma transaction commit the records.  If
 * any individual call fails the whole batch is rolled back — no partial state is
 * written to the database.
 *
 * Issue: #1263
 */

import { prisma } from "../lib/prisma";
import { eventBus } from "./eventBus";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input shape for a single token in a batch deploy request. */
export interface TokenDeployInput {
  /** Stellar G-address that will own the token. */
  creator: string;
  /** Human-readable token name. */
  name: string;
  /** Ticker symbol (uppercase, 1-12 characters). */
  symbol: string;
  /** Number of decimal places (0-18). */
  decimals: number;
  /** Initial supply as a decimal string (no scientific notation). */
  initialSupply: string;
  /** Optional IPFS/HTTPS metadata URI. */
  metadataUri?: string;
}

/** A successfully deployed token record (BigInt fields serialised as strings). */
export interface DeployedToken {
  id: string;
  address: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  initialSupply: string;
  totalBurned: string;
  burnCount: number;
  metadataUri: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-token result returned to the caller for a failed item. */
export interface FailedTokenDeploy {
  input: TokenDeployInput;
  error: string;
}

/** Shape returned by batchDeployTokens. */
export interface BatchDeployResult {
  succeeded: DeployedToken[];
  failed: FailedTokenDeploy[];
}

// ---------------------------------------------------------------------------
// Stellar contract adapter
// ---------------------------------------------------------------------------

/**
 * Represents a single on-chain deployment result before it is persisted.
 * In production this is populated by the Stellar SDK / Soroban RPC call.
 * The interface is kept as a narrow boundary so the adapter can be swapped
 * or mocked in tests without touching orchestration logic.
 */
export interface StellarDeployResult {
  /** The newly minted Stellar G-address for this token. */
  address: string;
}

/**
 * Calls the Stellar token-factory contract for a single token.
 *
 * This thin adapter is the only place that touches the Stellar SDK so it can
 * be cleanly mocked in unit / integration tests.  Replace the body with the
 * real Soroban RPC invocation (e.g. via `@stellar/stellar-sdk`) once contract
 * addresses and network config are available.
 */
export async function callStellarDeploy(
  input: TokenDeployInput
): Promise<StellarDeployResult> {
  // TODO: replace with real Soroban RPC call once contract addresses are
  //       finalised.  The generated address below is a placeholder that
  //       satisfies the Stellar G-address format used in tests.
  //
  // Example real implementation:
  //   const server = new SorobanRpc.Server(process.env.SOROBAN_RPC_URL!);
  //   const contract = new Contract(process.env.TOKEN_FACTORY_ADDRESS!);
  //   const result = await server.submitTransaction(
  //     TransactionBuilder.buildFeeBumpTransaction(...)
  //   );
  //   return { address: result.contractAddress };

  // Deterministic placeholder: use creator + symbol so tests can assert on it.
  const address = `G${input.creator.slice(0, 4).toUpperCase()}${input.symbol.toUpperCase()}${"0".repeat(
    Math.max(0, 50 - input.creator.length - input.symbol.length)
  )}`.slice(0, 56);

  return { address };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Deploy a batch of tokens atomically.
 *
 * Algorithm:
 *  1. Call the Stellar contract for every token in sequence.
 *     - Collect results; stop immediately on the first failure (fail-fast).
 *     - Because no DB writes have happened yet, the ledger changes are the
 *       only side-effect on failure; callers are expected to handle Stellar-
 *       side compensation if necessary.
 *  2. If *all* on-chain calls succeed, persist all records in a single Prisma
 *     transaction — guaranteeing all-or-nothing DB atomicity.
 *  3. Emit a `token.deployed` event for every successfully persisted token.
 *  4. Return a `BatchDeployResult` regardless of outcome.
 *
 * @param inputs - Validated token deploy inputs (1-10 items).
 * @returns BatchDeployResult with succeeded / failed arrays.
 */
export async function batchDeployTokens(
  inputs: TokenDeployInput[]
): Promise<BatchDeployResult> {
  // ── Phase 1: on-chain calls ──────────────────────────────────────────────
  const stellarResults: StellarDeployResult[] = [];
  const failed: FailedTokenDeploy[] = [];

  for (const input of inputs) {
    try {
      const result = await callStellarDeploy(input);
      stellarResults.push(result);
    } catch (err) {
      // Record this failure and short-circuit — we cannot commit a partial batch.
      failed.push({
        input,
        error: err instanceof Error ? err.message : "Stellar contract call failed",
      });

      // Remaining items in the batch are also marked failed since we will not
      // attempt them once any item has failed (atomicity guarantee).
      for (let i = stellarResults.length + 1; i < inputs.length; i++) {
        failed.push({
          input: inputs[i],
          error: "Skipped due to earlier failure in batch",
        });
      }

      return { succeeded: [], failed };
    }
  }

  // ── Phase 2: atomic DB commit ────────────────────────────────────────────
  try {
    const createdTokens = await prisma.$transaction(
      inputs.map((input, i) => {
        const supply = BigInt(input.initialSupply);
        return prisma.token.create({
          data: {
            address: stellarResults[i].address,
            creator: input.creator,
            name: input.name,
            symbol: input.symbol,
            decimals: input.decimals,
            totalSupply: supply,
            initialSupply: supply,
            totalBurned: BigInt(0),
            burnCount: 0,
            metadataUri: input.metadataUri ?? null,
          },
        });
      })
    );

    // ── Phase 3: event emission ──────────────────────────────────────────
    for (const token of createdTokens as Array<{
      id: string;
      address: string;
      creator: string;
      name: string;
      symbol: string;
      decimals: number;
      totalSupply: bigint;
      initialSupply: bigint;
      totalBurned: bigint;
      burnCount: number;
      metadataUri: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>) {
      // Fire-and-forget: event failures must not roll back a successful batch.
      // Emit events matching the GraphQL schema expectation (tokenAddress, creatorAddress, etc.)
      // to ensure subscription filters (like tenant scoping by creatorAddress) work correctly.
      eventBus
        .publish("token.deployed", {
          tokenAddress: token.address,
          creatorAddress: token.creator,
          name: token.name,
          symbol: token.symbol,
          totalSupply: token.totalSupply.toString(),
          // TODO: once on-chain integration is complete, capture the actual txHash from Stellar
          txHash: `batch-deploy-${token.id}`,
          timestamp: token.createdAt.toISOString(),
        })
        .catch((err) =>
          console.error("[batchDeploy] event emission failed:", err)
        );
    }

    const succeeded: DeployedToken[] = (createdTokens as Array<{
      id: string;
      address: string;
      creator: string;
      name: string;
      symbol: string;
      decimals: number;
      totalSupply: bigint;
      initialSupply: bigint;
      totalBurned: bigint;
      burnCount: number;
      metadataUri: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>).map((token) => ({
      id: token.id,
      address: token.address,
      creator: token.creator,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      totalSupply: token.totalSupply.toString(),
      initialSupply: token.initialSupply.toString(),
      totalBurned: token.totalBurned.toString(),
      burnCount: token.burnCount,
      metadataUri: token.metadataUri,
      createdAt: token.createdAt.toISOString(),
      updatedAt: token.updatedAt.toISOString(),
    }));

    return { succeeded, failed: [] };
  } catch (err) {
    // Prisma transaction rolled back automatically on throw.
    const dbError = err instanceof Error ? err.message : "Database transaction failed";
    return {
      succeeded: [],
      failed: inputs.map((input) => ({ input, error: dbError })),
    };
  }
}
