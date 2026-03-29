import {
  GovernanceEvent,
  ProposalCreatedEvent,
  VoteCastEvent,
  ProposalExecutedEvent,
  ProposalCancelledEvent,
  ProposalStatusChangedEvent,
  ProposalType,
  ProposalStatus,
} from '../types/governance';

/**
 * Stellar Event Structure
 */
interface StellarEvent {
  type: string;
  ledger: number;
  ledger_close_time: string;
  contract_id: string;
  id: string;
  paging_token: string;
  topic: string[];
  value: any;
  in_successful_contract_call: boolean;
  transaction_hash: string;
}

/**
 * Governance Event Mapper
 * 
 * Maps Stellar blockchain events to governance event types
 * for processing and persistence.
 */
export class GovernanceEventMapper {
  /**
   * Check if a Stellar event is a governance event
   */
  isGovernanceEvent(event: StellarEvent): boolean {
    if (event.topic.length < 1) {
      return false;
    }

    const eventName = event.topic[0];
    const governanceEvents = [
      // v1 versioned events (full suffix form)
      'prop_cr_v1',
      'vote_cs_v1',
      'prop_qu_v1',
      'prop_ex_v1',
      'prop_ca_v1',
      'prop_st_v1',
      // v1 abbreviated (no suffix)
      'prop_cr',
      'vote_cs',
      'prop_qu',
      'prop_ex',
      'prop_ca',
      // Legacy events (for backward compatibility)
      'prop_create',
      'vote_cast',
      'prop_exec',
      'prop_cancel',
      'prop_status',
    ];

    return governanceEvents.includes(eventName);
  }

  /**
   * Map Stellar event to governance event
   */
  mapEvent(event: StellarEvent): GovernanceEvent | null {
    if (!this.isGovernanceEvent(event)) {
      return null;
    }

    const eventName = event.topic[0];

    switch (eventName) {
      // v1 versioned events (with suffix)
      case 'prop_cr_v1':
      // v1 abbreviated (no suffix)
      case 'prop_cr':
      // Legacy
      case 'prop_create':
        return this.mapProposalCreatedEvent(event);
      case 'vote_cs_v1':
      case 'vote_cs':
      case 'vote_cast':
        return this.mapVoteCastEvent(event);
      case 'prop_qu_v1':
      case 'prop_qu':
        return this.mapProposalQueuedEvent(event);
      case 'prop_ex_v1':
      case 'prop_ex':
      case 'prop_exec':
        return this.mapProposalExecutedEvent(event);
      case 'prop_ca_v1':
      case 'prop_ca':
      case 'prop_cancel':
        return this.mapProposalCancelledEvent(event);
      case 'prop_st_v1':
      case 'prop_status':
        return this.mapProposalStatusChangedEvent(event);
      default:
        return null;
    }
  }

  /**
   * Map proposal created event
   */
  private mapProposalCreatedEvent(event: StellarEvent): ProposalCreatedEvent {
    const value = event.value || {};

    return {
      type: 'proposal_created',
      txHash: event.transaction_hash,
      ledger: event.ledger,
      timestamp: new Date(event.ledger_close_time),
      contractId: event.contract_id,
      proposalId: value.proposal_id || 0,
      tokenAddress: event.topic[1] || '',
      proposer: value.proposer || '',
      title: value.title || 'Untitled Proposal',
      description: value.description,
      proposalType: this.mapProposalType(value.proposal_type),
      startTime: value.start_time ? new Date(value.start_time * 1000) : new Date(),
      endTime: value.end_time ? new Date(value.end_time * 1000) : new Date(),
      quorum: value.quorum?.toString() || '0',
      threshold: value.threshold?.toString() || '0',
      metadata: value.metadata,
    };
  }

  /**
   * Map vote cast event
   */
  private mapVoteCastEvent(event: StellarEvent): VoteCastEvent {
    const value = event.value || {};

    return {
      type: 'vote_cast',
      txHash: event.transaction_hash,
      ledger: event.ledger,
      timestamp: new Date(event.ledger_close_time),
      contractId: event.contract_id,
      proposalId: value.proposal_id || 0,
      voter: value.voter || '',
      support: value.support === true || value.support === 1,
      weight: value.weight?.toString() || '0',
      reason: value.reason,
    };
  }

  /**
   * Map proposal queued event — queuing is a status transition, not an execution.
   */
  private mapProposalQueuedEvent(event: StellarEvent): ProposalStatusChangedEvent {
    const value = event.value || {};
    const proposalId = value.proposal_id
      ?? (event.topic[1] ? parseInt(event.topic[1], 10) : 0);

    return {
      type: 'proposal_status_changed',
      txHash: event.transaction_hash,
      ledger: event.ledger,
      timestamp: new Date(event.ledger_close_time),
      contractId: event.contract_id,
      proposalId,
      oldStatus: this.mapProposalStatus(value.old_status ?? 'passed'),
      newStatus: ProposalStatus.QUEUED,
    };
  }

  /**
   * Map proposal executed event
   */
  private mapProposalExecutedEvent(event: StellarEvent): ProposalExecutedEvent {
    const value = event.value || {};

    return {
      type: 'proposal_executed',
      txHash: event.transaction_hash,
      ledger: event.ledger,
      timestamp: new Date(event.ledger_close_time),
      contractId: event.contract_id,
      proposalId: value.proposal_id || 0,
      executor: value.executor || '',
      success: value.success === true || value.success === 1,
      returnData: value.return_data,
      gasUsed: value.gas_used?.toString(),
    };
  }

  /**
   * Map proposal cancelled event
   */
  private mapProposalCancelledEvent(event: StellarEvent): ProposalCancelledEvent {
    const value = event.value || {};

    return {
      type: 'proposal_cancelled',
      txHash: event.transaction_hash,
      ledger: event.ledger,
      timestamp: new Date(event.ledger_close_time),
      contractId: event.contract_id,
      proposalId: value.proposal_id || 0,
      canceller: value.canceller || '',
      reason: value.reason,
    };
  }

  /**
   * Map proposal status changed event
   */
  private mapProposalStatusChangedEvent(event: StellarEvent): ProposalStatusChangedEvent {
    const value = event.value || {};

    return {
      type: 'proposal_status_changed',
      txHash: event.transaction_hash,
      ledger: event.ledger,
      timestamp: new Date(event.ledger_close_time),
      contractId: event.contract_id,
      proposalId: value.proposal_id || 0,
      oldStatus: this.mapProposalStatus(value.old_status),
      newStatus: this.mapProposalStatus(value.new_status),
    };
  }

  /**
   * Map proposal type from contract value
   */
  private mapProposalType(type: string | number): ProposalType {
    if (typeof type === 'number') {
      const types = [
        ProposalType.PARAMETER_CHANGE,
        ProposalType.ADMIN_TRANSFER,
        ProposalType.TREASURY_SPEND,
        ProposalType.CONTRACT_UPGRADE,
        ProposalType.CUSTOM,
      ];
      return types[type] || ProposalType.CUSTOM;
    }

    const typeMap: Record<string, ProposalType> = {
      'parameter_change': ProposalType.PARAMETER_CHANGE,
      'admin_transfer': ProposalType.ADMIN_TRANSFER,
      'treasury_spend': ProposalType.TREASURY_SPEND,
      'contract_upgrade': ProposalType.CONTRACT_UPGRADE,
      'custom': ProposalType.CUSTOM,
    };

    return typeMap[type?.toLowerCase()] || ProposalType.CUSTOM;
  }

  /**
   * Map proposal status from contract value
   */
  private mapProposalStatus(status: string | number): ProposalStatus {
    if (typeof status === 'number') {
      const statuses = [
        ProposalStatus.ACTIVE,
        ProposalStatus.PASSED,
        ProposalStatus.REJECTED,
        ProposalStatus.QUEUED,
        ProposalStatus.EXECUTED,
        ProposalStatus.CANCELLED,
        ProposalStatus.EXPIRED,
      ];
      return statuses[status] || ProposalStatus.ACTIVE;
    }

    const statusMap: Record<string, ProposalStatus> = {
      'active': ProposalStatus.ACTIVE,
      'passed': ProposalStatus.PASSED,
      'rejected': ProposalStatus.REJECTED,
      'queued': ProposalStatus.QUEUED,
      'executed': ProposalStatus.EXECUTED,
      'cancelled': ProposalStatus.CANCELLED,
      'expired': ProposalStatus.EXPIRED,
    };

    return statusMap[status?.toLowerCase()] || ProposalStatus.ACTIVE;
  }

  /**
   * Batch map multiple events
   */
  mapEvents(events: StellarEvent[]): GovernanceEvent[] {
    return events
      .map(event => this.mapEvent(event))
      .filter((event): event is GovernanceEvent => event !== null);
  }
}

export default new GovernanceEventMapper();
