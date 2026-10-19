import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PrismaClient, ProposalStatus, ProposalType } from '@prisma/client';
import governanceRouter from '../routes/governance';
import { GovernanceEventParser } from '../services/governanceEventParser';
import { GovernanceEventMapper } from '../services/governanceEventMapper';
import {
  proposalCreatedEvent,
  voteCastEventFor,
  voteCastEventAgainst,
} from './fixtures/governanceEvents';

describe('Governance Routes', () => {
  let app: express.Application;
  let prisma: PrismaClient;
  let parser: GovernanceEventParser;
  let mapper: GovernanceEventMapper;

  beforeEach(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/governance', governanceRouter);

    prisma = new PrismaClient();
    parser = new GovernanceEventParser(prisma);
    mapper = new GovernanceEventMapper();

    // Clean up test data
    await prisma.proposalExecution.deleteMany();
    await prisma.vote.deleteMany();
    await prisma.proposal.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  describe('GET /api/governance/proposals', () => {
    beforeEach(async () => {
      // Create test proposals
      const event1 = mapper.mapEvent(proposalCreatedEvent);
      await parser.parseEvent(event1!);
    });

    it('should return all proposals', async () => {
      const response = await request(app)
        .get('/api/governance/proposals')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.proposals).toHaveLength(1);
      expect(response.body.data.total).toBe(1);
    });

    it('should filter proposals by status', async () => {
      const response = await request(app)
        .get('/api/governance/proposals')
        .query({ status: ProposalStatus.ACTIVE })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.proposals.every((p: any) => p.status === ProposalStatus.ACTIVE)).toBe(true);
    });

    it('should filter proposals by proposalType', async () => {
      const response = await request(app)
        .get('/api/governance/proposals')
        .query({ proposalType: ProposalType.PARAMETER_CHANGE })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.proposals.every((p: any) => p.proposalType === ProposalType.PARAMETER_CHANGE)).toBe(true);
    });

    it('should support pagination', async () => {
      const response = await request(app)
        .get('/api/governance/proposals')
        .query({ limit: 10, offset: 0 })
        .expect(200);

      expect(response.body.data.limit).toBe(10);
      expect(response.body.data.offset).toBe(0);
    });

    it('should support sorting', async () => {
      const response = await request(app)
        .get('/api/governance/proposals')
        .query({ sortBy: 'createdAt', sortOrder: 'desc' })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/governance/proposals/:proposalId', () => {
    beforeEach(async () => {
      const event = mapper.mapEvent(proposalCreatedEvent);
      await parser.parseEvent(event!);

      const voteFor = mapper.mapEvent(voteCastEventFor);
      await parser.parseEvent(voteFor!);
    });

    it('should return proposal by ID with analytics', async () => {
      const response = await request(app)
        .get('/api/governance/proposals/1')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.proposal.proposalId).toBe(1);
      expect(response.body.data.analytics).toBeDefined();
      expect(response.body.data.analytics.totalVotes).toBeGreaterThan(0);
    });

    it('should return 404 for non-existent proposal', async () => {
      const response = await request(app)
        .get('/api/governance/proposals/999')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe('Proposal not found');
    });

    it('should include votes and executions', async () => {
      const response = await request(app)
        .get('/api/governance/proposals/1')
        .expect(200);

      expect(response.body.data.proposal.votes).toBeDefined();
      expect(response.body.data.proposal.executions).toBeDefined();
    });
  });

  describe('GET /api/governance/proposals/:proposalId/votes', () => {
    beforeEach(async () => {
      const event = mapper.mapEvent(proposalCreatedEvent);
      await parser.parseEvent(event!);

      const voteFor = mapper.mapEvent(voteCastEventFor);
      const voteAgainst = mapper.mapEvent(voteCastEventAgainst);
      await parser.parseEvent(voteFor!);
      await parser.parseEvent(voteAgainst!);
    });

    it('should return all votes for a proposal', async () => {
      const response = await request(app)
        .get('/api/governance/proposals/1/votes')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.votes).toHaveLength(2);
      expect(response.body.data.total).toBe(2);
    });

    it('should support pagination for votes', async () => {
      const response = await request(app)
        .get('/api/governance/proposals/1/votes')
        .query({ limit: 1, offset: 0 })
        .expect(200);

      expect(response.body.data.votes).toHaveLength(1);
      expect(response.body.data.limit).toBe(1);
    });

    it('should return 404 for non-existent proposal', async () => {
      const response = await request(app)
        .get('/api/governance/proposals/999/votes')
        .expect(404);

      expect(response.body.success).toBe(false);
    });

    it('should validate limit parameter', async () => {
      const response = await request(app)
        .get('/api/governance/proposals/1/votes')
        .query({ limit: 200 })
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/governance/proposals/:proposalId/execution', () => {
    beforeEach(async () => {
      const event = mapper.mapEvent(proposalCreatedEvent);
      await parser.parseEvent(event!);
    });

    it('should return execution status for a proposal', async () => {
      const response = await request(app)
        .get('/api/governance/proposals/1/execution')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.proposalId).toBe(1);
      expect(response.body.data.status).toBeDefined();
      expect(response.body.data.isExecuted).toBeDefined();
      expect(response.body.data.canExecute).toBeDefined();
    });

    it('should return 404 for non-existent proposal', async () => {
      const response = await request(app)
        .get('/api/governance/proposals/999/execution')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe('Proposal not found');
    });

    it('should validate proposalId parameter', async () => {
      const response = await request(app)
        .get('/api/governance/proposals/invalid/execution')
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/governance/stats', () => {
    beforeEach(async () => {
      const event = mapper.mapEvent(proposalCreatedEvent);
      await parser.parseEvent(event!);

      const voteFor = mapper.mapEvent(voteCastEventFor);
      await parser.parseEvent(voteFor!);
    });

    it('should return governance statistics', async () => {
      const response = await request(app)
        .get('/api/governance/stats')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.totalProposals).toBeGreaterThan(0);
      expect(response.body.data.totalVotes).toBeGreaterThan(0);
      expect(response.body.data.proposalsByType).toBeDefined();
      expect(response.body.data.proposalsByStatus).toBeDefined();
    });
  });

  describe('GET /api/governance/voters/:address', () => {
    beforeEach(async () => {
      const event = mapper.mapEvent(proposalCreatedEvent);
      await parser.parseEvent(event!);

      const voteFor = mapper.mapEvent(voteCastEventFor);
      await parser.parseEvent(voteFor!);
    });

    it('should return voter statistics', async () => {
      const response = await request(app)
        .get('/api/governance/voters/GVOTER1123456789')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.address).toBe('GVOTER1123456789');
      expect(response.body.data.totalVotes).toBe(1);
      expect(response.body.data.votingPower).toBeDefined();
      expect(response.body.data.participationRate).toBeGreaterThan(0);
    });

    it('should return empty stats for non-voter', async () => {
      const response = await request(app)
        .get('/api/governance/voters/GNONVOTER123456789')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.totalVotes).toBe(0);
    });
  });

  describe('POST /api/governance/events/ingest', () => {
    it('should ingest governance events', async () => {
      const events = [
        mapper.mapEvent(proposalCreatedEvent),
        mapper.mapEvent(voteCastEventFor),
      ];

      const response = await request(app)
        .post('/api/governance/events/ingest')
        .send({ events })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.processed).toBe(2);
      expect(response.body.data.results.every((r: any) => r.success)).toBe(true);
    });

    it('should handle invalid events gracefully', async () => {
      const response = await request(app)
        .post('/api/governance/events/ingest')
        .send({ events: [{ type: 'invalid_event' }] })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.processed).toBe(1);
    });

    it('should return 400 for non-array events', async () => {
      const response = await request(app)
        .post('/api/governance/events/ingest')
        .send({ events: 'not-an-array' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.message).toBe('Events must be an array');
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      // Disconnect prisma to simulate error
      await prisma.$disconnect();

      const response = await request(app)
        .get('/api/governance/proposals')
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
    });
  });
});
