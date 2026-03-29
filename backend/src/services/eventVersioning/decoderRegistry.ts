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
 */

export interface RawStellarEvent {
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

function str(v: any): string  { return v?.toString() ?? '0'; }
function num(v: any): number  { return typeof v === 'number' ? v : parseInt(v, 10) || 0; }
function bool(v: any): boolean { return v === true || v === 1; }
function dateFromSec(v: any): Date { return new Date(num(v) * 1000); }

const DECODERS: Record<string, (raw: RawStellarEvent) => NormalizedEvent> = {
  proposal_created: (raw) => ({
    ...base(raw), kind: 'proposal_created',
    proposalId: num(raw.value?.proposal_id),
    tokenAddress: raw.topic[1] ?? '',
    proposer: raw.value?.proposer ?? '',
    title: raw.value?.title ?? 'Untitled',
    description: raw.value?.description,
    proposalType: num(raw.value?.proposal_type),
    startTime: dateFromSec(raw.value?.start_time),
    endTime: dateFromSec(raw.value?.end_time),
    quorum: str(raw.value?.quorum),
    threshold: str(raw.value?.threshold),
    metadata: raw.value?.metadata,
  }),

  vote_cast: (raw) => ({
    ...base(raw), kind: 'vote_cast',
    proposalId: num(raw.value?.proposal_id),
    voter: raw.value?.voter ?? '',
    support: bool(raw.value?.support),
    weight: str(raw.value?.weight),
    reason: raw.value?.reason,
  }),

  proposal_queued: (raw) => ({
    ...base(raw), kind: 'proposal_queued',
    proposalId: num(raw.value?.proposal_id ?? raw.topic[1]),
    oldStatus: raw.value?.old_status?.toString() ?? 'passed',
  }),

  proposal_executed: (raw) => ({
    ...base(raw), kind: 'proposal_executed',
    proposalId: num(raw.value?.proposal_id),
    executor: raw.value?.executor ?? '',
    success: bool(raw.value?.success ?? true),
    returnData: raw.value?.return_data,
    gasUsed: raw.value?.gas_used != null ? str(raw.value.gas_used) : undefined,
  }),

  proposal_cancelled: (raw) => ({
    ...base(raw), kind: 'proposal_cancelled',
    proposalId: num(raw.value?.proposal_id),
    canceller: raw.value?.canceller ?? '',
    reason: raw.value?.reason,
  }),

  proposal_status_changed: (raw) => ({
    ...base(raw), kind: 'proposal_status_changed',
    proposalId: num(raw.value?.proposal_id),
    oldStatus: str(raw.value?.old_status),
    newStatus: str(raw.value?.new_status),
  }),

  vault_created: (raw) => ({
    ...base(raw), kind: 'vault_created',
    streamId: num(raw.value?.stream_id ?? raw.topic[1]),
    creator: raw.value?.creator ?? '',
    recipient: raw.value?.recipient ?? '',
    amount: str(raw.value?.amount),
    hasMetadata: bool(raw.value?.has_metadata),
  }),

  vault_claimed: (raw) => ({
    ...base(raw), kind: 'vault_claimed',
    streamId: num(raw.value?.stream_id ?? raw.topic[1]),
    recipient: raw.value?.recipient ?? '',
    amount: str(raw.value?.amount),
  }),

  vault_cancelled: (raw) => ({
    ...base(raw), kind: 'vault_cancelled',
    streamId: num(raw.value?.stream_id ?? raw.topic[1]),
    canceller: raw.value?.canceller ?? '',
    remainingAmount: str(raw.value?.remaining_amount),
  }),

  vault_metadata_updated: (raw) => ({
    ...base(raw), kind: 'vault_metadata_updated',
    streamId: num(raw.value?.stream_id ?? raw.topic[1]),
    updater: raw.value?.updater ?? '',
    hasMetadata: bool(raw.value?.has_metadata),
  }),

  campaign_created: (raw) => ({
    ...base(raw), kind: 'campaign_created',
    campaignId: num(raw.value?.campaign_id),
    tokenId: raw.value?.token_id ?? raw.topic[1] ?? '',
    creator: raw.value?.creator ?? '',
    campaignType: raw.value?.campaign_type ?? 'BUYBACK',
    targetAmount: str(raw.value?.target_amount),
    startTime: dateFromSec(raw.value?.start_time),
    endTime: raw.value?.end_time ? dateFromSec(raw.value.end_time) : undefined,
    metadata: raw.value?.metadata,
  }),

  campaign_executed: (raw) => ({
    ...base(raw), kind: 'campaign_executed',
    campaignId: num(raw.value?.campaign_id),
    executor: raw.value?.executor ?? '',
    amount: str(raw.value?.amount),
    recipient: raw.value?.recipient,
  }),

  campaign_status_changed: (raw) => ({
    ...base(raw), kind: 'campaign_status_changed',
    campaignId: num(raw.value?.campaign_id),
    status: raw.value?.status ?? '',
  }),

  token_created: (raw) => ({
    ...base(raw), kind: 'token_created',
    tokenAddress: raw.topic[1] ?? '',
    creator: raw.value?.creator ?? '',
    name: raw.value?.name ?? '',
    symbol: raw.value?.symbol ?? '',
    decimals: num(raw.value?.decimals ?? 7),
    initialSupply: str(raw.value?.initial_supply),
  }),

  token_burned: (raw) => ({
    ...base(raw), kind: 'token_burned',
    tokenAddress: raw.topic[1] ?? '',
    from: raw.value?.from ?? '',
    amount: str(raw.value?.amount),
    burner: raw.value?.burner ?? raw.value?.from ?? '',
  }),

  token_admin_burned: (raw) => ({
    ...base(raw), kind: 'token_admin_burned',
    tokenAddress: raw.topic[1] ?? '',
    from: raw.value?.from ?? '',
    amount: str(raw.value?.amount),
    admin: raw.value?.admin ?? '',
  }),

  token_metadata_updated: (raw) => ({
    ...base(raw), kind: 'token_metadata_updated',
    tokenAddress: raw.topic[1] ?? '',
    metadataUri: raw.value?.metadata_uri ?? '',
    updatedBy: raw.value?.updated_by ?? '',
  }),
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
