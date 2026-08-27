/**
 * Schema Contract Test: Governance Proposal Status-Changed Event
 *
 * Validates that the governanceEventParser.ts + governanceEventMapper.ts output
 * conforms to event-schemas/governance.proposal.statusChanged.schema.json for
 * every documented status transition.
 *
 * This producer-consumer contract ensures that mapped events can be reliably
 * ingested by downstream consumers (subscriptions, webhooks, projections).
 *
 * Closes #1572
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Ajv from 'ajv';
import * as fs from 'fs';
import * as path from 'path';
import { GovernanceEventMapper } from '../services/governanceEventMapper';
import { ProposalStatus } from '@prisma/client';
import type { ProposalStatusChangedEvent } from '../types/governance';

// ---------------------------------------------------------------------------
// Load Schema
// ---------------------------------------------------------------------------

const schemaPath = path.join(
  __dirname,
  '../../..',
  'event-schemas/governance.proposal.statusChanged.schema.json'
);

const rawSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));

// ---------------------------------------------------------------------------
// Ajv Validator Setup
// ---------------------------------------------------------------------------

const ajv = new Ajv();
const validateAgainstSchema = ajv.compile(rawSchema);

// ---------------------------------------------------------------------------
// Test Fixtures: Status Transitions
// ---------------------------------------------------------------------------

/**
 * Define every valid proposal status transition that can occur in the system.
 * Each transition produces a ProposalStatusChangedEvent that MUST validate
 * against the schema.
 */
const statusTransitions = [
  {
    name: 'active → passed',
    oldStatus: ProposalStatus.ACTIVE,
    newStatus: ProposalStatus.PASSED,
  },
  {
    name: 'active → rejected',
    oldStatus: ProposalStatus.ACTIVE,
    newStatus: ProposalStatus.REJECTED,
  },
  {
    name: 'active → expired',
    oldStatus: ProposalStatus.ACTIVE,
    newStatus: ProposalStatus.EXPIRED,
  },
  {
    name: 'active → cancelled',
    oldStatus: ProposalStatus.ACTIVE,
    newStatus: ProposalStatus.CANCELLED,
  },
  {
    name: 'passed → queued',
    oldStatus: ProposalStatus.PASSED,
    newStatus: ProposalStatus.QUEUED,
  },
  {
    name: 'passed → cancelled',
    oldStatus: ProposalStatus.PASSED,
    newStatus: ProposalStatus.CANCELLED,
  },
  {
    name: 'queued → executed',
    oldStatus: ProposalStatus.QUEUED,
    newStatus: ProposalStatus.EXECUTED,
  },
  {
    name: 'queued → cancelled',
    oldStatus: ProposalStatus.QUEUED,
    newStatus: ProposalStatus.CANCELLED,
  },
  {
    name: 'rejected → cancelled',
    oldStatus: ProposalStatus.REJECTED,
    newStatus: ProposalStatus.CANCELLED,
  },
  {
    name: 'expired → cancelled',
    oldStatus: ProposalStatus.EXPIRED,
    newStatus: ProposalStatus.CANCELLED,
  },
];

// ---------------------------------------------------------------------------
// Stellar Event Fixtures
// ---------------------------------------------------------------------------

/**
 * Factory: creates a minimal Stellar event for a proposal status change.
 */
function makeStellarStatusChangeEvent(
  newStatus: ProposalStatus,
  oldStatus: ProposalStatus,
  proposalId: number = 42
) {
  const ledgerCloseTime = new Date().toISOString();

  return {
    type: 'contract',
    ledger: 12345,
    ledger_close_time: ledgerCloseTime,
    contract_id: 'CGOVCONTRACT1234567890ABCDEF',
    id: 'event-' + Math.random().toString(36).slice(2),
    paging_token: 'paging-token-1',
    topic: ['prop_st_v1'],
    value: {
      proposal_id: proposalId,
      old_status: oldStatus,
      new_status: newStatus,
    },
    in_successful_contract_call: true,
    transaction_hash: 'tx-hash-status-change-' + proposalId,
  };
}

/**
 * Convert ProposalStatus enum value to string for Stellar event compatibility.
 */
function statusToString(status: ProposalStatus): string {
  const statusMap: Record<ProposalStatus, string> = {
    [ProposalStatus.ACTIVE]: 'active',
    [ProposalStatus.PASSED]: 'passed',
    [ProposalStatus.REJECTED]: 'rejected',
    [ProposalStatus.QUEUED]: 'queued',
    [ProposalStatus.EXECUTED]: 'executed',
    [ProposalStatus.CANCELLED]: 'cancelled',
    [ProposalStatus.EXPIRED]: 'expired',
  };
  return statusMap[status];
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Schema Contract: governance.proposal.statusChanged (#1572)', () => {
  let mapper: GovernanceEventMapper;

  beforeEach(() => {
    mapper = new GovernanceEventMapper();
  });

  // -- Contract Test: Every transition validates against schema --

  it.each(statusTransitions)(
    'mapped event for $name transition validates against schema',
    ({ oldStatus, newStatus }) => {
      // Create a Stellar event with string status values
      const oldStatusStr = statusToString(oldStatus);
      const newStatusStr = statusToString(newStatus);

      const stellarEvent = {
        type: 'contract',
        ledger: 12345,
        ledger_close_time: new Date().toISOString(),
        contract_id: 'CGOVCONTRACT1234567890ABCDEF',
        id: 'event-' + Math.random().toString(36).slice(2),
        paging_token: 'paging-token-1',
        topic: ['prop_st_v1'],
        value: {
          proposal_id: 100,
          old_status: oldStatusStr,
          new_status: newStatusStr,
        },
        in_successful_contract_call: true,
        transaction_hash: 'tx-hash-transition-test',
      };

      // Map the Stellar event
      const mapped = mapper.mapEvent(stellarEvent);

      // Should be a proposal_status_changed event
      expect(mapped).toBeDefined();
      expect(mapped?.type).toBe('proposal_status_changed');

      const statusChangedEvent = mapped as ProposalStatusChangedEvent;

      // Construct the payload object that would be published
      const eventPayload = {
        schemaVersion: 1,
        creatorAddress: 'GCREATOR1234567890ABCDEF',
        proposalId: statusChangedEvent.proposalId,
        tokenAddress: 'GTOKEN1234567890ABCDEF',
        status: statusToString(statusChangedEvent.newStatus),
        previousStatus: statusToString(statusChangedEvent.oldStatus),
        txHash: statusChangedEvent.txHash,
        timestamp: statusChangedEvent.timestamp.toISOString(),
      };

      // Validate against schema
      const isValid = validateAgainstSchema(eventPayload);

      if (!isValid) {
        console.error('Validation errors:', validateAgainstSchema.errors);
      }

      expect(isValid).toBe(true);
    }
  );

  // -- Additional Schema Compliance Tests --

  it('validates that mapped event has all required schema fields', () => {
    const stellarEvent = makeStellarStatusChangeEvent(
      ProposalStatus.PASSED,
      ProposalStatus.ACTIVE,
      99
    );

    const mapped = mapper.mapEvent(stellarEvent) as ProposalStatusChangedEvent;

    expect(mapped).toBeDefined();
    expect(mapped.proposalId).toBeDefined();
    expect(mapped.txHash).toBeDefined();
    expect(mapped.timestamp).toBeDefined();
    expect(mapped.oldStatus).toBeDefined();
    expect(mapped.newStatus).toBeDefined();
  });

  it('validates event payload with schemaVersion field', () => {
    const stellarEvent = makeStellarStatusChangeEvent(
      ProposalStatus.EXECUTED,
      ProposalStatus.QUEUED
    );

    const mapped = mapper.mapEvent(stellarEvent) as ProposalStatusChangedEvent;

    const eventPayload = {
      schemaVersion: 1,
      creatorAddress: 'GCREATOR1234567890ABCDEF',
      proposalId: mapped.proposalId,
      tokenAddress: 'GTOKEN1234567890ABCDEF',
      status: statusToString(mapped.newStatus),
      previousStatus: statusToString(mapped.oldStatus),
      txHash: mapped.txHash,
      timestamp: mapped.timestamp.toISOString(),
    };

    const isValid = validateAgainstSchema(eventPayload);
    expect(isValid).toBe(true);
  });

  it('rejects events with missing required fields', () => {
    // Payload missing 'txHash'
    const invalidPayload = {
      schemaVersion: 1,
      creatorAddress: 'GCREATOR1234567890ABCDEF',
      proposalId: 42,
      tokenAddress: 'GTOKEN1234567890ABCDEF',
      status: 'passed',
      previousStatus: 'active',
      timestamp: new Date().toISOString(),
      // Missing: txHash
    };

    const isValid = validateAgainstSchema(invalidPayload);
    expect(isValid).toBe(false);
  });

  it('rejects events with invalid schema version', () => {
    const eventPayload = {
      schemaVersion: 2, // Wrong version — should be 1
      creatorAddress: 'GCREATOR1234567890ABCDEF',
      proposalId: 42,
      tokenAddress: 'GTOKEN1234567890ABCDEF',
      status: 'passed',
      previousStatus: 'active',
      txHash: 'tx-hash',
      timestamp: new Date().toISOString(),
    };

    const isValid = validateAgainstSchema(eventPayload);
    expect(isValid).toBe(false);
  });

  it('rejects events with invalid timestamp format', () => {
    const eventPayload = {
      schemaVersion: 1,
      creatorAddress: 'GCREATOR1234567890ABCDEF',
      proposalId: 42,
      tokenAddress: 'GTOKEN1234567890ABCDEF',
      status: 'passed',
      previousStatus: 'active',
      txHash: 'tx-hash',
      timestamp: 'not-a-valid-date', // Invalid RFC3339/ISO8601
    };

    const isValid = validateAgainstSchema(eventPayload);
    expect(isValid).toBe(false);
  });

  it('allows previousStatus to be null', () => {
    const eventPayload = {
      schemaVersion: 1,
      creatorAddress: 'GCREATOR1234567890ABCDEF',
      proposalId: 42,
      tokenAddress: 'GTOKEN1234567890ABCDEF',
      status: 'active',
      previousStatus: null, // Explicitly null
      txHash: 'tx-hash',
      timestamp: new Date().toISOString(),
    };

    const isValid = validateAgainstSchema(eventPayload);
    expect(isValid).toBe(true);
  });

  it('rejects events with additional unknown properties', () => {
    const eventPayload = {
      schemaVersion: 1,
      creatorAddress: 'GCREATOR1234567890ABCDEF',
      proposalId: 42,
      tokenAddress: 'GTOKEN1234567890ABCDEF',
      status: 'passed',
      previousStatus: 'active',
      txHash: 'tx-hash',
      timestamp: new Date().toISOString(),
      unknownField: 'this should not be allowed', // Extra property
    };

    const isValid = validateAgainstSchema(eventPayload);
    expect(isValid).toBe(false);
  });

  it('validates mapped event for queued event (prop_qu_v1) also conforms', () => {
    // The queued event is mapped as a status change from passed → queued
    const stellarQueuedEvent = {
      type: 'contract',
      ledger: 54321,
      ledger_close_time: new Date().toISOString(),
      contract_id: 'CGOVCONTRACT1234567890ABCDEF',
      id: 'event-queued-' + Math.random().toString(36).slice(2),
      paging_token: 'paging-token-queued',
      topic: ['prop_qu_v1', '50'],
      value: {
        proposal_id: 50,
        old_status: 'passed',
      },
      in_successful_contract_call: true,
      transaction_hash: 'tx-hash-queued',
    };

    const mapped = mapper.mapEvent(stellarQueuedEvent);

    expect(mapped).toBeDefined();
    expect(mapped?.type).toBe('proposal_status_changed');

    const statusChangedEvent = mapped as ProposalStatusChangedEvent;

    const eventPayload = {
      schemaVersion: 1,
      creatorAddress: 'GCREATOR1234567890ABCDEF',
      proposalId: statusChangedEvent.proposalId,
      tokenAddress: 'GTOKEN1234567890ABCDEF',
      status: statusToString(statusChangedEvent.newStatus),
      previousStatus: statusToString(statusChangedEvent.oldStatus),
      txHash: statusChangedEvent.txHash,
      timestamp: statusChangedEvent.timestamp.toISOString(),
    };

    const isValid = validateAgainstSchema(eventPayload);
    expect(isValid).toBe(true);
  });
});
