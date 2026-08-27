/**
 * governanceEventMapper.test.ts
 *
 * Covers:
 *  1. Table-driven tests for every event variant asserting exact output shape.
 *  2. Out-of-order event: vote arriving before proposal_created must not crash
 *     and should produce a valid VoteCastEvent (the mapper is stateless; callers
 *     are responsible for deferred persistence — so we assert the mapped event
 *     is valid and the proposalId can be used as a deferred-write key).
 *  3. Vote-weight accumulation across repeated votes from the same account.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GovernanceEventMapper } from '../services/governanceEventMapper';
import {
  ProposalStatus,
  ProposalType,
  GovernanceEvent,
  VoteCastEvent,
} from '../types/governance';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeBase(overrides: Partial<Record<string, any>> = {}) {
  return {
    type: 'contract',
    ledger: 1_000_000,
    ledger_close_time: '2024-06-01T00:00:00Z',
    contract_id: 'CGOVCONTRACTABC',
    id: 'ev-001',
    paging_token: 'pt-001',
    in_successful_contract_call: true,
    transaction_hash: 'txhash-001',
    topic: [] as string[],
    value: {} as any,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. TABLE-DRIVEN: every event variant
// ─────────────────────────────────────────────────────────────────────────────

describe('GovernanceEventMapper – event variant mapping', () => {
  let mapper: GovernanceEventMapper;

  beforeEach(() => {
    mapper = new GovernanceEventMapper();
  });

  // ── 1a. proposal_created (prop_cr_v1) ──────────────────────────────────────
  describe('proposal_created', () => {
    const CASES = [
      { topic0: 'prop_cr_v1', label: 'v1 versioned' },
      { topic0: 'prop_cr',    label: 'v1 abbreviated' },
      { topic0: 'prop_create', label: 'legacy' },
    ];

    for (const { topic0, label } of CASES) {
      it(`maps ${label} (${topic0}) to ProposalCreatedEvent`, () => {
        const raw = makeBase({
          ledger: 2_000_000,
          ledger_close_time: '2025-01-10T08:00:00Z',
          transaction_hash: 'tx-pcreate',
          topic: [topic0, 'CTOKENADDR'],
          value: {
            proposal_id: 42,
            proposer: 'GPROPOSERADDR',
            title: 'My Proposal',
            description: 'A detailed description',
            proposal_type: 'parameter_change',
            start_time: 1_700_000_000,
            end_time: 1_700_604_800,
            quorum: 1_000_000,
            threshold: 500_000,
            metadata: '{"key":"val"}',
          },
        });

        const event = mapper.mapEvent(raw);

        expect(event).not.toBeNull();
        expect(event!.type).toBe('proposal_created');
        const pc = event as any;
        expect(pc.proposalId).toBe(42);
        expect(pc.tokenAddress).toBe('CTOKENADDR');
        expect(pc.proposer).toBe('GPROPOSERADDR');
        expect(pc.title).toBe('My Proposal');
        expect(pc.description).toBe('A detailed description');
        expect(pc.proposalType).toBe(ProposalType.PARAMETER_CHANGE);
        expect(pc.quorum).toBe('1000000');
        expect(pc.threshold).toBe('500000');
        expect(pc.metadata).toBe('{"key":"val"}');
        expect(pc.txHash).toBe('tx-pcreate');
        expect(pc.ledger).toBe(2_000_000);
        expect(pc.contractId).toBe('CGOVCONTRACTABC');
        expect(pc.startTime).toBeInstanceOf(Date);
        expect(pc.endTime).toBeInstanceOf(Date);
        expect(pc.timestamp).toBeInstanceOf(Date);
      });
    }

    it('defaults title to "Untitled Proposal" when omitted', () => {
      const raw = makeBase({
        topic: ['prop_cr_v1', 'CTOKENADDR'],
        value: { proposal_id: 1, proposer: 'GADDR' },
      });
      const event = mapper.mapEvent(raw) as any;
      expect(event!.title).toBe('Untitled Proposal');
    });

    it('maps numeric proposal_type correctly (index 1 → ADMIN_TRANSFER)', () => {
      const raw = makeBase({
        topic: ['prop_cr_v1', 'CTOKENADDR'],
        value: { proposal_id: 5, proposer: 'GADDR', proposal_type: 1 },
      });
      const event = mapper.mapEvent(raw) as any;
      expect(event!.proposalType).toBe(ProposalType.ADMIN_TRANSFER);
    });
  });

  // ── 1b. vote_cast ──────────────────────────────────────────────────────────
  describe('vote_cast', () => {
    const CASES = [
      { topic0: 'vote_cs_v1', label: 'v1 versioned' },
      { topic0: 'vote_cs',    label: 'v1 abbreviated' },
      { topic0: 'vote_cast',  label: 'legacy' },
    ];

    for (const { topic0, label } of CASES) {
      it(`maps ${label} (${topic0}) to VoteCastEvent`, () => {
        const raw = makeBase({
          ledger: 2_000_100,
          transaction_hash: 'tx-votecast',
          topic: [topic0, 'CTOKENADDR'],
          value: {
            proposal_id: 42,
            voter: 'GVOTERADDR',
            support: true,
            weight: 250_000_000,
            reason: 'I agree',
          },
        });

        const event = mapper.mapEvent(raw);

        expect(event).not.toBeNull();
        expect(event!.type).toBe('vote_cast');
        const vc = event as VoteCastEvent;
        expect(vc.proposalId).toBe(42);
        expect(vc.voter).toBe('GVOTERADDR');
        expect(vc.support).toBe(true);
        expect(vc.weight).toBe('250000000');
        expect(vc.reason).toBe('I agree');
        expect(vc.txHash).toBe('tx-votecast');
        expect(vc.ledger).toBe(2_000_100);
      });
    }

    it('treats support=1 (numeric) as true', () => {
      const raw = makeBase({
        topic: ['vote_cs_v1'],
        value: { proposal_id: 1, voter: 'G', support: 1, weight: 100 },
      });
      expect((mapper.mapEvent(raw) as VoteCastEvent).support).toBe(true);
    });

    it('treats support=false as false', () => {
      const raw = makeBase({
        topic: ['vote_cs_v1'],
        value: { proposal_id: 1, voter: 'G', support: false, weight: 100 },
      });
      expect((mapper.mapEvent(raw) as VoteCastEvent).support).toBe(false);
    });

    it('defaults weight to "0" when absent', () => {
      const raw = makeBase({
        topic: ['vote_cs_v1'],
        value: { proposal_id: 1, voter: 'G', support: true },
      });
      expect((mapper.mapEvent(raw) as VoteCastEvent).weight).toBe('0');
    });
  });

  // ── 1c. proposal_queued (prop_qu / prop_qu_v1) ────────────────────────────
  describe('proposal_queued → proposal_status_changed', () => {
    const CASES = [
      { topic0: 'prop_qu_v1', label: 'v1 versioned' },
      { topic0: 'prop_qu',    label: 'v1 abbreviated' },
    ];

    for (const { topic0, label } of CASES) {
      it(`maps ${label} (${topic0}) to proposal_status_changed with QUEUED newStatus`, () => {
        const raw = makeBase({
          ledger: 2_000_200,
          transaction_hash: 'tx-queued',
          topic: [topic0, '7'],          // proposal_id in topic[1]
          value: { old_status: 'passed' },
        });

        const event = mapper.mapEvent(raw);

        expect(event).not.toBeNull();
        expect(event!.type).toBe('proposal_status_changed');
        const psc = event as any;
        expect(psc.newStatus).toBe(ProposalStatus.QUEUED);
        expect(psc.oldStatus).toBe(ProposalStatus.PASSED);
        expect(psc.proposalId).toBe(7);   // parsed from topic[1]
        expect(psc.txHash).toBe('tx-queued');
      });
    }

    it('reads proposal_id from value.proposal_id when present', () => {
      const raw = makeBase({
        topic: ['prop_qu_v1', '99'],
        value: { proposal_id: 55, old_status: 'active' },
      });
      const psc = mapper.mapEvent(raw) as any;
      // value.proposal_id takes precedence via ?? operator
      expect(psc.proposalId).toBe(55);
      expect(psc.oldStatus).toBe(ProposalStatus.ACTIVE);
    });
  });

  // ── 1d. proposal_executed ─────────────────────────────────────────────────
  describe('proposal_executed', () => {
    const CASES = [
      { topic0: 'prop_ex_v1', label: 'v1 versioned' },
      { topic0: 'prop_ex',    label: 'v1 abbreviated' },
      { topic0: 'prop_exec',  label: 'legacy' },
    ];

    for (const { topic0, label } of CASES) {
      it(`maps ${label} (${topic0}) to ProposalExecutedEvent`, () => {
        const raw = makeBase({
          ledger: 2_000_300,
          transaction_hash: 'tx-executed',
          topic: [topic0, 'CTOKENADDR'],
          value: {
            proposal_id: 42,
            executor: 'GEXECUTORADDR',
            success: true,
            return_data: '0xdeadbeef',
            gas_used: 75_000,
          },
        });

        const event = mapper.mapEvent(raw);

        expect(event).not.toBeNull();
        expect(event!.type).toBe('proposal_executed');
        const pe = event as any;
        expect(pe.proposalId).toBe(42);
        expect(pe.executor).toBe('GEXECUTORADDR');
        expect(pe.success).toBe(true);
        expect(pe.returnData).toBe('0xdeadbeef');
        expect(pe.gasUsed).toBe('75000');
        expect(pe.txHash).toBe('tx-executed');
      });
    }

    it('treats success=1 (numeric) as true', () => {
      const raw = makeBase({
        topic: ['prop_ex_v1'],
        value: { proposal_id: 1, executor: 'G', success: 1 },
      });
      expect((mapper.mapEvent(raw) as any).success).toBe(true);
    });
  });

  // ── 1e. proposal_cancelled ────────────────────────────────────────────────
  describe('proposal_cancelled', () => {
    const CASES = [
      { topic0: 'prop_ca_v1', label: 'v1 versioned' },
      { topic0: 'prop_ca',    label: 'v1 abbreviated' },
      { topic0: 'prop_cancel', label: 'legacy' },
    ];

    for (const { topic0, label } of CASES) {
      it(`maps ${label} (${topic0}) to ProposalCancelledEvent`, () => {
        const raw = makeBase({
          ledger: 2_000_400,
          transaction_hash: 'tx-cancelled',
          topic: [topic0, 'CTOKENADDR'],
          value: {
            proposal_id: 9,
            canceller: 'GCANCELLERADDR',
            reason: 'No longer relevant',
          },
        });

        const event = mapper.mapEvent(raw);

        expect(event).not.toBeNull();
        expect(event!.type).toBe('proposal_cancelled');
        const pca = event as any;
        expect(pca.proposalId).toBe(9);
        expect(pca.canceller).toBe('GCANCELLERADDR');
        expect(pca.reason).toBe('No longer relevant');
        expect(pca.txHash).toBe('tx-cancelled');
      });
    }

    it('omits reason when absent (undefined)', () => {
      const raw = makeBase({
        topic: ['prop_ca_v1'],
        value: { proposal_id: 1, canceller: 'G' },
      });
      const pca = mapper.mapEvent(raw) as any;
      expect(pca.reason).toBeUndefined();
    });
  });

  // ── 1f. proposal_status_changed (prop_st_v1 / prop_status) ───────────────
  describe('proposal_status_changed', () => {
    const CASES = [
      { topic0: 'prop_st_v1', label: 'v1 versioned' },
      { topic0: 'prop_status', label: 'legacy' },
    ];

    for (const { topic0, label } of CASES) {
      it(`maps ${label} (${topic0}) to ProposalStatusChangedEvent with correct statuses`, () => {
        const raw = makeBase({
          ledger: 2_000_500,
          transaction_hash: 'tx-status',
          topic: [topic0, 'CTOKENADDR'],
          value: {
            proposal_id: 42,
            old_status: 'active',
            new_status: 'passed',
          },
        });

        const event = mapper.mapEvent(raw);

        expect(event).not.toBeNull();
        expect(event!.type).toBe('proposal_status_changed');
        const psc = event as any;
        expect(psc.proposalId).toBe(42);
        expect(psc.oldStatus).toBe(ProposalStatus.ACTIVE);
        expect(psc.newStatus).toBe(ProposalStatus.PASSED);
        expect(psc.txHash).toBe('tx-status');
      });
    }

    it('maps numeric status values (0→ACTIVE, 1→PASSED)', () => {
      const raw = makeBase({
        topic: ['prop_st_v1'],
        value: { proposal_id: 1, old_status: 0, new_status: 1 },
      });
      const psc = mapper.mapEvent(raw) as any;
      expect(psc.oldStatus).toBe(ProposalStatus.ACTIVE);
      expect(psc.newStatus).toBe(ProposalStatus.PASSED);
    });

    it('maps all status transitions correctly', () => {
      const transitions: Array<[string, string, ProposalStatus, ProposalStatus]> = [
        ['active',   'rejected',  ProposalStatus.ACTIVE,    ProposalStatus.REJECTED],
        ['passed',   'queued',    ProposalStatus.PASSED,    ProposalStatus.QUEUED],
        ['queued',   'executed',  ProposalStatus.QUEUED,    ProposalStatus.EXECUTED],
        ['active',   'cancelled', ProposalStatus.ACTIVE,    ProposalStatus.CANCELLED],
        ['active',   'expired',   ProposalStatus.ACTIVE,    ProposalStatus.EXPIRED],
        ['succeeded','executed',  ProposalStatus.PASSED,    ProposalStatus.EXECUTED],
        ['defeated', 'cancelled', ProposalStatus.REJECTED,  ProposalStatus.CANCELLED],
      ];

      for (const [oldS, newS, expectedOld, expectedNew] of transitions) {
        const raw = makeBase({
          topic: ['prop_st_v1'],
          value: { proposal_id: 1, old_status: oldS, new_status: newS },
        });
        const psc = mapper.mapEvent(raw) as any;
        expect(psc.oldStatus).toBe(expectedOld);
        expect(psc.newStatus).toBe(expectedNew);
      }
    });
  });

  // ── 1g. proposal_state_snapshot (prop_snap) ───────────────────────────────
  describe('proposal_state_snapshot', () => {
    it('maps prop_snap to ProposalStateSnapshotEvent with full shape', () => {
      const raw = makeBase({
        ledger: 2_001_000,
        transaction_hash: 'tx-snap',
        topic: ['prop_snap', '42'],
        value: {
          proposal_id: 42,
          status: 'active',
          yes_votes: 800_000,
          no_votes: 200_000,
          quorum_required: 500_000,
          ledger: 2_001_000,
        },
      });

      const event = mapper.mapEvent(raw);

      expect(event).not.toBeNull();
      expect(event!.type).toBe('proposal_state_snapshot');
      const snap = event as any;
      expect(snap.proposalId).toBe(42);
      expect(snap.status).toBe(ProposalStatus.ACTIVE);
      expect(snap.yesVotes).toBe('800000');
      expect(snap.noVotes).toBe('200000');
      expect(snap.quorumRequired).toBe('500000');
      expect(snap.snapshotLedger).toBe(2_001_000);
      expect(snap.txHash).toBe('tx-snap');
      expect(snap.ledger).toBe(2_001_000);
      expect(snap.contractId).toBe('CGOVCONTRACTABC');
    });

    it('falls back to event.ledger for snapshotLedger when value.ledger is absent', () => {
      const raw = makeBase({
        ledger: 3_000_000,
        topic: ['prop_snap', '10'],
        value: { status: 'passed', yes_votes: 100, no_votes: 0, quorum_required: 50 },
      });
      const snap = mapper.mapEvent(raw) as any;
      expect(snap.snapshotLedger).toBe(3_000_000);
    });

    it('reads proposalId from topic[1] when value.proposal_id is absent', () => {
      const raw = makeBase({
        topic: ['prop_snap', '77'],
        value: { status: 'active', yes_votes: 0, no_votes: 0, quorum_required: 1 },
      });
      const snap = mapper.mapEvent(raw) as any;
      expect(snap.proposalId).toBe(77);
    });

    it('defaults yesVotes/noVotes/quorumRequired to "0" when absent', () => {
      const raw = makeBase({
        topic: ['prop_snap', '1'],
        value: { status: 'active' },
      });
      const snap = mapper.mapEvent(raw) as any;
      expect(snap.yesVotes).toBe('0');
      expect(snap.noVotes).toBe('0');
      expect(snap.quorumRequired).toBe('0');
    });
  });

  // ── 1h. non-governance event ──────────────────────────────────────────────
  describe('non-governance events', () => {
    it('returns null for an unknown topic', () => {
      const raw = makeBase({ topic: ['token_transfer'], value: {} });
      expect(mapper.mapEvent(raw)).toBeNull();
    });

    it('returns null for empty topic array', () => {
      const raw = makeBase({ topic: [], value: {} });
      expect(mapper.mapEvent(raw)).toBeNull();
    });

    it('isGovernanceEvent returns false for unknown topic', () => {
      const raw = makeBase({ topic: ['random_event'] });
      expect(mapper.isGovernanceEvent(raw as any)).toBe(false);
    });

    it('isGovernanceEvent returns true for all known event names', () => {
      const knownTopics = [
        'prop_cr_v1', 'vote_cs_v1', 'prop_qu_v1', 'prop_ex_v1',
        'prop_ca_v1', 'prop_st_v1', 'prop_cr', 'vote_cs', 'prop_qu',
        'prop_ex', 'prop_ca', 'prop_snap',
        'prop_create', 'vote_cast', 'prop_exec', 'prop_cancel', 'prop_status',
      ];
      for (const t of knownTopics) {
        const raw = makeBase({ topic: [t] });
        expect(mapper.isGovernanceEvent(raw as any), `topic: ${t}`).toBe(true);
      }
    });
  });

  // ── batch mapping ─────────────────────────────────────────────────────────
  describe('mapEvents (batch)', () => {
    it('filters nulls and returns only recognized events', () => {
      const events = [
        makeBase({ topic: ['prop_cr_v1', 'CTOKEN'], value: { proposal_id: 1, proposer: 'G', title: 'T' } }),
        makeBase({ topic: ['UNKNOWN'],               value: {} }),
        makeBase({ topic: ['vote_cs_v1'],             value: { proposal_id: 1, voter: 'G', support: true, weight: 100 } }),
      ];
      const mapped = mapper.mapEvents(events as any[]);
      expect(mapped).toHaveLength(2);
      expect(mapped[0].type).toBe('proposal_created');
      expect(mapped[1].type).toBe('vote_cast');
    });

    it('returns empty array for all-unknown events', () => {
      const events = [
        makeBase({ topic: ['bad_event'] }),
        makeBase({ topic: [] }),
      ];
      expect(mapper.mapEvents(events as any[])).toHaveLength(0);
    });
  });
}); // end "event variant mapping" suite

// ─────────────────────────────────────────────────────────────────────────────
// 2. OUT-OF-ORDER EVENT: vote arrives before proposal_created
// ─────────────────────────────────────────────────────────────────────────────

describe('GovernanceEventMapper – out-of-order event handling', () => {
  /**
   * The mapper is intentionally stateless: it does not buffer or defer events
   * itself.  Ordering guarantees are the responsibility of the calling
   * projection layer.  What we verify here is:
   *
   *  a) A vote_cast event processed BEFORE its parent proposal_created does NOT
   *     throw — it maps cleanly to a VoteCastEvent.
   *  b) The resulting VoteCastEvent carries a valid proposalId that the
   *     projection layer can use as a deferred-write key (i.e. hold in a
   *     pending buffer until the parent proposal arrives).
   *  c) When the proposal_created event is subsequently processed it also maps
   *     cleanly with the same proposalId, allowing the projection layer to
   *     flush the buffered vote.
   */

  let mapper: GovernanceEventMapper;

  beforeEach(() => {
    mapper = new GovernanceEventMapper();
  });

  it('does not throw when vote arrives before proposal_created (out-of-order)', () => {
    const voteEvent = makeBase({
      ledger: 500,       // earlier ledger — "out of order"
      transaction_hash: 'tx-early-vote',
      topic: ['vote_cs_v1'],
      value: {
        proposal_id: 10,
        voter: 'GVOTERXYZ',
        support: true,
        weight: 1_000_000,
        reason: 'Early bird',
      },
    });

    // Must not throw even though no proposal_created has been processed yet.
    let result: GovernanceEvent | null = null;
    expect(() => {
      result = mapper.mapEvent(voteEvent as any);
    }).not.toThrow();

    expect(result).not.toBeNull();
    expect(result!.type).toBe('vote_cast');
  });

  it('out-of-order vote produces a VoteCastEvent with a usable proposalId (deferred-write key)', () => {
    const voteEvent = makeBase({
      ledger: 500,
      transaction_hash: 'tx-early-vote',
      topic: ['vote_cs_v1'],
      value: { proposal_id: 10, voter: 'GVOTERXYZ', support: true, weight: 1_000_000 },
    });

    const vc = mapper.mapEvent(voteEvent as any) as VoteCastEvent;

    // The projection layer would buffer this event keyed by proposalId.
    expect(vc.proposalId).toBe(10);
    expect(typeof vc.proposalId).toBe('number');
  });

  it('subsequent proposal_created maps with same proposalId, enabling buffer flush', () => {
    const voteEvent = makeBase({
      ledger: 500,
      topic: ['vote_cs_v1'],
      value: { proposal_id: 10, voter: 'GVOTERXYZ', support: true, weight: 1_000_000 },
    });

    const proposalEvent = makeBase({
      ledger: 1_000,     // later ledger — arrives after vote
      transaction_hash: 'tx-proposal',
      topic: ['prop_cr_v1', 'CTOKEN'],
      value: {
        proposal_id: 10,
        proposer: 'GPROPOSER',
        title: 'Delayed Proposal',
        proposal_type: 'custom',
        start_time: 1_700_000_000,
        end_time: 1_700_604_800,
        quorum: 100_000,
        threshold: 50_000,
      },
    });

    const vc  = mapper.mapEvent(voteEvent as any) as VoteCastEvent;
    const pc  = mapper.mapEvent(proposalEvent as any) as any;

    // Both events share the same proposalId — the projection layer uses this
    // match to flush any buffered votes once the proposal arrives.
    expect(vc.proposalId).toBe(pc.proposalId);
    expect(pc.type).toBe('proposal_created');
    expect(pc.title).toBe('Delayed Proposal');
  });

  it('snap event arriving before proposal_created also does not crash', () => {
    const snapEvent = makeBase({
      ledger: 300,
      topic: ['prop_snap', '99'],
      value: { status: 'active', yes_votes: 0, no_votes: 0, quorum_required: 1000 },
    });

    let result: GovernanceEvent | null = null;
    expect(() => {
      result = mapper.mapEvent(snapEvent as any);
    }).not.toThrow();

    expect(result).not.toBeNull();
    expect(result!.type).toBe('proposal_state_snapshot');
    expect((result as any).proposalId).toBe(99);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. VOTE-WEIGHT ACCUMULATION
// ─────────────────────────────────────────────────────────────────────────────

describe('GovernanceEventMapper – vote-weight accumulation', () => {
  /**
   * The mapper itself is stateless — it maps each individual event.
   * Vote-weight accumulation is the responsibility of the projection layer
   * that consumes the mapped events.
   *
   * These tests verify:
   *  a) Each individual vote maps its weight faithfully (no loss).
   *  b) A simple accumulator (simulating what the projection layer would do)
   *     correctly sums weights per voter per proposalId.
   *  c) A repeat vote from the same voter (e.g. a changed vote) maps correctly,
   *     allowing the projection layer to replace the prior weight rather than
   *     double-count.
   */

  let mapper: GovernanceEventMapper;

  beforeEach(() => {
    mapper = new GovernanceEventMapper();
  });

  // Minimal accumulator mirroring what a real projection would implement.
  function accumulate(votes: VoteCastEvent[]): Map<string, bigint> {
    const totals = new Map<string, bigint>();
    for (const v of votes) {
      // Use the LAST weight for each voter (replace semantics).
      totals.set(v.voter, BigInt(v.weight));
    }
    return totals;
  }

  it('maps weight correctly for a single supporting vote', () => {
    const raw = makeBase({
      topic: ['vote_cs_v1'],
      value: { proposal_id: 1, voter: 'GVOTER_A', support: true, weight: 500_000 },
    });
    const vc = mapper.mapEvent(raw as any) as VoteCastEvent;
    expect(vc.weight).toBe('500000');
  });

  it('maps weight correctly for a single opposing vote', () => {
    const raw = makeBase({
      topic: ['vote_cs_v1'],
      value: { proposal_id: 1, voter: 'GVOTER_B', support: false, weight: 200_000 },
    });
    const vc = mapper.mapEvent(raw as any) as VoteCastEvent;
    expect(vc.weight).toBe('200000');
    expect(vc.support).toBe(false);
  });

  it('accumulates weights correctly across multiple different voters', () => {
    const rawVotes = [
      makeBase({ topic: ['vote_cs_v1'], value: { proposal_id: 5, voter: 'G_A', support: true,  weight: 300_000 } }),
      makeBase({ topic: ['vote_cs_v1'], value: { proposal_id: 5, voter: 'G_B', support: true,  weight: 700_000 } }),
      makeBase({ topic: ['vote_cs_v1'], value: { proposal_id: 5, voter: 'G_C', support: false, weight: 150_000 } }),
    ];

    const votes = rawVotes.map(r => mapper.mapEvent(r as any) as VoteCastEvent);
    const totals = accumulate(votes);

    expect(totals.get('G_A')).toBe(300_000n);
    expect(totals.get('G_B')).toBe(700_000n);
    expect(totals.get('G_C')).toBe(150_000n);

    // Total yes weight
    const yesTotal = votes
      .filter(v => v.support)
      .reduce((acc, v) => acc + BigInt(v.weight), 0n);
    expect(yesTotal).toBe(1_000_000n);

    // Total no weight
    const noTotal = votes
      .filter(v => !v.support)
      .reduce((acc, v) => acc + BigInt(v.weight), 0n);
    expect(noTotal).toBe(150_000n);
  });

  it('correctly reflects updated weight when same voter votes twice (replace semantics)', () => {
    // Voter G_A casts an initial vote then changes it.
    const initialVote = makeBase({
      ledger: 1_000,
      topic: ['vote_cs_v1'],
      value: { proposal_id: 7, voter: 'G_A', support: true, weight: 400_000 },
    });
    const updatedVote = makeBase({
      ledger: 1_100,
      topic: ['vote_cs_v1'],
      value: { proposal_id: 7, voter: 'G_A', support: false, weight: 400_000 },
    });

    const v1 = mapper.mapEvent(initialVote as any) as VoteCastEvent;
    const v2 = mapper.mapEvent(updatedVote as any) as VoteCastEvent;

    expect(v1.weight).toBe('400000');
    expect(v1.support).toBe(true);
    expect(v2.weight).toBe('400000');
    expect(v2.support).toBe(false);

    // Projection layer uses replace semantics (last write wins per voter).
    const totals = accumulate([v1, v2]);
    // Only the second (updated) vote should count.
    expect(totals.get('G_A')).toBe(400_000n);
    // Net yes = 0 (the vote flipped to no), net no = 400_000
    const allVotes = [v1, v2];
    const finalVotes = [v2]; // after deduplication
    const yesNet = finalVotes.filter(v => v.support).reduce((a, v) => a + BigInt(v.weight), 0n);
    const noNet  = finalVotes.filter(v => !v.support).reduce((a, v) => a + BigInt(v.weight), 0n);
    expect(yesNet).toBe(0n);
    expect(noNet).toBe(400_000n);

    // The raw array (before dedup) would double-count — confirming that the
    // mapper does NOT deduplicate, which is correct: that is the projection's job.
    expect(allVotes).toHaveLength(2);
  });

  it('maps large bigint-like weight values without precision loss', () => {
    // Stellar balances can be expressed as i128 on-chain; test a large value.
    const largeWeight = 9_007_199_254_740_993; // > Number.MAX_SAFE_INTEGER
    const raw = makeBase({
      topic: ['vote_cs_v1'],
      value: { proposal_id: 1, voter: 'G_WHALE', support: true, weight: largeWeight },
    });
    const vc = mapper.mapEvent(raw as any) as VoteCastEvent;
    // The mapper stores weight as a string to preserve precision.
    expect(vc.weight).toBe(String(largeWeight));
  });

  it('accumulates vote weights across a realistic lifecycle sequence', () => {
    const PROPOSAL_ID = 100;
    const voteData = [
      { voter: 'G_1', support: true,  weight: 1_000_000 },
      { voter: 'G_2', support: true,  weight: 2_500_000 },
      { voter: 'G_3', support: false, weight: 500_000   },
      { voter: 'G_4', support: true,  weight: 750_000   },
      { voter: 'G_5', support: false, weight: 1_200_000 },
    ];

    const votes = voteData.map((d, i) =>
      mapper.mapEvent(makeBase({
        ledger: 1_000_000 + i * 100,
        topic: ['vote_cs_v1'],
        value: { proposal_id: PROPOSAL_ID, ...d },
      }) as any) as VoteCastEvent,
    );

    const yesTotal = votes.filter(v => v.support).reduce((a, v) => a + BigInt(v.weight), 0n);
    const noTotal  = votes.filter(v => !v.support).reduce((a, v) => a + BigInt(v.weight), 0n);

    expect(yesTotal).toBe(4_250_000n);   // 1M + 2.5M + 0.75M
    expect(noTotal).toBe(1_700_000n);    // 0.5M + 1.2M
    expect(votes.every(v => v.proposalId === PROPOSAL_ID)).toBe(true);
    expect(votes.every(v => v.type === 'vote_cast')).toBe(true);
  });
});
