import { PrismaClient, StreamStatus } from "@prisma/client";
import axios from "axios";
import { logger } from "../lib/logger";
import { stellarConfig } from "../lib/stellar";
import { eventBus } from "./eventBus";

export interface StreamDivergence {
  streamId: number;
  creator: string;
  recipient: string;
  /** Name of the field that diverged, e.g. "balance" */
  field: string;
  projectedValue: string;
  onChainValue: string;
  divergenceType: "mismatch" | "missing_onchain" | "missing_projected";
  severity: "error" | "warning";
  timestamp: Date;
}

/** Payload published on the eventBus when reconciliation finds a divergence */
export interface StreamDivergenceDetectedPayload {
  streamId: number;
  field: string;
  onChainValue: string;
  projectedValue: string;
}

export interface StreamReconciliationResult {
  totalStreams: number;
  streamsChecked: number;
  divergences: StreamDivergence[];
  errors: string[];
  reconciliationTime: number;
  timestamp: Date;
}

export class StreamReconciliationService {
  private prisma: PrismaClient;
  private reconciliationIntervalMs: number;
  private lastReconciliation?: Date;
  private horizonUrl: string;
  private factoryContractId: string;

  constructor(
    prisma: PrismaClient,
    reconciliationIntervalMs: number = parseInt(
      process.env.STREAM_RECONCILIATION_INTERVAL_MS || "300000"
    ), // 5 minutes default
    config: { horizonUrl?: string; factoryContractId?: string } = {}
  ) {
    this.prisma = prisma;
    this.reconciliationIntervalMs = reconciliationIntervalMs;
    this.horizonUrl =
      config.horizonUrl ||
      process.env.STELLAR_HORIZON_URL ||
      stellarConfig.horizonUrl;
    this.factoryContractId =
      config.factoryContractId ||
      process.env.FACTORY_CONTRACT_ID ||
      stellarConfig.factoryContractId;
  }

  async reconcile(): Promise<StreamReconciliationResult> {
    const startTime = Date.now();
    logger.debug("Starting stream settlement reconciliation");

    const divergences: StreamDivergence[] = [];
    const errors: string[] = [];

    try {
      const streams = await this.prisma.stream.findMany({
        where: {
          status: { in: [StreamStatus.CREATED, StreamStatus.CLAIMED] },
        },
        select: {
          streamId: true,
          creator: true,
          recipient: true,
          amount: true,
          claimedAt: true,
          status: true,
        },
      });

      const totalStreams = streams.length;
      let streamsChecked = 0;

      for (const stream of streams) {
        try {
          streamsChecked++;

          const projectedBalance = this.calculateProjectedBalance(stream);
          const onChainBalance = await this.fetchOnChainBalance(stream.streamId);

          if (
            onChainBalance !== null &&
            projectedBalance !== onChainBalance.toString()
          ) {
            const divergence: StreamDivergence = {
              streamId: stream.streamId,
              creator: stream.creator,
              recipient: stream.recipient,
              field: "balance",
              projectedValue: projectedBalance,
              onChainValue: onChainBalance.toString(),
              divergenceType: "mismatch",
              severity: "error",
              timestamp: new Date(),
            };
            divergences.push(divergence);

            const eventPayload: StreamDivergenceDetectedPayload = {
              streamId: divergence.streamId,
              field: divergence.field,
              onChainValue: divergence.onChainValue,
              projectedValue: divergence.projectedValue,
            };
            await eventBus.publish("stream.divergence_detected", eventPayload);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Stream ${stream.streamId} check failed: ${msg}`);
        }
      }

      this.lastReconciliation = new Date();

      if (divergences.length > 0) {
        logger.warn(
          `Found ${divergences.length} stream divergences during reconciliation`
        );
      }

      return {
        totalStreams,
        streamsChecked,
        divergences,
        errors,
        reconciliationTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Reconciliation failed: ${msg}`);
      errors.push(`Reconciliation failed: ${msg}`);

      return {
        totalStreams: 0,
        streamsChecked: 0,
        divergences,
        errors,
        reconciliationTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    }
  }

  private calculateProjectedBalance(stream: any): string {
    if (stream.status === StreamStatus.CLAIMED) {
      return "0";
    }
    return stream.amount.toString();
  }

  private async fetchOnChainBalance(streamId: number): Promise<bigint | null> {
    try {
      if (!this.factoryContractId) {
        return null;
      }

      const response = await axios.get(
        `${this.horizonUrl}/contracts/${this.factoryContractId}/events`,
        {
          params: {
            topic: `vlt_cr_v1,${streamId}`,
            limit: 10,
            order: "desc",
          },
          timeout: 10000,
        }
      );

      const records = response.data?._embedded?.records || [];
      if (records.length === 0) {
        // Fallback query across recent contract events to locate this stream
        const fallbackResponse = await axios.get(
          `${this.horizonUrl}/contracts/${this.factoryContractId}/events`,
          {
            params: {
              limit: 50,
              order: "desc",
            },
            timeout: 10000,
          }
        );
        const fallbackRecords = fallbackResponse.data?._embedded?.records || [];
        const matching = fallbackRecords.find(
          (r: any) =>
            r.topic?.[1] === String(streamId) ||
            r.value?.stream_id === streamId ||
            r.value?.streamId === streamId
        );
        if (matching) {
          return this.parseStreamBalanceFromEvent(matching);
        }
        return null;
      }

      return this.parseStreamBalanceFromEvent(records[0]);
    } catch (err) {
      logger.warn(
        `Failed to fetch on-chain balance for stream ${streamId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return null;
    }
  }

  private parseStreamBalanceFromEvent(event: any): bigint {
    const topic = event?.topic?.[0];
    if (
      topic === "vlt_cl_v1" ||
      topic === "vlt_cn_v1" ||
      topic === "strm_cl_v1" ||
      topic === "strm_cn_v1"
    ) {
      return BigInt(0);
    }
    const value = event?.value;
    if (value === undefined || value === null) {
      return BigInt(0);
    }
    if (typeof value === "object") {
      if (value.amount !== undefined) {
        return BigInt(value.amount);
      }
      if (Array.isArray(value) && value.length >= 3) {
        return BigInt(value[2]);
      }
    }
    return BigInt(value.toString());
  }

  getLastReconciliationTime(): Date | undefined {
    return this.lastReconciliation;
  }

  shouldReconcile(): boolean {
    if (!this.lastReconciliation) return true;
    return (
      Date.now() - this.lastReconciliation.getTime() >=
      this.reconciliationIntervalMs
    );
  }

  formatResults(result: StreamReconciliationResult): string {
    const lines: string[] = [];
    lines.push("═══════════════════════════════════════════════════════");
    lines.push("  Stream Settlement Reconciliation Results");
    lines.push("═══════════════════════════════════════════════════════");
    lines.push(`  Timestamp:        ${result.timestamp.toISOString()}`);
    lines.push(`  Duration:         ${result.reconciliationTime}ms`);
    lines.push(`  Total Streams:    ${result.totalStreams}`);
    lines.push(`  Checked:          ${result.streamsChecked}`);
    lines.push(`  Divergences:      ${result.divergences.length}`);
    lines.push(`  Errors:           ${result.errors.length}`);
    lines.push("───────────────────────────────────────────────────────");

    if (result.errors.length > 0) {
      lines.push("  ERRORS:");
      result.errors.forEach((err) => {
        lines.push(`    ⚠ ${err}`);
      });
      lines.push("");
    }

    if (result.divergences.length > 0) {
      lines.push("  DIVERGENCES:");
      result.divergences.forEach((div) => {
        lines.push(`    ❌ Stream ${div.streamId} (${div.field})`);
        lines.push(`       Projected: ${div.projectedValue}`);
        lines.push(`       On-chain:  ${div.onChainValue}`);
      });
    } else {
      lines.push("  ✅ All streams reconciled successfully");
    }

    lines.push("═══════════════════════════════════════════════════════");
    return lines.join("\n");
  }
}

export const streamReconciliationService = new StreamReconciliationService(
  new PrismaClient()
);
