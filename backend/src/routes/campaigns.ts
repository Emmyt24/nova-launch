import { Router } from "express";
import { campaignProjectionService } from "../services/campaignProjectionService";
import type { CampaignRecord, CampaignStats, CampaignExecutionsResponse } from "../contracts/apiSchemas";

const router = Router();

// Public route contract: all paths are relative to the /api/campaigns mount point.
// Response shapes are defined in ../contracts/apiSchemas.ts.

/** @contract CampaignStats */
router.get("/stats/:tokenId?", async (req, res) => {
  try {
    const { tokenId } = req.params;
    const stats: CampaignStats = await campaignProjectionService.getCampaignStats(tokenId);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch campaign stats" });
  }
});

/** @contract CampaignRecord[] */
router.get("/token/:tokenId", async (req, res) => {
  try {
    const { tokenId } = req.params;
    const campaigns: CampaignRecord[] =
      await campaignProjectionService.getCampaignsByToken(tokenId);
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

/** @contract CampaignRecord[] */
router.get("/creator/:creator", async (req, res) => {
  try {
    const { creator } = req.params;
    const campaigns: CampaignRecord[] =
      await campaignProjectionService.getCampaignsByCreator(creator);
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

/** @contract CampaignExecutionsResponse */
router.get("/:campaignId/executions", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const result: CampaignExecutionsResponse =
      await campaignProjectionService.getExecutionHistory(
        campaignId,
        limit,
        offset
      );

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch execution history" });
  }
});

/** @contract CampaignRecord */
router.get("/:campaignId", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const campaign: CampaignRecord | null =
      await campaignProjectionService.getCampaignById(campaignId);

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch campaign" });
  }
});

export default router;
