# Nova Launch Admin Dashboard API

Backend API for the Nova Launch admin dashboard with protected endpoints for platform management, statistics, and content moderation.

## Features

- 🔐 Admin authentication with JWT
- 👥 Role-based access control (RBAC)
- 📊 Platform statistics and analytics
- 🎯 Token management (flag, soft delete, update)
- 👤 User management (ban, role changes)
- 📝 Comprehensive audit logging
- 📤 Data export functionality
- � Multi-channel notification service support
- 🔒 Rate limiting and security headers

## Notification Service

The backend includes a multi-channel notification service that supports:

- `WEBHOOK` - dispatches notifications through existing webhook subscriptions
- `EMAIL` - sends email notifications through a configurable provider endpoint
- `SMS` - sends SMS notifications through a configurable provider endpoint

Configuration is optional for email and SMS. When a channel is not configured, delivery fails safely and other channels continue.

### Environment variables

| Environment variable | Description |
|---|---|
| `NOTIFICATION_EMAIL_API_URL` | HTTP endpoint used to send email notifications |
| `NOTIFICATION_EMAIL_API_KEY` | Optional bearer token for email provider |
| `NOTIFICATION_SMS_API_URL` | HTTP endpoint used to send SMS notifications |
| `NOTIFICATION_SMS_API_KEY` | Optional bearer token for SMS provider |

## Tech Stack

- Node.js + Express
- TypeScript
- JWT for authentication
- Zod for validation
- Vitest for testing

## Getting Started

### Installation

```bash
cd backend
npm install
```

### Environment Setup

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

`.env.example` documents every variable inline. The core set is validated at
startup — see [Environment Variables](#environment-variables) below for the
authoritative rules.

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Production

```bash
npm start
```

### Testing

```bash
npm test
```

Run the rate limiter tests specifically:

```bash
npm test src/middleware/rateLimiter.test.ts
```

Run the database pool chaos spec directly when validating exhaustion handling:

```bash
npm test backend/src/__tests__/chaos.db-pool.test.ts
```

This spec covers concurrent query saturation, client acquisition failures,
and safe shutdown behavior for the pg pool wrapper.

## Environment Variables

Core configuration is validated at startup by `validateEnv()` in
[`src/config/env.ts`](src/config/env.ts), which is the **source of truth** for
the variables below. When a required variable is missing or malformed the
process fails fast with an explanatory error instead of booting in a bad state.

Behaviour depends on `NODE_ENV`:

- **`NODE_ENV=production`** — the "required in production" variables must be
  present and valid, or startup throws.
- **any other value** (the default is `development`) — those variables fall back
  to the development defaults listed below.

A few checks run regardless of `NODE_ENV`: an unknown `STELLAR_NETWORK` and a
`FACTORY_CONTRACT_ID` that does not match the expected format both always throw.

| Variable | Required in production | Format / allowed values | Development default |
|---|---|---|---|
| `NODE_ENV` | no | free-form; only the exact value `production` changes behaviour | `development` |
| `PORT` | no | integer | `3001` |
| `STELLAR_NETWORK` | no | `testnet` \| `mainnet` — any other value throws in every environment | `testnet` |
| `STELLAR_HORIZON_URL` | no | URL | derived from `STELLAR_NETWORK` (see below) |
| `STELLAR_SOROBAN_RPC_URL` | no | URL | derived from `STELLAR_NETWORK` (see below) |
| `STELLAR_NETWORK_PASSPHRASE` | no | string | derived from `STELLAR_NETWORK` (see below) |
| `FACTORY_CONTRACT_ID` | **yes** | `^C[A-Z2-7]{55}$` (56 chars, starts with `C`); a malformed value throws in **every** environment | `""` (empty string) |
| `DATABASE_URL` | **yes** | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5432/postgres?schema=public` |
| `JWT_SECRET` | **yes** | any non-empty string except the literal `your-secret-key-change-in-production` | `dev-secret-key-change-me` |

### Network-derived Stellar defaults

`STELLAR_NETWORK` implicitly selects the defaults for `STELLAR_HORIZON_URL`,
`STELLAR_SOROBAN_RPC_URL`, and `STELLAR_NETWORK_PASSPHRASE`. Setting any of those
three explicitly overrides just that one; leaving them unset is the common case,
so it is easy to miss that switching `STELLAR_NETWORK` moves all three endpoints
at once.

| `STELLAR_NETWORK` | `STELLAR_HORIZON_URL` | `STELLAR_SOROBAN_RPC_URL` | `STELLAR_NETWORK_PASSPHRASE` |
|---|---|---|---|
| `testnet` (default) | `https://horizon-testnet.stellar.org` | `https://soroban-testnet.stellar.org` | `Test SDF Network ; September 2015` |
| `mainnet` | `https://horizon.stellar.org` | `https://soroban-mainnet.stellar.org` | `Public Global Stellar Network ; September 2015` |

See [`.env.example`](.env.example) for a copy-paste template. Variables consumed
elsewhere in the app (`ADMIN_JWT_SECRET`, `REDIS_URL`, notification provider
keys, …) are documented inline in `.env.example` and are **not** enforced by
`validateEnv()`.

## Rate Limiting

The API uses a **Redis-backed sliding-window rate limiter** (`src/middleware/rateLimiter.ts`).

### How it works

Each request is recorded as a timestamped entry in a Redis sorted set. On every
request the middleware:

1. Removes entries older than the window (`ZREMRANGEBYSCORE`).
2. Adds the current timestamp (`ZADD`).
3. Counts remaining entries (`ZCARD`).
4. Refreshes the key TTL (`EXPIRE`).

All four operations run in a single atomic pipeline, making the counter safe
for distributed deployments.

### Fail-open behaviour

If Redis is unavailable the middleware calls `next()` and allows the request
through. This prevents a cache outage from taking down the API.

### Response headers

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Configured maximum requests per window |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the window resets |
| `Retry-After` | Seconds until the client may retry (only on 429) |

### Configuration

| Environment variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `RATE_LIMIT_WINDOW_MS` | `900000` (15 min) | Window size in milliseconds |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window (global limiter) |

### Pre-configured limiters

| Export | Max requests | Key prefix | Used for |
|---|---|---|---|
| `globalRateLimiter` | 100 / 15 min | `rl:global` | All API routes |
| `webhookRateLimiter` | 20 / 15 min | `rl:webhook` | Webhook subscription endpoints |

### Custom limiter

```typescript
import { createRateLimiter, createRedisClient } from "./middleware/rateLimiter";

const redis = createRedisClient();
const limiter = createRateLimiter(redis, {
  windowMs: 60_000,   // 1 minute
  max: 30,
  keyPrefix: "rl:myroute",
  message: "Slow down!",
});

app.use("/api/my-route", limiter);
```

## API Endpoints

### Governance API

Public endpoints for governance proposals and voting. No authentication required.

#### GET /api/governance/proposals

Returns all governance proposals with optional filters.

**Query Parameters:**

- `status` - Filter by status: `ACTIVE`, `PASSED`, `REJECTED`, `EXECUTED`, `CANCELLED`, `EXPIRED`
- `proposalType` - Filter by type: `PARAMETER_CHANGE`, `ADMIN_TRANSFER`, `TREASURY_SPEND`, `CONTRACT_UPGRADE`, `CUSTOM`
- `tokenId` - Filter by token ID
- `proposer` - Filter by proposer address
- `limit` - Results per page: 1-100 (default: `50`)
- `offset` - Pagination offset (default: `0`)
- `sortBy` - Sort field: `createdAt`, `startTime`, `endTime` (default: `createdAt`)
- `sortOrder` - Sort order: `asc`, `desc` (default: `desc`)

**Response:**

```json
{
  "success": true,
  "data": {
    "proposals": [...],
    "total": 45,
    "limit": 50,
    "offset": 0
  }
}
```

#### GET /api/governance/proposals/:proposalId

Returns detailed proposal information with analytics.

**Response:**

```json
{
  "success": true,
  "data": {
    "proposal": {...},
    "analytics": {
      "totalVotes": 150,
      "votesFor": "750000",
      "votesAgainst": "250000",
      "participationRate": 75.5,
      "uniqueVoters": 150
    }
  }
}
```

#### GET /api/governance/proposals/:proposalId/votes

Returns all votes for a specific proposal.

**Query Parameters:**

- `limit` - Results per page: 1-100 (default: `100`)
- `offset` - Pagination offset (default: `0`)

#### GET /api/governance/proposals/:proposalId/execution

Returns execution status and history for a proposal.

**Response:**

```json
{
  "success": true,
  "data": {
    "proposalId": 1,
    "status": "EXECUTED",
    "executedAt": "2024-01-09T00:00:00.000Z",
    "executions": [...],
    "isExecuted": true,
    "canExecute": false
  }
}
```

#### GET /api/governance/stats

Returns overall governance statistics.

#### GET /api/governance/voters/:address

Returns voting statistics for a specific address.

**Features:**

- ✅ Input validation with express-validator
- ✅ Pagination support
- ✅ Comprehensive error handling
- ✅ OpenAPI documentation
- ✅ Full test coverage

**Documentation:**

- [Full API Documentation](GOVERNANCE_API.md)
- [Quick Reference](GOVERNANCE_API_QUICK_REF.md)

---

### Token Leaderboard API

Public endpoints for token rankings and leaderboards. No authentication required.

#### GET /api/leaderboard/most-burned

Returns tokens with the highest burn volume.

**Query Parameters:**

- `period` - Time period: `24h`, `7d`, `30d`, `all` (default: `7d`)
- `page` - Page number: 1-100 (default: `1`)
- `limit` - Results per page: 1-100 (default: `10`)

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "rank": 1,
      "token": {
        "address": "0x123...",
        "name": "Token Name",
        "symbol": "TKN",
        "decimals": 18,
        "totalSupply": "1000000000",
        "totalBurned": "50000000",
        "burnCount": 125,
        "metadataUri": "ipfs://...",
        "createdAt": "2024-01-01T00:00:00.000Z"
      },
      "metric": "50000000"
    }
  ],
  "period": "7d",
  "updatedAt": "2024-02-24T12:00:00.000Z",
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 45
  }
}
```

#### GET /api/leaderboard/most-active

Returns tokens with the most burn transactions.

**Query Parameters:** Same as most-burned

**Metric:** Number of burn transactions

#### GET /api/leaderboard/newest

Returns recently created tokens.

**Query Parameters:**

- `page` - Page number
- `limit` - Results per page

**Metric:** Creation timestamp

#### GET /api/leaderboard/largest-supply

Returns tokens with the highest total supply.

**Query Parameters:** Same as newest

**Metric:** Total supply amount

#### GET /api/leaderboard/most-burners

Returns tokens with the most unique burners.

**Query Parameters:** Same as most-burned

**Metric:** Number of unique addresses that burned tokens

**Features:**

- ✅ Server-side caching (5-minute TTL)
- ✅ Rate limiting (100 requests per 15 minutes)
- ✅ Optimized database queries with indexes
- ✅ Comprehensive error handling

**Documentation:**

- [Full API Documentation](LEADERBOARD_API.md)
- [Quick Reference](LEADERBOARD_QUICK_REF.md)

---

### Authentication

All admin endpoints require authentication via Bearer token:

```
Authorization: Bearer <admin_jwt_token>
```

### Statistics

#### GET /api/admin/stats

Get platform statistics including:

- Total tokens created
- Total burns executed
- Total volume burned
- Active users count
- Revenue generated
- Platform health metrics
- Growth metrics (daily/weekly/monthly)

**Response:**

```json
{
  "totalTokens": 150,
  "totalBurns": 45,
  "totalVolumeBurned": "1000000",
  "activeUsers": 89,
  "revenueGenerated": "5000",
  "platformHealth": {
    "uptime": 86400,
    "errorRate": 0.01,
    "avgResponseTime": 150
  },
  "growth": {
    "daily": {
      "newTokens": 5,
      "newUsers": 12,
      "burnVolume": "50000",
      "revenue": "250"
    },
    "weekly": {
      "newTokens": 28,
      "newUsers": 67,
      "burnVolume": "300000",
      "revenue": "1500"
    },
    "monthly": {
      "newTokens": 120,
      "newUsers": 250,
      "burnVolume": "900000",
      "revenue": "4500"
    }
  }
}
```

### Token Management

#### GET /api/admin/tokens

List all tokens with optional filters.

**Query Parameters:**

- `flagged` - Filter by flagged status (true/false)
- `deleted` - Include deleted tokens (true/false)
- `creator` - Filter by creator address
- `search` - Search by name, symbol, or address

**Response:**

```json
{
  "tokens": [...],
  "total": 150
}
```

#### GET /api/admin/tokens/:id

Get detailed token information including creator details.

**Response:**

```json
{
  "token": {
    "id": "token_1",
    "name": "Sample Token",
    "symbol": "SMPL",
    "contractAddress": "CTOKEN...",
    "creatorAddress": "GCREATOR...",
    "totalSupply": "1000000",
    "burned": "50000",
    "flagged": false,
    "deleted": false,
    "metadata": {},
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  },
  "creator": {
    "id": "user_1",
    "address": "GCREATOR...",
    "role": "user",
    "banned": false,
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

#### PATCH /api/admin/tokens/:id

Update token (flag/unflag, update metadata).

**Permissions:** Admin or Super Admin

**Request Body:**

```json
{
  "flagged": true,
  "metadata": {
    "reason": "Suspicious activity",
    "reviewedBy": "admin_1"
  }
}
```

#### DELETE /api/admin/tokens/:id

Soft delete a token.

**Permissions:** Super Admin only

### User Management

#### GET /api/admin/users

List all users with optional filters.

**Query Parameters:**

- `banned` - Filter by banned status (true/false)
- `role` - Filter by role (user/admin/super_admin)
- `search` - Search by address or ID

**Response:**

```json
{
  "users": [...],
  "total": 89
}
```

#### GET /api/admin/users/:id

Get user details with activity and tokens.

**Response:**

```json
{
  "user": {...},
  "tokens": [...],
  "activity": {
    "tokensCreated": 5,
    "totalBurned": "100000",
    "adminActions": 0
  },
  "recentAuditLogs": [...]
}
```

#### PATCH /api/admin/users/:id

Update user (ban/unban, change role).

**Permissions:** Super Admin only

**Request Body:**

```json
{
  "banned": true,
  "role": "admin"
}
```

#### GET /api/admin/users/:id/export

Export user data including all tokens and activity.

**Response:** JSON file download

### Audit Logs

#### GET /api/admin/audit

Get audit logs with filters and pagination.

**Query Parameters:**

- `adminId` - Filter by admin ID
- `action` - Filter by action type
- `resource` - Filter by resource type
- `startDate` - Filter by start date (ISO 8601)
- `endDate` - Filter by end date (ISO 8601)
- `limit` - Results per page (default: 50)
- `offset` - Pagination offset (default: 0)

**Response:**

```json
{
  "logs": [...],
  "pagination": {
    "total": 500,
    "limit": 50,
    "offset": 0,
    "hasMore": true
  }
}
```

#### GET /api/admin/audit/export

Export audit logs as JSON file.

**Query Parameters:** Same as GET /api/admin/audit

**Response:** JSON file download

## Role-Based Access Control

### Roles

1. **user** - Regular platform users (no admin access)
2. **admin** - Can view stats, manage tokens, view users
3. **super_admin** - Full access including user management and deletions

### Permission Matrix

| Endpoint                     | User | Admin | Super Admin |
| ---------------------------- | ---- | ----- | ----------- |
| GET /api/admin/stats         | ❌   | ✅    | ✅          |
| GET /api/admin/tokens        | ❌   | ✅    | ✅          |
| PATCH /api/admin/tokens/:id  | ❌   | ✅    | ✅          |
| DELETE /api/admin/tokens/:id | ❌   | ❌    | ✅          |
| GET /api/admin/users         | ❌   | ✅    | ✅          |
| PATCH /api/admin/users/:id   | ❌   | ❌    | ✅          |
| GET /api/admin/audit         | ❌   | ✅    | ✅          |

## Audit Logging

All admin actions are automatically logged with:

- Admin ID
- Action type (method + endpoint)
- Resource type and ID
- Before/after state
- IP address and user agent
- Timestamp

Audit logs are searchable, filterable, and exportable.

## Security Features

- JWT-based authentication
- Role-based access control
- Rate limiting (100 requests per 15 minutes)
- Helmet.js security headers
- CORS protection
- Input validation with Zod
- Soft deletes (data preservation)

## Error Handling

All endpoints return consistent error responses:

```json
{
  "error": "Error message",
  "details": {} // Optional validation details
}
```

HTTP Status Codes:

- 200 - Success
- 400 - Bad Request (validation error)
- 401 - Unauthorized (missing/invalid token)
- 403 - Forbidden (insufficient permissions)
- 404 - Not Found
- 500 - Internal Server Error

## Development

### Project Structure

```
backend/
├── src/
│   ├── config/
│   │   └── database.ts       # Database operations
│   ├── middleware/
│   │   ├── auth.ts           # Authentication & RBAC
│   │   └── auditLog.ts       # Audit logging
│   ├── routes/
│   │   └── admin/
│   │       ├── index.ts      # Route aggregator
│   │       ├── stats.ts      # Statistics endpoints
│   │       ├── tokens.ts     # Token management
│   │       ├── users.ts      # User management
│   │       └── audit.ts      # Audit logs
│   ├── types/
│   │   └── index.ts          # TypeScript types
│   ├── __tests__/
│   │   └── admin.test.ts     # Tests
│   └── index.ts              # Main application
├── .env.example
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Testing

Run tests with coverage:

```bash
npm test
```

Tests cover:

- Database operations
- User management
- Token management
- Audit logging
- Filtering and pagination

## Deployment

1. Build the application:

```bash
npm run build
```

2. Set production environment variables

3. Start the server:

```bash
npm start
```

## Future Enhancements

- [ ] PostgreSQL/MongoDB integration
- [ ] Real-time notifications
- [ ] Advanced analytics dashboard
- [ ] Bulk operations
- [ ] Scheduled reports
- [ ] Two-factor authentication
- [ ] IP whitelisting
- [ ] API versioning

## License

MIT
