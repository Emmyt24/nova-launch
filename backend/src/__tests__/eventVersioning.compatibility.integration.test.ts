/**
 * Event Versioning Compatibility Integration Tests
 *
 * Verifies that the decoder registry:
 *  - Normalizes all known topic variants (v1, abbreviated, legacy) to stable shapes
 *  - Logs and skips unknown topics without throwing
 *  - Produces API-stable output regardless of topic alias used
 */

import { describe, it, expect, vi } from 'vitest';
import {
  decodeEvent,
  isKnownTopic,
  kindForTopic,
  RawStellarEvent,
} from '../services/eventVersioning/decoderRegistry';

// ── Fixture factory ──────────────────────────────────────────────────────────

const NOW_ISO = '2025-06-01T12:00:00Z';
const NOW_S = Math.floor(new Date(NOW_ISO).getTime() / 1000);

function raw(topic: string[], value: any, extra: Partial<RawStellarEvent> = {}): RawStellarEvent {
  return {
    type: 'contract',
    ledger: 5000000,
    ledger_close_time: NOW_ISO,
    contract_id: 'CCONTRACT123',
    id: `ev-${topic[0]}`,
    paging_token: `pt-${topic[0]}`,
    topic,
    value,
    in_successful_contract_call: true,
    transaction_hash: `tx-${topic[0]}`,
    ...extra,
  };
}

// ── Governance fixtures (all three alias families) ───────────────────────────

const PROP_VALUE = {
  proposal_id: 7,
  proposer: 'GPROPOSER',
  title: 'Test',
  proposal_type: 0,
  start_time: NOW_S,
  end_time: NOW_S + 86400,
  quorum: 1_000_000,
  threshold: 500_000,
};

const governanceVariants: Array<[string, string[], any]> = [
  ['prop_cr_v1',  ['prop_cr_v1',  'CTOKEN'], PROP_VALUE],
  ['prop_cr',     ['prop_cr',     'CTOKEN'], PROP_VALUE],
  ['prop_create', ['prop_create', 'CTOKEN'], PROP_VALUE],
  ['vote_cs_v1',  ['vote_cs_v1',  '7'],      { proposal_id: 7, voter: 'GVOTER', support: true, weight: 100 }],
  ['vote_cs',     ['vote_cs',     '7'],      { proposal_id: 7, voter: 'GVOTER', support: true, weight: 100 }],
  ['vote_cast',   ['vote_cast',   '7'],      { proposal_id: 7, voter: 'GVOTER', support: true, weight: 100 }],
  ['prop_qu_v1',  ['prop_qu_v1',  '7'],      { proposal_id: 7, old_status: 'passed' }],
  ['prop_qu',     ['prop_qu',     '7'],      { proposal_id: 7, old_status: 'passed' }],
  ['prop_ex_v1',  ['prop_ex_v1',  'CTOKEN'], { proposal_id: 7, executor: 'GEXEC', success: true }],
  ['prop_ex',     ['prop_ex',     'CTOKEN'], { proposal_id: 7, executor: 'GEXEC', success: true }],
  ['prop_exec',   ['prop_exec',   'CTOKEN'], { proposal_id: 7, executor: 'GEXEC', success: true }],
  ['prop_ca_v1',  ['prop_ca_v1',  'CTOKEN'], { proposal_id: 7, canceller: 'GCANCEL' }],
  ['prop_ca',     ['prop_ca',     'CTOKEN'], { proposal_id: 7, canceller: 'GCANCEL' }],
  ['prop_cancel', ['prop_cancel', 'CTOKEN'], { proposal_id: 7, canceller: 'GCANCEL' }],
  ['prop_st_v1',  ['prop_st_v1',  'CTOKEN'], { proposal_id: 7, old_status: 0, new_status: 1 }],
  ['prop_status', ['prop_status', 'CTOKEN'], { proposal_id: 7, old_status: 0, new_status: 1 }],
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Decoder Registry — topic recognition', () => {
  it('recognises all governance topic aliases', () => {
    const topics = ['prop_cr_v1','prop_cr','prop_create','vote_cs_v1','vote_cs','vote_cast',
      'prop_qu_v1','prop_qu','prop_ex_v1','prop_ex','prop_exec','prop_ca_v1','prop_ca',
      'prop_cancel','prop_st_v1','prop_status'];
    for (const t of topics) expect(isKnownTopic(t), t).toBe(true);
  });

  it('recognises vault topics', () => {
    for (const t of ['vlt_cr_v1','vlt_cl_v1','vlt_cn_v1','vlt_md_v1']) {
      expect(isKnownTopic(t), t).toBe(true);
    }
  });

  it('recognises campaign topics', () => {
    for (const t of ['camp_cr_v1','camp_cr','camp_ex_v1','camp_ex','camp_st_v1','camp_st']) {
      expect(isKnownTopic(t), t).toBe(true);
    }
  });

  it('recognises token topics', () => {
    for (const t of ['tok_reg','tok_burn','adm_burn','tok_meta']) {
      expect(isKnownTopic(t), t).toBe(true);
    }
  });

  it('returns false for unknown topics', () => {
    expect(isKnownTopic('totally_unknown')).toBe(false);
    expect(isKnownTopic('')).toBe(false);
  });
});

describe('Decoder Registry — kindForTopic', () => {
  it('maps all governance aliases to stable kinds', () => {
    expect(kindForTopic('prop_cr_v1')).toBe('proposal_created');
    expect(kindForTopic('prop_cr')).toBe('proposal_created');
    expect(kindForTopic('prop_create')).toBe('proposal_created');
    expect(kindForTopic('vote_cs_v1')).toBe('vote_cast');
    expect(kindForTopic('vote_cast')).toBe('vote_cast');
    expect(kindForTopic('prop_qu_v1')).toBe('proposal_queued');
    expect(kindForTopic('prop_ex_v1')).toBe('proposal_executed');
    expect(kindForTopic('prop_exec')).toBe('proposal_executed');
    expect(kindForTopic('prop_ca_v1')).toBe('proposal_cancelled');
    expect(kindForTopic('prop_cancel')).toBe('proposal_cancelled');
    expect(kindForTopic('prop_st_v1')).toBe('proposal_status_changed');
    expect(kindForTopic('prop_status')).toBe('proposal_status_changed');
  });

  it('returns null for unknown topic', () => {
    expect(kindForTopic('unknown_xyz')).toBeNull();
  });
});

describe('Decoder Registry — governance normalization', () => {
  it.each(governanceVariants)('decodes %s to stable shape', (topic0, topic, value) => {
    const ev = decodeEvent(raw(topic, value));
    expect(ev.kind).not.toBe('unknown');
    expect(ev.txHash).toBe(`tx-${topic0}`);
    expect(ev.ledger).toBe(5000000);
    expect(ev.timestamp).toBeInstanceOf(Date);
  });

  it('all prop_cr aliases produce identical proposalId/title', () => {
    const aliases = ['prop_cr_v1', 'prop_cr', 'prop_create'];
    const results = aliases.map(a => decodeEvent(raw([a, 'CTOKEN'], PROP_VALUE)));
    for (const r of results) {
      expect(r.kind).toBe('proposal_created');
      if (r.kind === 'proposal_created') {
        expect(r.proposalId).toBe(7);
        expect(r.title).toBe('Test');
      }
    }
  });

  it('prop_qu_v1 decodes to proposal_queued with oldStatus', () => {
    const ev = decodeEvent(raw(['prop_qu_v1', '7'], { proposal_id: 7, old_status: 'passed' }));
    expect(ev.kind).toBe('proposal_queued');
    if (ev.kind === 'proposal_queued') {
      expect(ev.proposalId).toBe(7);
      expect(ev.oldStatus).toBe('passed');
    }
  });

  it('prop_ex_v1 decodes success flag correctly', () => {
    const ev = decodeEvent(raw(['prop_ex_v1', 'CTOKEN'], { proposal_id: 7, executor: 'GEXEC', success: true, gas_used: 50000 }));
    expect(ev.kind).toBe('proposal_executed');
    if (ev.kind === 'proposal_executed') {
      expect(ev.success).toBe(true);
      expect(ev.gasUsed).toBe('50000');
    }
  });

  it('prop_ca_v1 captures canceller and reason', () => {
    const ev = decodeEvent(raw(['prop_ca_v1', 'CTOKEN'], { proposal_id: 7, canceller: 'GCANCEL', reason: 'no longer needed' }));
    expect(ev.kind).toBe('proposal_cancelled');
    if (ev.kind === 'proposal_cancelled') {
      expect(ev.canceller).toBe('GCANCEL');
      expect(ev.reason).toBe('no longer needed');
    }
  });
});

describe('Decoder Registry — vault normalization', () => {
  it('decodes vlt_cr_v1', () => {
    const ev = decodeEvent(raw(['vlt_cr_v1', '1'], { stream_id: 1, creator: 'GCREATOR', recipient: 'GRECIP', amount: '5000', has_metadata: false }));
    expect(ev.kind).toBe('vault_created');
    if (ev.kind === 'vault_created') {
      expect(ev.streamId).toBe(1);
      expect(ev.amount).toBe('5000');
      expect(ev.hasMetadata).toBe(false);
    }
  });

  it('decodes vlt_cl_v1', () => {
    const ev = decodeEvent(raw(['vlt_cl_v1', '1'], { stream_id: 1, recipient: 'GRECIP', amount: '5000' }));
    expect(ev.kind).toBe('vault_claimed');
    if (ev.kind === 'vault_claimed') expect(ev.amount).toBe('5000');
  });

  it('decodes vlt_cn_v1', () => {
    const ev = decodeEvent(raw(['vlt_cn_v1', '1'], { stream_id: 1, canceller: 'GCANCEL', remaining_amount: '2500' }));
    expect(ev.kind).toBe('vault_cancelled');
    if (ev.kind === 'vault_cancelled') expect(ev.remainingAmount).toBe('2500');
  });
});

describe('Decoder Registry — token normalization', () => {
  it('decodes tok_reg', () => {
    const ev = decodeEvent(raw(['tok_reg', 'CTOKEN'], { creator: 'GCREATOR', name: 'MyToken', symbol: 'MTK', decimals: 7, initial_supply: '1000000' }));
    expect(ev.kind).toBe('token_created');
    if (ev.kind === 'token_created') {
      expect(ev.symbol).toBe('MTK');
      expect(ev.initialSupply).toBe('1000000');
    }
  });

  it('decodes tok_burn with BigInt-safe amount', () => {
    const ev = decodeEvent(raw(['tok_burn', 'CTOKEN'], { from: 'GFROM', amount: '9007199254740993', burner: 'GFROM' }));
    expect(ev.kind).toBe('token_burned');
    if (ev.kind === 'token_burned') expect(ev.amount).toBe('9007199254740993');
  });

  it('decodes adm_burn', () => {
    const ev = decodeEvent(raw(['adm_burn', 'CTOKEN'], { from: 'GHOLDER', amount: '1000', admin: 'GADMIN' }));
    expect(ev.kind).toBe('token_admin_burned');
    if (ev.kind === 'token_admin_burned') expect(ev.admin).toBe('GADMIN');
  });
});

describe('Decoder Registry — unknown topic handling', () => {
  it('returns kind=unknown for unrecognised topic', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ev = decodeEvent(raw(['totally_unknown_v99'], {}));
    expect(ev.kind).toBe('unknown');
    if (ev.kind === 'unknown') expect(ev.topic).toBe('totally_unknown_v99');
    warnSpy.mockRestore();
  });

  it('logs a warning for unknown topics', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    decodeEvent(raw(['future_event_v2'], {}));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('future_event_v2'));
    warnSpy.mockRestore();
  });

  it('does not throw for empty topic array', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => decodeEvent(raw([], {}))).not.toThrow();
    warnSpy.mockRestore();
  });
});

describe('Decoder Registry — API payload stability', () => {
  it('v1 and legacy aliases produce identical normalized output fields', () => {
    const v1  = decodeEvent(raw(['prop_cr_v1', 'CTOKEN'], PROP_VALUE));
    const leg = decodeEvent(raw(['prop_create', 'CTOKEN'], PROP_VALUE));

    expect(v1.kind).toBe(leg.kind);
    if (v1.kind === 'proposal_created' && leg.kind === 'proposal_created') {
      expect(v1.proposalId).toBe(leg.proposalId);
      expect(v1.title).toBe(leg.title);
      expect(v1.proposalType).toBe(leg.proposalType);
      expect(v1.quorum).toBe(leg.quorum);
    }
  });

  it('numeric and string support values both decode to boolean', () => {
    const withBool = decodeEvent(raw(['vote_cs_v1', '7'], { proposal_id: 7, voter: 'G', support: true,  weight: 1 }));
    const withInt  = decodeEvent(raw(['vote_cs_v1', '7'], { proposal_id: 7, voter: 'G', support: 1,     weight: 1 }));
    if (withBool.kind === 'vote_cast' && withInt.kind === 'vote_cast') {
      expect(withBool.support).toBe(true);
      expect(withInt.support).toBe(true);
    }
  });

  it('missing optional fields default safely without throwing', () => {
    // Minimal proposal_created — no description, metadata, etc.
    const ev = decodeEvent(raw(['prop_cr_v1', 'CTOKEN'], { proposal_id: 1, proposer: 'G', title: 'T', proposal_type: 0, start_time: NOW_S, end_time: NOW_S + 1, quorum: 0, threshold: 0 }));
    expect(ev.kind).toBe('proposal_created');
    if (ev.kind === 'proposal_created') {
      expect(ev.description).toBeUndefined();
      expect(ev.metadata).toBeUndefined();
    }
  });
});
