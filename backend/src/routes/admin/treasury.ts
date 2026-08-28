/**
 * GET/PUT /api/admin/treasury/policy
 * Treasury policy endpoints.
 */
import { Router, Request, Response } from 'express';
import { authenticateAdmin } from '../../middleware/auth';
import { successResponse, errorResponse } from '../../utils/response';
import { prisma } from '../../lib/prisma';

const router = Router();

const TREASURY_POLICY_KEY = 'treasury_policy_daily_cap';
const DEFAULT_DAILY_CAP = '1000000000';

router.get('/', authenticateAdmin, async (_req: Request, res: Response) => {
  const policy = await prisma.integrationState.findUnique({
    where: { key: TREASURY_POLICY_KEY },
  });
  const dailyCap = policy?.value ?? DEFAULT_DAILY_CAP;
  res.json(successResponse({ dailyCap, fetchedAt: new Date().toISOString() }));
});

router.put('/', authenticateAdmin, async (req: Request, res: Response) => {
  const { dailyCap } = req.body;

  if (typeof dailyCap !== 'string' || !/^\d+$/.test(dailyCap)) {
    return res.status(400).json(
      errorResponse({ code: 'INVALID_REQUEST', message: 'dailyCap must be a non-negative integer string' }),
    );
  }

  await prisma.integrationState.upsert({
    where: { key: TREASURY_POLICY_KEY },
    create: { key: TREASURY_POLICY_KEY, value: dailyCap },
    update: { value: dailyCap },
  });
  res.json(successResponse({ dailyCap, updatedAt: new Date().toISOString() }));
});

export default router;
