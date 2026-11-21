import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { GovernanceEventParser } from '../services/governanceEventParser';
import { query, param } from 'express-validator';
import { validate } from '../middleware/validation';
import { sendError } from '../utils/response';
import { ErrorCode } from '../lib/errors';
import { logger } from '../lib/logger';
import type { ProposalListResponse, ProposalDetailResponse, ProposalVotesResponse } from '../contracts/apiSchemas';

const router = Router();
const prisma = new PrismaClient();
const governanceParser = new GovernanceEventParser(prisma);

/**
 * @openapi
 * /api/governance/proposals:
 *   get:
 *     summary: List all proposals
 *     tags: [Governance]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [ACTIVE, PASSED, REJECTED, QUEUED, EXECUTED, CANCELLED, EXPIRED]
 *       - in: query
 *         name: search
 *         description: Case-insensitive substring match on proposal title or description
 *         schema:
 *           type: string
 *           maxLength: 200
 *       - in: query
 *         name: proposalType
 *         schema:
 *           type: string
 *           enum: [PARAMETER_CHANGE, ADMIN_TRANSFER, TREASURY_SPEND, CONTRACT_UPGRADE, CUSTOM]
 *       - in: query
 *         name: tokenId
 *         schema:
 *           type: string
 *       - in: query
 *         name: proposer
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [createdAt, startTime, endTime]
 *           default: createdAt
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *     responses:
 *       200:
 *         description: List of proposals
 *       400:
 *         description: Validation error
 *       500:
 *         description: Server error
 */
router.get(
  '/proposals',
  [
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('sortBy').optional().isIn(['createdAt', 'startTime', 'endTime']),
    query('sortOrder').optional().isIn(['asc', 'desc']),
    query('search').optional().isString().trim().isLength({ max: 200 }),
    validate,
  ],
  async (req: Request, res: Response) => {
  try {
    const {
      status,
      search,
      proposalType,
      tokenId,
      proposer,
      limit = '50',
      offset = '0',
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const where: Prisma.ProposalWhereInput = {};

    if (status) {
      where.status = status as Prisma.ProposalWhereInput['status'];
    }

    if (typeof search === 'string' && search.length > 0) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (proposalType) {
      where.proposalType = proposalType as Prisma.ProposalWhereInput['proposalType'];
    }

    if (tokenId) {
      where.tokenId = tokenId as Prisma.ProposalWhereInput['tokenId'];
    }

    if (proposer) {
      where.proposer = proposer as Prisma.ProposalWhereInput['proposer'];
    }

    const [proposals, total] = await Promise.all([
      prisma.proposal.findMany({
        where,
        include: {
          votes: {
            select: {
              id: true,
              voter: true,
              support: true,
              weight: true,
              timestamp: true,
            },
          },
          executions: {
            select: {
              id: true,
              executor: true,
              success: true,
              executedAt: true,
            },
          },
        },
        orderBy: {
          [sortBy as string]: sortOrder,
        },
        take: parseInt(limit as string),
        skip: parseInt(offset as string),
      }),
      prisma.proposal.count({ where }),
    ]);

    // Convert BigInt to string for JSON serialization
    const serializedProposals = proposals.map(p => ({
      ...p,
      quorum: p.quorum.toString(),
      threshold: p.threshold.toString(),
      votes: p.votes.map(v => ({
        ...v,
        weight: v.weight.toString(),
      })),
    }));

    const response: ProposalListResponse = {
      success: true,
      data: {
        proposals: serializedProposals as unknown as ProposalListResponse['data']['proposals'],
        total,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
      },
    };

    res.json(response);
  } catch (error) {
    logger.error('Failed to fetch proposals', {
      error: error instanceof Error ? error.message : String(error),
    });
    sendError(res, 500, ErrorCode.INTERNAL_SERVER_ERROR, 'Failed to fetch proposals');
  }
});

/**
 * @openapi
 * /api/governance/proposals/{proposalId}:
 *   get:
 *     summary: Get proposal by ID
 *     tags: [Governance]
 *     parameters:
 *       - in: path
 *         name: proposalId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Proposal details with analytics
 *       404:
 *         description: Proposal not found
 *       500:
 *         description: Server error
 */
router.get(
  '/proposals/:proposalId',
  [
    param('proposalId').isInt({ min: 0 }).toInt(),
    validate,
  ],
  async (req: Request, res: Response) => {
  try {
    const { proposalId } = req.params;

    const proposal = await prisma.proposal.findUnique({
      where: { proposalId: parseInt(proposalId) },
      include: {
        votes: {
          orderBy: { timestamp: 'desc' },
        },
        executions: {
          orderBy: { executedAt: 'desc' },
        },
      },
    });

    if (!proposal) {
      return sendError(res, 404, ErrorCode.NOT_FOUND, 'Proposal not found');
    }

    // Get analytics
    const analytics = await governanceParser.getProposalAnalytics(parseInt(proposalId));

    // Serialize BigInt values
    const serializedProposal = {
      ...proposal,
      quorum: proposal.quorum.toString(),
      threshold: proposal.threshold.toString(),
      votes: proposal.votes.map(v => ({
        ...v,
        weight: v.weight.toString(),
      })),
      executions: proposal.executions.map(e => ({
        ...e,
        gasUsed: e.gasUsed?.toString(),
      })),
    };

    const response: ProposalDetailResponse = {
      success: true,
      data: {
        proposal: serializedProposal as unknown as ProposalDetailResponse['data']['proposal'],
        analytics,
      },
    };

    res.json(response);
  } catch (error) {
    logger.error('Failed to fetch proposal', {
      error: error instanceof Error ? error.message : String(error),
    });
    sendError(res, 500, ErrorCode.INTERNAL_SERVER_ERROR, 'Failed to fetch proposal');
  }
});

/**
 * @openapi
 * /api/governance/proposals/{proposalId}/votes:
 *   get:
 *     summary: Get votes for a proposal
 *     tags: [Governance]
 *     parameters:
 *       - in: path
 *         name: proposalId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 100
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *     responses:
 *       200:
 *         description: List of votes
 *       404:
 *         description: Proposal not found
 *       500:
 *         description: Server error
 */
router.get(
  '/proposals/:proposalId/votes',
  [
    param('proposalId').isInt({ min: 0 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    validate,
  ],
  async (req: Request, res: Response) => {
    try {
      const { proposalId } = req.params;
      const { limit = '100', offset = '0' } = req.query;

      const proposal = await prisma.proposal.findUnique({
        where: { proposalId: parseInt(proposalId) },
        select: { id: true },
      });

      if (!proposal) {
        return sendError(res, 404, ErrorCode.NOT_FOUND, 'Proposal not found');
      }

      const [votes, total] = await Promise.all([
        prisma.vote.findMany({
          where: { proposalId: parseInt(proposalId) },
          orderBy: { timestamp: 'desc' },
          take: parseInt(limit as string),
          skip: parseInt(offset as string),
        }),
        prisma.vote.count({ where: { proposalId: parseInt(proposalId) } }),
      ]);

      const serializedVotes = votes.map(v => ({
        ...v,
        weight: v.weight.toString(),
      }));

      const response: ProposalVotesResponse = {
        success: true,
        data: {
          votes: serializedVotes as unknown as ProposalVotesResponse['data']['votes'],
          total,
          limit: parseInt(limit as string),
          offset: parseInt(offset as string),
        },
      };

      res.json(response);
    } catch (error) {
      logger.error('Failed to fetch votes', {
        error: error instanceof Error ? error.message : String(error),
      });
      sendError(res, 500, ErrorCode.INTERNAL_SERVER_ERROR, 'Failed to fetch votes');
    }
  });

export default router;
