/**
 * GET /api/admin/operational
 * Aggregated operational state for the admin dashboard.
 * Returns campaign counts, token counts, and event listener cursor status.
 * All fields are read-only — no mutations here.
 */
import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticateAdmin } from '../../middleware/auth';
import { successResponse, errorResponse } from '../../utils/response';

const router = Router();

router.get('/', authenticateAdmin, async (_req, res) => {
  try {
    const [
      totalTokens,
      totalCampaigns,
      activeCampaigns,
      completedCampaigns,
      cursorState,
    ] = await Promise.all([
      prisma.token.count(),
      prisma.campaign.count(),
      prisma.campaign.count({ where: { status: 'ACTIVE' } }),
      prisma.campaign.count({ where: { status: 'COMPLETED' } }),
      prisma.integrationState.findUnique({ where: { key: 'event_cursor' } }),
    ]);

    res.json(
      successResponse({
        tokens: { total: totalTokens },
        campaigns: {
          total: totalCampaigns,
          active: activeCampaigns,
          completed: completedCampaigns,
        },
        eventListener: {
          cursor: cursorState?.value ?? null,
          updatedAt: cursorState?.updatedAt ?? null,
        },
        fetchedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    console.error('Error fetching operational state:', error);
    res.status(500).json(
      errorResponse({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch operational state',
      }),
    );
  }
});

export default router;
