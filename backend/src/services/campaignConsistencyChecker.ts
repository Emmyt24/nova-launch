import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export interface OnChainCampaignState {
  campaignId: number;
  status: string;
  currentAmount: bigint;
  executionCount: number;
  targetAmount: bigint;
}

export interface ConsistencyDiff {
  campaignId: number;
  field: string;
  backendValue: any;
  onChainValue: any;
}

export interface ConsistencyCheckResult {
  consistent: boolean;
  totalChecked: number;
  diffs: ConsistencyDiff[];
}

export class CampaignConsistencyChecker {
  async checkCampaign(
    campaignId: number,
    onChainState: OnChainCampaignState
  ): Promise<ConsistencyDiff[]> {
    const backendCampaign = await prisma.campaign.findUnique({
      where: { campaignId },
    });

    if (!backendCampaign) {
      return [
        {
          campaignId,
          field: "existence",
          backendValue: null,
          onChainValue: "exists",
        },
      ];
    }

    const diffs: ConsistencyDiff[] = [];

    if (backendCampaign.status !== onChainState.status) {
      diffs.push({
        campaignId,
        field: "status",
        backendValue: backendCampaign.status,
        onChainValue: onChainState.status,
      });
    }

    if (backendCampaign.currentAmount !== onChainState.currentAmount) {
      diffs.push({
        campaignId,
        field: "currentAmount",
        backendValue: backendCampaign.currentAmount.toString(),
        onChainValue: onChainState.currentAmount.toString(),
      });
    }

    if (backendCampaign.executionCount !== onChainState.executionCount) {
      diffs.push({
        campaignId,
        field: "executionCount",
        backendValue: backendCampaign.executionCount,
        onChainValue: onChainState.executionCount,
      });
    }

    if (backendCampaign.targetAmount !== onChainState.targetAmount) {
      diffs.push({
        campaignId,
        field: "targetAmount",
        backendValue: backendCampaign.targetAmount.toString(),
        onChainValue: onChainState.targetAmount.toString(),
      });
    }

    return diffs;
  }

  async checkMultipleCampaigns(
    onChainStates: OnChainCampaignState[]
  ): Promise<ConsistencyCheckResult> {
    const allDiffs: ConsistencyDiff[] = [];

    for (const onChainState of onChainStates) {
      const diffs = await this.checkCampaign(
        onChainState.campaignId,
        onChainState
      );
      allDiffs.push(...diffs);
    }

    return {
      consistent: allDiffs.length === 0,
      totalChecked: onChainStates.length,
      diffs: allDiffs,
    };
  }

  formatDiffs(diffs: ConsistencyDiff[]): string {
    if (diffs.length === 0) {
      return "✅ No inconsistencies found";
    }

    let output = `❌ Found ${diffs.length} inconsistencies:\n\n`;

    for (const diff of diffs) {
      output += `Campaign ${diff.campaignId} - ${diff.field}:\n`;
      output += `  Backend:  ${diff.backendValue}\n`;
      output += `  On-chain: ${diff.onChainValue}\n\n`;
    }

    return output;
  }
}

export const campaignConsistencyChecker = new CampaignConsistencyChecker();
