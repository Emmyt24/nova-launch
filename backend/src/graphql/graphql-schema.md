# Nova Launch GraphQL API

The GraphQL API exposes read-only **queries** over HTTP and real-time
**subscriptions** over WebSocket.

| Operation type | Transport            | Endpoint                          |
| -------------- | -------------------- | --------------------------------- |
| Query          | HTTP (`graphql-http`)| `POST /api/graphql`               |
| Subscription   | WebSocket (`graphql-ws`) | `ws(s)://<host>/graphql`      |

Mutations are intentionally not exposed — all writes go through the REST layer,
which carries the full validation / auth middleware.

---

## Pagination (Relay connections)

List data is available through Relay-style cursor connections, which return a
bounded page plus the cursor to fetch the next one:

| Field               | Filters                                         | Node     |
| ------------------- | ----------------------------------------------- | -------- |
| `tokensConnection`  | `creator: String`                               | `Token`  |
| `streamsConnection` | `creator`, `recipient: String`, `status: StreamStatus` | `Stream` |

Arguments:

- **`first: Int`**: page size. Defaults to `20`; must be between `1` and `100`.
  A value outside that range is rejected with a `BAD_USER_INPUT` error rather
  than silently clamped.
- **`after: String`**: the `endCursor` from the previous page. Cursors are
  opaque; don't parse or construct them. An unknown or malformed cursor is
  rejected with `Invalid cursor`.

Results are ordered newest first (`createdAt` desc, then `id` desc). Paging is
keyset based, so rows inserted while a client is paging don't shift later pages.

```graphql
type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

type TokenConnection {
  edges: [TokenEdge!]!   # { cursor: String!, node: Token! }
  pageInfo: PageInfo!
  totalCount: Int!       # rows matching the filters, across all pages
}
```

```graphql
query NextTokens($after: String) {
  tokensConnection(creator: "GCREATOR...", first: 50, after: $after) {
    totalCount
    edges { cursor node { address name symbol } }
    pageInfo { hasNextPage endCursor }
  }
}
```

Repeat the query with `after: pageInfo.endCursor` until `hasNextPage` is
`false`. The older `tokens` / `streams` fields (`limit` / `offset`) are still
available for backwards compatibility, but new clients should use the connection
fields. Connection fields count as list fields for query-complexity scoring.

---

## Subscriptions

Subscriptions deliver real-time domain events sourced from the in-process
`eventBus`. They use the [`graphql-ws`](https://github.com/enisdenjo/graphql-ws)
protocol (the current standard that replaces the deprecated
`subscriptions-transport-ws`).

### Connection & authentication

Authentication is performed on the `connection_init` handshake. Pass a JWT in
the `connectionParams` payload — the server validates it with the same JWT logic
used by the REST tenancy middleware and resolves the caller's **tenant** from
the `tenantId` / `tenant_id` claim. Connections without a valid tenant are
rejected (close code `4403`).

```ts
import { createClient } from "graphql-ws";

const client = createClient({
  url: "wss://api.novalaunch.example/graphql",
  connectionParams: {
    authorization: `Bearer ${jwt}`, // or { authToken: jwt }
  },
});
```

### Tenant scoping

Every subscription is tenant scoped using the same rule as the query/REST layer
(`creator === tenantId`): a subscriber only receives events whose owning token
creator matches the tenant resolved from the connection JWT. The optional
arguments narrow the stream **further within** the tenant's own data — they can
never broaden it across tenants.

### Limits

- **Max concurrent subscriptions per connection:** `10`
  (configurable via `GRAPHQL_MAX_SUBSCRIPTIONS_PER_CONNECTION`). Exceeding the
  cap rejects the new subscription with a GraphQL error; existing ones are
  unaffected. Queries/mutations over the same socket do not count toward the cap.

### Operations

| Field                   | Argument                     | Payload                       | Fires when                                   |
| ----------------------- | ---------------------------- | ----------------------------- | -------------------------------------------- |
| `tokenDeployed`         | `creatorAddress: String`     | `TokenDeployedEvent`          | a new token finishes deploying               |
| `burnExecuted`          | `tokenAddress: String`       | `BurnExecutedEvent`           | tokens are burned                            |
| `proposalStatusChanged` | `tokenAddress: String`       | `ProposalStatusChangedEvent`  | a governance proposal transitions status     |
| `vaultMatured`          | `recipientAddress: String`   | `VaultMaturedEvent`           | a vesting vault matures                       |
| `campaignStepExecuted`  | `campaignId: Int`            | `CampaignStepExecutedEvent`   | a buyback campaign step completes on-chain    |

All arguments are optional filters. `BigInt` amounts are serialised as `String`
to avoid JS precision loss.

`campaignStepExecuted` is the one exception to tenant scoping below — buyback
campaigns are keyed by `tokenAddress`, not by a tenant-owned creator, so any
authenticated connection receives all matching events.

#### Schema (SDL)

```graphql
type Subscription {
  tokenDeployed(creatorAddress: String): TokenDeployedEvent!
  burnExecuted(tokenAddress: String): BurnExecutedEvent!
  proposalStatusChanged(tokenAddress: String): ProposalStatusChangedEvent!
  vaultMatured(recipientAddress: String): VaultMaturedEvent!
  campaignStepExecuted(campaignId: Int): CampaignStepExecutedEvent!
}

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

type CampaignStepExecutedEvent {
  campaignId: Int!
  stepNumber: Int!
  amount: String!
  status: BuybackStepStatus!
  txHash: String!
  executedAt: DateTime!
  totalSteps: Int!
  executedAmount: String!
  campaignStatus: CampaignStatus!
}
```

### Example

```graphql
subscription OnTokenDeployed {
  tokenDeployed {
    tokenAddress
    creatorAddress
    name
    symbol
    totalSupply
    txHash
    timestamp
  }
}
```

```ts
client.subscribe(
  { query: /* the subscription above */ },
  {
    next: ({ data }) => console.log("token deployed", data.tokenDeployed),
    error: (err) => console.error(err),
    complete: () => console.log("done"),
  }
);
```

### Event topics

The subscription fields consume these `eventBus` topics (produced by the domain
services / event listeners, not by the GraphQL layer):

| Subscription field      | eventBus topic                          |
| ----------------------- | --------------------------------------- |
| `tokenDeployed`         | `token.deployed`                        |
| `burnExecuted`          | `burn.executed`                         |
| `proposalStatusChanged` | `governance.proposal.statusChanged`     |
| `vaultMatured`          | `vault.matured`                         |
| `campaignStepExecuted`  | `campaign.step_executed`                |

Each topic's payload must carry a `creatorAddress` so the stream can be tenant
scoped consistently with the rest of the API — except `campaign.step_executed`,
which has no creator concept (see above).
</content>
