/**
 * Governance Event Types
 * 
 * These types represent governance events emitted by smart contracts
 * and processed by the backend for analytics and tracking.
 */

export enum ProposalType {
  PARAMETER_CHANGE = 'PARAMETER_CHANGE',
  ADMIN_TRANSFER = 'ADMIN_TRANSFER',
  TREASURY_SPEND = 'TREASURY_SPEND',
  CONTRACT_UPGRADE = 'CONTRACT_UPGRADE',
  CUSTOM = 'CUSTOM',
}

export enum ProposalStatus {
  ACTIVE = 'ACTIVE',
  PASSED = 'PASSED',
  REJECTED = 'REJECTED',
  QUEUED = 'QUEUED',
  EXECUTED = 'EXECUTED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export interface BaseGovernanceEvent {
  txHash: string;
  ledger: number;
  timestamp: Date;
  contractId: string;
}

export interface ProposalCreatedEvent extends BaseGovernanceEvent {
  type: 'proposal_created';
  proposalId: number;
  tokenAddress: string;
  proposer: string;
  title: string;
  description?: string;
  proposalType: ProposalType;
  startTime: Date;
  endTime: Date;
  quorum: string;
  threshold: string;
  metadata?: string;
}

export interface VoteCastEvent extends BaseGovernanceEvent {
  type: 'vote_cast';
  proposalId: number;
  voter: string;
  support: boolean;
  weight: string;
  reason?: string;
}

export interface ProposalExecutedEvent extends BaseGovernanceEvent {
  type: 'proposal_executed';
  proposalId: number;
  executor: string;
  success: boolean;
  returnData?: string;
  gasUsed?: string;
}

export interface ProposalCancelledEvent extends BaseGovernanceEvent {
  type: 'proposal_cancelled';
  proposalId: number;
  canceller: string;
  reason?: string;
}

export interface ProposalStatusChangedEvent extends BaseGovernanceEvent {
  type: 'proposal_status_changed';
  proposalId: number;
  oldStatus: ProposalStatus;
  newStatus: ProposalStatus;
}

export type GovernanceEvent =
  | ProposalCreatedEvent
  | VoteCastEvent
  | ProposalExecutedEvent
  | ProposalCancelledEvent
  | ProposalStatusChangedEvent;

/**
 * Governance Analytics Types
 */

export interface ProposalAnalytics {
  proposalId: number;
  totalVotes: number;
  votesFor: string;
  votesAgainst: string;
  participationRate: number;
  uniqueVoters: number;
  status: ProposalStatus;
  timeRemaining?: number;
}

export interface GovernanceStats {
  totalProposals: number;
  activeProposals: number;
  executedProposals: number;
  totalVotes: number;
  uniqueVoters: number;
  averageParticipation: number;
  proposalsByType: Record<ProposalType, number>;
  proposalsByStatus: Record<ProposalStatus, number>;
}

export interface VoterStats {
  address: string;
  totalVotes: number;
  votingPower: string;
  participationRate: number;
  proposalsVoted: number[];
}
