/**
 * Canonical API contract schemas for all backend routes.
 *
 * These are the source-of-truth response shapes that frontend clients
 * must align with. Any change here is a breaking contract change.
 *
 * Issue: #654
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export interface ErrorResponse {
  success: false;
  error: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Tokens  –  GET /api/tokens/search
// ---------------------------------------------------------------------------

export interface TokenRecord {
  id: string;
  address: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  /** BigInt serialised as string */
  totalSupply: string;
  /** BigInt serialised as string */
  initialSupply: string;
  /** BigInt serialised as string */
  totalBurned: string;
  burnCount: number;
  metadataUri: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TokenPagination {
  /** @deprecated offset-based page number — prefer `cursor`/`nextCursor` */
  page: number;
  limit: number;
  total: number;
  /** @deprecated offset-based page count — prefer `hasMore` */
  totalPages: number;
  /** @deprecated prefer `hasMore` */
  hasNext: boolean;
  /** @deprecated offset-based pagination is deprecated */
  hasPrev: boolean;
  /** Opaque keyset cursor for the next page; `null` when there are no more results. */
  nextCursor: string | null;
  /** Whether another page is available via `nextCursor`. */
  hasMore: boolean;
}

export interface TokenFilters {
  q?: string;
  creator?: string;
  startDate?: string;
  endDate?: string;
  minSupply?: string;
  maxSupply?: string;
  hasBurns?: string;
  sortBy: "created" | "burned" | "supply" | "name";
  sortOrder: "asc" | "desc";
  /** Echoes back the `cursor` query param when one was supplied. */
  cursor?: string;
}

export interface TokenSearchResponse {
  success: boolean;
  data: TokenRecord[];
  pagination: TokenPagination;
  filters: TokenFilters;
  cached?: boolean;
}

// ---------------------------------------------------------------------------
// Batch token deployment  –  POST /api/tokens/batch
// ---------------------------------------------------------------------------

/** Shape for the batch deploy endpoint request body. */
export interface BatchDeployRequestBody {
  tokens: import("../services/batchTokenDeployService").TokenDeployInput[];
}

/** Shape returned by POST /api/tokens/batch. */
export interface BatchDeployResponse {
  success: boolean;
  data: import("../services/batchTokenDeployService").BatchDeployResult;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Campaigns  –  /api/campaigns
// ---------------------------------------------------------------------------

export interface CampaignRecord {
  id: string;
  campaignId: number;
  tokenId: string;
  creator: string;
  type: string;
  status: string;
  targetAmount: string;
  currentAmount: string;
  executionCount: number;
  progress: number;
  startTime: string;
  endTime?: string;
  metadata?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface CampaignStats {
  totalCampaigns: number;
  activeCampaigns: number;
  completedCampaigns: number;
  totalVolume: string;
  totalExecutions: number;
}

export interface CampaignExecutionsResponse {
  executions: unknown[];
  total: number;
}

// ---------------------------------------------------------------------------
// Governance  –  /api/governance
// ---------------------------------------------------------------------------

export interface GovernanceVoteRecord {
  id: string;
  voter: string;
  support: boolean;
  /** BigInt serialised as string */
  weight: string;
  timestamp: string;
}

export interface GovernanceExecutionRecord {
  id: string;
  executor: string;
  success: boolean;
  executedAt: string;
  /** BigInt serialised as string, optional */
  gasUsed?: string;
}

export interface ProposalRecord {
  id: string;
  proposalId: number;
  tokenId: string;
  proposer: string;
  status: "ACTIVE" | "PASSED" | "REJECTED" | "EXECUTED" | "CANCELLED" | "EXPIRED";
  proposalType: "PARAMETER_CHANGE" | "ADMIN_TRANSFER" | "TREASURY_SPEND" | "CONTRACT_UPGRADE" | "CUSTOM";
  /** BigInt serialised as string */
  quorum: string;
  /** BigInt serialised as string */
  threshold: string;
  createdAt: string;
  startTime: string;
  endTime: string;
  votes: GovernanceVoteRecord[];
  executions: GovernanceExecutionRecord[];
}

export interface ProposalListResponse {
  success: true;
  data: {
    proposals: ProposalRecord[];
    total: number;
    limit: number;
    offset: number;
  };
}

export interface ProposalDetailResponse {
  success: true;
  data: {
    proposal: ProposalRecord;
    analytics: unknown;
  };
}

export interface ProposalVotesResponse {
  success: true;
  data: {
    votes: GovernanceVoteRecord[];
    total: number;
    limit: number;
    offset: number;
  };
}

// ---------------------------------------------------------------------------
// Leaderboard  –  /api/leaderboard/:type
// ---------------------------------------------------------------------------

export interface LeaderboardTokenRecord {
  rank: number;
  token: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
    totalBurned: string;
    burnCount: number;
    metadataUri: string | null;
    createdAt: string;
  };
  metric: string;
  change?: number;
}

export interface LeaderboardResponse {
  success: boolean;
  data: LeaderboardTokenRecord[];
  period: "24h" | "7d" | "30d" | "all";
  updatedAt: string;
  pagination: {
    page: number;
    limit: number;
    total: number;
  };
}

// ---------------------------------------------------------------------------
// Webhooks  –  /api/webhooks
// ---------------------------------------------------------------------------

export type WebhookEventType =
  | "token.burn.self"
  | "token.burn.admin"
  | "token.created"
  | "token.metadata.updated"
  | "token.fee.changed"
  | "token.allowlist.updated";

export interface WebhookSubscriptionRecord {
  id: string;
  url: string;
  tokenAddress: string | null;
  events: WebhookEventType[];
  /** Full secret only on creation; truncated (e.g. "abc12345...") elsewhere */
  secret: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  lastTriggered: string | null;
}

export interface WebhookDeliveryLogRecord {
  id: string;
  subscriptionId: string;
  event: WebhookEventType;
  payload: unknown;
  statusCode: number | null;
  success: boolean;
  attempts: number;
  lastAttemptAt: string;
  errorMessage: string | null;
  createdAt: string;
}

export interface WebhookCreateResponse {
  success: true;
  data: WebhookSubscriptionRecord;
  message: string;
}

export interface WebhookListResponse {
  success: true;
  data: WebhookSubscriptionRecord[];
  count: number;
}

export interface WebhookLogsResponse {
  success: true;
  data: WebhookDeliveryLogRecord[];
  count: number;
}

export interface WebhookToggleResponse {
  success: true;
  message: string;
}

export interface WebhookTestResponse {
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Contract events  –  versioned event payloads
// ---------------------------------------------------------------------------

/**
 * Version tag carried by every contract event payload. Consumers must
 * dispatch on `version` so that older parsers keep working when new fields
 * are added (wire compatibility via event versioning).
 */
export type ContractEventVersion = "v1" | "v2";

/**
 * Fee parameter change event (issue #2243).
 *
 * `v1` payloads only carried the new value; `v2` adds the previous value so
 * audit trails are complete. Parsers should treat `oldValue` as optional and
 * fall back to `null` when reading `v1` events.
 */
export interface FeeChangeEventV1 {
  version: "v1";
  event: "fee.changed";
  /** BigInt serialised as string */
  newValue: string;
  changedBy: string;
  timestamp: string;
}

export interface FeeChangeEventV2 {
  version: "v2";
  event: "fee.changed";
  /** BigInt serialised as string — value before the change */
  oldValue: string;
  /** BigInt serialised as string — value after the change */
  newValue: string;
  changedBy: string;
  timestamp: string;
}

export type FeeChangeEvent = FeeChangeEventV1 | FeeChangeEventV2;

/**
 * Allowlist (whitelist) mode events (issue #2245).
 *
 * Emitted when allowlist mode is toggled at creation or by an admin, and when
 * individual addresses are added to / removed from the allowlist.
 */
export interface AllowlistModeChangedEvent {
  version: "v1";
  event: "allowlist.mode_changed";
  /** Whether allowlist mode is now enabled */
  enabled: boolean;
  changedBy: string;
  timestamp: string;
}

export interface AllowlistAddressUpdatedEvent {
  version: "v1";
  event: "allowlist.address_updated";
  address: string;
  /** `true` when the address was added, `false` when removed */
  allowed: boolean;
  changedBy: string;
  timestamp: string;
}

export type AllowlistEvent = AllowlistModeChangedEvent | AllowlistAddressUpdatedEvent;

/** Discriminated union of all versioned contract events. */
export type ContractEvent = FeeChangeEvent | AllowlistEvent;
