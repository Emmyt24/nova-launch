<!--
  GENERATED FILE — DO NOT EDIT.
  Source: backend/src/config/envSchema.ts
  Regenerate: cd backend && npm run docs:env
-->

# Backend Environment Variables

Reference for every environment variable read by the backend. It is generated
from `backend/src/config/envSchema.ts`, and CI fails when this file is out of date.

**Required** column:

- **Production** — `validateEnv()` (`src/config/env.ts`) throws at startup when unset
  with `NODE_ENV=production`; a development default applies otherwise.
- **Deployment** — listed as required in the deployment manifest
  (`REQUIRED_SCHEMAS` in `src/config/startupValidation.ts`); set it in every
  deployed environment.
- **No** — optional; the default or a graceful fallback applies.

🔒 marks credentials: load them from a secret store (see the Vault group) and never commit them.

## Required at a glance

| Variable | Required | Group |
|---|---|---|
| `STELLAR_NETWORK` | Deployment | [Stellar](#stellar) |
| `STELLAR_HORIZON_URL` | Deployment | [Stellar](#stellar) |
| `STELLAR_SOROBAN_RPC_URL` | Deployment | [Stellar](#stellar) |
| `STELLAR_NETWORK_PASSPHRASE` | Deployment | [Stellar](#stellar) |
| `FACTORY_CONTRACT_ID` | **Production** | [Stellar](#stellar) |
| `DATABASE_URL` | **Production** | [Database](#database) |
| `JWT_SECRET` | **Production** | [Auth](#auth) |
| `ADMIN_JWT_SECRET` | **Production** | [Auth](#auth) |
| `PINATA_API_KEY` | Deployment | [IPFS / Pinata](#ipfs--pinata) |
| `PINATA_API_SECRET` | Deployment | [IPFS / Pinata](#ipfs--pinata) |
| `SENDGRID_API_KEY` | Deployment | [Notifications](#notifications) |
| `TWILIO_ACCOUNT_SID` | Deployment | [Notifications](#notifications) |
| `TWILIO_AUTH_TOKEN` | Deployment | [Notifications](#notifications) |
| `TWILIO_PHONE_NUMBER` | Deployment | [Notifications](#notifications) |

## Contents

- [Core](#core) (4)
- [Stellar](#stellar) (11)
- [Database](#database) (11)
- [Auth](#auth) (3)
- [Redis](#redis) (4)
- [HTTP & Rate Limiting](#http--rate-limiting) (7)
- [GraphQL](#graphql) (5)
- [IPFS / Pinata](#ipfs--pinata) (16)
- [Notifications](#notifications) (12)
- [Webhooks](#webhooks) (18)
- [Background Jobs](#background-jobs) (8)
- [Backups & Audit](#backups--audit) (3)
- [Observability](#observability) (8)
- [Vault](#vault) (5)

## Core

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `NODE_ENV` | No | development | `production` | Runtime environment. Only "production" changes validation behaviour; "test" disables tracing and some external calls. |
| `PORT` | No | 3001 | `3001` | HTTP port the API listens on (integer 1–65535). |
| `BACKEND_VERSION` | No | 0.0.0 | `1.4.2` | Version string reported by GET /api/version. |
| `FRONTEND_URL` | No | http://localhost:5173 | `https://app.nova-launch.app` | Origin allowed by CORS for the frontend. |

## Stellar

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `STELLAR_NETWORK` | Deployment | testnet | `testnet` | Stellar network: "testnet" or "mainnet". Selects defaults for the Horizon/RPC URLs and passphrase. |
| `STELLAR_HORIZON_URL` | Deployment | Derived from STELLAR_NETWORK (https://horizon-testnet.stellar.org on testnet) | `https://horizon-testnet.stellar.org` | Horizon REST endpoint. |
| `STELLAR_SOROBAN_RPC_URL` | Deployment | Derived from STELLAR_NETWORK (https://soroban-testnet.stellar.org on testnet) | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint. |
| `SOROBAN_RPC_URL` | No | — | `https://soroban-testnet.stellar.org` | Legacy alias read by the on-chain projection verifier before STELLAR_SOROBAN_RPC_URL. |
| `STELLAR_NETWORK_PASSPHRASE` | Deployment | Derived from STELLAR_NETWORK | `Test SDF Network ; September 2015` | Network passphrase; must match STELLAR_NETWORK. |
| `FACTORY_CONTRACT_ID` | **Production** | empty (non-production only) | `CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` | Soroban token factory contract ID (56 chars, starts with "C"). A malformed value always fails startup. |
| `STELLAR_CURSOR_ORIGIN` | No | — | `now` | Paging-token origin the event listener and replay service resume from when no cursor is stored. |
| `MAX_CATCHUP_LEDGERS` | No | 1000 | `1000` | Maximum ledgers the event listener replays on catch-up after downtime. |
| `STELLAR_FEE_BUMP_SPONSOR_ACCOUNT` | No | empty (fee bumps disabled) | `GABC...SPONSOR` | Account that sponsors fee-bump transactions. |
| `STELLAR_FEE_BUMP_THRESHOLD_XLM` | No | 1.0 | `5.0` | Sponsor balance (XLM) below which fee-bump alerts fire. |
| `FEE_BUMP_PENDING_THRESHOLD_MS` | No | 60000 | `60000` | Time a transaction may stay pending before it is fee-bumped. |

## Database

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `DATABASE_URL` 🔒 | **Production** | postgresql://postgres:postgres@localhost:5432/postgres?schema=public (non-production only) | _secret_ | PostgreSQL connection URL used by Prisma and the pooled client. |
| `DB_HOST` | No | localhost | `db.internal` | Host for the legacy pg client (src/database/db.ts). |
| `DB_PORT` | No | 5432 | `5432` | Port for the legacy pg client. |
| `DB_NAME` | No | nova_launch | `nova_launch` | Database name for the legacy pg client. |
| `DB_USER` | No | user | `nova_user` | User for the legacy pg client. |
| `DB_PASSWORD` 🔒 | No | password | _secret_ | Password for the legacy pg client. |
| `DB_POOL_MIN` | No | 2 | `2` | Minimum pooled connections. |
| `DB_POOL_MAX` | No | 10 | `20` | Maximum pooled connections. |
| `DB_POOL_SIZE` | No | 10 | `20` | Pool size reported by the pool-saturation metrics. |
| `DB_CONNECT_TIMEOUT_MS` | No | 5000 | `5000` | Connection acquisition timeout. |
| `DB_IDLE_TIMEOUT_MS` | No | 30000 | `30000` | Idle connection eviction timeout. |

## Auth

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `JWT_SECRET` 🔒 | **Production** | dev-secret-key-change-me (non-production only) | _secret_ | Secret used to sign and verify user JWTs. Publicly known placeholders are rejected in production. |
| `ADMIN_JWT_SECRET` 🔒 | **Production** | dev-admin-secret-key-change-me (non-production only) | _secret_ | Secret used to sign and verify admin JWTs. Publicly known placeholders are rejected in production. |
| `JWT_ACCESS_SECRET` 🔒 | No | Falls back to JWT_SECRET | _secret_ | Secret for WebSocket access tokens. |

## Redis

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `REDIS_URL` | No | redis://localhost:6379 | `redis://redis:6379` | Redis connection URL (rate limiter, webhook limits, token store). |
| `REDIS_HOST` | No | localhost | `redis` | Redis host for the auth nonce/token services when REDIS_URL is unset. |
| `REDIS_PORT` | No | 6379 | `6379` | Redis port for the auth nonce/token services. |
| `REDIS_PASSWORD` 🔒 | No | — | _secret_ | Redis password for the auth nonce/token services. |

## HTTP & Rate Limiting

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `REQUEST_TIMEOUT_MS` | No | 30000 | `30000` | Per-request timeout enforced by the timeout middleware. |
| `RATE_LIMIT_WINDOW_MS` | No | 900000 | `900000` | Distributed rate-limit window. |
| `RATE_LIMIT_MAX_REQUESTS` | No | 100 | `100` | Requests allowed per client per window. |
| `TRUSTED_PROXY_IPS` | No | empty (no proxies trusted) | `10.0.0.1,10.0.0.2` | Comma-separated proxy IPs whose X-Forwarded-For is trusted for client IP resolution. |
| `HEALTH_DETAIL_ENABLED` | No | false | `true` | Set to "true" to expose dependency details on the health endpoint. |
| `DEPLOY_STATUS_STREAM_INTERVAL_MS` | No | 3000 | `3000` | Poll interval for the deploy-status SSE stream (minimum 500). |
| `DISCOVERY_AGGREGATION_TIMEOUT_MS` | No | 5000 | `5000` | Timeout for the discovery endpoint's aggregation queries. |

## GraphQL

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `GRAPHQL_MAX_DEPTH` | No | 6 | `6` | Maximum query depth; malformed values fall back to the default. |
| `GRAPHQL_MAX_COMPLEXITY` | No | 100 | `100` | Maximum query complexity score. |
| `GRAPHQL_LIST_FIELD_COST` | No | 10 | `10` | Complexity cost charged per list field. |
| `GRAPHQL_MAX_SUBSCRIPTIONS_PER_CONNECTION` | No | 10 | `10` | Concurrent subscriptions allowed per WebSocket connection. |
| `GRAPHQL_SUBSCRIPTION_QUEUE_DEPTH` | No | 1000 | `1000` | Buffered events per subscription before the slowest are dropped. |

## IPFS / Pinata

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `PINATA_API_KEY` 🔒 | Deployment | — | _secret_ | Pinata API key for pinning token metadata. |
| `PINATA_API_SECRET` 🔒 | Deployment | — | _secret_ | Pinata API secret. |
| `PINATA_API_KEY_NEXT` 🔒 | No | — | _secret_ | Next Pinata API key, used during zero-downtime key rotation. |
| `PINATA_API_SECRET_NEXT` 🔒 | No | — | _secret_ | Next Pinata API secret, used during key rotation. |
| `PINATA_GATEWAY_URL` | No | https://gateway.pinata.cloud/ipfs | `https://gateway.pinata.cloud/ipfs` | Primary IPFS gateway. |
| `CLOUDFLARE_IPFS_GATEWAY` | No | https://cloudflare-ipfs.com/ipfs | `https://cloudflare-ipfs.com/ipfs` | Secondary IPFS gateway. |
| `PUBLIC_IPFS_GATEWAY` | No | https://ipfs.io/ipfs | `https://ipfs.io/ipfs` | Last-resort public IPFS gateway. |
| `IPFS_VERIFY_CID` | No | false | `true` | Set to "true" to re-fetch and verify CIDs after pinning. |
| `IPFS_VERIFY_GATEWAY_URL` | No | https://gateway.pinata.cloud/ipfs | `https://gateway.pinata.cloud/ipfs` | Gateway used for CID verification. |
| `PINATA_RPS` | No | 5 | `5` | Pinata request queue rate (requests per second). |
| `PINATA_MAX_BURST` | No | 10 | `10` | Pinata request queue burst size. |
| `PINATA_MAX_CONCURRENT` | No | 3 | `3` | Concurrent in-flight Pinata requests. |
| `PINATA_MAX_RETRIES_429` | No | 5 | `5` | Retries after Pinata 429 responses. |
| `PINATA_RETRY_BASE_MS` | No | 1000 | `1000` | Base backoff for Pinata retries. |
| `PINATA_RETRY_CAP_MS` | No | 60000 | `60000` | Maximum backoff for Pinata retries. |
| `PIN_MONITOR_INTERVAL_MS` | No | 300000 | `300000` | Interval of the pin-health monitor. |

## Notifications

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `SENDGRID_API_KEY` 🔒 | Deployment | — | _secret_ | SendGrid API key. When set, NOTIFICATION_EMAIL_API_URL is ignored. |
| `NOTIFICATION_FROM_EMAIL` | No | noreply@nova-launch.app | `noreply@your-domain.com` | Sender address for notification emails. |
| `NOTIFICATION_EMAIL_API_URL` | No | — | `https://your-email-provider.com/send` | Legacy generic HTTP email provider; used only when SENDGRID_API_KEY is unset. |
| `NOTIFICATION_EMAIL_API_KEY` 🔒 | No | — | _secret_ | Bearer token for the legacy email provider. |
| `TWILIO_ACCOUNT_SID` | Deployment | — | `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` | Twilio account SID (must start with "AC"). |
| `TWILIO_AUTH_TOKEN` 🔒 | Deployment | — | _secret_ | Twilio auth token. |
| `TWILIO_PHONE_NUMBER` | Deployment | — | `+15550001234` | Twilio sender phone number (E.164). |
| `NOTIFICATION_SMS_API_URL` | No | — | `https://your-sms-provider.com/send` | Legacy generic HTTP SMS provider; used only when Twilio is not configured. |
| `NOTIFICATION_SMS_API_KEY` 🔒 | No | — | _secret_ | Bearer token for the legacy SMS provider. |
| `MAX_RETRIES` | No | 3 | `3` | Notification delivery attempts, including the first. |
| `NOTIFICATION_RATE_LIMIT_WINDOW_MS` | No | 3600000 | `3600000` | One notification per recipient per event within this window. |
| `PAGERDUTY_ROUTING_KEY` 🔒 | No | empty (paging disabled) | _secret_ | PagerDuty Events v2 routing key for incident alerts. |

## Webhooks

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `WEBHOOK_TIMEOUT_MS` | No | 5000 | `5000` | Per-attempt HTTP timeout for webhook delivery. |
| `WEBHOOK_MAX_RETRIES` | No | 3 | `3` | Delivery attempts before a webhook is dead-lettered. |
| `WEBHOOK_RETRY_DELAY_MS` | No | 1000 | `1000` | Base delay of the delivery backoff (doubles each attempt). |
| `WEBHOOK_WORKER_CONCURRENCY` | No | 10 | `10` | Concurrent deliveries in the webhook worker pool (integer ≥ 1). |
| `WEBHOOK_COMPRESSION_THRESHOLD_BYTES` | No | 1024 | `1024` | Payloads at least this large are gzip-compressed. |
| `WEBHOOK_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | No | 5 | `5` | Consecutive failures that open the delivery circuit breaker. |
| `WEBHOOK_CIRCUIT_BREAKER_SUCCESS_THRESHOLD` | No | 2 | `2` | Successes in half-open state that close the circuit breaker. |
| `WEBHOOK_CIRCUIT_BREAKER_TIMEOUT_MS` | No | 60000 | `60000` | Time the circuit breaker stays open before half-opening. |
| `WEBHOOK_TENANT_RATE_LIMIT_MAX` | No | 60 | `60` | Deliveries per tenant per sliding window (Redis ceiling). |
| `WEBHOOK_TENANT_RATE_LIMIT_WINDOW_MS` | No | 60000 | `60000` | Sliding window for WEBHOOK_TENANT_RATE_LIMIT_MAX. |
| `WEBHOOK_RATE_LIMIT_PER_MINUTE` | No | 100 | `100` | Per-tenant token-bucket refill rate. |
| `WEBHOOK_RATE_LIMIT_BURST` | No | 20 | `20` | Per-tenant token-bucket capacity. |
| `WEBHOOK_DLQ_MAX_REQUEUE_CYCLES` | No | 3 | `3` | Requeues allowed per dead-letter entry before the poison-message guard blocks it. |
| `WEBHOOK_MAX_ATTEMPTS` | No | 5 | `5` | Attempts for the WebhookRetryService engine (notification webhooks). |
| `WEBHOOK_BASE_DELAY_MS` | No | 1000 | `1000` | Base delay for the WebhookRetryService engine. |
| `WEBHOOK_BACKOFF_MULTIPLIER` | No | 2 | `2` | Backoff multiplier for the WebhookRetryService engine. |
| `WEBHOOK_MAX_DELAY_MS` | No | 30000 | `30000` | Backoff cap for the WebhookRetryService engine. |
| `WEBHOOK_JITTER` | No | true | `false` | Set to "false" to disable ±25 % backoff jitter in WebhookRetryService. |

## Background Jobs

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `ENABLE_EVENT_LISTENER` | No | false | `true` | Set to "true" to start the Stellar event listener on boot. |
| `ENABLE_STREAM_RECONCILIATION` | No | false | `true` | Set to "true" to run periodic stream reconciliation. |
| `STREAM_RECONCILIATION_INTERVAL_MS` | No | 300000 | `300000` | Interval between stream reconciliation runs. |
| `ENABLE_PROJECTION_SNAPSHOTS` | No | false | `true` | Set to "true" to run the projection snapshot job. |
| `PROJECTION_SNAPSHOT_INTERVAL_MS` | No | 1800000 | `1800000` | Interval between projection snapshots. |
| `JOB_QUEUE_CONCURRENCY` | No | 2 | `4` | Jobs processed concurrently by the job queue. |
| `JOB_QUEUE_FAIRNESS_STREAK` | No | 5 | `5` | Consecutive high-priority jobs before a lower-priority job is scheduled. |
| `JOB_QUEUE_STUCK_THRESHOLD_MS` | No | 900000 | `900000` | Running time after which a job is reported as stuck. |

## Backups & Audit

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `BACKUP_STORAGE_PATH` | No | /var/backups/nova/pitr | `/var/backups/nova/pitr` | Directory for PITR backups and audit-archive checkpoints. |
| `AUDIT_RETENTION_DAYS` | No | 90 | `365` | Audit log rows older than this are archived and pruned. |
| `AUDIT_RETENTION_INTERVAL_MS` | No | 3600000 | `3600000` | Interval of the audit retention job. |

## Observability

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `METRICS_ENABLED` | No | true | `false` | Set to "false" to disable the Prometheus /metrics endpoint. |
| `OTEL_ENABLED` | No | false | `true` | Set to "true" to enable the in-process tracing middleware. |
| `OTEL_SDK_DISABLED` | No | false | `true` | Set to "true" to skip OpenTelemetry SDK instrumentation (always skipped when NODE_ENV=test). |
| `OTEL_DEBUG` | No | false | `true` | Set to "true" for verbose OpenTelemetry diagnostics. |
| `OTEL_SERVICE_NAME` | No | nova-launch-backend | `nova-launch-backend` | Service name attached to traces. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | http://localhost:4318 | `http://otel-collector:4318` | OTLP collector endpoint. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | No | http://localhost:4318/v1/traces | `http://otel-collector:4318/v1/traces` | OTLP traces endpoint; used when OTEL_EXPORTER_OTLP_ENDPOINT is unset. |
| `SENTRY_DSN` 🔒 | No | — | _secret_ | Sentry DSN for error tracking (also loadable from Vault). |

## Vault

| Variable | Required | Default | Example | Description |
|---|---|---|---|---|
| `VAULT_ADDR` | No | http://127.0.0.1:8200 | `https://vault.internal:8200` | HashiCorp Vault server address. |
| `VAULT_ROLE_ID` 🔒 | No | — | _secret_ | Vault AppRole role ID. Vault is skipped when unset. |
| `VAULT_SECRET_ID` 🔒 | No | — | _secret_ | Vault AppRole secret ID. |
| `VAULT_MOUNT_PATH` | No | nova | `nova` | KV mount path that holds backend secrets. |
| `VAULT_CACHE_TTL_MS` | No | 300000 | `300000` | How long secrets fetched from Vault are cached. |

## Example `.env`

Every required variable for a deployed environment (all others use their defaults).
Replace each `<set-me>` with a value from your secret store:

```env
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
FACTORY_CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+15550001234
DATABASE_URL=<set-me>
JWT_SECRET=<set-me>
ADMIN_JWT_SECRET=<set-me>
PINATA_API_KEY=<set-me>
PINATA_API_SECRET=<set-me>
SENDGRID_API_KEY=<set-me>
TWILIO_AUTH_TOKEN=<set-me>
```
