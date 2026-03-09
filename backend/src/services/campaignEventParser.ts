import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export interface CampaignEvent {
  campaignId: number;
  tokenId: string;
  creator: string;
  type: "BUYBACK" | "AIRDROP" | "LIQUIDITY";
  targetAmount: bigint;
  startTime: Date;
  endTime?: Date;
  metadata?: string;
  txHash: string;
}

export interface CampaignExecutionEvent {
  campaignId: number;
  executor: string;
  amount: bigint;
  recipient?: string;
  txHash: string;
  executedAt: Date;
}

export interface CampaignStatusEvent {
  campaignId: number;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  txHash: string;
}

export class CampaignEventParser {
  async parseCampaignCreated(event: CampaignEvent) {
    await prisma.campaign.upsert({
      where: { campaignId: event.campaignId },
      create: {
        campaignId: event.campaignId,
        tokenId: event.tokenId,
        creator: event.creator,
        type: event.type,
        status: "ACTIVE",
        targetAmount: event.targetAmount,
        currentAmount: BigInt(0),
        executionCount: 0,
        startTime: event.startTime,
        endTime: event.endTime,
        metadata: event.metadata,
        txHash: event.txHash,
      },
      update: {},
    });
  }

  async parseCampaignExecution(event: CampaignExecutionEvent) {
    const campaign = await prisma.campaign.findUnique({
      where: { campaignId: event.campaignId },
    });

    if (!campaign) {
      throw new Error(`Campaign ${event.campaignId} not found`);
    }

    // Check if execution already exists
    const existingExecution = await prisma.campaignExecution.findUnique({
      where: { txHash: event.txHash },
    });

    if (existingExecution) {
      // Already processed, skip
      return;
    }

    await prisma.$transaction([
      prisma.campaignExecution.create({
        data: {
          campaignId: campaign.id,
          executor: event.executor,
          amount: event.amount,
          recipient: event.recipient,
          txHash: event.txHash,
          executedAt: event.executedAt,
        },
      }),
      prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          currentAmount: { increment: event.amount },
          executionCount: { increment: 1 },
          updatedAt: new Date(),
        },
      }),
    ]);
  }

  async parseCampaignStatusChange(event: CampaignStatusEvent) {
    const campaign = await prisma.campaign.findUnique({
      where: { campaignId: event.campaignId },
    });

    if (!campaign) {
      throw new Error(`Campaign ${event.campaignId} not found`);
    }

    const updateData: any = {
      status: event.status,
      updatedAt: new Date(),
    };

    if (event.status === "COMPLETED") {
      updateData.completedAt = new Date();
    } else if (event.status === "CANCELLED") {
      updateData.cancelledAt = new Date();
    }

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: updateData,
    });
  }
}

export const campaignEventParser = new CampaignEventParser();
