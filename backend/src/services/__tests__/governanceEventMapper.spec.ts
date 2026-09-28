/**
 * governanceEventMapper.spec.ts
 *
 * Pinned-ordinal regression tests for the hardcoded enum arrays inside
 * GovernanceEventMapper.mapProposalType and GovernanceEventMapper.mapProposalStatus.
 *
 * WHY THESE TESTS EXIST (Issue #1991)
 * ─────────────────────────────────────
 * Both methods use a positional array to convert a raw Rust enum ordinal (a
 * plain `number` from the chain) into a backend ProposalType / ProposalStatus.
 * If the Rust enum ever gains a new variant anywhere other than the very end,
 * every subsequent backend mapping silently becomes wrong — there is no runtime
 * error, just stale/incorrect data in the projection.
 *
 * These tests pin each numeric ordinal to its *expected* backend value WITHOUT
 * round-tripping through the same in-source array.  A future accidental
 * reordering of either array will cause these tests to fail immediately, making
 * drift loudly detectable rather than silently propagating bad data.
 *
 * ⚠️  MAINTENANCE NOTE
 * When a new variant is added to `ProposalType` or `ProposalStatus` (Rust
 * side), you MUST:
 *   1. Append it to the corresponding array in governanceEventMapper.ts.
 *   2. Add a new pinned case here asserting the correct ordinal ↔ value.
 * The Rust declaration order is the source of truth for ordinal assignment.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GovernanceEventMapper } from '../governanceEventMapper';
import { ProposalType, ProposalStatus } from '../../types/governance';

// ─── helper: call the private mapProposalType / mapProposalStatus via mapEvent ─

/**
 * Round-trip a numeric proposal_type through the public mapEvent() entrypoint
 * so we exercise the same code path as production without reaching into a
 * private method.
 */
function resolveProposalType(mapper: GovernanceEventMapper, ordinal: number): ProposalType {
  const event = mapper.mapEvent({
    type: 'contract',
    ledger: 1,
    ledger_close_time: '2024-01-01T00:00:00Z',
    contract_id: 'CTEST',
    id: 'ev',
    paging_token: 'pt',
    in_successful_contract_call: true,
    transaction_hash: 'txhash',
    topic: ['prop_cr', 'CTOKEN'],
    value: {
      proposal_id: 1,
      proposer: 'GPROPOSER',
      title: 'Title',
      proposal_type: ordinal,
      start_time: 1_700_000_000,
      end_time: 1_700_604_800,
    },
  } as any);
  return (event as any).proposalType as ProposalType;
}

/**
 * Round-trip a numeric status through the public mapEvent() entrypoint using
 * a prop_st_v1 event so mapProposalStatus is exercised for new_status.
 */
function resolveProposalStatus(mapper: GovernanceEventMapper, ordinal: number): ProposalStatus {
  const event = mapper.mapEvent({
    type: 'contract',
    ledger: 1,
    ledger_close_time: '2024-01-01T00:00:00Z',
    contract_id: 'CTEST',
    id: 'ev',
    paging_token: 'pt',
    in_successful_contract_call: true,
    transaction_hash: 'txhash',
    topic: ['prop_st_v1'],
    value: {
      proposal_id: 1,
      old_status: 0,  // ACTIVE – a known-good reference value
      new_status: ordinal,
    },
  } as any);
  return (event as any).newStatus as ProposalStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// ProposalType ordinal pinning
//
// Source of truth: contracts/token-factory/src/types.rs (ProposalType enum).
// The ordinal ↔ variant mapping below MUST match the Rust declaration order.
// ─────────────────────────────────────────────────────────────────────────────

describe('GovernanceEventMapper – pinned ProposalType ordinals (#1991)', () => {
  let mapper: GovernanceEventMapper;

  beforeEach(() => {
    mapper = new GovernanceEventMapper();
  });

  it('ordinal 0 → ProposalType.PARAMETER_CHANGE', () => {
    expect(resolveProposalType(mapper, 0)).toBe(ProposalType.PARAMETER_CHANGE);
  });

  it('ordinal 1 → ProposalType.ADMIN_TRANSFER', () => {
    expect(resolveProposalType(mapper, 1)).toBe(ProposalType.ADMIN_TRANSFER);
  });

  it('ordinal 2 → ProposalType.TREASURY_SPEND', () => {
    expect(resolveProposalType(mapper, 2)).toBe(ProposalType.TREASURY_SPEND);
  });

  it('ordinal 3 → ProposalType.CONTRACT_UPGRADE', () => {
    expect(resolveProposalType(mapper, 3)).toBe(ProposalType.CONTRACT_UPGRADE);
  });

  it('ordinal 4 → ProposalType.CUSTOM', () => {
    expect(resolveProposalType(mapper, 4)).toBe(ProposalType.CUSTOM);
  });

  it('out-of-range ordinal falls back to ProposalType.CUSTOM (not PARAMETER_CHANGE)', () => {
    // If the array ever shifts and ordinal 99 maps to a real variant instead of
    // falling back, that would also be a regression.
    expect(resolveProposalType(mapper, 99)).toBe(ProposalType.CUSTOM);
  });

  it('every defined ordinal maps to a distinct ProposalType', () => {
    const KNOWN_ORDINALS = [0, 1, 2, 3, 4];
    const mapped = KNOWN_ORDINALS.map((n) => resolveProposalType(mapper, n));
    const unique = new Set(mapped);
    expect(unique.size).toBe(KNOWN_ORDINALS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ProposalStatus ordinal pinning
//
// Source of truth: contracts/governance/src/... (ProposalStatus / ProposalState).
// The ordinal ↔ variant mapping below MUST match the Rust declaration order.
// ─────────────────────────────────────────────────────────────────────────────

describe('GovernanceEventMapper – pinned ProposalStatus ordinals (#1991)', () => {
  let mapper: GovernanceEventMapper;

  beforeEach(() => {
    mapper = new GovernanceEventMapper();
  });

  it('ordinal 0 → ProposalStatus.ACTIVE', () => {
    expect(resolveProposalStatus(mapper, 0)).toBe(ProposalStatus.ACTIVE);
  });

  it('ordinal 1 → ProposalStatus.PASSED', () => {
    expect(resolveProposalStatus(mapper, 1)).toBe(ProposalStatus.PASSED);
  });

  it('ordinal 2 → ProposalStatus.REJECTED', () => {
    expect(resolveProposalStatus(mapper, 2)).toBe(ProposalStatus.REJECTED);
  });

  it('ordinal 3 → ProposalStatus.QUEUED', () => {
    expect(resolveProposalStatus(mapper, 3)).toBe(ProposalStatus.QUEUED);
  });

  it('ordinal 4 → ProposalStatus.EXECUTED', () => {
    expect(resolveProposalStatus(mapper, 4)).toBe(ProposalStatus.EXECUTED);
  });

  it('ordinal 5 → ProposalStatus.CANCELLED', () => {
    expect(resolveProposalStatus(mapper, 5)).toBe(ProposalStatus.CANCELLED);
  });

  it('ordinal 6 → ProposalStatus.EXPIRED', () => {
    expect(resolveProposalStatus(mapper, 6)).toBe(ProposalStatus.EXPIRED);
  });

  it('out-of-range ordinal falls back to ProposalStatus.ACTIVE (not a mis-mapped variant)', () => {
    // Regression guard: an ordinal that doesn't exist in the array must not
    // accidentally return a real variant due to an off-by-one insertion.
    expect(resolveProposalStatus(mapper, 99)).toBe(ProposalStatus.ACTIVE);
  });

  it('every defined ordinal maps to a distinct ProposalStatus', () => {
    const KNOWN_ORDINALS = [0, 1, 2, 3, 4, 5, 6];
    const mapped = KNOWN_ORDINALS.map((n) => resolveProposalStatus(mapper, n));
    const unique = new Set(mapped);
    expect(unique.size).toBe(KNOWN_ORDINALS.length);
  });
});
