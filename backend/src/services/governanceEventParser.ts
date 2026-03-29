import { PrismaClient, ProposalStatus, ProposalType } from '@prisma/client';
import {
  ProposalCreatedEvent,
  VoteCastEvent,
  ProposalExecutedEvent,
  ProposalCancelledEvent,
  ProposalStatusChangedEvent,
  GovernanceEvent,
} from '../types/governance';

/**
 * Governance Event Parser
 * 
 * Parses and persists governance events from the blockchain
 * into the database for analytics and tracking.
 */
export class GovernanceEventParser {
  constructor(private prisma: PrismaClient) {}

  /**
   * Parse and persist a proposal created event
   */
  async parseProposalCreatedEvent(event: ProposalCreatedEvent): Promise<void> {
    try {
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
          quorum: BigInt(event.quorum),
          threshold: BigInt(event.threshold),
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
          weight: BigInt(event.weight),
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

      await this.prisma.proposalExecution.upsert({
        where: { txHash: event.txHash },
        create: {
          proposalId: proposal.id,
          executor: event.executor,
          success: event.success,
          returnData: event.returnData,
          gasUsed: event.gasUsed ? BigInt(event.gasUsed) : null,
          txHash: event.txHash,
          executedAt: event.timestamp,
        },
        update: {}, // no-op on replay
      });

      await this.prisma.proposal.update({
        where: { id: proposal.id },
        data: {
          status: ProposalStatus.EXECUTED,
          executedAt: event.timestamp,
        },
      });

      console.log(`Proposal ${event.proposalId} executed successfully`);
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

      await this.prisma.proposal.update({
        where: { id: proposal.id },
        data: {
          status: event.newStatus as ProposalStatus,
        },
      });

      console.log(`Proposal ${event.proposalId} status changed from ${event.oldStatus} to ${event.newStatus}`);
    } catch (error) {
      console.error(`Error parsing proposal status changed event:`, error);
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
