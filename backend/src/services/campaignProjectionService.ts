import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export interface CampaignProjection {
  id: string;
  campaignId: number;
  tokenId: string;
  creator: string;
  type: string;
  status: string;
  targetAmount: bigint;
  currentAmount: bigint;
  executionCount: number;
  progress: number;
  startTime: Date;
  endTime?: Date;
  metadata?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  cancelledAt?: Date;
}

export interface CampaignStats {
  totalCampaigns: number;
  activeCampaigns: number;
  completedCampaigns: number;
  totalVolume: bigint;
  totalExecutions: number;
}

export class CampaignProjectionService {
  async getCampaignById(
    campaignId: number
  ): Promise<CampaignProjection | null> {
    const campaign = await prisma.campaign.findUnique({
      where: { campaignId },
      include: {
        executions: {
          orderBy: { executedAt: "desc" },
          take: 10,
        },
      },
    });

    if (!campaign) return null;

    return this.buildProjection(campaign);
  }

  async getCampaignsByToken(tokenId: string): Promise<CampaignProjection[]> {
    const campaigns = await prisma.campaign.findMany({
      where: { tokenId },
      orderBy: { createdAt: "desc" },
    });

    return campaigns.map((c) => this.buildProjection(c));
  }

  async getCampaignsByCreator(creator: string): Promise<CampaignProjection[]> {
    const campaigns = await prisma.campaign.findMany({
      where: { creator },
      orderBy: { createdAt: "desc" },
    });

    return campaigns.map((c) => this.buildProjection(c));
  }

  async getCampaignStats(tokenId?: string): Promise<CampaignStats> {
    const where = tokenId ? { tokenId } : {};

    const [totalCampaigns, activeCampaigns, completedCampaigns, aggregates] =
      await Promise.all([
        prisma.campaign.count({ where }),
        prisma.campaign.count({ where: { ...where, status: "ACTIVE" } }),
        prisma.campaign.count({ where: { ...where, status: "COMPLETED" } }),
        prisma.campaign.aggregate({
          where,
          _sum: {
            currentAmount: true,
            executionCount: true,
          },
        }),
      ]);

    return {
      totalCampaigns,
      activeCampaigns,
      completedCampaigns,
      totalVolume: aggregates._sum.currentAmount || BigInt(0),
      totalExecutions: aggregates._sum.executionCount || 0,
    };
  }

  async getExecutionHistory(campaignId: number, limit = 50, offset = 0) {
    const campaign = await prisma.campaign.findUnique({
      where: { campaignId },
    });

    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    const [executions, total] = await Promise.all([
      prisma.campaignExecution.findMany({
        where: { campaignId: campaign.id },
        orderBy: { executedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.campaignExecution.count({
        where: { campaignId: campaign.id },
      }),
    ]);

    return { executions, total };
  }

  private buildProjection(campaign: any): CampaignProjection {
    const progress =
      campaign.targetAmount > 0
        ? Number((campaign.currentAmount * BigInt(100)) / campaign.targetAmount)
        : 0;

    return {
      id: campaign.id,
      campaignId: campaign.campaignId,
      tokenId: campaign.tokenId,
      creator: campaign.creator,
      type: campaign.type,
      status: campaign.status,
      targetAmount: campaign.targetAmount,
      currentAmount: campaign.currentAmount,
      executionCount: campaign.executionCount,
      progress,
      startTime: campaign.startTime,
      endTime: campaign.endTime,
      metadata: campaign.metadata,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      completedAt: campaign.completedAt,
      cancelledAt: campaign.cancelledAt,
    };
  }
}

export const campaignProjectionService = new CampaignProjectionService();
