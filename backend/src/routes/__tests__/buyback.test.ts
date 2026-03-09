import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import buybackRoutes from '../buyback';
import { PrismaClient } from '@prisma/client';

vi.mock('@prisma/client');

const app = express();
app.use(express.json());
app.use('/api/buyback', buybackRoutes);

describe('Buyback Routes Integration Tests', () => {
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      buybackCampaign: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
      },
      buybackStep: {
        update: vi.fn(),
      },
    };
  });

  describe('POST /campaigns', () => {
    it('should create a new campaign', async () => {
      const campaignData = {
        tokenAddress: 'GTEST123',
        totalAmount: '10000',
        steps: ['2000', '3000', '5000'],
      };

      const mockCampaign = {
        id: 1,
        ...campaignData,
        executedAmount: '0',
        currentStep: 0,
        totalSteps: 3,
        status: 'ACTIVE',
        steps: campaignData.steps.map((amount, index) => ({
          id: index + 1,
          stepNumber: index,
          amount,
          status: 'PENDING',
        })),
      };

      mockPrisma.buybackCampaign.create.mockResolvedValue(mockCampaign);

      const response = await request(app)
        .post('/api/buyback/campaigns')
        .send(campaignData)
        .expect(201);

      expect(response.body).toMatchObject({
        id: 1,
        tokenAddress: campaignData.tokenAddress,
        totalAmount: campaignData.totalAmount,
        totalSteps: 3,
      });
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/buyback/campaigns')
        .send({})
        .expect(400);

      expect(response.body.errors).toBeDefined();
    });

    it('should validate steps array', async () => {
      const response = await request(app)
        .post('/api/buyback/campaigns')
        .send({
          tokenAddress: 'GTEST123',
          totalAmount: '10000',
          steps: [],
        })
        .expect(400);

      expect(response.body.errors).toBeDefined();
    });
  });

  describe('GET /campaigns', () => {
    it('should fetch all campaigns', async () => {
      const mockCampaigns = [
        {
          id: 1,
          tokenAddress: 'GTEST123',
          totalAmount: '10000',
          status: 'ACTIVE',
          steps: [],
        },
      ];

      mockPrisma.buybackCampaign.findMany.mockResolvedValue(mockCampaigns);
      mockPrisma.buybackCampaign.count.mockResolvedValue(1);

      const response = await request(app)
        .get('/api/buyback/campaigns')
        .expect(200);

      expect(response.body.campaigns).toHaveLength(1);
      expect(response.body.pagination).toMatchObject({
        total: 1,
        limit: 50,
        offset: 0,
      });
    });

    it('should filter by status', async () => {
      mockPrisma.buybackCampaign.findMany.mockResolvedValue([]);
      mockPrisma.buybackCampaign.count.mockResolvedValue(0);

      await request(app)
        .get('/api/buyback/campaigns?status=COMPLETED')
        .expect(200);

      expect(mockPrisma.buybackCampaign.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'COMPLETED' },
        })
      );
    });

    it('should support pagination', async () => {
      mockPrisma.buybackCampaign.findMany.mockResolvedValue([]);
      mockPrisma.buybackCampaign.count.mockResolvedValue(0);

      await request(app)
        .get('/api/buyback/campaigns?limit=10&offset=20')
        .expect(200);

      expect(mockPrisma.buybackCampaign.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 20,
        })
      );
    });
  });

  describe('GET /campaigns/:id', () => {
    it('should fetch a specific campaign', async () => {
      const mockCampaign = {
        id: 1,
        tokenAddress: 'GTEST123',
        totalAmount: '10000',
        status: 'ACTIVE',
        steps: [],
      };

      mockPrisma.buybackCampaign.findUnique.mockResolvedValue(mockCampaign);

      const response = await request(app)
        .get('/api/buyback/campaigns/1')
        .expect(200);

      expect(response.body).toMatchObject(mockCampaign);
    });

    it('should return 404 for non-existent campaign', async () => {
      mockPrisma.buybackCampaign.findUnique.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/buyback/campaigns/999')
        .expect(404);

      expect(response.body.error).toBe('Campaign not found');
    });
  });

  describe('POST /campaigns/:id/execute-step', () => {
    it('should execute a step successfully', async () => {
      const mockCampaign = {
        id: 1,
        tokenAddress: 'GTEST123',
        totalAmount: '10000',
        executedAmount: '2000',
        currentStep: 1,
        totalSteps: 3,
        status: 'ACTIVE',
        steps: [
          { id: 1, stepNumber: 0, amount: '2000', status: 'COMPLETED' },
          { id: 2, stepNumber: 1, amount: '3000', status: 'PENDING' },
          { id: 3, stepNumber: 2, amount: '5000', status: 'PENDING' },
        ],
      };

      const updatedStep = {
        id: 2,
        stepNumber: 1,
        amount: '3000',
        status: 'COMPLETED',
        executedAt: new Date(),
        txHash: 'abc123',
      };

      const updatedCampaign = {
        ...mockCampaign,
        executedAmount: '5000',
        currentStep: 2,
      };

      mockPrisma.buybackCampaign.findUnique.mockResolvedValue(mockCampaign);
      mockPrisma.buybackStep.update.mockResolvedValue(updatedStep);
      mockPrisma.buybackCampaign.update.mockResolvedValue(updatedCampaign);

      const response = await request(app)
        .post('/api/buyback/campaigns/1/execute-step')
        .send({ txHash: 'abc123' })
        .expect(200);

      expect(response.body.campaign.executedAmount).toBe('5000');
      expect(response.body.campaign.currentStep).toBe(2);
      expect(response.body.executedStep.status).toBe('COMPLETED');
    });

    it('should reject execution on inactive campaign', async () => {
      const mockCampaign = {
        id: 1,
        status: 'COMPLETED',
        steps: [],
      };

      mockPrisma.buybackCampaign.findUnique.mockResolvedValue(mockCampaign);

      const response = await request(app)
        .post('/api/buyback/campaigns/1/execute-step')
        .send({ txHash: 'abc123' })
        .expect(400);

      expect(response.body.error).toBe('Campaign is not active');
    });

    it('should reject execution when all steps completed', async () => {
      const mockCampaign = {
        id: 1,
        currentStep: 3,
        totalSteps: 3,
        status: 'ACTIVE',
        steps: [],
      };

      mockPrisma.buybackCampaign.findUnique.mockResolvedValue(mockCampaign);

      const response = await request(app)
        .post('/api/buyback/campaigns/1/execute-step')
        .send({ txHash: 'abc123' })
        .expect(400);

      expect(response.body.error).toBe('All steps completed');
    });

    it('should mark campaign as completed after last step', async () => {
      const mockCampaign = {
        id: 1,
        currentStep: 2,
        totalSteps: 3,
        status: 'ACTIVE',
        executedAmount: '5000',
        steps: [
          { id: 1, stepNumber: 0, amount: '2000', status: 'COMPLETED' },
          { id: 2, stepNumber: 1, amount: '3000', status: 'COMPLETED' },
          { id: 3, stepNumber: 2, amount: '5000', status: 'PENDING' },
        ],
      };

      mockPrisma.buybackCampaign.findUnique.mockResolvedValue(mockCampaign);
      mockPrisma.buybackStep.update.mockResolvedValue({
        id: 3,
        status: 'COMPLETED',
      });
      mockPrisma.buybackCampaign.update.mockResolvedValue({
        ...mockCampaign,
        status: 'COMPLETED',
        currentStep: 3,
      });

      const response = await request(app)
        .post('/api/buyback/campaigns/1/execute-step')
        .send({ txHash: 'abc123' })
        .expect(200);

      expect(response.body.campaign.status).toBe('COMPLETED');
    });
  });

  describe('POST /campaigns/:id/cancel', () => {
    it('should cancel an active campaign', async () => {
      const mockCampaign = {
        id: 1,
        status: 'ACTIVE',
      };

      const updatedCampaign = {
        ...mockCampaign,
        status: 'CANCELLED',
        steps: [],
      };

      mockPrisma.buybackCampaign.findUnique.mockResolvedValue(mockCampaign);
      mockPrisma.buybackCampaign.update.mockResolvedValue(updatedCampaign);

      const response = await request(app)
        .post('/api/buyback/campaigns/1/cancel')
        .expect(200);

      expect(response.body.status).toBe('CANCELLED');
    });

    it('should reject cancellation of non-active campaign', async () => {
      const mockCampaign = {
        id: 1,
        status: 'COMPLETED',
      };

      mockPrisma.buybackCampaign.findUnique.mockResolvedValue(mockCampaign);

      const response = await request(app)
        .post('/api/buyback/campaigns/1/cancel')
        .expect(400);

      expect(response.body.error).toBe('Campaign is not active');
    });
  });
});
