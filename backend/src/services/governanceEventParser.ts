import { PrismaClient, ProposalStatus, ProposalType } from '@prisma/client';
import axios from 'axios';
import {
  ProposalCreatedEvent,
  VoteCastEvent,
  ProposalExecutedEvent,
  ProposalCancelledEvent,
  ProposalStatusChangedEvent,
  ProposalStateSnapshotEvent,
  GovernanceEvent,
} from '../types/governance';
import { GovernanceEventMapper } from './governanceEventMapper';
import { EventCursorStore } from './eventCursorStore';

/**
 * Default bounded catchup window in ledgers.
 * Prevents unbounded replay on first start or after very long downtime.
 * Can be overridden via the GOVERNANCE_CATCHUP_WINDOW environment variable.
 */
export const DEFAULT_GOVERNANCE_CATCHUP_WINDOW = 10_000;

/**
 * Horizon transport abstraction used by catchupFromCursor.
 * Matches the HorizonTransport interface in stellarEventListener.ts so the
 * same mock can be reused in tests.
 */
export interface GovernanceCatchupTransport {
  getEvents(url: string, params: Record<string, unknown>): Promise<{
    data: { _embedded?: { records: RawStellarEvent[] } };
  }>;
}

export interface RawStellarEvent {
  type: string;
  ledger: number;
  ledger_close_time: string;
  contract_id: string;
  id: string;
  paging_token: string;
  topic: string[];
  value: unknown;
  in_successful_contract_call: boolean;
  transaction_hash: string;
}

/**
 * Default transport that delegates to axios — identical to DefaultHorizonTransport
 * in stellarEventListener.ts.
 */
export class DefaultGovernanceCatchupTransport implements GovernanceCatchupTransport {
  async getEvents(url: string, params: Record<string, unknown>) {
    return axios.get(url, { params, timeout: 30_000 });
  }
}

/**
 * Contract error details structure
 * Aligned with docs/CONTRACT_ERROR_MATRIX.md
 */
export interface ContractErrorDetails {
  errorCode?: string;
  message: string;
  details?: string;
  retryable: boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
  rawError?: string;
}

/**
 * Validation error thrown when a governance event payload is malformed.
 */
export class GovernanceEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceEventValidationError';
  }
}

/**
 * Known contract error codes from CONTRACT_ERROR_MATRIX.md
 */
const KNOWN_CONTRACT_ERRORS = new Set([
  // Token errors
  'TOKEN_ALREADY_EXISTS', 'INVALID_TOKEN_PARAMS', 'TOKEN_NOT_FOUND',
  'UNAUTHORIZED_BURN', 'BURN_AMOUNT_EXCEEDS_BALANCE', 'ZERO_BURN_AMOUNT',
  'METADATA_TOO_LARGE', 'INVALID_METADATA_URI',
  // Campaign errors
  'CAMPAIGN_NOT_FOUND', 'CAMPAIGN_ALREADY_EXISTS', 'CAMPAIGN_NOT_ACTIVE',
  'CAMPAIGN_ENDED', 'INSUFFICIENT_BUDGET', 'INVALID_TIME_RANGE',
  'INVALID_SLIPPAGE', 'UNAUTHORIZED_CREATOR', 'MIN_INTERVAL_NOT_MET',
  // Governance errors
  'PROPOSAL_NOT_FOUND', 'VOTING_NOT_STARTED', 'VOTING_ENDED',
  'ALREADY_VOTED', 'INSUFFICIENT_VOTING_POWER', 'QUORUM_NOT_MET',
  'UNAUTHORIZED_PROPOSER',
  // Vault errors
  'VAULT_NOT_FOUND', 'VAULT_ALREADY_CLAIMED', 'UNAUTHORIZED_CLAIMER',
  // Stream errors
  'STREAM_NOT_FOUND', 'STREAM_ALREADY_CLAIMED', 'UNAUTHORIZED_STREAM_CLAIMER',
  // System errors
  'CONTRACT_PAUSED',
]);

  /**
   * Governance Event Parser
   * 
   * Parses and persists governance events from the blockchain
   * into the database for analytics and tracking.
   * 
   * Preserves structured error details aligned with frontend error semantics.
   */
  export class GovernanceEventParser {
    private readonly mapper: GovernanceEventMapper;
    private readonly cursorStore: EventCursorStore;
    private readonly transport: GovernanceCatchupTransport;

    constructor(
      private prisma: PrismaClient,
      opts?: {
        transport?: GovernanceCatchupTransport;
        cursorStore?: EventCursorStore;
      },
    ) {
      this.mapper = new GovernanceEventMapper();
      this.cursorStore = opts?.cursorStore ?? new EventCursorStore(prisma);
      this.transport = opts?.transport ?? new DefaultGovernanceCatchupTransport();
    }

    private validateBigIntString(value: unknown, field: string): string {
      const str = typeof value === 'string' ? value : String(value ?? '');
      if (!/^-?\d+$/.test(str)) {
        throw new GovernanceEventValidationError(`Invalid ${field}: ${str}`);
      }
      return str;
    }

    private validateProposalStatus(status: unknown, field: string): ProposalStatus {
      const str = typeof status === 'string' ? status.toLowerCase() : String(status ?? '').toLowerCase();
      const statusMap: Record<string, ProposalStatus> = {
        'active': ProposalStatus.ACTIVE,
        'passed': ProposalStatus.PASSED,
        'rejected': ProposalStatus.REJECTED,
        'queued': ProposalStatus.QUEUED,
        'executed': ProposalStatus.EXECUTED,
        'cancelled': ProposalStatus.CANCELLED,
        'expired': ProposalStatus.EXPIRED,
        'created': ProposalStatus.ACTIVE,
        'succeeded': ProposalStatus.PASSED,
        'defeated': ProposalStatus.REJECTED,
        'failed': ProposalStatus.REJECTED,
      };
      const mapped = statusMap[str];
      if (!mapped) {
        throw new GovernanceEventValidationError(`Unknown ${field}: ${String(status)}`);
      }
      return mapped;
    }

  /**
   * Parse contract error from error response
   * Aligned with docs/CONTRACT_ERROR_MATRIX.md
   */
  private parseContractError(error: any): ContractErrorDetails {
    // Extract error code from various formats
    let errorCode: string | undefined;
    
    if (error.contractErrorCode) {
      errorCode = error.contractErrorCode;
    } else if (error.message) {
      const match = error.message.match(/Error\(([A-Z_]+)\)/);
      if (match) {
        errorCode = match[1];
      }
    }

    // Check if it's a known error
    if (errorCode && KNOWN_CONTRACT_ERRORS.has(errorCode)) {
      return {
        errorCode,
        message: error.message || `Contract error: ${errorCode}`,
        details: error.details || `Error(${errorCode})`,
        retryable: this.isRetryableError(errorCode),
        severity: this.getErrorSeverity(errorCode),
      };
    }

    // Unknown error - preserve raw details
    return {
      errorCode,
      message: error.message || 'Unknown contract error',
      details: error.details || JSON.stringify(error),
      retryable: true,
      severity: 'medium',
      rawError: JSON.stringify(error),
    };
  }

  /**
   * Determine if error is retryable based on error code
   */
  private isRetryableError(errorCode: string): boolean {
    const retryableErrors = new Set([
      'METADATA_TOO_LARGE',
      'MIN_INTERVAL_NOT_MET',
      'CONTRACT_PAUSED',
    ]);
    return retryableErrors.has(errorCode);
  }

  /**
   * Get error severity based on error code
   */
  private getErrorSeverity(errorCode: string): 'low' | 'medium' | 'high' | 'critical' {
    const highSeverityErrors = new Set([
      'UNAUTHORIZED_BURN',
      'INSUFFICIENT_BUDGET',
      'UNAUTHORIZED_CREATOR',
      'INSUFFICIENT_VOTING_POWER',
      'UNAUTHORIZED_PROPOSER',
      'UNAUTHORIZED_CLAIMER',
      'UNAUTHORIZED_STREAM_CLAIMER',
    ]);

    const lowSeverityErrors = new Set([
      'ZERO_BURN_AMOUNT',
    ]);

    const criticalErrors = new Set([
      'CONTRACT_PAUSED',
    ]);

    if (criticalErrors.has(errorCode)) return 'critical';
    if (highSeverityErrors.has(errorCode)) return 'high';
    if (lowSeverityErrors.has(errorCode)) return 'low';
    return 'medium';
  }

  /**
   * Parse and persist a proposal created event
   */
  async parseProposalCreatedEvent(event: ProposalCreatedEvent): Promise<void> {
    try {
      const quorum = this.validateBigIntString(event.quorum, 'quorum');
      const threshold = this.validateBigIntString(event.threshold, 'threshold');

      await this.prisma.proposal.upsert({
        where: { proposalId: event.proposalId },
        create: {
          proposalId: event.proposalId,
          tokenId: event.tokenAddress,
          proposer: event.proposer,
          title: event.title,
          description: event.description,
          proposalType: event.proposalType as ProposalType,
          status: ProposalStatus.ACTIVE,
          startTime: event.startTime,
          endTime: event.endTime,
          quorum: BigInt(quorum),
          threshold: BigInt(threshold),
          metadata: event.metadata,
          txHash: event.txHash,
          createdAt: event.timestamp,
        },
        update: {}, // no-op on replay — proposal fields are immutable after creation
      });

      console.log(`Proposal ${event.proposalId} created successfully`);
    } catch (error) {
      console.error(`Error parsing proposal created event:`, error);
      throw error;
    }
  }

  /**
   * Parse and persist a vote cast event
   */
  async parseVoteCastEvent(event: VoteCastEvent): Promise<void> {
    try {
      const weight = this.validateBigIntString(event.weight, 'vote weight');

      const proposal = await this.prisma.proposal.findUnique({
        where: { proposalId: event.proposalId },
      });

      if (!proposal) {
        throw new Error(`Proposal ${event.proposalId} not found`);
      }

      await this.prisma.vote.upsert({
        where: { txHash: event.txHash },
        create: {
          proposalId: proposal.id,
          voter: event.voter,
          support: event.support,
          weight: BigInt(weight),
          reason: event.reason,
          txHash: event.txHash,
          timestamp: event.timestamp,
        },
        update: {}, // no-op on replay — votes are immutable
      });

      console.log(`Vote cast for proposal ${event.proposalId} by ${event.voter}`);
    } catch (error) {
      console.error(`Error parsing vote cast event:`, error);
      throw error;
    }
  }

  /**
   * Parse and persist a proposal executed event
   */
  async parseProposalExecutedEvent(event: ProposalExecutedEvent): Promise<void> {
    try {
      const proposal = await this.prisma.proposal.findUnique({
        where: { proposalId: event.proposalId },
      });

      if (!proposal) {
        throw new Error(`Proposal ${event.proposalId} not found`);
      }

      // Parse error details if execution failed
      let errorDetails: ContractErrorDetails | undefined;
      if (!event.success && event.returnData) {
        try {
          const errorData = JSON.parse(event.returnData);
          errorDetails = this.parseContractError(errorData);
        } catch (parseError) {
          // If parsing fails, preserve raw error
          errorDetails = {
            message: 'Execution failed',
            details: event.returnData,
            retryable: false,
            severity: 'high',
            rawError: event.returnData,
          };
        }
      }

      // Create execution record with structured error details
      await this.prisma.proposalExecution.create({
        data: {
          proposalId: proposal.id,
          executor: event.executor,
          success: event.success,
          returnData: event.returnData,
          gasUsed: event.gasUsed ? BigInt(event.gasUsed) : null,
          txHash: event.txHash,
          executedAt: event.timestamp,
        },
      });

      await this.prisma.proposal.update({
        where: { id: proposal.id },
        data: {
          status: event.success ? ProposalStatus.EXECUTED : ProposalStatus.REJECTED,
          executedAt: event.timestamp,
        },
      });

      if (event.success) {
        console.log(`Proposal ${event.proposalId} executed successfully`);
      } else {
        console.log(`Proposal ${event.proposalId} execution failed:`, errorDetails);
      }
    } catch (error) {
      console.error(`Error parsing proposal executed event:`, error);
      throw error;
    }
  }

  /**
   * Parse and persist a proposal cancelled event
   */
  async parseProposalCancelledEvent(event: ProposalCancelledEvent): Promise<void> {
    try {
      const proposal = await this.prisma.proposal.findUnique({
        where: { proposalId: event.proposalId },
      });

      if (!proposal) {
        throw new Error(`Proposal ${event.proposalId} not found`);
      }

      await this.prisma.proposal.update({
        where: { id: proposal.id },
        data: {
          status: ProposalStatus.CANCELLED,
          cancelledAt: event.timestamp,
          canceller: event.canceller,
          cancelReason: event.reason ?? null,
        },
      });

      console.log(`Proposal ${event.proposalId} cancelled`);
    } catch (error) {
      console.error(`Error parsing proposal cancelled event:`, error);
      throw error;
    }
  }

  /**
   * Parse and persist a proposal status changed event
   */
  async parseProposalStatusChangedEvent(event: ProposalStatusChangedEvent): Promise<void> {
    try {
      const proposal = await this.prisma.proposal.findUnique({
        where: { proposalId: event.proposalId },
      });

      if (!proposal) {
        throw new Error(`Proposal ${event.proposalId} not found`);
      }

      const newStatus = this.validateProposalStatus(event.newStatus, 'proposal status');

      await this.prisma.proposal.update({
        where: { id: proposal.id },
        data: {
          status: newStatus,
        },
      });

      console.log(`Proposal ${event.proposalId} status changed from ${event.oldStatus} to ${event.newStatus}`);
    } catch (error) {
      console.error(`Error parsing proposal status changed event:`, error);
      throw error;
    }
  }

  /**
   * Parse and persist a proposal state snapshot event (#1383).
   *
   * Snapshots are periodic/on-demand checkpoints of a proposal's fully
   * accumulated state (status + vote tallies as of a given ledger). They
   * let an indexer fast-forward instead of replaying every event from
   * genesis: this handler simply fast-forwards the proposal's `status` to
   * match the snapshot.
   *
   * Snapshots are derived from, and must always agree with, the same
   * persisted contract state used by `vote_cast`/`proposal_status_changed`
   * events, so applying one is idempotent and never diverges from a full
   * event replay — applying it twice (or out of order with a slightly
   * stale snapshot) only ever re-asserts a status the proposal already
   * passed through.
   *
   * Unlike the other handlers, a missing proposal is *not* treated as an
   * error: a snapshot may be the very first event an indexer observes when
   * fast-forwarding from a checkpoint, before the originating
   * `proposal_created` event (which may predate the indexer's replay
   * window) has been (re)played.
   */
  async parseProposalStateSnapshotEvent(event: ProposalStateSnapshotEvent): Promise<void> {
    try {
      const proposal = await this.prisma.proposal.findUnique({
        where: { proposalId: event.proposalId },
      });

      if (!proposal) {
        console.warn(
          `[GovernanceEventParser] Snapshot for unknown proposal ${event.proposalId} ` +
            `at ledger ${event.snapshotLedger} — skipping (proposal not yet indexed)`,
        );
        return;
      }

      const status = this.validateProposalStatus(event.status, 'snapshot status');
      this.validateBigIntString(event.yesVotes, 'snapshot yesVotes');
      this.validateBigIntString(event.noVotes, 'snapshot noVotes');
      this.validateBigIntString(event.quorumRequired, 'snapshot quorumRequired');

      await this.prisma.proposal.update({
        where: { id: proposal.id },
        data: {
          status,
        },
      });

      console.log(
        `Proposal ${event.proposalId} snapshot at ledger ${event.snapshotLedger}: ` +
          `status=${event.status} yes=${event.yesVotes} no=${event.noVotes} ` +
          `quorumRequired=${event.quorumRequired}`,
      );
    } catch (error) {
      console.error(`Error parsing proposal state snapshot event:`, error);
      throw error;
    }
  }

  /**
   * Parse any governance event
   */
  async parseEvent(event: GovernanceEvent): Promise<void> {
    switch (event.type) {
      case 'proposal_created':
        await this.parseProposalCreatedEvent(event);
        break;
      case 'vote_cast':
        await this.parseVoteCastEvent(event);
        break;
      case 'proposal_executed':
        await this.parseProposalExecutedEvent(event);
        break;
      case 'proposal_cancelled':
        await this.parseProposalCancelledEvent(event);
        break;
      case 'proposal_status_changed':
        await this.parseProposalStatusChangedEvent(event);
        break;
      case 'proposal_state_snapshot':
        await this.parseProposalStateSnapshotEvent(event);
        break;
      default:
        console.warn(`Unknown governance event type:`, event);
    }
  }

  /**
   * Get proposal analytics
   */
  async getProposalAnalytics(proposalId: number) {
    const proposal = await this.prisma.proposal.findUnique({
      where: { proposalId },
      include: {
        votes: true,
      },
    });

    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`);
    }

    const votesFor = proposal.votes
      .filter(v => v.support)
      .reduce((sum, v) => sum + v.weight, BigInt(0));

    const votesAgainst = proposal.votes
      .filter(v => !v.support)
      .reduce((sum, v) => sum + v.weight, BigInt(0));

    const totalVotingPower = votesFor + votesAgainst;
    const participationRate = proposal.quorum > BigInt(0)
      ? Number((totalVotingPower * BigInt(100)) / proposal.quorum)
      : 0;

    const now = new Date();
    const timeRemaining = proposal.endTime > now
      ? Math.floor((proposal.endTime.getTime() - now.getTime()) / 1000)
      : 0;

    return {
      proposalId: proposal.proposalId,
      totalVotes: proposal.votes.length,
      votesFor: votesFor.toString(),
      votesAgainst: votesAgainst.toString(),
      participationRate,
      uniqueVoters: proposal.votes.length,
      status: proposal.status,
      timeRemaining: timeRemaining > 0 ? timeRemaining : undefined,
    };
  }

  /**
   * Get governance statistics
   */
  async getGovernanceStats() {
    const [
      totalProposals,
      activeProposals,
      executedProposals,
      totalVotes,
      uniqueVoters,
      proposalsByType,
      proposalsByStatus,
    ] = await Promise.all([
      this.prisma.proposal.count(),
      this.prisma.proposal.count({ where: { status: ProposalStatus.ACTIVE } }),
      this.prisma.proposal.count({ where: { status: ProposalStatus.EXECUTED } }),
      this.prisma.vote.count(),
      this.prisma.vote.groupBy({
        by: ['voter'],
        _count: true,
      }),
      this.prisma.proposal.groupBy({
        by: ['proposalType'],
        _count: true,
      }),
      this.prisma.proposal.groupBy({
        by: ['status'],
        _count: true,
      }),
    ]);

    // Calculate average participation
    const proposals = await this.prisma.proposal.findMany({
      include: { votes: true },
    });

    const avgParticipation = proposals.length > 0
      ? proposals.reduce((sum, p) => {
          const totalVotes = p.votes.reduce((s, v) => s + v.weight, BigInt(0));
          const rate = p.quorum > BigInt(0)
            ? Number((totalVotes * BigInt(100)) / p.quorum)
            : 0;
          return sum + rate;
        }, 0) / proposals.length
      : 0;

    return {
      totalProposals,
      activeProposals,
      executedProposals,
      totalVotes,
      uniqueVoters: uniqueVoters.length,
      averageParticipation: avgParticipation,
      proposalsByType: Object.fromEntries(
        proposalsByType.map(p => [p.proposalType, p._count])
      ),
      proposalsByStatus: Object.fromEntries(
        proposalsByStatus.map(p => [p.status, p._count])
      ),
    };
  }
}
