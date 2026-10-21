import { PrismaClient } from "@prisma/client";
import axios from "axios";

/**
 * On-Chain to Backend Projection Verifier
 *
 * Provides automated consistency verification between on-chain contract state
 * and backend database projections for tokens, burns and stream vaults.
 *
 * Usage:
 * - CI pipelines: Run as part of integration tests
 * - Operational smoke tests: Post-deploy verification
 * - Monitoring: Periodic drift detection
 */

// ============================================================================
// Type Definitions
// ============================================================================

export interface OnChainTokenState {
  address: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  initialSupply: bigint;
  totalBurned: bigint;
  burnCount: number;
}

export interface OnChainBurnRecord {
  tokenAddress: string;
  from: string;
  amount: bigint;
  burnedBy: string;
  isAdminBurn: boolean;
  txHash: string;
}

export interface OnChainFactoryState {
  admin: string;
  treasury: string;
  baseFee: bigint;
  metadataFee: bigint;
  paused: boolean;
  tokenCount: number;
}

/**
 * On-chain vault (stream escrow) state, folded from the contract's
 * `vlt_cr_v1` / `vlt_cl_v1` / `vlt_cn_v1` events.
 */
export interface OnChainVaultState {
  streamId: number;
  creator: string;
  recipient: string;
  amount: bigint;
  status: "CREATED" | "CLAIMED" | "CANCELLED";
}

export interface ConsistencyDiff {
  entity: "token" | "burn" | "factory" | "vault";
  identifier: string;
  field: string;
  backendValue: string | number | boolean | null;
  onChainValue: string | number | boolean | null;
  severity: "error" | "warning";
}

export interface ConsistencyCheckResult {
  consistent: boolean;
  timestamp: Date;
  totalChecked: number;
  tokensChecked: number;
  burnsChecked: number;
  diffs: ConsistencyDiff[];
  errors: string[];
  duration: number;
}

export interface VerifierConfig {
  horizonUrl?: string;
  factoryContractId?: string;
  sorobanRpcUrl?: string;
  tolerances?: {
    amountDriftPercent?: number;
    countDriftAbsolute?: number;
  };
}

// ============================================================================
// On-Chain Data Fetcher
// ============================================================================

export class OnChainDataFetcher {
  private horizonUrl: string;
  private factoryContractId: string;
  private sorobanRpcUrl: string;

  constructor(config: VerifierConfig = {}) {
    this.horizonUrl =
      config.horizonUrl ||
      process.env.STELLAR_HORIZON_URL ||
      "https://horizon-testnet.stellar.org";
    this.factoryContractId =
      config.factoryContractId || process.env.FACTORY_CONTRACT_ID || "";
    this.sorobanRpcUrl =
      config.sorobanRpcUrl ||
      process.env.SOROBAN_RPC_URL ||
      "https://soroban-testnet.stellar.org";
  }

  /**
   * Fetch factory state from on-chain contract
   */
  async fetchFactoryState(): Promise<OnChainFactoryState | null> {
    if (!this.factoryContractId) {
      return null;
    }

    try {
      const response = await axios.get(
        `${this.horizonUrl}/contracts/${this.factoryContractId}/events`,
        {
          params: { limit: 1, order: "desc" },
          timeout: 10000,
        }
      );

      if (response.data?._embedded?.records?.length > 0) {
        return this.parseFactoryStateFromEvents(response.data._embedded.records);
      }
      return null;
    } catch (error) {
      console.warn("Failed to fetch factory state from Horizon:", error);
      return null;
    }
  }

  /**
   * Fetch token count from on-chain contract
   */
  async fetchTokenCount(): Promise<number | null> {
    try {
      const state = await this.fetchFactoryState();
      return state?.tokenCount ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch burn events for a token from Horizon
   */
  async fetchBurnEvents(
    tokenAddress: string
  ): Promise<OnChainBurnRecord[] | null> {
    try {
      const response = await axios.get(
        `${this.horizonUrl}/contracts/${this.factoryContractId}/events`,
        {
          params: {
            topic: `tok_burn,${tokenAddress}`,
            limit: 200,
            order: "asc",
          },
          timeout: 15000,
        }
      );

      if (response.data?._embedded?.records) {
        return response.data._embedded.records
          .filter(
            (r: any) =>
              r.topic?.[0] === "tok_burn" || r.topic?.[0] === "adm_burn"
          )
          .map((r: any) => this.parseBurnEvent(r));
      }
      return [];
    } catch (error) {
      console.warn(
        `Failed to fetch burn events for ${tokenAddress}:`,
        error
      );
      return null;
    }
  }

  /**
   * Fetch every vault lifecycle event from Horizon and fold them into the
   * current per-vault state. Returns null when the factory contract isn't
   * configured or the event lookup fails, so callers can report "could not
   * compare" instead of treating every vault as missing on-chain.
   */
  async fetchVaultStates(
    maxPages = 50
  ): Promise<Map<number, OnChainVaultState> | null> {
    if (!this.factoryContractId) {
      return null;
    }

    const states = new Map<number, OnChainVaultState>();
    let cursor: string | undefined;

    try {
      for (let page = 0; page < maxPages; page++) {
        const response = await axios.get(
          `${this.horizonUrl}/contracts/${this.factoryContractId}/events`,
          {
            params: { limit: 200, order: "asc", ...(cursor ? { cursor } : {}) },
            timeout: 15000,
          }
        );

        const records: any[] = response.data?._embedded?.records ?? [];
        for (const record of records) {
          this.applyVaultEvent(states, record);
        }

        if (records.length < 200) break;
        cursor = records[records.length - 1]?.paging_token;
        if (!cursor) break;
      }
      return states;
    } catch (error) {
      console.warn("Failed to fetch vault events from Horizon:", error);
      return null;
    }
  }

  private applyVaultEvent(
    states: Map<number, OnChainVaultState>,
    event: any
  ): void {
    const topic = event?.topic?.[0];
    const value = event?.value ?? {};
    const streamId = Number(value.stream_id ?? value.streamId ?? event?.topic?.[1]);
    if (!Number.isInteger(streamId)) return;

    if (topic === "vlt_cr_v1") {
      states.set(streamId, {
        streamId,
        creator: value.creator || "",
        recipient: value.recipient || "",
        amount: BigInt(value.amount || "0"),
        status: "CREATED",
      });
      return;
    }

    const existing = states.get(streamId);
    if (!existing) return;
    if (topic === "vlt_cl_v1") existing.status = "CLAIMED";
    if (topic === "vlt_cn_v1") existing.status = "CANCELLED";
  }

  private parseFactoryStateFromEvents(events: any[]): OnChainFactoryState {
    const latest = events[0];
    return {
      admin: latest?.value?.admin || "",
      treasury: latest?.value?.treasury || "",
      baseFee: BigInt(latest?.value?.base_fee || "0"),
      metadataFee: BigInt(latest?.value?.metadata_fee || "0"),
      paused: latest?.value?.paused || false,
      tokenCount: parseInt(latest?.value?.token_count || "0", 10),
    };
  }

  private parseBurnEvent(event: any): OnChainBurnRecord {
    const value = event.value || {};
    return {
      tokenAddress: value.token_address || event.topic?.[1] || "",
      from: value.from || "",
      amount: BigInt(value.amount || "0"),
      burnedBy: value.burned_by || value.from || "",
      isAdminBurn: event.topic?.[0] === "adm_burn",
      txHash: event.transaction_hash || event.id || "",
    };
  }
}

// ============================================================================
// On-Chain Projection Verifier
// ============================================================================

export class OnChainProjectionVerifier {
  private prisma: PrismaClient;
  private fetcher: OnChainDataFetcher;
  private tolerances: {
    amountDriftPercent: number;
    countDriftAbsolute: number;
  };

  constructor(
    prisma: PrismaClient,
    config: VerifierConfig = {}
  ) {
    this.prisma = prisma;
    this.fetcher = new OnChainDataFetcher(config);
    this.tolerances = {
      amountDriftPercent: config.tolerances?.amountDriftPercent ?? 0,
      countDriftAbsolute: config.tolerances?.countDriftAbsolute ?? 0,
    };
  }

  /**
   * Run full consistency check across all entity types
   */
  async runFullCheck(): Promise<ConsistencyCheckResult> {
    const startTime = Date.now();
    const diffs: ConsistencyDiff[] = [];
    const errors: string[] = [];
    let tokensChecked = 0;
    let burnsChecked = 0;

    try {
      // Check token counts
      const tokenResult = await this.checkTokenCounts();
      diffs.push(...tokenResult.diffs);
      errors.push(...tokenResult.errors);
      tokensChecked = tokenResult.checked;

      // Check burn totals
      const burnResult = await this.checkBurnTotals();
      diffs.push(...burnResult.diffs);
      errors.push(...burnResult.errors);
      burnsChecked = burnResult.checked;
    } catch (error) {
      errors.push(
        `Full check failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const duration = Date.now() - startTime;

    return {
      consistent: diffs.length === 0 && errors.length === 0,
      timestamp: new Date(),
      totalChecked: tokensChecked + burnsChecked,
      tokensChecked,
      burnsChecked,
      diffs,
      errors,
      duration,
    };
  }

  /**
   * Check token count consistency between backend and on-chain
   */
  async checkTokenCounts(): Promise<{
    diffs: ConsistencyDiff[];
    errors: string[];
    checked: number;
  }> {
    const diffs: ConsistencyDiff[] = [];
    const errors: string[] = [];

    try {
      const backendTokenCount = await this.prisma.token.count();
      const onChainTokenCount = await this.fetcher.fetchTokenCount();

      if (onChainTokenCount === null) {
        errors.push("Could not fetch on-chain token count");
        return { diffs, errors, checked: backendTokenCount };
      }

      const drift = Math.abs(backendTokenCount - onChainTokenCount);
      if (drift > this.tolerances.countDriftAbsolute) {
        diffs.push({
          entity: "factory",
          identifier: "token_count",
          field: "tokenCount",
          backendValue: backendTokenCount,
          onChainValue: onChainTokenCount,
          severity: drift > 5 ? "error" : "warning",
        });
      }

      return { diffs, errors, checked: backendTokenCount };
    } catch (error) {
      errors.push(
        `Token count check failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return { diffs, errors, checked: 0 };
    }
  }

  /**
   * Check burn total consistency for all tokens
   */
  async checkBurnTotals(): Promise<{
    diffs: ConsistencyDiff[];
    errors: string[];
    checked: number;
  }> {
    const diffs: ConsistencyDiff[] = [];
    const errors: string[] = [];
    let checked = 0;

    try {
      const tokens = await this.prisma.token.findMany({
        where: { burnCount: { gt: 0 } },
        select: {
          address: true,
          totalBurned: true,
          burnCount: true,
        },
      });

      for (const token of tokens) {
        checked++;
        const onChainBurns = await this.fetcher.fetchBurnEvents(token.address);

        if (onChainBurns === null) {
          errors.push(`Could not fetch burns for token ${token.address}`);
          continue;
        }

        const onChainBurnCount = onChainBurns.length;
        const onChainTotalBurned = onChainBurns.reduce(
          (sum, b) => sum + b.amount,
          BigInt(0)
        );

        // Check burn count
        if (Math.abs(token.burnCount - onChainBurnCount) > this.tolerances.countDriftAbsolute) {
          diffs.push({
            entity: "burn",
            identifier: token.address,
            field: "burnCount",
            backendValue: token.burnCount,
            onChainValue: onChainBurnCount,
            severity: "error",
          });
        }

        // Check total burned
        if (!this.isWithinTolerance(token.totalBurned, onChainTotalBurned)) {
          diffs.push({
            entity: "burn",
            identifier: token.address,
            field: "totalBurned",
            backendValue: token.totalBurned.toString(),
            onChainValue: onChainTotalBurned.toString(),
            severity: "error",
          });
        }

        // Auto-reconcile when divergence is detected
        if (
          Math.abs(token.burnCount - onChainBurnCount) > this.tolerances.countDriftAbsolute ||
          !this.isWithinTolerance(token.totalBurned, onChainTotalBurned)
        ) {
          try {
            await this.reconcileProjection(token.address);
          } catch (reconcileErr) {
            errors.push(
              `Auto-reconciliation failed for ${token.address}: ${
                reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)
              }`
            );
          }
        }
      }

      return { diffs, errors, checked };
    } catch (error) {
      errors.push(
        `Burn totals check failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return { diffs, errors, checked };
    }
  }

  /**
   * Compare every projected vault (`Stream` row) with the state folded from
   * on-chain vault events. Read-only: unlike `checkBurnTotals`, this never
   * auto-reconciles. It only reports.
   */
  async checkVaultConsistency(): Promise<{
    diffs: ConsistencyDiff[];
    errors: string[];
    projected: number;
    onChain: number;
  }> {
    const diffs: ConsistencyDiff[] = [];
    const errors: string[] = [];

    try {
      const streams = await this.prisma.stream.findMany({
        select: {
          streamId: true,
          creator: true,
          recipient: true,
          amount: true,
          status: true,
        },
        orderBy: { streamId: "asc" },
      });

      const onChain = await this.fetcher.fetchVaultStates();
      if (onChain === null) {
        errors.push("Could not fetch on-chain vault state");
        return { diffs, errors, projected: streams.length, onChain: 0 };
      }

      const seen = new Set<number>();
      for (const stream of streams) {
        seen.add(stream.streamId);
        const identifier = String(stream.streamId);
        const chain = onChain.get(stream.streamId);

        if (!chain) {
          diffs.push({
            entity: "vault",
            identifier,
            field: "existence",
            backendValue: "exists",
            onChainValue: null,
            severity: "error",
          });
          continue;
        }

        if (stream.status !== chain.status) {
          diffs.push({
            entity: "vault",
            identifier,
            field: "status",
            backendValue: stream.status,
            onChainValue: chain.status,
            severity: "error",
          });
        }

        if (!this.isWithinTolerance(stream.amount, chain.amount)) {
          diffs.push({
            entity: "vault",
            identifier,
            field: "amount",
            backendValue: stream.amount.toString(),
            onChainValue: chain.amount.toString(),
            severity: "error",
          });
        }

        for (const field of ["creator", "recipient"] as const) {
          if (chain[field] && stream[field] !== chain[field]) {
            diffs.push({
              entity: "vault",
              identifier,
              field,
              backendValue: stream[field],
              onChainValue: chain[field],
              severity: "error",
            });
          }
        }
      }

      for (const [streamId, chain] of onChain) {
        if (seen.has(streamId)) continue;
        diffs.push({
          entity: "vault",
          identifier: String(streamId),
          field: "existence",
          backendValue: null,
          onChainValue: "exists",
          // A vault created moments ago may simply not be ingested yet.
          severity: chain.status === "CREATED" ? "warning" : "error",
        });
      }

      return { diffs, errors, projected: streams.length, onChain: onChain.size };
    } catch (error) {
      errors.push(
        `Vault consistency check failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return { diffs, errors, projected: 0, onChain: 0 };
    }
  }

  /**
   * Structured report of on-chain vault state vs. the projection, for the
   * admin reconciliation endpoint (#2208). Mismatches are grouped by kind so
   * operators can tell missing rows apart from drifted fields.
   */
  async buildVaultReconciliationReport(): Promise<VaultReconciliationReport> {
    const startTime = Date.now();
    const { diffs, errors, projected, onChain } =
      await this.checkVaultConsistency();

    const mismatches: VaultMismatch[] = diffs.map((d) => ({
      streamId: Number(d.identifier),
      kind:
        d.field !== "existence"
          ? "field_mismatch"
          : d.backendValue === null
            ? "missing_in_projection"
            : "missing_on_chain",
      field: d.field,
      projectionValue: d.backendValue,
      onChainValue: d.onChainValue,
      severity: d.severity,
    }));

    const count = (kind: VaultMismatch["kind"]) =>
      mismatches.filter((m) => m.kind === kind).length;

    return {
      consistent: mismatches.length === 0 && errors.length === 0,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      summary: {
        projectedVaults: projected,
        onChainVaults: onChain,
        mismatchedVaults: new Set(mismatches.map((m) => m.streamId)).size,
        totalMismatches: mismatches.length,
        missingOnChain: count("missing_on_chain"),
        missingInProjection: count("missing_in_projection"),
        fieldMismatches: count("field_mismatch"),
        errors: errors.length,
      },
      mismatches,
      errors,
    };
  }

  /**
   * Check a single token's burn consistency
   */
  async checkTokenBurnConsistency(
    tokenAddress: string,
    onChainState: OnChainTokenState
  ): Promise<ConsistencyDiff[]> {
    const diffs: ConsistencyDiff[] = [];

    const backendToken = await this.prisma.token.findUnique({
      where: { address: tokenAddress },
    });

    if (!backendToken) {
      diffs.push({
        entity: "token",
        identifier: tokenAddress,
        field: "existence",
        backendValue: null,
        onChainValue: "exists",
        severity: "error",
      });
      return diffs;
    }

    if (backendToken.totalBurned !== onChainState.totalBurned) {
      diffs.push({
        entity: "token",
        identifier: tokenAddress,
        field: "totalBurned",
        backendValue: backendToken.totalBurned.toString(),
        onChainValue: onChainState.totalBurned.toString(),
        severity: "error",
      });
    }

    if (backendToken.burnCount !== onChainState.burnCount) {
      diffs.push({
        entity: "token",
        identifier: tokenAddress,
        field: "burnCount",
        backendValue: backendToken.burnCount,
        onChainValue: onChainState.burnCount,
        severity: "error",
      });
    }

    if (backendToken.totalSupply !== onChainState.totalSupply) {
      diffs.push({
        entity: "token",
        identifier: tokenAddress,
        field: "totalSupply",
        backendValue: backendToken.totalSupply.toString(),
        onChainValue: onChainState.totalSupply.toString(),
        severity: "error",
      });
    }

    return diffs;
  }

  /**
   * Reconcile Prisma projection for a single token against on-chain state.
   *
   * Idempotent: calling this multiple times produces the same result.
   * If the projection already matches on-chain state, no write is performed.
   *
   * @param tokenAddress - Stellar contract address of the token
   */
  async reconcileProjection(tokenAddress: string): Promise<ReconciliationResult> {
    const now = new Date();
    const fieldsUpdated: string[] = [];

    // Fetch on-chain burn events
    const onChainBurns = await this.fetcher.fetchBurnEvents(tokenAddress);

    if (onChainBurns === null) {
      throw new Error(
        `reconcileProjection: could not fetch on-chain data for ${tokenAddress}`
      );
    }

    const onChainBurnCount = onChainBurns.length;
    const onChainTotalBurned = onChainBurns.reduce(
      (sum, b) => sum + b.amount,
      BigInt(0)
    );

    const token = await this.prisma.token.findUnique({
      where: { address: tokenAddress },
      select: { totalBurned: true, burnCount: true, lastReconciledAt: true },
    });

    if (!token) {
      throw new Error(
        `reconcileProjection: token not found in projection: ${tokenAddress}`
      );
    }

    // Build update payload — only fields that differ
    const updateData: Record<string, any> = { lastReconciledAt: now };

    if (token.totalBurned !== onChainTotalBurned) {
      updateData.totalBurned = onChainTotalBurned;
      fieldsUpdated.push("totalBurned");
    }

    if (token.burnCount !== onChainBurnCount) {
      updateData.burnCount = onChainBurnCount;
      fieldsUpdated.push("burnCount");
    }

    await this.prisma.token.update({
      where: { address: tokenAddress },
      data: updateData,
    });

    return {
      tokenAddress,
      fieldsUpdated,
      alreadyConsistent: fieldsUpdated.length === 0,
      lastReconciledAt: now,
    };
  }

  /**
   * Format check results for human-readable output
   */
  formatResults(result: ConsistencyCheckResult): string {
    const lines: string[] = [];

    lines.push("═══════════════════════════════════════════════════════");
    lines.push("  On-Chain Projection Consistency Check Results");
    lines.push("═══════════════════════════════════════════════════════");
    lines.push(`  Timestamp:  ${result.timestamp.toISOString()}`);
    lines.push(`  Duration:   ${result.duration}ms`);
    lines.push(`  Consistent: ${result.consistent ? "✅ YES" : "❌ NO"}`);
    lines.push("───────────────────────────────────────────────────────");
    lines.push(`  Tokens checked:    ${result.tokensChecked}`);
    lines.push(`  Burns checked:     ${result.burnsChecked}`);
    lines.push(`  Total checked:     ${result.totalChecked}`);
    lines.push("───────────────────────────────────────────────────────");

    if (result.errors.length > 0) {
      lines.push("  ERRORS:");
      for (const error of result.errors) {
        lines.push(`    ⚠ ${error}`);
      }
      lines.push("");
    }

    if (result.diffs.length > 0) {
      lines.push("  INCONSISTENCIES:");
      for (const diff of result.diffs) {
        const icon = diff.severity === "error" ? "❌" : "⚠";
        lines.push(
          `    ${icon} [${diff.entity}] ${diff.identifier}.${diff.field}`
        );
        lines.push(`       Backend:  ${diff.backendValue}`);
        lines.push(`       On-chain: ${diff.onChainValue}`);
      }
    } else if (result.errors.length === 0) {
      lines.push("  ✅ No inconsistencies found");
    }

    lines.push("═══════════════════════════════════════════════════════");

    return lines.join("\n");
  }

  /**
   * Generate JSON report for CI/monitoring systems
   */
  generateReport(result: ConsistencyCheckResult): object {
    return {
      success: result.consistent,
      timestamp: result.timestamp.toISOString(),
      duration_ms: result.duration,
      summary: {
        tokens_checked: result.tokensChecked,
        burns_checked: result.burnsChecked,
        total_checked: result.totalChecked,
        inconsistencies: result.diffs.length,
        errors: result.errors.length,
      },
      diffs: result.diffs.map((d) => ({
        entity: d.entity,
        identifier: d.identifier,
        field: d.field,
        backend_value: d.backendValue,
        onchain_value: d.onChainValue,
        severity: d.severity,
      })),
      errors: result.errors,
    };
  }

  private isWithinTolerance(
    backendValue: bigint,
    onChainValue: bigint
  ): boolean {
    if (this.tolerances.amountDriftPercent === 0) {
      return backendValue === onChainValue;
    }

    const maxVal =
      backendValue > onChainValue ? backendValue : onChainValue;
    if (maxVal === BigInt(0)) return true;

    const diff =
      backendValue > onChainValue
        ? backendValue - onChainValue
        : onChainValue - backendValue;

    const percentDiff = Number((diff * BigInt(100)) / maxVal);
    return percentDiff <= this.tolerances.amountDriftPercent;
  }
}

// ============================================================================
// Vault reconciliation report
// ============================================================================

export interface VaultMismatch {
  streamId: number;
  kind: "missing_on_chain" | "missing_in_projection" | "field_mismatch";
  /** `"existence"` for missing rows, otherwise the drifted field. */
  field: string;
  projectionValue: string | number | boolean | null;
  onChainValue: string | number | boolean | null;
  severity: "error" | "warning";
}

export interface VaultReconciliationReport {
  consistent: boolean;
  generatedAt: string;
  durationMs: number;
  summary: {
    projectedVaults: number;
    onChainVaults: number;
    mismatchedVaults: number;
    totalMismatches: number;
    missingOnChain: number;
    missingInProjection: number;
    fieldMismatches: number;
    errors: number;
  };
  mismatches: VaultMismatch[];
  errors: string[];
}

// ============================================================================
// Reconciliation
// ============================================================================

export interface ReconciliationResult {
  tokenAddress: string;
  fieldsUpdated: string[];
  alreadyConsistent: boolean;
  lastReconciledAt: Date;
}

// ============================================================================
// CLI Runner (for scripts)
// ============================================================================

export async function runConsistencyCheck(
  config: VerifierConfig = {}
): Promise<ConsistencyCheckResult> {
  const prisma = new PrismaClient();

  try {
    const verifier = new OnChainProjectionVerifier(prisma, config);
    return await verifier.runFullCheck();
  } finally {
    await prisma.$disconnect();
  }
}

export async function runAndPrintConsistencyCheck(
  config: VerifierConfig = {}
): Promise<boolean> {
  const prisma = new PrismaClient();

  try {
    const verifier = new OnChainProjectionVerifier(prisma, config);
    const result = await verifier.runFullCheck();
    console.log(verifier.formatResults(result));
    return result.consistent;
  } finally {
    await prisma.$disconnect();
  }
}
