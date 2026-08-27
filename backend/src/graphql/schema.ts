/**
 * GraphQL schema (SDL) for the Nova Launch API.
 *
 * Exposes the core domain objects already served by the REST layer:
 *   Token, Stream, Proposal (governance)
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
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * Schema ↔ resolver correspondence contract (READ BEFORE EDITING)
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * This SDL string and `./resolvers.ts` are kept in sync **by convention only**.
 * There is no compile-time link and — see below — no startup validation either.
 *
 * The contract, in both directions:
 *
 *  1. Every field defined here must EITHER have a matching resolver in
 *     `resolvers.ts`, OR intentionally rely on GraphQL's default field resolver
 *     (which returns `parent[fieldName]`). In practice that means:
 *       - Every `Query.*` field  → a function on `resolvers.Query`.
 *       - Every `Subscription.*` field → a `{ subscribe, resolve }` pair on
 *         `resolvers.Subscription`.
 *       - Scalar fields of `Token` / `Stream` / `Proposal` / `Vote` / the
 *         `*Event` payload types → satisfied by the default resolver because the
 *         Prisma row / event payload already carries an identically-named
 *         property.
 *       - Non-scalar / computed fields that the parent object does NOT carry
 *         (`Token.burnRecords`, `Proposal.votes`, `Proposal.queuePosition`) →
 *         a function on `resolvers.Token` / `resolvers.Proposal`.
 *  2. Conversely, every function exported from `resolvers.ts` must correspond to
 *     a field defined here. A resolver with no matching SDL field is dead code:
 *     nothing ever invokes it through the running server.
 *
 * How the two files are actually combined into an executable schema
 * ----------------------------------------------------------------------------
 * `./index.ts` does NOT use `makeExecutableSchema` (graphql-tools). It calls
 * `buildSchema(typeDefs)` from the core `graphql` package, which produces a
 * schema object with NO resolvers attached, then wires behaviour on top:
 *
 *   - `resolvers.Query.*` is spread into a plain `rootValue` object that is
 *     handed to `graphql-http`'s `createHandler` (HTTP `POST /api/graphql`) and
 *     to the `graphql-ws` `useServer` `roots` (queries over the WS transport).
 *   - `resolvers.Subscription.*` is copied field-by-field onto the schema's
 *     subscription type in a `for` loop, guarded by `if (field)` — a
 *     subscription resolver whose name does not match an SDL field is silently
 *     skipped.
 *   - `resolvers.Token.*` and `resolvers.Proposal.*` (the nested-relation field
 *     resolvers) are NOT wired into the `buildSchema` schema at all. They are
 *     exercised directly by `resolvers.test.ts`. Through the live endpoint,
 *     selecting e.g. `token { burnRecords { ... } }` falls back to the default
 *     field resolver, finds no `burnRecords` property on the Prisma row, and
 *     the non-null `[BurnRecord!]!` field errors at query time. Treat these
 *     field resolvers as documentation of intended behaviour, not as code the
 *     HTTP path runs today.
 *
 * Does any of this catch a mismatch at startup? NO.
 * ----------------------------------------------------------------------------
 * `buildSchema(typeDefs)` validates only that this SDL is internally
 * well-formed (syntax, referenced types exist, interface conformance). It never
 * compares the SDL against `resolvers.ts`. `graphql-http` and `graphql-ws` do
 * not either. Therefore:
 *
 *   - Adding a resolver here with no matching SDL field  → no error, ever
 *     (dead code).
 *   - Adding an SDL field here with no matching resolver → no startup error;
 *     it fails only when a query actually selects that field (HTTP 200 with an
 *     `errors` entry, or `null` for a nullable field).
 *
 * A concrete instance of this drift exists as of this writing: `resolvers.test.ts`
 * and `graphql-schema.md` reference `Query.campaign(s)` and a
 * `campaignStepExecuted` subscription that this SDL does not define — the
 * mismatch surfaces only as failing tests, never as a server startup failure.
 *
 * Contributor guidance
 * ----------------------------------------------------------------------------
 *  - When you add or rename a field, change BOTH this file and `resolvers.ts`
 *    in the same commit.
 *  - Add / extend a case in `resolvers.test.ts` that executes the field through
 *    `graphql()` against `buildSchema(typeDefs)` + `rootValue`, so a future
 *    mismatch is caught in CI rather than in production.
 *
 * Possible follow-up (NOT done here): swapping `buildSchema` for
 * `@graphql-tools/schema`'s `makeExecutableSchema({ typeDefs, resolvers })` —
 * which throws on a resolver that references a field absent from the SDL — or
 * adding a small CI assertion that every `resolvers.*` key maps to an SDL
 * field, would turn this convention into an enforced check.
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
    """
    0-based position of this proposal in the FIFO execution queue for its
    proposalType. Only meaningful while status is QUEUED; null otherwise.
    """
    queuePosition: Int
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

    # Current FIFO execution queue (status = QUEUED), ordered by queue time.
    # Optionally narrowed to a single proposalType.
    governanceQueue(proposalType: ProposalType): [Proposal!]!
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

  type ProposalVoteCastEvent {
    proposalId: Int!
    tokenAddress: String!
    creatorAddress: String!
    voter: String!
    support: Boolean!
    weight: String!
    votesFor: String!
    votesAgainst: String!
    reason: String
    txHash: String!
    timestamp: DateTime!
  }

  # ── Root Subscription ───────────────────────────────────────────────────────
  #
  # All subscriptions are tenant scoped via the connection JWT. The optional
  # arguments below narrow the stream further within the tenant's own data.

  type Subscription {
    # Emitted when a new token finishes deploying. Optionally filter to a
    # specific creator address (must be within the subscriber's tenant).
    tokenDeployed(creatorAddress: String): TokenDeployedEvent!

    # Emitted when tokens are burned. Optionally filter to a token address.
    burnExecuted(tokenAddress: String): BurnExecutedEvent!

    # Emitted when a governance proposal transitions status. Optionally filter
    # to the proposals of a specific token address.
    proposalStatusChanged(tokenAddress: String): ProposalStatusChangedEvent!

    # Emitted whenever a vote is cast on a governance proposal. Optionally
    # filter to a specific proposal (by its on-chain proposalId). Carries the
    # running for/against tallies so subscribers can update vote counts and
    # quorum progress without a full refetch.
    proposalVoteCast(proposalId: Int): ProposalVoteCastEvent!

    # Emitted when a vesting vault matures. Optionally filter to a recipient.
    vaultMatured(recipientAddress: String): VaultMaturedEvent!
  }
`;
