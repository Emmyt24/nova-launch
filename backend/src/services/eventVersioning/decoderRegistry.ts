/**
 * Event Version Decoder Registry
 *
 * Single normalization point for all contract event topics.
 * Each decoder maps a raw Stellar event (any version) to a stable
 * NormalizedEvent shape consumed by downstream parsers.
 *
 * Rules:
 *  - Add new topic aliases here; parsers never inspect raw topics.
 *  - Unknown topics are logged and returned as { kind: 'unknown' }.
 *  - Numeric/string field coercions live here, not in parsers.
 *  - NEVER remove old topic aliases — they may still appear in ledger
 *    history from the previous contract version.
 *
 * UPGRADE COMPATIBILITY: When adding a new event topic, also add it to
 * TOPIC_KIND and DECODERS below. Run check-upgrade-compatibility.sh to
 * verify coverage. See docs/CONTRACT_UPGRADE_COMPATIBILITY.md.
 */

/**
 * Decoded event payload. The shape varies per topic/contract version, so it is
 * typed as `unknown` and narrowed via `asEventValue` before property access.
 */
export type RawEventValue = Record<string, unknown>;

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
 * Narrow an unknown event payload to a property bag.
 * Non-object payloads (null, primitives) yield an empty bag so that
 * property reads fall back to the same defaults as before.
 */
function asEventValue(v: unknown): RawEventValue {
  return typeof v === 'object' && v !== null ? (v as RawEventValue) : {};
}

// ── Normalized shapes ────────────────────────────────────────────────────────

export type NormalizedEvent =
  | NormalizedGovernanceEvent
  | NormalizedVaultEvent
  | NormalizedCampaignEvent
  | NormalizedTokenEvent
  | UnknownEvent;

interface EventBase {
  txHash: string;
  ledger: number;
  timestamp: Date;
  contractId: string;
}

// Governance
export type NormalizedGovernanceEvent = EventBase & (
  | { kind: 'proposal_created'; proposalId: number; tokenAddress: string; proposer: string; title: string; description?: string; proposalType: number; startTime: Date; endTime: Date; quorum: string; threshold: string; metadata?: string }
  | { kind: 'vote_cast'; proposalId: number; voter: string; support: boolean; weight: string; reason?: string }
  | { kind: 'proposal_queued'; proposalId: number; oldStatus: string }
  | { kind: 'proposal_executed'; proposalId: number; executor: string; success: boolean; returnData?: string; gasUsed?: string }
  | { kind: 'proposal_cancelled'; proposalId: number; canceller: string; reason?: string }
  | { kind: 'proposal_status_changed'; proposalId: number; oldStatus: string; newStatus: string }
  | { kind: 'proposal_state_snapshot'; proposalId: number; status: string; yesVotes: string; noVotes: string; quorumRequired: string; snapshotLedger: number }
);

// Vault
export type NormalizedVaultEvent = EventBase & (
  | { kind: 'vault_created'; streamId: number; creator: string; recipient: string; amount: string; hasMetadata: boolean }
  | { kind: 'vault_claimed'; streamId: number; recipient: string; amount: string }
  | { kind: 'vault_cancelled'; streamId: number; canceller: string; remainingAmount: string }
  | { kind: 'vault_metadata_updated'; streamId: number; updater: string; hasMetadata: boolean }
);

// Campaign
export type NormalizedCampaignEvent = EventBase & (
  | { kind: 'campaign_created'; campaignId: number; tokenId: string; creator: string; campaignType: string; targetAmount: string; startTime: Date; endTime?: Date; metadata?: string }
  | { kind: 'campaign_executed'; campaignId: number; executor: string; amount: string; recipient?: string }
  | { kind: 'campaign_status_changed'; campaignId: number; status: string }
);

// Token
export type NormalizedTokenEvent = EventBase & (
  | { kind: 'token_created'; tokenAddress: string; creator: string; name: string; symbol: string; decimals: number; initialSupply: string }
  | { kind: 'token_burned'; tokenAddress: string; from: string; amount: string; burner: string }
  | { kind: 'token_admin_burned'; tokenAddress: string; from: string; amount: string; admin: string }
  | { kind: 'token_metadata_updated'; tokenAddress: string; metadataUri: string; updatedBy: string }
);

export type UnknownEvent = EventBase & { kind: 'unknown'; topic: string };

// ── Topic → kind mapping ─────────────────────────────────────────────────────

const TOPIC_KIND: Record<string, string> = {
  // Governance — v1 + abbreviated + legacy
  prop_cr_v1: 'proposal_created', prop_cr: 'proposal_created', prop_create: 'proposal_created',
  vote_cs_v1: 'vote_cast',        vote_cs: 'vote_cast',        vote_cast: 'vote_cast',
  prop_qu_v1: 'proposal_queued',  prop_qu: 'proposal_queued',
  prop_ex_v1: 'proposal_executed',prop_ex: 'proposal_executed',prop_exec: 'proposal_executed',
  prop_ca_v1: 'proposal_cancelled',prop_ca: 'proposal_cancelled',prop_cancel: 'proposal_cancelled',
  prop_st_v1: 'proposal_status_changed', prop_status: 'proposal_status_changed',
  // Proposal state snapshot (#1383) — periodic/on-demand fast-forward checkpoint
  prop_snap: 'proposal_state_snapshot',
  // Vault — v1 only
  vlt_cr_v1: 'vault_created',
  vlt_cl_v1: 'vault_claimed',
  vlt_cn_v1: 'vault_cancelled',
  vlt_md_v1: 'vault_metadata_updated',
  // Campaign
  camp_cr_v1: 'campaign_created',  camp_cr: 'campaign_created',
  camp_ex_v1: 'campaign_executed', camp_ex: 'campaign_executed',
  camp_st_v1: 'campaign_status_changed', camp_st: 'campaign_status_changed',
  // Token
  tok_reg:  'token_created',
  tok_burn: 'token_burned',
  adm_burn: 'token_admin_burned',
  tok_meta: 'token_metadata_updated',
};

// ── Decoders ─────────────────────────────────────────────────────────────────

function base(raw: RawStellarEvent): EventBase {
  return {
    txHash: raw.transaction_hash,
    ledger: raw.ledger,
    timestamp: new Date(raw.ledger_close_time),
    contractId: raw.contract_id,
  };
}

function str(v: unknown): string {
  if (v == null) return '0';
  return typeof v === 'string' ? v : String(v);
}
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseInt(v, 10) || 0;
  return 0;
}
function bool(v: unknown): boolean { return v === true || v === 1; }
function dateFromSec(v: unknown): Date { return new Date(num(v) * 1000); }

const DECODERS: Record<string, (raw: RawStellarEvent) => NormalizedEvent> = {
  proposal_created: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'proposal_created',
      proposalId: num(value.proposal_id),
      tokenAddress: raw.topic[1] ?? '',
      proposer: value.proposer ?? '',
      title: value.title ?? 'Untitled',
      description: value.description as string | undefined,
      proposalType: num(value.proposal_type),
      startTime: dateFromSec(value.start_time),
      endTime: dateFromSec(value.end_time),
      quorum: str(value.quorum),
      threshold: str(value.threshold),
      metadata: value.metadata as string | undefined,
    };
  },

  vote_cast: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'vote_cast',
      proposalId: num(value.proposal_id),
      voter: value.voter ?? '',
      support: bool(value.support),
      weight: str(value.weight),
      reason: value.reason as string | undefined,
    };
  },

  proposal_queued: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'proposal_queued',
      proposalId: num(value.proposal_id ?? raw.topic[1]),
      oldStatus: value.old_status?.toString() ?? 'passed',
    };
  },

  proposal_executed: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'proposal_executed',
      proposalId: num(value.proposal_id),
      executor: value.executor ?? '',
      success: bool(value.success ?? true),
      returnData: value.return_data as string | undefined,
      gasUsed: value.gas_used != null ? str(value.gas_used) : undefined,
    };
  },

  proposal_cancelled: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'proposal_cancelled',
      proposalId: num(value.proposal_id),
      canceller: value.canceller ?? '',
      reason: value.reason as string | undefined,
    };
  },

  proposal_status_changed: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'proposal_status_changed',
      proposalId: num(value.proposal_id),
      oldStatus: str(value.old_status),
      newStatus: str(value.new_status),
    };
  },

  proposal_state_snapshot: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'proposal_state_snapshot',
      proposalId: num(value.proposal_id ?? raw.topic[1]),
      status: value.status?.toString() ?? 'active',
      yesVotes: str(value.yes_votes),
      noVotes: str(value.no_votes),
      quorumRequired: str(value.quorum_required),
      snapshotLedger: num(value.ledger ?? raw.ledger),
    };
  },

  vault_created: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'vault_created',
      streamId: num(value.stream_id ?? raw.topic[1]),
      creator: value.creator ?? '',
      recipient: value.recipient ?? '',
      amount: str(value.amount),
      hasMetadata: bool(value.has_metadata),
    };
  },

  vault_claimed: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'vault_claimed',
      streamId: num(value.stream_id ?? raw.topic[1]),
      recipient: value.recipient ?? '',
      amount: str(value.amount),
    };
  },

  vault_cancelled: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'vault_cancelled',
      streamId: num(value.stream_id ?? raw.topic[1]),
      canceller: value.canceller ?? '',
      remainingAmount: str(value.remaining_amount),
    };
  },

  vault_metadata_updated: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'vault_metadata_updated',
      streamId: num(value.stream_id ?? raw.topic[1]),
      updater: value.updater ?? '',
      hasMetadata: bool(value.has_metadata),
    };
  },

  campaign_created: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'campaign_created',
      campaignId: num(value.campaign_id),
      tokenId: value.token_id ?? raw.topic[1] ?? '',
      creator: value.creator ?? '',
      campaignType: value.campaign_type ?? 'BUYBACK',
      targetAmount: str(value.target_amount),
      startTime: dateFromSec(value.start_time),
      endTime: value.end_time ? dateFromSec(value.end_time) : undefined,
      metadata: value.metadata as string | undefined,
    };
  },

  campaign_executed: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'campaign_executed',
      campaignId: num(value.campaign_id),
      executor: value.executor ?? '',
      amount: str(value.amount),
      recipient: value.recipient as string | undefined,
    };
  },

  campaign_status_changed: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'campaign_status_changed',
      campaignId: num(value.campaign_id),
      status: value.status ?? '',
    };
  },

  token_created: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'token_created',
      tokenAddress: raw.topic[1] ?? '',
      creator: value.creator ?? '',
      name: value.name ?? '',
      symbol: value.symbol ?? '',
      decimals: num(value.decimals ?? 7),
      initialSupply: str(value.initial_supply),
    };
  },

  token_burned: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'token_burned',
      tokenAddress: raw.topic[1] ?? '',
      from: value.from ?? '',
      amount: str(value.amount),
      burner: value.burner ?? value.from ?? '',
    };
  },

  token_admin_burned: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'token_admin_burned',
      tokenAddress: raw.topic[1] ?? '',
      from: value.from ?? '',
      amount: str(value.amount),
      admin: value.admin ?? '',
    };
  },

  token_metadata_updated: (raw) => {
    const value = asEventValue(raw.value);
    return {
      ...base(raw), kind: 'token_metadata_updated',
      tokenAddress: raw.topic[1] ?? '',
      metadataUri: value.metadata_uri ?? '',
      updatedBy: value.updated_by ?? '',
    };
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Decode a raw Stellar event into a stable NormalizedEvent.
 * Unknown topics produce { kind: 'unknown' } and are logged.
 */
export function decodeEvent(raw: RawStellarEvent): NormalizedEvent {
  const topic0 = raw.topic?.[0] ?? '';
  const kind = TOPIC_KIND[topic0];

  if (!kind) {
    console.warn(`[eventVersioning] Unknown event topic "${topic0}" — skipping (ledger=${raw.ledger}, tx=${raw.transaction_hash})`);
    return { ...base(raw), kind: 'unknown', topic: topic0 };
  }

  const decoder = DECODERS[kind];
  if (!decoder) {
    // Mapped kind but no decoder — defensive fallback
    console.warn(`[eventVersioning] No decoder for kind "${kind}" (topic="${topic0}")`);
    return { ...base(raw), kind: 'unknown', topic: topic0 };
  }

  return decoder(raw);
}

/** Returns true if the topic is recognized by the registry. */
export function isKnownTopic(topic0: string): boolean {
  return topic0 in TOPIC_KIND;
}

/** Returns the canonical kind for a topic, or null if unknown. */
export function kindForTopic(topic0: string): string | null {
  return TOPIC_KIND[topic0] ?? null;
}
