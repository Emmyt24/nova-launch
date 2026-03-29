import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { GovernanceEventParser } from '../services/governanceEventParser';
import { query, param } from 'express-validator';
import { validate } from '../middleware/validation';
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
 *           enum: [ACTIVE, PASSED, REJECTED, EXECUTED, CANCELLED, EXPIRED]
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
    validate,
  ],
  async (req: Request, res: Response) => {
  try {
    const {
      status,
      proposalType,
      tokenId,
      proposer,
      limit = '50',
      offset = '0',
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const where: any = {};

    if (status) {
      where.status = status;
    }

    if (proposalType) {
      where.proposalType = proposalType;
    }

    if (tokenId) {
      where.tokenId = tokenId;
    }

    if (proposer) {
      where.proposer = proposer;
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
        proposals: serializedProposals as any,
        total,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
      },
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching proposals:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch proposals',
    });
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
      return res.status(404).json({
        success: false,
        error: 'Proposal not found',
      });
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
        proposal: serializedProposal as any,
        analytics,
      },
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching proposal:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch proposal',
    });
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
    });

    if (!proposal) {
      return res.status(404).json({
        success: false,
        error: 'Proposal not found',
      });
    }

    const [votes, total] = await Promise.all([
      prisma.vote.findMany({
        where: { proposalId: proposal.id },
        orderBy: { timestamp: 'desc' },
        take: parseInt(limit as string),
        skip: parseInt(offset as string),
      }),
      prisma.vote.count({ where: { proposalId: proposal.id } }),
    ]);

    const serializedVotes = votes.map(v => ({
      ...v,
      weight: v.weight.toString(),
    }));

    res.json({
      success: true,
      data: {
        votes: serializedVotes,
        total,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string),
      },
    });
  } catch (error) {
    console.error('Error fetching votes:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch votes',
    });
  }
});

/**
 * @openapi
 * /api/governance/proposals/{proposalId}/execution:
 *   get:
 *     summary: Get proposal execution status
 *     tags: [Governance]
 *     parameters:
 *       - in: path
 *         name: proposalId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Execution status and history
 *       404:
 *         description: Proposal not found
 *       500:
 *         description: Server error
 */
router.get(
  '/proposals/:proposalId/execution',
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
          executions: {
            orderBy: { executedAt: 'desc' },
          },
        },
      });

      if (!proposal) {
        return res.status(404).json({
          success: false,
          error: 'Proposal not found',
        });
      }

      const serializedExecutions = proposal.executions.map(e => ({
        ...e,
        gasUsed: e.gasUsed?.toString(),
      }));

      res.json({
        success: true,
        data: {
          proposalId: proposal.proposalId,
          status: proposal.status,
          executedAt: proposal.executedAt,
          executions: serializedExecutions,
          isExecuted: proposal.status === 'EXECUTED',
          canExecute: proposal.status === 'PASSED' && !proposal.executedAt,
        },
      });
    } catch (error) {
      console.error('Error fetching execution status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch execution status',
      });
    }
  }
);

/**
 * @openapi
 * /api/governance/stats:
 *   get:
 *     summary: Get governance statistics
 *     tags: [Governance]
 *     responses:
 *       200:
 *         description: Governance statistics
 *       500:
 *         description: Server error
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await governanceParser.getGovernanceStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('Error fetching governance stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch governance stats',
    });
  }
});

/**
 * GET /api/governance/voters/:address
 * Get voter statistics for a specific address
 */
router.get('/voters/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    const votes = await prisma.vote.findMany({
      where: { voter: address },
      include: {
        proposal: {
          select: {
            proposalId: true,
            title: true,
            status: true,
          },
        },
      },
      orderBy: { timestamp: 'desc' },
    });

    const totalVotingPower = votes.reduce((sum, v) => sum + v.weight, BigInt(0));
    const totalProposals = await prisma.proposal.count();
    const participationRate = totalProposals > 0
      ? (votes.length / totalProposals) * 100
      : 0;

    const voterStats = {
      address,
      totalVotes: votes.length,
      votingPower: totalVotingPower.toString(),
      participationRate,
      proposalsVoted: votes.map(v => v.proposal.proposalId),
      recentVotes: votes.slice(0, 10).map(v => ({
        proposalId: v.proposal.proposalId,
        proposalTitle: v.proposal.title,
        support: v.support,
        weight: v.weight.toString(),
        timestamp: v.timestamp,
      })),
    };

    res.json({
      success: true,
      data: voterStats,
    });
  } catch (error) {
    console.error('Error fetching voter stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch voter stats',
    });
  }
});

/**
 * POST /api/governance/events/ingest
 * Ingest governance events (internal endpoint)
 */
router.post('/events/ingest', async (req: Request, res: Response) => {
  try {
    const { events } = req.body;

    if (!Array.isArray(events)) {
      return res.status(400).json({
        success: false,
        error: 'Events must be an array',
      });
    }

    const results = [];

    for (const event of events) {
      try {
        await governanceParser.parseEvent(event);
        results.push({ success: true, event: event.type });
      } catch (error) {
        console.error(`Error processing event:`, error);
        results.push({
          success: false,
          event: event.type,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    res.json({
      success: true,
      data: {
        processed: results.length,
        results,
      },
    });
  } catch (error) {
    console.error('Error ingesting events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to ingest events',
    });
  }
});

export default router;
