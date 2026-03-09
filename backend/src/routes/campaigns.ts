import { Router } from "express";
import { campaignProjectionService } from "../services/campaignProjectionService";

const router = Router();

router.get("/campaigns/:campaignId", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const campaign =
      await campaignProjectionService.getCampaignById(campaignId);

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    res.json(campaign);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch campaign" });
  }
});

router.get("/campaigns/token/:tokenId", async (req, res) => {
  try {
    const { tokenId } = req.params;
    const campaigns =
      await campaignProjectionService.getCampaignsByToken(tokenId);
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

router.get("/campaigns/creator/:creator", async (req, res) => {
  try {
    const { creator } = req.params;
    const campaigns =
      await campaignProjectionService.getCampaignsByCreator(creator);
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

router.get("/campaigns/:campaignId/executions", async (req, res) => {
  try {
    const campaignId = parseInt(req.params.campaignId);
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await campaignProjectionService.getExecutionHistory(
      campaignId,
      limit,
      offset
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch execution history" });
  }
});

router.get("/campaigns/stats/:tokenId?", async (req, res) => {
  try {
    const { tokenId } = req.params;
    const stats = await campaignProjectionService.getCampaignStats(tokenId);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch campaign stats" });
  }
});

export default router;
