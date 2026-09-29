/**
 * Governance Event Types
 * 
 * These types represent governance events emitted by smart contracts
 * and processed by the backend for analytics and tracking.
 */

/**
 * Governance percentage fields and the shared validator
 * (`src/lib/validation/governancePercentage.ts`).
 *
 * The shared percentage validator is the single source of truth for
 * governance percentage fields that are expressed as a fraction of the
 * total voting power and are therefore bounded to the inclusive range
 * `[0, 100]`. The following fields in this codebase are expected to
 * route through that validator:
 *
 * - `quorum_percent` — minimum participation required for a proposal to
 *   be valid; a fraction of total voting power, so `[0, 100]`.
 * - `approval_percent` — share of cast votes that must support a
 *   proposal; a fraction of cast votes, so `[0, 100]`.
 * - `threshold` (see `ProposalCreatedEvent`) — the approval threshold
 *   recorded on a proposal; same `[0, 100]` fraction semantics as
 *   `approval_percent`.
 * - `quorum` (see `ProposalCreatedEvent`) — the quorum recorded on a
 *   proposal; same `[0, 100]` fraction semantics as `quorum_percent`.
 *
 * Deliberate exceptions — percentage-like fields that intentionally do
 * NOT use the shared validator:
 *
 * - `participationRate` (`ProposalAnalytics`, `VoterStats`) and
 *   `averageParticipation` (`GovernanceStats`) are derived analytics
 *   values computed by the backend, not user-supplied governance
 *   parameters. They are not validated on input and are not routed
 *   through the shared validator.
 * - `quorumRequired` (`ProposalStateSnapshotEvent`) is a contract-emitted
 *   snapshot value reported by the chain, not an input parameter, so it
 *   is not validated by the backend.
 *
 * If a new governance percentage field is added, route it through the
 * shared validator unless it has genuinely different bounds; if so,
 * document the exception here with the reason.
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

/**
 * Periodic (every ~1000 ledgers) or on-demand checkpoint of a proposal's
 * fully accumulated state, emitted by the contract's `prop_snap`
 * (`ProposalStateSnapshot`) event (#1383).
 *
 * Off-chain indexers can use this as a fast-forward point: instead of
 * replaying every `proposal_created`/`vote_cast`/status-change event from
 * genesis, an indexer can seed its projection from the latest snapshot for
 * a proposal and only replay events emitted after `snapshotLedger`.
 */
export interface ProposalStateSnapshotEvent extends BaseGovernanceEvent {
  type: 'proposal_state_snapshot';
  proposalId: number;
  status: ProposalStatus;
  yesVotes: string;
  noVotes: string;
  quorumRequired: string;
  /** Ledger sequence at which the contract took this snapshot. */
  snapshotLedger: number;
}

export type GovernanceEvent =
  | ProposalCreatedEvent
  | VoteCastEvent
  | ProposalExecutedEvent
  | ProposalCancelledEvent
  | ProposalStatusChangedEvent
  | ProposalStateSnapshotEvent;

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
