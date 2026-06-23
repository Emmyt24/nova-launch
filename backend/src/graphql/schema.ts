/**
 * GraphQL schema (SDL) for the Nova Launch API.
 *
 * Exposes the four core domain objects already served by the REST layer:
 *   Token, Stream, Proposal (governance), Campaign
 *
 * Design decisions:
 *  - BigInt fields are serialised as String to avoid JS precision loss.
 *  - All list queries accept optional `limit` (max 100) and `offset` args.
 *  - Enum values mirror the Prisma enums so resolvers can pass them through directly.
 *  - Mutations are intentionally excluded – writes go through the existing REST
 *    endpoints which carry full validation / auth middleware.
 *  - Subscriptions deliver real-time domain events over a graphql-ws WebSocket
 *    transport, fed by the in-process eventBus. Every subscription is tenant
 *    scoped: a subscriber only receives events for tokens / proposals / vaults
 *    whose creator matches the tenant resolved from the connection JWT.
 */

export const typeDefs = /* GraphQL */ `
  scalar DateTime

  # ── Token ──────────────────────────────────────────────────────────────────

  type Token {
    id: ID!
    address: String!
    creator: String!
    name: String!
    symbol: String!
    decimals: Int!
    totalSupply: String!
    initialSupply: String!
    totalBurned: String!
    burnCount: Int!
    metadataUri: String
    createdAt: DateTime!
    updatedAt: DateTime!
    burnRecords(limit: Int, offset: Int): [BurnRecord!]!
  }

  type BurnRecord {
    id: ID!
    from: String!
    amount: String!
    burnedBy: String!
    isAdminBurn: Boolean!
    txHash: String!
    timestamp: DateTime!
  }

  # ── Stream ─────────────────────────────────────────────────────────────────

  enum StreamStatus {
    CREATED
    CLAIMED
    CANCELLED
  }

  type Stream {
    id: ID!
    streamId: Int!
    creator: String!
    recipient: String!
    amount: String!
    metadata: String
    status: StreamStatus!
    txHash: String!
    createdAt: DateTime!
    claimedAt: DateTime
    cancelledAt: DateTime
  }

  # ── Governance ─────────────────────────────────────────────────────────────

  enum ProposalStatus {
    ACTIVE
    PASSED
    REJECTED
    QUEUED
    EXECUTED
    CANCELLED
    EXPIRED
  }

  enum ProposalType {
    PARAMETER_CHANGE
    ADMIN_TRANSFER
    TREASURY_SPEND
    CONTRACT_UPGRADE
    CUSTOM
  }

  type Proposal {
    id: ID!
    proposalId: Int!
    tokenId: String!
    proposer: String!
    title: String!
    description: String
    proposalType: ProposalType!
    status: ProposalStatus!
    startTime: DateTime!
    endTime: DateTime!
    quorum: String!
    threshold: String!
    metadata: String
    txHash: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    executedAt: DateTime
    votes(limit: Int, offset: Int): [Vote!]!
  }

  type Vote {
    id: ID!
    voter: String!
    support: Boolean!
    weight: String!
    reason: String
    txHash: String!
    timestamp: DateTime!
  }

  # ── Campaign ───────────────────────────────────────────────────────────────

  enum CampaignStatus {
    ACTIVE
    PAUSED
    COMPLETED
    CANCELLED
  }

  enum CampaignType {
    BUYBACK
    AIRDROP
    LIQUIDITY
  }

  type Campaign {
    id: ID!
    campaignId: Int!
    tokenId: String!
    creator: String!
    type: CampaignType!
    status: CampaignStatus!
    targetAmount: String!
    currentAmount: String!
    executionCount: Int!
    startTime: DateTime!
    endTime: DateTime
    metadata: String
    txHash: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    completedAt: DateTime
    cancelledAt: DateTime
  }

  # ── Root Query ─────────────────────────────────────────────────────────────

  type Query {
    # Token queries
    token(address: String!): Token
    tokens(creator: String, limit: Int, offset: Int): [Token!]!

    # Stream queries
    stream(streamId: Int!): Stream
    streams(
      creator: String
      recipient: String
      status: StreamStatus
      limit: Int
      offset: Int
    ): [Stream!]!

    # Governance queries
    proposal(proposalId: Int!): Proposal
    proposals(
      tokenId: String
      proposer: String
      status: ProposalStatus
      proposalType: ProposalType
      limit: Int
      offset: Int
    ): [Proposal!]!

    # Campaign queries
    campaign(campaignId: Int!): Campaign
    campaigns(
      tokenId: String
      creator: String
      status: CampaignStatus
      type: CampaignType
      limit: Int
      offset: Int
    ): [Campaign!]!
  }

  # ── Real-time event payloads ────────────────────────────────────────────────

  type TokenDeployedEvent {
    tokenAddress: String!
    creatorAddress: String!
    name: String!
    symbol: String!
    totalSupply: String!
    txHash: String!
    timestamp: DateTime!
  }

  type BurnExecutedEvent {
    tokenAddress: String!
    creatorAddress: String!
    amount: String!
    burnedBy: String!
    isAdminBurn: Boolean!
    txHash: String!
    timestamp: DateTime!
  }

  type ProposalStatusChangedEvent {
    proposalId: Int!
    tokenAddress: String!
    creatorAddress: String!
    status: ProposalStatus!
    previousStatus: ProposalStatus
    txHash: String!
    timestamp: DateTime!
  }

  type VaultMaturedEvent {
    vaultId: Int!
    recipientAddress: String!
    creatorAddress: String!
    amount: String!
    txHash: String!
    timestamp: DateTime!
  }

  # ── Leaderboard ──────────────────────────────────────────────────────────────

  enum LeaderboardType {
    MOST_BURNED
    MOST_ACTIVE
    NEWEST
    LARGEST_SUPPLY
    MOST_BURNERS
  }

  type LeaderboardEntry {
    rank: Int!
    tokenAddress: String!
    tokenName: String!
    tokenSymbol: String!
    metric: String!
  }

  type LeaderboardUpdatedEvent {
    type: LeaderboardType!
    period: String!
    entries: [LeaderboardEntry!]!
    updatedAt: DateTime!
  }

  # ── Root Subscription ───────────────────────────────────────────────────────
  #
  # All subscriptions are tenant scoped via the connection JWT, EXCEPT
  # leaderboardUpdated — the leaderboard ranks tokens across every tenant, so
  # it is broadcast publicly the same way the REST leaderboard routes are.

  type Subscription {
    # Emitted when a new token finishes deploying. Optionally filter to a
    # specific creator address (must be within the subscriber's tenant).
    tokenDeployed(creatorAddress: String): TokenDeployedEvent!

    # Emitted when tokens are burned. Optionally filter to a token address.
    burnExecuted(tokenAddress: String): BurnExecutedEvent!

    # Emitted when a governance proposal transitions status. Optionally filter
    # to the proposals of a specific token address.
    proposalStatusChanged(tokenAddress: String): ProposalStatusChangedEvent!

    # Emitted when a vesting vault matures. Optionally filter to a recipient.
    vaultMatured(recipientAddress: String): VaultMaturedEvent!

    # Emitted when the top-100 ranking for a leaderboard changes (new burns
    # or deployments). Debounced to at most one emission every 5 seconds per
    # (type, period) so rapid bursts of activity batch into a single update.
    leaderboardUpdated(
      type: LeaderboardType = MOST_BURNED
      period: String = "7d"
    ): LeaderboardUpdatedEvent!
  }
`;
