/**
 * Governance Projection Replay Integration Tests
 *
 * Verifies that governance events are correctly projected into Prisma-backed
 * models and that replaying the same events is idempotent (no duplicate rows).
 *
 * Covers: proposal creation, votes, execution, cancellation, status changes,
 * queued transitions, and versioned event topics (v1 suffix + legacy names).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient, ProposalStatus, ProposalType } from '@prisma/client';
import { GovernanceEventParser } from '../services/governanceEventParser';
import { GovernanceEventMapper } from '../services/governanceEventMapper';

// ---------------------------------------------------------------------------
// Minimal raw Stellar event factory helpers
// ---------------------------------------------------------------------------

const BASE = {
  type: 'contract',
  contract_id: 'CGOVCONTRACT123456789',
  in_successful_contract_call: true,
};

function makeStellarEvent(overrides: Record<string, unknown>) {
  return { ...BASE, ...overrides } as Parameters<GovernanceEventMapper['mapEvent']>[0];
}

const NOW_S = Math.floor(Date.now() / 1000);

// Versioned (v1) fixtures
const v1ProposalCreated = makeStellarEvent({
  ledger: 2000000,
  ledger_close_time: '2025-01-01T10:00:00Z',
  id: 'ev-v1-prop-cr-1',
  paging_token: 'pt-v1-1',
  topic: ['prop_cr_v1', 'CTOKENREPLAY'],
  value: {
    proposal_id: 100,
    proposer: 'GREPLAY_PROPOSER',
    title: 'Replay Proposal',
    description: 'Testing replay idempotency',
    proposal_type: 0, // PARAMETER_CHANGE
    start_time: NOW_S,
    end_time: NOW_S + 86400,
    quorum: 1_000_000_000_000,
    threshold: 500_000_000_000,
    metadata: null,
  },
  transaction_hash: 'tx-replay-prop-cr-v1',
});

const v1VoteCast = makeStellarEvent({
  ledger: 2000100,
  ledger_close_time: '2025-01-01T11:00:00Z',
  id: 'ev-v1-vote-1',
  paging_token: 'pt-v1-2',
  topic: ['vote_cs_v1', '100'],
  value: {
    proposal_id: 100,
    voter: 'GREPLAY_VOTER1',
    support: true,
    weight: 300_000_000_000,
    reason: 'Looks good',
  },
  transaction_hash: 'tx-replay-vote-v1',
});

const v1VoteCastAgainst = makeStellarEvent({
  ledger: 2000150,
  ledger_close_time: '2025-01-01T11:30:00Z',
  id: 'ev-v1-vote-2',
  paging_token: 'pt-v1-3',
  topic: ['vote_cs_v1', '100'],
  value: {
    proposal_id: 100,
    voter: 'GREPLAY_VOTER2',
    support: false,
    weight: 100_000_000_000,
    reason: 'Disagree',
  },
  transaction_hash: 'tx-replay-vote-against-v1',
});

const v1ProposalQueued = makeStellarEvent({
  ledger: 2000200,
  ledger_close_time: '2025-01-02T10:00:00Z',
  id: 'ev-v1-prop-qu-1',
  paging_token: 'pt-v1-4',
  topic: ['prop_qu_v1', '100'],
  value: {
    proposal_id: 100,
    old_status: 'passed',
  },
  transaction_hash: 'tx-replay-prop-qu-v1',
});

const v1ProposalExecuted = makeStellarEvent({
  ledger: 2000300,
  ledger_close_time: '2025-01-03T10:00:00Z',
  id: 'ev-v1-prop-ex-1',
  paging_token: 'pt-v1-5',
  topic: ['prop_ex_v1', 'CTOKENREPLAY'],
  value: {
    proposal_id: 100,
    executor: 'GREPLAY_EXECUTOR',
    success: true,
    return_data: '0x01',
    gas_used: 75000,
  },
  transaction_hash: 'tx-replay-prop-ex-v1',
});

// Cancellation fixture (separate proposal)
const v1ProposalCreatedForCancel = makeStellarEvent({
  ledger: 2001000,
  ledger_close_time: '2025-01-05T10:00:00Z',
  id: 'ev-v1-prop-cr-cancel',
  paging_token: 'pt-v1-10',
  topic: ['prop_cr_v1', 'CTOKENREPLAY'],
  value: {
    proposal_id: 101,
    proposer: 'GREPLAY_PROPOSER',
    title: 'Proposal To Cancel',
    description: null,
    proposal_type: 4, // CUSTOM
    start_time: NOW_S,
    end_time: NOW_S + 86400,
    quorum: 500_000_000_000,
    threshold: 250_000_000_000,
    metadata: null,
  },
  transaction_hash: 'tx-replay-prop-cr-cancel',
});

const v1ProposalCancelled = makeStellarEvent({
  ledger: 2001100,
  ledger_close_time: '2025-01-05T12:00:00Z',
  id: 'ev-v1-prop-ca-1',
  paging_token: 'pt-v1-11',
  topic: ['prop_ca_v1', 'CTOKENREPLAY'],
  value: {
    proposal_id: 101,
    canceller: 'GREPLAY_PROPOSER',
    reason: 'No longer needed',
  },
  transaction_hash: 'tx-replay-prop-ca-v1',
});

// Legacy-named fixture (backward compat)
const legacyProposalCreated = makeStellarEvent({
  ledger: 3000000,
  ledger_close_time: '2025-02-01T10:00:00Z',
  id: 'ev-legacy-prop-cr',
  paging_token: 'pt-legacy-1',
  topic: ['prop_create', 'CTOKENLEGACY'],
  value: {
    proposal_id: 200,
    proposer: 'GLEGACY_PROPOSER',
    title: 'Legacy Proposal',
    description: 'Created with old event name',
    proposal_type: 2, // TREASURY_SPEND
    start_time: NOW_S,
    end_time: NOW_S + 86400 * 3,
    quorum: 2_000_000_000_000,
    threshold: 1_000_000_000_000,
    metadata: null,
  },
  transaction_hash: 'tx-legacy-prop-cr',
});

const legacyVoteCast = makeStellarEvent({
  ledger: 3000100,
  ledger_close_time: '2025-02-01T11:00:00Z',
  id: 'ev-legacy-vote',
  paging_token: 'pt-legacy-2',
  topic: ['vote_cast', 'CTOKENLEGACY'],
  value: {
    proposal_id: 200,
    voter: 'GLEGACY_VOTER',
    support: true,
    weight: 500_000_000_000,
  },
  transaction_hash: 'tx-legacy-vote',
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Governance Projection Replay Integration', () => {
  let prisma: PrismaClient;
  let parser: GovernanceEventParser;
  let mapper: GovernanceEventMapper;

  beforeEach(async () => {
    prisma = new PrismaClient();
    parser = new GovernanceEventParser(prisma);
    mapper = new GovernanceEventMapper();

    await prisma.proposalExecution.deleteMany();
    await prisma.vote.deleteMany();
    await prisma.proposal.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Proposal creation
  // -------------------------------------------------------------------------

  describe('Proposal creation', () => {
    it('persists a v1 proposal_created event', async () => {
      const ev = mapper.mapEvent(v1ProposalCreated);
      expect(ev).not.toBeNull();
      await parser.parseEvent(ev!);

      const row = await prisma.proposal.findUnique({ where: { proposalId: 100 } });
      expect(row).not.toBeNull();
      expect(row!.proposer).toBe('GREPLAY_PROPOSER');
      expect(row!.title).toBe('Replay Proposal');
      expect(row!.proposalType).toBe(ProposalType.PARAMETER_CHANGE);
      expect(row!.status).toBe(ProposalStatus.ACTIVE);
      expect(row!.txHash).toBe('tx-replay-prop-cr-v1');
    });

    it('replaying proposal_created does not create duplicate rows', async () => {
      const ev = mapper.mapEvent(v1ProposalCreated)!;
      await parser.parseEvent(ev);
      await parser.parseEvent(ev); // replay

      const count = await prisma.proposal.count({ where: { proposalId: 100 } });
      expect(count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Vote persistence
  // -------------------------------------------------------------------------

  describe('Vote persistence', () => {
    beforeEach(async () => {
      await parser.parseEvent(mapper.mapEvent(v1ProposalCreated)!);
    });

    it('persists a v1 vote_cast event (for)', async () => {
      await parser.parseEvent(mapper.mapEvent(v1VoteCast)!);

      const votes = await prisma.vote.findMany({ where: { voter: 'GREPLAY_VOTER1' } });
      expect(votes).toHaveLength(1);
      expect(votes[0].support).toBe(true);
      expect(votes[0].weight.toString()).toBe('300000000000');
    });

    it('persists a v1 vote_cast event (against)', async () => {
      await parser.parseEvent(mapper.mapEvent(v1VoteCastAgainst)!);

      const votes = await prisma.vote.findMany({ where: { voter: 'GREPLAY_VOTER2' } });
      expect(votes).toHaveLength(1);
      expect(votes[0].support).toBe(false);
    });

    it('replaying vote_cast does not create duplicate rows', async () => {
      const ev = mapper.mapEvent(v1VoteCast)!;
      await parser.parseEvent(ev);
      await parser.parseEvent(ev); // replay

      const count = await prisma.vote.count({ where: { voter: 'GREPLAY_VOTER1' } });
      expect(count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Queued status transition
  // -------------------------------------------------------------------------

  describe('Queued status transition', () => {
    beforeEach(async () => {
      await parser.parseEvent(mapper.mapEvent(v1ProposalCreated)!);
    });

    it('maps prop_qu_v1 to a QUEUED status change', () => {
      const ev = mapper.mapEvent(v1ProposalQueued);
      expect(ev).not.toBeNull();
      expect(ev!.type).toBe('proposal_status_changed');
      if (ev!.type === 'proposal_status_changed') {
        expect(ev!.newStatus).toBe('QUEUED');
      }
    });

    it('persists QUEUED status on proposal', async () => {
      await parser.parseEvent(mapper.mapEvent(v1ProposalQueued)!);

      const row = await prisma.proposal.findUnique({ where: { proposalId: 100 } });
      expect(row!.status).toBe(ProposalStatus.QUEUED);
    });

    it('replaying queued event is idempotent', async () => {
      const ev = mapper.mapEvent(v1ProposalQueued)!;
      await parser.parseEvent(ev);
      await parser.parseEvent(ev); // replay

      const row = await prisma.proposal.findUnique({ where: { proposalId: 100 } });
      expect(row!.status).toBe(ProposalStatus.QUEUED);
    });
  });

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  describe('Proposal execution', () => {
    beforeEach(async () => {
      await parser.parseEvent(mapper.mapEvent(v1ProposalCreated)!);
    });

    it('persists execution record and updates status to EXECUTED', async () => {
      await parser.parseEvent(mapper.mapEvent(v1ProposalExecuted)!);

      const exec = await prisma.proposalExecution.findUnique({
        where: { txHash: 'tx-replay-prop-ex-v1' },
      });
      expect(exec).not.toBeNull();
      expect(exec!.executor).toBe('GREPLAY_EXECUTOR');
      expect(exec!.success).toBe(true);
      expect(exec!.gasUsed?.toString()).toBe('75000');

      const row = await prisma.proposal.findUnique({ where: { proposalId: 100 } });
      expect(row!.status).toBe(ProposalStatus.EXECUTED);
      expect(row!.executedAt).not.toBeNull();
    });

    it('replaying execution event does not create duplicate execution rows', async () => {
      const ev = mapper.mapEvent(v1ProposalExecuted)!;
      await parser.parseEvent(ev);
      await parser.parseEvent(ev); // replay

      const count = await prisma.proposalExecution.count({
        where: { txHash: 'tx-replay-prop-ex-v1' },
      });
      expect(count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  describe('Proposal cancellation', () => {
    beforeEach(async () => {
      await parser.parseEvent(mapper.mapEvent(v1ProposalCreatedForCancel)!);
    });

    it('persists cancellation with canceller and reason', async () => {
      await parser.parseEvent(mapper.mapEvent(v1ProposalCancelled)!);

      const row = await prisma.proposal.findUnique({ where: { proposalId: 101 } });
      expect(row!.status).toBe(ProposalStatus.CANCELLED);
      expect(row!.cancelledAt).not.toBeNull();
      expect(row!.canceller).toBe('GREPLAY_PROPOSER');
      expect(row!.cancelReason).toBe('No longer needed');
    });

    it('replaying cancellation event is idempotent', async () => {
      const ev = mapper.mapEvent(v1ProposalCancelled)!;
      await parser.parseEvent(ev);
      await parser.parseEvent(ev); // replay

      const row = await prisma.proposal.findUnique({ where: { proposalId: 101 } });
      expect(row!.status).toBe(ProposalStatus.CANCELLED);
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle replay
  // -------------------------------------------------------------------------

  describe('Full lifecycle replay', () => {
    it('replaying the complete event sequence produces stable final state', async () => {
      const events = [
        mapper.mapEvent(v1ProposalCreated)!,
        mapper.mapEvent(v1VoteCast)!,
        mapper.mapEvent(v1VoteCastAgainst)!,
        mapper.mapEvent(v1ProposalQueued)!,
        mapper.mapEvent(v1ProposalExecuted)!,
      ];

      // First pass
      for (const ev of events) await parser.parseEvent(ev);
      // Replay
      for (const ev of events) await parser.parseEvent(ev);

      const proposal = await prisma.proposal.findUnique({
        where: { proposalId: 100 },
        include: { votes: true, executions: true },
      });

      expect(proposal!.status).toBe(ProposalStatus.EXECUTED);
      expect(proposal!.votes).toHaveLength(2);
      expect(proposal!.executions).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Legacy event name backward compatibility
  // -------------------------------------------------------------------------

  describe('Legacy event name backward compatibility', () => {
    it('recognises legacy prop_create topic', () => {
      expect(mapper.isGovernanceEvent(legacyProposalCreated)).toBe(true);
    });

    it('recognises legacy vote_cast topic', () => {
      expect(mapper.isGovernanceEvent(legacyVoteCast)).toBe(true);
    });

    it('persists proposal from legacy event name', async () => {
      await parser.parseEvent(mapper.mapEvent(legacyProposalCreated)!);

      const row = await prisma.proposal.findUnique({ where: { proposalId: 200 } });
      expect(row).not.toBeNull();
      expect(row!.proposalType).toBe(ProposalType.TREASURY_SPEND);
    });

    it('persists vote from legacy event name', async () => {
      await parser.parseEvent(mapper.mapEvent(legacyProposalCreated)!);
      await parser.parseEvent(mapper.mapEvent(legacyVoteCast)!);

      const votes = await prisma.vote.findMany({ where: { voter: 'GLEGACY_VOTER' } });
      expect(votes).toHaveLength(1);
      expect(votes[0].support).toBe(true);
    });

    it('replaying legacy events is idempotent', async () => {
      const create = mapper.mapEvent(legacyProposalCreated)!;
      const vote = mapper.mapEvent(legacyVoteCast)!;

      await parser.parseEvent(create);
      await parser.parseEvent(vote);
      await parser.parseEvent(create); // replay
      await parser.parseEvent(vote);   // replay

      const count = await prisma.proposal.count({ where: { proposalId: 200 } });
      expect(count).toBe(1);

      const voteCount = await prisma.vote.count({ where: { voter: 'GLEGACY_VOTER' } });
      expect(voteCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Versioned API payload stability
  // -------------------------------------------------------------------------

  describe('Versioned event → stable API payload mapping', () => {
    it('v1 and legacy proposal_created events map to identical API shape', () => {
      const v1 = mapper.mapEvent(v1ProposalCreated)!;
      const legacy = mapper.mapEvent(legacyProposalCreated)!;

      // Both must be proposal_created type with the same required fields present
      expect(v1.type).toBe('proposal_created');
      expect(legacy.type).toBe('proposal_created');

      if (v1.type === 'proposal_created' && legacy.type === 'proposal_created') {
        expect(typeof v1.proposalId).toBe('number');
        expect(typeof v1.proposer).toBe('string');
        expect(typeof v1.title).toBe('string');
        expect(typeof legacy.proposalId).toBe('number');
        expect(typeof legacy.proposer).toBe('string');
        expect(typeof legacy.title).toBe('string');
      }
    });

    it('prop_qu_v1 maps to proposal_status_changed with QUEUED newStatus', () => {
      const ev = mapper.mapEvent(v1ProposalQueued)!;
      expect(ev.type).toBe('proposal_status_changed');
      if (ev.type === 'proposal_status_changed') {
        expect(ev.newStatus).toBe('QUEUED');
      }
    });
  });
});
