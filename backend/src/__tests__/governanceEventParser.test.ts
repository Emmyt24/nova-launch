/**
 * Table-driven validation tests for GovernanceEventParser.
 *
 * Closes the gap for malformed proposal/vote event payloads by asserting
 * that the parser rejects bad data with a typed GovernanceEventValidationError
 * (instead of letting raw Prisma/BigInt errors leak).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrismaClient, ProposalStatus, ProposalType } from '@prisma/client';
import {
  GovernanceEventParser,
  GovernanceEventValidationError,
} from '../services/governanceEventParser';
import type {
  ProposalCreatedEvent,
  VoteCastEvent,
  ProposalExecutedEvent,
  ProposalCancelledEvent,
  ProposalStatusChangedEvent,
  ProposalStateSnapshotEvent,
} from '../types/governance';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const BASE_TIMESTAMP = new Date('2024-01-15T12:00:00.000Z');
const END_TIMESTAMP = new Date('2024-01-22T12:00:00.000Z');
const CONTRACT_ID = 'CGOVCONTRACT1234567890ABCDEF';

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------

const mockProposal = {
  id: 'proposal-uuid-1',
  proposalId: 1,
  status: ProposalStatus.ACTIVE,
};

const mockPrisma = {
  proposal: {
    upsert: vi.fn().mockResolvedValue(mockProposal),
    findUnique: vi.fn().mockResolvedValue(mockProposal),
    update: vi.fn().mockResolvedValue(mockProposal),
  },
  vote: {
    upsert: vi.fn().mockResolvedValue({}),
  },
  proposalExecution: {
    create: vi.fn().mockResolvedValue({}),
  },
} as unknown as PrismaClient;

// ---------------------------------------------------------------------------
// Baseline fixtures (valid)
// ---------------------------------------------------------------------------

const baseCreatedEvent: ProposalCreatedEvent = {
  type: 'proposal_created',
  txHash: 'tx-create-valid',
  ledger: 1_000_000,
  timestamp: BASE_TIMESTAMP,
  contractId: CONTRACT_ID,
  proposalId: 1,
  tokenAddress: 'CTOKEN1234567890ABCDEFGHIJKLMN',
  proposer: 'GPROPOSER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12345',
  title: 'Increase Protocol Fee',
  description: 'Valid proposal description',
  proposalType: ProposalType.PARAMETER_CHANGE,
  startTime: BASE_TIMESTAMP,
  endTime: END_TIMESTAMP,
  quorum: '1000000000000',
  threshold: '500000000000',
  metadata: '{}',
};

const baseVoteEvent: VoteCastEvent = {
  type: 'vote_cast',
  txHash: 'tx-vote-valid',
  ledger: 1_000_100,
  timestamp: new Date('2024-01-15T13:00:00.000Z'),
  contractId: CONTRACT_ID,
  proposalId: 1,
  voter: 'GVOTER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12345',
  support: true,
  weight: '250000000000',
  reason: 'Valid vote reason',
};

const baseExecutedEvent: ProposalExecutedEvent = {
  type: 'proposal_executed',
  txHash: 'tx-exec-valid',
  ledger: 1_000_300,
  timestamp: new Date('2024-01-23T10:00:00.000Z'),
  contractId: CONTRACT_ID,
  proposalId: 1,
  executor: 'GEXECUTOR1234567890ABCDEFGHIJKLMNOPQRSTUV',
  success: true,
  returnData: '0x01',
  gasUsed: '50000',
};

const baseCancelledEvent: ProposalCancelledEvent = {
  type: 'proposal_cancelled',
  txHash: 'tx-cancel-valid',
  ledger: 1_000_400,
  timestamp: new Date('2024-01-16T09:00:00.000Z'),
  contractId: CONTRACT_ID,
  proposalId: 2,
  canceller: 'GCANCELLER1234567890ABCDEFGHIJKLMNOPQRSTUV',
  reason: 'Proposal no longer needed',
};

const baseStatusChangedEvent: ProposalStatusChangedEvent = {
  type: 'proposal_status_changed',
  txHash: 'tx-status-valid',
  ledger: 1_000_200,
  timestamp: new Date('2024-01-22T12:30:00.000Z'),
  contractId: CONTRACT_ID,
  proposalId: 1,
  oldStatus: ProposalStatus.ACTIVE,
  newStatus: ProposalStatus.PASSED,
};

const baseSnapshotEvent: ProposalStateSnapshotEvent = {
  type: 'proposal_state_snapshot',
  txHash: 'tx-snap-valid',
  ledger: 1_000_500,
  timestamp: new Date('2024-01-24T08:00:00.000Z'),
  contractId: CONTRACT_ID,
  proposalId: 1,
  status: ProposalStatus.PASSED,
  yesVotes: '300000000000',
  noVotes: '100000000000',
  quorumRequired: '1000000000000',
  snapshotLedger: 1_000_500,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GovernanceEventParser — malformed payload validation', () => {
  let parser: GovernanceEventParser;

  beforeEach(() => {
    vi.clearAllMocks();
    parser = new GovernanceEventParser(mockPrisma);
  });

  // =========================================================================
  // proposal_created
  // =========================================================================

  describe('proposal_created', () => {
    type Case = {
      label: string;
      event: ProposalCreatedEvent;
      expected?: string;
    }

    const cases: Case[] = [
      { label: 'valid baseline', event: baseCreatedEvent },
      {
        label: 'malformed quorum — not-a-number',
        event: { ...baseCreatedEvent, quorum: 'not-a-number' },
        expected: 'Invalid quorum: not-a-number',
      },
      {
        label: 'malformed threshold — not-a-number',
        event: { ...baseCreatedEvent, threshold: 'not-a-number' },
        expected: 'Invalid threshold: not-a-number',
      },
      {
        label: 'empty quorum',
        event: { ...baseCreatedEvent, quorum: '' },
        expected: 'Invalid quorum: ',
      },
    ];

    it.each(cases)('$label — returns typed error', async ({ event, expected }) => {
      if (expected) {
        await expect(parser.parseProposalCreatedEvent(event)).rejects.toThrow(
          GovernanceEventValidationError,
        );
        await expect(parser.parseProposalCreatedEvent(event)).rejects.toThrow(expected);
      } else {
        await expect(parser.parseProposalCreatedEvent(event)).resolves.toBeUndefined();
      }
    });
  });

  // =========================================================================
  // vote_cast
  // =========================================================================

  describe('vote_cast', () => {
    type Case = {
      label: string;
      event: VoteCastEvent;
      expected?: string;
    }

    const cases: Case[] = [
      { label: 'valid baseline', event: baseVoteEvent },
      {
        label: 'malformed weight — not-a-number',
        event: { ...baseVoteEvent, weight: 'not-a-number' },
        expected: 'Invalid vote weight: not-a-number',
      },
      {
        label: 'malformed weight — empty',
        event: { ...baseVoteEvent, weight: '' },
        expected: 'Invalid vote weight: ',
      },
      {
        label: 'malformed weight — decimal',
        event: { ...baseVoteEvent, weight: '1.5' },
        expected: 'Invalid vote weight: 1.5',
      },
    ];

    it.each(cases)('$label — returns typed error', async ({ event, expected }) => {
      if (expected) {
        await expect(parser.parseVoteCastEvent(event)).rejects.toThrow(
          GovernanceEventValidationError,
        );
        await expect(parser.parseVoteCastEvent(event)).rejects.toThrow(expected);
      } else {
        await expect(parser.parseVoteCastEvent(event)).resolves.toBeUndefined();
      }
    });
  });

  // =========================================================================
  // proposal_status_changed — unknown state transitions
  // =========================================================================

  describe('proposal_status_changed', () => {
    type Case = {
      label: string;
      event: ProposalStatusChangedEvent;
      expected?: string;
    }

    const cases: Case[] = [
      { label: 'valid baseline', event: baseStatusChangedEvent },
      {
        label: 'unknown new status string',
        event: { ...baseStatusChangedEvent, newStatus: 'UNKNOWN' as any },
        expected: 'Unknown proposal status: UNKNOWN',
      },
      {
        label: 'unknown new status number',
        event: { ...baseStatusChangedEvent, newStatus: 99 as any },
        expected: 'Unknown proposal status: 99',
      },
      {
        label: 'empty new status string',
        event: { ...baseStatusChangedEvent, newStatus: '' as any },
        expected: 'Unknown proposal status: ',
      },
    ];

    it.each(cases)('$label — returns typed error', async ({ event, expected }) => {
      if (expected) {
        await expect(parser.parseProposalStatusChangedEvent(event)).rejects.toThrow(
          GovernanceEventValidationError,
        );
        await expect(parser.parseProposalStatusChangedEvent(event)).rejects.toThrow(expected);
      } else {
        await expect(parser.parseProposalStatusChangedEvent(event)).resolves.toBeUndefined();
      }
    });
  });

  // =========================================================================
  // proposal_state_snapshot — missing/invalid quorum snapshot data
  // =========================================================================

  describe('proposal_state_snapshot', () => {
    type Case = {
      label: string;
      event: ProposalStateSnapshotEvent;
      expected?: string;
    }

    const cases: Case[] = [
      { label: 'valid baseline', event: baseSnapshotEvent },
      {
        label: 'unknown snapshot status',
        event: { ...baseSnapshotEvent, status: 'BOGUS' as any },
        expected: 'Unknown snapshot status: BOGUS',
      },
      {
        label: 'missing quorumRequired',
        event: { ...baseSnapshotEvent, quorumRequired: '' },
        expected: 'Invalid snapshot quorumRequired: ',
      },
      {
        label: 'malformed yesVotes',
        event: { ...baseSnapshotEvent, yesVotes: 'not-a-number' as any },
        expected: 'Invalid snapshot yesVotes: not-a-number',
      },
      {
        label: 'malformed noVotes',
        event: { ...baseSnapshotEvent, noVotes: 'xyz' as any },
        expected: 'Invalid snapshot noVotes: xyz',
      },
      {
        label: 'missing quorumRequired — empty string',
        event: { ...baseSnapshotEvent, quorumRequired: '   ' },
        expected: 'Invalid snapshot quorumRequired:    ',
      },
    ];

    it.each(cases)('$label — returns typed error', async ({ event, expected }) => {
      (mockPrisma.proposal.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockProposal);
      if (expected) {
        await expect(parser.parseProposalStateSnapshotEvent(event)).rejects.toThrow(
          GovernanceEventValidationError,
        );
        await expect(parser.parseProposalStateSnapshotEvent(event)).rejects.toThrow(expected);
      } else {
        await expect(parser.parseProposalStateSnapshotEvent(event)).resolves.toBeUndefined();
      }
    });
  });

  // =========================================================================
  // Valid baseline regression — each event type resolves without error
  // =========================================================================

  describe('valid baseline regression', () => {
    it('proposal_created resolves', async () => {
      await expect(parser.parseProposalCreatedEvent(baseCreatedEvent)).resolves.toBeUndefined();
    });

    it('vote_cast resolves', async () => {
      await expect(parser.parseVoteCastEvent(baseVoteEvent)).resolves.toBeUndefined();
    });

    it('proposal_executed resolves', async () => {
      await expect(parser.parseProposalExecutedEvent(baseExecutedEvent)).resolves.toBeUndefined();
    });

    it('proposal_cancelled resolves', async () => {
      await expect(parser.parseProposalCancelledEvent(baseCancelledEvent)).resolves.toBeUndefined();
    });

    it('proposal_status_changed resolves', async () => {
      await expect(parser.parseProposalStatusChangedEvent(baseStatusChangedEvent)).resolves.toBeUndefined();
    });

    it('proposal_state_snapshot resolves', async () => {
      (mockPrisma.proposal.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockProposal);
      await expect(parser.parseProposalStateSnapshotEvent(baseSnapshotEvent)).resolves.toBeUndefined();
    });
  });
});
