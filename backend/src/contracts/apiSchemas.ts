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
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
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
}

export interface TokenSearchResponse {
  success: boolean;
  data: TokenRecord[];
  pagination: TokenPagination;
  filters: TokenFilters;
  cached?: boolean;
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
  | "token.metadata.updated";

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
