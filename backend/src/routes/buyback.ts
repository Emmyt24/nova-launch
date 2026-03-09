import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { param, body, query } from 'express-validator';
import { validate } from '../middleware/validation';

const router = Router();
const prisma = new PrismaClient();

router.post(
  '/campaigns',
  [
    body('tokenAddress').isString().notEmpty(),
    body('totalAmount').isString().notEmpty(),
    body('steps').isArray({ min: 1 }),
    body('steps.*').isString(),
    validate,
  ],
  async (req: Request, res: Response) => {
    try {
      const { tokenAddress, totalAmount, steps } = req.body;

      const campaign = await prisma.buybackCampaign.create({
        data: {
          tokenAddress,
          totalAmount,
          executedAmount: '0',
          currentStep: 0,
          totalSteps: steps.length,
          status: 'ACTIVE',
          steps: {
            create: steps.map((amount: string, index: number) => ({
              stepNumber: index,
              amount,
              status: 'PENDING',
            })),
          },
        },
        include: {
          steps: true,
        },
      });

      res.status(201).json(campaign);
    } catch (error) {
      console.error('Error creating campaign:', error);
      res.status(500).json({ error: 'Failed to create campaign' });
    }
  }
);

router.get(
  '/campaigns',
  [
    query('status').optional().isIn(['ACTIVE', 'COMPLETED', 'CANCELLED']),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    validate,
  ],
  async (req: Request, res: Response) => {
    try {
      const { status, limit = 50, offset = 0 } = req.query;

      const where: any = {};
      if (status) where.status = status;

      const [campaigns, total] = await Promise.all([
        prisma.buybackCampaign.findMany({
          where,
          include: {
            steps: {
              orderBy: { stepNumber: 'asc' },
            },
          },
          take: Number(limit),
          skip: Number(offset),
          orderBy: { createdAt: 'desc' },
        }),
        prisma.buybackCampaign.count({ where }),
      ]);

      res.json({
        campaigns,
        pagination: {
          total,
          limit: Number(limit),
          offset: Number(offset),
        },
      });
    } catch (error) {
      console.error('Error fetching campaigns:', error);
      res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
  }
);

router.get(
  '/campaigns/:id',
  [param('id').isInt().toInt(), validate],
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const campaign = await prisma.buybackCampaign.findUnique({
        where: { id: Number(id) },
        include: {
          steps: {
            orderBy: { stepNumber: 'asc' },
          },
        },
      });

      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      res.json(campaign);
    } catch (error) {
      console.error('Error fetching campaign:', error);
      res.status(500).json({ error: 'Failed to fetch campaign' });
    }
  }
);

router.post(
  '/campaigns/:id/execute-step',
  [
    param('id').isInt().toInt(),
    body('txHash').isString().notEmpty(),
    validate,
  ],
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { txHash } = req.body;

      const campaign = await prisma.buybackCampaign.findUnique({
        where: { id: Number(id) },
        include: { steps: true },
      });

      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      if (campaign.status !== 'ACTIVE') {
        return res.status(400).json({ error: 'Campaign is not active' });
      }

      if (campaign.currentStep >= campaign.totalSteps) {
        return res.status(400).json({ error: 'All steps completed' });
      }

      const currentStep = campaign.steps.find(
        (s) => s.stepNumber === campaign.currentStep
      );

      if (!currentStep) {
        return res.status(404).json({ error: 'Step not found' });
      }

      if (currentStep.status !== 'PENDING') {
        return res.status(400).json({ error: 'Step already executed' });
      }

      const updatedStep = await prisma.buybackStep.update({
        where: { id: currentStep.id },
        data: {
          status: 'COMPLETED',
          executedAt: new Date(),
          txHash,
        },
      });

      const newExecutedAmount = (
        BigInt(campaign.executedAmount) + BigInt(currentStep.amount)
      ).toString();

      const updatedCampaign = await prisma.buybackCampaign.update({
        where: { id: Number(id) },
        data: {
          executedAmount: newExecutedAmount,
          currentStep: campaign.currentStep + 1,
          status:
            campaign.currentStep + 1 >= campaign.totalSteps
              ? 'COMPLETED'
              : 'ACTIVE',
        },
        include: {
          steps: {
            orderBy: { stepNumber: 'asc' },
          },
        },
      });

      res.json({
        campaign: updatedCampaign,
        executedStep: updatedStep,
      });
    } catch (error) {
      console.error('Error executing step:', error);
      res.status(500).json({ error: 'Failed to execute step' });
    }
  }
);

router.post(
  '/campaigns/:id/cancel',
  [param('id').isInt().toInt(), validate],
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const campaign = await prisma.buybackCampaign.findUnique({
        where: { id: Number(id) },
      });

      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }

      if (campaign.status !== 'ACTIVE') {
        return res.status(400).json({ error: 'Campaign is not active' });
      }

      const updatedCampaign = await prisma.buybackCampaign.update({
        where: { id: Number(id) },
        data: { status: 'CANCELLED' },
        include: {
          steps: {
            orderBy: { stepNumber: 'asc' },
          },
        },
      });

      res.json(updatedCampaign);
    } catch (error) {
      console.error('Error cancelling campaign:', error);
      res.status(500).json({ error: 'Failed to cancel campaign' });
    }
  }
);

export default router;
