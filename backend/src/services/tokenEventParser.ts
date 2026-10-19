import { PrismaClient } from "@prisma/client";
import { eventBus } from "./eventBus";

export interface RawTokenEvent {
  type: "tok_reg" | "tok_burn" | "adm_burn" | "tok_meta" | "fee_chg";
  tokenAddress: string;
  transactionHash: string;
  ledger: number;
  // event schema version; absent means v1 (legacy payloads)
  version?: number;
  // tok_reg fields
  creator?: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  initialSupply?: string;
  // burn fields
  from?: string;
  amount?: string;
  burner?: string;
  admin?: string;
  // metadata fields
  metadataUri?: string;
  updatedBy?: string;
  // fee change fields (v2)
  feeType?: string;
  previousValue?: string;
  newValue?: string;
  // fee change fields (v1 legacy — only the new value was emitted)
  value?: string;
}

export class TokenEventParser {
  constructor(private readonly prisma: PrismaClient) {}

  async parseEvent(event: RawTokenEvent): Promise<void> {
    switch (event.type) {
      case "tok_reg":
        await this.handleTokenCreated(event);
        break;
      case "tok_burn":
        await this.handleBurn(event, false);
        break;
      case "adm_burn":
        await this.handleBurn(event, true);
        break;
      case "tok_meta":
        await this.handleMetadataUpdate(event);
        break;
      case "fee_chg":
        await this.handleFeeChange(event);
        break;
    }
  }

  private async handleTokenCreated(event: RawTokenEvent): Promise<void> {
    const initialSupply = BigInt(event.initialSupply ?? "0");

    await this.prisma.token.upsert({
      where: { address: event.tokenAddress },
      create: {
        address: event.tokenAddress,
        deployTxHash: event.transactionHash,
        creator: event.creator ?? "",
        name: event.name ?? "",
        symbol: event.symbol ?? "",
        decimals: event.decimals ?? 7,
        totalSupply: initialSupply,
        initialSupply,
      },
      update: {}, // idempotent — do not overwrite on replay
    });
  }

  private async handleBurn(
    event: RawTokenEvent,
    isAdminBurn: boolean
  ): Promise<void> {
    // Idempotency: txHash is unique on BurnRecord
    const existing = await this.prisma.burnRecord.findUnique({
      where: { txHash: event.transactionHash },
    });
    if (existing) return;

    const token = await this.prisma.token.findUnique({
      where: { address: event.tokenAddress },
    });
    if (!token) {
      console.warn(
        `TokenEventParser: burn for unknown token ${event.tokenAddress}, skipping`
      );
      return;
    }

    const amount = BigInt(event.amount ?? "0");

    await this.prisma.$transaction([
      this.prisma.burnRecord.create({
        data: {
          tokenId: token.id,
          from: event.from ?? "",
          amount,
          burnedBy: isAdminBurn
            ? (event.admin ?? event.from ?? "")
            : (event.burner ?? event.from ?? ""),
          isAdminBurn,
          txHash: event.transactionHash,
        },
      }),
      this.prisma.token.update({
        where: { id: token.id },
        data: {
          totalBurned: { increment: amount },
          burnCount: { increment: 1 },
          totalSupply: { decrement: amount },
        },
      }),
    ]);

    // Fire-and-forget: notifies the leaderboard service (and any other
    // subscriber) to incrementally update its Redis sorted-set ranking
    // instead of waiting for a full recompute. Mirrors how
    // batchTokenDeployService publishes "token.deployed".
    eventBus
      .publish("token.burned", {
        tokenId: token.id,
        tokenAddress: event.tokenAddress,
        amount: amount.toString(),
        isAdminBurn,
      })
      .catch((err) =>
        console.error("[TokenEventParser] event emission failed:", err)
      );
  }

  private async handleMetadataUpdate(event: RawTokenEvent): Promise<void> {
    await this.prisma.token.updateMany({
      where: { address: event.tokenAddress },
      data: { metadataUri: event.metadataUri ?? null },
    });
  }

  private async handleFeeChange(event: RawTokenEvent): Promise<void> {
    // v1 payloads only carried the new value; v2 adds the previous value.
    // Normalise both shapes so downstream consumers always see old + new.
    const isV2 = (event.version ?? 1) >= 2;
    const newValue = isV2 ? event.newValue : event.value;
    const previousValue = isV2 ? event.previousValue : undefined;

    if (newValue === undefined) {
      console.warn(
        `TokenEventParser: fee_chg for ${event.tokenAddress} missing new value, skipping`
      );
      return;
    }

    eventBus
      .publish("fee.changed", {
        version: isV2 ? 2 : 1,
        tokenAddress: event.tokenAddress,
        transactionHash: event.transactionHash,
        ledger: event.ledger,
        feeType: event.feeType ?? "unknown",
        previousValue: previousValue ?? null,
        newValue,
      })
      .catch((err) =>
        console.error("[TokenEventParser] event emission failed:", err)
      );
  }
}
