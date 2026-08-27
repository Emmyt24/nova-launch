import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  validateCampaignCreate,
  validateCampaignId,
} from "../middleware/validation";
import { idempotencyMiddleware } from "../middleware/idempotency";
import { successResponse, errorResponse } from "../utils/response";
import { prisma } from "../lib/prisma";

const router = Router();

function serializeCampaign(c: any) {
  return {
    ...c,
    targetAmount: c.targetAmount?.toString?.() ?? c.targetAmount,
    currentAmount: c.currentAmount?.toString?.() ?? c.currentAmount,
  };
}

/**
 * GET /api/campaigns/stats/:tokenId?
 * Aggregate campaign counters, optionally scoped to one token.
 */
router.get("/stats/:tokenId?", async (req, res) => {
  try {
    const where = req.params.tokenId ? { tokenId: req.params.tokenId } : {};
    const [total, active, completed, executions] = await Promise.all([
      prisma.campaign.count({ where }),
      prisma.campaign.count({ where: { ...where, status: "ACTIVE" as const } }),
      prisma.campaign.count({
        where: { ...where, status: "COMPLETED" as const },
      }),
      prisma.campaignExecution.count({
        where: where.tokenId ? { campaign: { tokenId: where.tokenId } } : {},
      }),
    ]);
    res.json(
      successResponse({
        totalCampaigns: total,
        activeCampaigns: active,
        completedCampaigns: completed,
        totalExecutions: executions,
      })
    );
  } catch {
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch campaign stats",
      })
    );
  }
});

/** GET /api/campaigns/token/:tokenId — campaigns for a token. */
router.get("/token/:tokenId", async (req, res) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { tokenId: req.params.tokenId },
      orderBy: { createdAt: "desc" },
    });
    res.json(successResponse(campaigns.map(serializeCampaign)));
  } catch {
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch campaigns for token",
      })
    );
  }
});

/** GET /api/campaigns/creator/:creator — campaigns by creator address. */
router.get("/creator/:creator", async (req, res) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { creator: req.params.creator },
      orderBy: { createdAt: "desc" },
    });
    res.json(successResponse(campaigns.map(serializeCampaign)));
  } catch {
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch campaigns for creator",
      })
    );
  }
});

/** GET /api/campaigns/:campaignId — a single campaign. */
router.get("/:campaignId", validateCampaignId, async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { campaignId: Number(req.params.campaignId) },
    });
    if (!campaign)
      return res
        .status(404)
        .json(
          errorResponse({ code: "NOT_FOUND", message: "Campaign not found" })
        );
    res.json(successResponse(serializeCampaign(campaign)));
  } catch {
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch campaign",
      })
    );
  }
});

/** GET /api/campaigns/:campaignId/executions — step-execution history. */
router.get("/:campaignId/executions", validateCampaignId, async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { campaignId: Number(req.params.campaignId) },
    });
    if (!campaign)
      return res
        .status(404)
        .json(
          errorResponse({ code: "NOT_FOUND", message: "Campaign not found" })
        );
    const executions = await prisma.campaignExecution.findMany({
      where: { campaignId: campaign.id },
      orderBy: { executedAt: "desc" },
    });
    res.json(
      successResponse(
        executions.map((e: any) => ({ ...e, amount: e.amount.toString() }))
      )
    );
  } catch {
    res.status(500).json(
      errorResponse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch execution history",
      })
    );
  }
});

/**
 * POST /api/campaigns
 * Records a campaign that has already been created on-chain — this route
 * projects the contract's `cmp_crt` event, it does not itself submit a
 * transaction. `txHash` is unique so re-ingesting the same event is a no-op.
 */
router.post(
  "/",
  idempotencyMiddleware,
  validateCampaignCreate,
  async (req, res) => {
    try {
      const {
        tokenId,
        creator,
        type,
        targetAmount,
        startTime,
        endTime,
        metadata,
        campaignId,
        txHash,
      } = req.body;
      const campaign = await prisma.campaign.upsert({
        where: { txHash },
        update: {},
        create: {
          campaignId,
          tokenId,
          creator,
          type,
          targetAmount: BigInt(targetAmount),
          startTime: new Date(startTime),
          endTime: endTime ? new Date(endTime) : null,
          metadata,
          txHash,
        },
      });
      res.status(201).json(successResponse(serializeCampaign(campaign)));
    } catch (err: any) {
      if (err?.code === "P2002") {
        return res.status(409).json(
          errorResponse({
            code: "CONFLICT",
            message: "Campaign already recorded",
          })
        );
      }
      res.status(500).json(
        errorResponse({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to record campaign",
        })
      );
    }
  }
);

export default router;
