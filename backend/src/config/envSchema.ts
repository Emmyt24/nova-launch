/**
 * Environment variable catalog — the single documented schema of every
 * environment variable the backend reads.
 *
 * `scripts/generate-env-docs.ts` renders this catalog into
 * `docs/ENVIRONMENT.md`; CI fails when the committed file is stale. The
 * `envSchema.test.ts` suite keeps the catalog honest: every `process.env.X`
 * read under `src/` must be listed here, every entry must still be read, and
 * required flags must agree with `startupValidation.ts`'s manifest.
 *
 * Adding a variable: add an entry below, then run `npm run docs:env`.
 *
 * Issue: #2211
 */

export type EnvRequirement =
  /** `validateEnv()` (src/config/env.ts) throws when unset with NODE_ENV=production. */
  | "production"
  /** Listed as required in the deployment manifest (`REQUIRED_SCHEMAS` in startupValidation.ts). */
  | "manifest"
  /** Optional — a default or graceful fallback applies. */
  | "optional";

export interface EnvVarSpec {
  name: string;
  group: EnvGroup;
  description: string;
  required: EnvRequirement;
  /** Default applied when unset, as documentation text. Omit when there is none. */
  default?: string;
  /** Example value. Never a real secret. */
  example?: string;
  /** Value is a credential — must come from a secret store, never committed. */
  secret?: boolean;
}

export const ENV_GROUPS = [
  "Core",
  "Stellar",
  "Database",
  "Auth",
  "Redis",
  "HTTP & Rate Limiting",
  "GraphQL",
  "IPFS / Pinata",
  "Notifications",
  "Webhooks",
  "Background Jobs",
  "Backups & Audit",
  "Observability",
  "Vault",
] as const;

export type EnvGroup = (typeof ENV_GROUPS)[number];

export const ENV_SCHEMA: readonly EnvVarSpec[] = [
  // ── Core ──────────────────────────────────────────────────────────────────
  {
    name: "NODE_ENV",
    group: "Core",
    description:
      'Runtime environment. Only "production" changes validation behaviour; "test" disables tracing and some external calls.',
    required: "optional",
    default: "development",
    example: "production",
  },
  {
    name: "PORT",
    group: "Core",
    description: "HTTP port the API listens on (integer 1–65535).",
    required: "optional",
    default: "3001",
    example: "3001",
  },
  {
    name: "BACKEND_VERSION",
    group: "Core",
    description: "Version string reported by GET /api/version.",
    required: "optional",
    default: "0.0.0",
    example: "1.4.2",
  },
  {
    name: "FRONTEND_URL",
    group: "Core",
    description: "Origin allowed by CORS for the frontend.",
    required: "optional",
    default: "http://localhost:5173",
    example: "https://app.nova-launch.app",
  },

  // ── Stellar ───────────────────────────────────────────────────────────────
  {
    name: "STELLAR_NETWORK",
    group: "Stellar",
    description:
      'Stellar network: "testnet" or "mainnet". Selects defaults for the Horizon/RPC URLs and passphrase.',
    required: "manifest",
    default: "testnet",
    example: "testnet",
  },
  {
    name: "STELLAR_HORIZON_URL",
    group: "Stellar",
    description: "Horizon REST endpoint.",
    required: "manifest",
    default:
      "Derived from STELLAR_NETWORK (https://horizon-testnet.stellar.org on testnet)",
    example: "https://horizon-testnet.stellar.org",
  },
  {
    name: "STELLAR_SOROBAN_RPC_URL",
    group: "Stellar",
    description: "Soroban RPC endpoint.",
    required: "manifest",
    default:
      "Derived from STELLAR_NETWORK (https://soroban-testnet.stellar.org on testnet)",
    example: "https://soroban-testnet.stellar.org",
  },
  {
    name: "SOROBAN_RPC_URL",
    group: "Stellar",
    description:
      "Legacy alias read by the on-chain projection verifier before STELLAR_SOROBAN_RPC_URL.",
    required: "optional",
    example: "https://soroban-testnet.stellar.org",
  },
  {
    name: "STELLAR_NETWORK_PASSPHRASE",
    group: "Stellar",
    description: "Network passphrase; must match STELLAR_NETWORK.",
    required: "manifest",
    default: "Derived from STELLAR_NETWORK",
    example: "Test SDF Network ; September 2015",
  },
  {
    name: "FACTORY_CONTRACT_ID",
    group: "Stellar",
    description:
      'Soroban token factory contract ID (56 chars, starts with "C"). A malformed value always fails startup.',
    required: "production",
    default: "empty (non-production only)",
    example: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  {
    name: "STELLAR_CURSOR_ORIGIN",
    group: "Stellar",
    description:
      "Paging-token origin the event listener and replay service resume from when no cursor is stored.",
    required: "optional",
    example: "now",
  },
  {
    name: "MAX_CATCHUP_LEDGERS",
    group: "Stellar",
    description:
      "Maximum ledgers the event listener replays on catch-up after downtime.",
    required: "optional",
    default: "1000",
    example: "1000",
  },
  {
    name: "STELLAR_FEE_BUMP_SPONSOR_ACCOUNT",
    group: "Stellar",
    description: "Account that sponsors fee-bump transactions.",
    required: "optional",
    default: "empty (fee bumps disabled)",
    example: "GABC...SPONSOR",
  },
  {
    name: "STELLAR_FEE_BUMP_THRESHOLD_XLM",
    group: "Stellar",
    description: "Sponsor balance (XLM) below which fee-bump alerts fire.",
    required: "optional",
    default: "1.0",
    example: "5.0",
  },
  {
    name: "FEE_BUMP_PENDING_THRESHOLD_MS",
    group: "Stellar",
    description: "Time a transaction may stay pending before it is fee-bumped.",
    required: "optional",
    default: "60000",
    example: "60000",
  },

  // ── Database ──────────────────────────────────────────────────────────────
  {
    name: "DATABASE_URL",
    group: "Database",
    description:
      "PostgreSQL connection URL used by Prisma and the pooled client.",
    required: "production",
    default:
      "postgresql://postgres:postgres@localhost:5432/postgres?schema=public (non-production only)",
    example: "postgresql://user:password@localhost:5432/nova_launch",
    secret: true,
  },
  {
    name: "DB_HOST",
    group: "Database",
    description: "Host for the legacy pg client (src/database/db.ts).",
    required: "optional",
    default: "localhost",
    example: "db.internal",
  },
  {
    name: "DB_PORT",
    group: "Database",
    description: "Port for the legacy pg client.",
    required: "optional",
    default: "5432",
    example: "5432",
  },
  {
    name: "DB_NAME",
    group: "Database",
    description: "Database name for the legacy pg client.",
    required: "optional",
    default: "nova_launch",
    example: "nova_launch",
  },
  {
    name: "DB_USER",
    group: "Database",
    description: "User for the legacy pg client.",
    required: "optional",
    default: "user",
    example: "nova_user",
  },
  {
    name: "DB_PASSWORD",
    group: "Database",
    description: "Password for the legacy pg client.",
    required: "optional",
    default: "password",
    secret: true,
  },
  {
    name: "DB_POOL_MIN",
    group: "Database",
    description: "Minimum pooled connections.",
    required: "optional",
    default: "2",
    example: "2",
  },
  {
    name: "DB_POOL_MAX",
    group: "Database",
    description: "Maximum pooled connections.",
    required: "optional",
    default: "10",
    example: "20",
  },
  {
    name: "DB_POOL_SIZE",
    group: "Database",
    description: "Pool size reported by the pool-saturation metrics.",
    required: "optional",
    default: "10",
    example: "20",
  },
  {
    name: "DB_CONNECT_TIMEOUT_MS",
    group: "Database",
    description: "Connection acquisition timeout.",
    required: "optional",
    default: "5000",
    example: "5000",
  },
  {
    name: "DB_IDLE_TIMEOUT_MS",
    group: "Database",
    description: "Idle connection eviction timeout.",
    required: "optional",
    default: "30000",
    example: "30000",
  },

  // ── Auth ──────────────────────────────────────────────────────────────────
  {
    name: "JWT_SECRET",
    group: "Auth",
    description:
      "Secret used to sign and verify user JWTs. Publicly known placeholders are rejected in production.",
    required: "production",
    default: "dev-secret-key-change-me (non-production only)",
    secret: true,
  },
  {
    name: "ADMIN_JWT_SECRET",
    group: "Auth",
    description:
      "Secret used to sign and verify admin JWTs. Publicly known placeholders are rejected in production.",
    required: "production",
    default: "dev-admin-secret-key-change-me (non-production only)",
    secret: true,
  },
  {
    name: "JWT_ACCESS_SECRET",
    group: "Auth",
    description: "Secret for WebSocket access tokens.",
    required: "optional",
    default: "Falls back to JWT_SECRET",
    secret: true,
  },

  // ── Redis ─────────────────────────────────────────────────────────────────
  {
    name: "REDIS_URL",
    group: "Redis",
    description:
      "Redis connection URL (rate limiter, webhook limits, token store).",
    required: "optional",
    default: "redis://localhost:6379",
    example: "redis://redis:6379",
  },
  {
    name: "REDIS_HOST",
    group: "Redis",
    description:
      "Redis host for the auth nonce/token services when REDIS_URL is unset.",
    required: "optional",
    default: "localhost",
    example: "redis",
  },
  {
    name: "REDIS_PORT",
    group: "Redis",
    description: "Redis port for the auth nonce/token services.",
    required: "optional",
    default: "6379",
    example: "6379",
  },
  {
    name: "REDIS_PASSWORD",
    group: "Redis",
    description: "Redis password for the auth nonce/token services.",
    required: "optional",
    secret: true,
  },

  // ── HTTP & Rate Limiting ──────────────────────────────────────────────────
  {
    name: "REQUEST_TIMEOUT_MS",
    group: "HTTP & Rate Limiting",
    description: "Per-request timeout enforced by the timeout middleware.",
    required: "optional",
    default: "30000",
    example: "30000",
  },
  {
    name: "RATE_LIMIT_WINDOW_MS",
    group: "HTTP & Rate Limiting",
    description: "Distributed rate-limit window.",
    required: "optional",
    default: "900000",
    example: "900000",
  },
  {
    name: "RATE_LIMIT_MAX_REQUESTS",
    group: "HTTP & Rate Limiting",
    description: "Requests allowed per client per window.",
    required: "optional",
    default: "100",
    example: "100",
  },
  {
    name: "TRUSTED_PROXY_IPS",
    group: "HTTP & Rate Limiting",
    description:
      "Comma-separated proxy IPs whose X-Forwarded-For is trusted for client IP resolution.",
    required: "optional",
    default: "empty (no proxies trusted)",
    example: "10.0.0.1,10.0.0.2",
  },
  {
    name: "HEALTH_DETAIL_ENABLED",
    group: "HTTP & Rate Limiting",
    description:
      'Set to "true" to expose dependency details on the health endpoint.',
    required: "optional",
    default: "false",
    example: "true",
  },
  {
    name: "DEPLOY_STATUS_STREAM_INTERVAL_MS",
    group: "HTTP & Rate Limiting",
    description:
      "Poll interval for the deploy-status SSE stream (minimum 500).",
    required: "optional",
    default: "3000",
    example: "3000",
  },
  {
    name: "DISCOVERY_AGGREGATION_TIMEOUT_MS",
    group: "HTTP & Rate Limiting",
    description: "Timeout for the discovery endpoint's aggregation queries.",
    required: "optional",
    default: "5000",
    example: "5000",
  },

  // ── GraphQL ───────────────────────────────────────────────────────────────
  {
    name: "GRAPHQL_MAX_DEPTH",
    group: "GraphQL",
    description:
      "Maximum query depth; malformed values fall back to the default.",
    required: "optional",
    default: "6",
    example: "6",
  },
  {
    name: "GRAPHQL_MAX_COMPLEXITY",
    group: "GraphQL",
    description: "Maximum query complexity score.",
    required: "optional",
    default: "100",
    example: "100",
  },
  {
    name: "GRAPHQL_LIST_FIELD_COST",
    group: "GraphQL",
    description: "Complexity cost charged per list field.",
    required: "optional",
    default: "10",
    example: "10",
  },
  {
    name: "GRAPHQL_MAX_SUBSCRIPTIONS_PER_CONNECTION",
    group: "GraphQL",
    description: "Concurrent subscriptions allowed per WebSocket connection.",
    required: "optional",
    default: "10",
    example: "10",
  },
  {
    name: "GRAPHQL_SUBSCRIPTION_QUEUE_DEPTH",
    group: "GraphQL",
    description:
      "Buffered events per subscription before the slowest are dropped.",
    required: "optional",
    default: "1000",
    example: "1000",
  },

  // ── IPFS / Pinata ─────────────────────────────────────────────────────────
  {
    name: "PINATA_API_KEY",
    group: "IPFS / Pinata",
    description: "Pinata API key for pinning token metadata.",
    required: "manifest",
    secret: true,
  },
  {
    name: "PINATA_API_SECRET",
    group: "IPFS / Pinata",
    description: "Pinata API secret.",
    required: "manifest",
    secret: true,
  },
  {
    name: "PINATA_API_KEY_NEXT",
    group: "IPFS / Pinata",
    description: "Next Pinata API key, used during zero-downtime key rotation.",
    required: "optional",
    secret: true,
  },
  {
    name: "PINATA_API_SECRET_NEXT",
    group: "IPFS / Pinata",
    description: "Next Pinata API secret, used during key rotation.",
    required: "optional",
    secret: true,
  },
  {
    name: "PINATA_GATEWAY_URL",
    group: "IPFS / Pinata",
    description: "Primary IPFS gateway.",
    required: "optional",
    default: "https://gateway.pinata.cloud/ipfs",
    example: "https://gateway.pinata.cloud/ipfs",
  },
  {
    name: "CLOUDFLARE_IPFS_GATEWAY",
    group: "IPFS / Pinata",
    description: "Secondary IPFS gateway.",
    required: "optional",
    default: "https://cloudflare-ipfs.com/ipfs",
    example: "https://cloudflare-ipfs.com/ipfs",
  },
  {
    name: "PUBLIC_IPFS_GATEWAY",
    group: "IPFS / Pinata",
    description: "Last-resort public IPFS gateway.",
    required: "optional",
    default: "https://ipfs.io/ipfs",
    example: "https://ipfs.io/ipfs",
  },
  {
    name: "IPFS_VERIFY_CID",
    group: "IPFS / Pinata",
    description: 'Set to "true" to re-fetch and verify CIDs after pinning.',
    required: "optional",
    default: "false",
    example: "true",
  },
  {
    name: "IPFS_VERIFY_GATEWAY_URL",
    group: "IPFS / Pinata",
    description: "Gateway used for CID verification.",
    required: "optional",
    default: "https://gateway.pinata.cloud/ipfs",
    example: "https://gateway.pinata.cloud/ipfs",
  },
  {
    name: "PINATA_RPS",
    group: "IPFS / Pinata",
    description: "Pinata request queue rate (requests per second).",
    required: "optional",
    default: "5",
    example: "5",
  },
  {
    name: "PINATA_MAX_BURST",
    group: "IPFS / Pinata",
    description: "Pinata request queue burst size.",
    required: "optional",
    default: "10",
    example: "10",
  },
  {
    name: "PINATA_MAX_CONCURRENT",
    group: "IPFS / Pinata",
    description: "Concurrent in-flight Pinata requests.",
    required: "optional",
    default: "3",
    example: "3",
  },
  {
    name: "PINATA_MAX_RETRIES_429",
    group: "IPFS / Pinata",
    description: "Retries after Pinata 429 responses.",
    required: "optional",
    default: "5",
    example: "5",
  },
  {
    name: "PINATA_RETRY_BASE_MS",
    group: "IPFS / Pinata",
    description: "Base backoff for Pinata retries.",
    required: "optional",
    default: "1000",
    example: "1000",
  },
  {
    name: "PINATA_RETRY_CAP_MS",
    group: "IPFS / Pinata",
    description: "Maximum backoff for Pinata retries.",
    required: "optional",
    default: "60000",
    example: "60000",
  },
  {
    name: "PIN_MONITOR_INTERVAL_MS",
    group: "IPFS / Pinata",
    description: "Interval of the pin-health monitor.",
    required: "optional",
    default: "300000",
    example: "300000",
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  {
    name: "SENDGRID_API_KEY",
    group: "Notifications",
    description:
      "SendGrid API key. When set, NOTIFICATION_EMAIL_API_URL is ignored.",
    required: "manifest",
    example: "SG.xxxxxxxx",
    secret: true,
  },
  {
    name: "NOTIFICATION_FROM_EMAIL",
    group: "Notifications",
    description: "Sender address for notification emails.",
    required: "optional",
    default: "noreply@nova-launch.app",
    example: "noreply@your-domain.com",
  },
  {
    name: "NOTIFICATION_EMAIL_API_URL",
    group: "Notifications",
    description:
      "Legacy generic HTTP email provider; used only when SENDGRID_API_KEY is unset.",
    required: "optional",
    example: "https://your-email-provider.com/send",
  },
  {
    name: "NOTIFICATION_EMAIL_API_KEY",
    group: "Notifications",
    description: "Bearer token for the legacy email provider.",
    required: "optional",
    secret: true,
  },
  {
    name: "TWILIO_ACCOUNT_SID",
    group: "Notifications",
    description: 'Twilio account SID (must start with "AC").',
    required: "manifest",
    example: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  {
    name: "TWILIO_AUTH_TOKEN",
    group: "Notifications",
    description: "Twilio auth token.",
    required: "manifest",
    secret: true,
  },
  {
    name: "TWILIO_PHONE_NUMBER",
    group: "Notifications",
    description: "Twilio sender phone number (E.164).",
    required: "manifest",
    example: "+15550001234",
  },
  {
    name: "NOTIFICATION_SMS_API_URL",
    group: "Notifications",
    description:
      "Legacy generic HTTP SMS provider; used only when Twilio is not configured.",
    required: "optional",
    example: "https://your-sms-provider.com/send",
  },
  {
    name: "NOTIFICATION_SMS_API_KEY",
    group: "Notifications",
    description: "Bearer token for the legacy SMS provider.",
    required: "optional",
    secret: true,
  },
  {
    name: "MAX_RETRIES",
    group: "Notifications",
    description: "Notification delivery attempts, including the first.",
    required: "optional",
    default: "3",
    example: "3",
  },
  {
    name: "NOTIFICATION_RATE_LIMIT_WINDOW_MS",
    group: "Notifications",
    description: "One notification per recipient per event within this window.",
    required: "optional",
    default: "3600000",
    example: "3600000",
  },
  {
    name: "PAGERDUTY_ROUTING_KEY",
    group: "Notifications",
    description: "PagerDuty Events v2 routing key for incident alerts.",
    required: "optional",
    default: "empty (paging disabled)",
    secret: true,
  },

  // ── Webhooks ──────────────────────────────────────────────────────────────
  {
    name: "WEBHOOK_TIMEOUT_MS",
    group: "Webhooks",
    description: "Per-attempt HTTP timeout for webhook delivery.",
    required: "optional",
    default: "5000",
    example: "5000",
  },
  {
    name: "WEBHOOK_MAX_RETRIES",
    group: "Webhooks",
    description: "Delivery attempts before a webhook is dead-lettered.",
    required: "optional",
    default: "3",
    example: "3",
  },
  {
    name: "WEBHOOK_RETRY_DELAY_MS",
    group: "Webhooks",
    description: "Base delay of the delivery backoff (doubles each attempt).",
    required: "optional",
    default: "1000",
    example: "1000",
  },
  {
    name: "WEBHOOK_WORKER_CONCURRENCY",
    group: "Webhooks",
    description:
      "Concurrent deliveries in the webhook worker pool (integer ≥ 1).",
    required: "optional",
    default: "10",
    example: "10",
  },
  {
    name: "WEBHOOK_COMPRESSION_THRESHOLD_BYTES",
    group: "Webhooks",
    description: "Payloads at least this large are gzip-compressed.",
    required: "optional",
    default: "1024",
    example: "1024",
  },
  {
    name: "WEBHOOK_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
    group: "Webhooks",
    description: "Consecutive failures that open the delivery circuit breaker.",
    required: "optional",
    default: "5",
    example: "5",
  },
  {
    name: "WEBHOOK_CIRCUIT_BREAKER_SUCCESS_THRESHOLD",
    group: "Webhooks",
    description: "Successes in half-open state that close the circuit breaker.",
    required: "optional",
    default: "2",
    example: "2",
  },
  {
    name: "WEBHOOK_CIRCUIT_BREAKER_TIMEOUT_MS",
    group: "Webhooks",
    description: "Time the circuit breaker stays open before half-opening.",
    required: "optional",
    default: "60000",
    example: "60000",
  },
  {
    name: "WEBHOOK_TENANT_RATE_LIMIT_MAX",
    group: "Webhooks",
    description: "Deliveries per tenant per sliding window (Redis ceiling).",
    required: "optional",
    default: "60",
    example: "60",
  },
  {
    name: "WEBHOOK_TENANT_RATE_LIMIT_WINDOW_MS",
    group: "Webhooks",
    description: "Sliding window for WEBHOOK_TENANT_RATE_LIMIT_MAX.",
    required: "optional",
    default: "60000",
    example: "60000",
  },
  {
    name: "WEBHOOK_RATE_LIMIT_PER_MINUTE",
    group: "Webhooks",
    description: "Per-tenant token-bucket refill rate.",
    required: "optional",
    default: "100",
    example: "100",
  },
  {
    name: "WEBHOOK_RATE_LIMIT_BURST",
    group: "Webhooks",
    description: "Per-tenant token-bucket capacity.",
    required: "optional",
    default: "20",
    example: "20",
  },
  {
    name: "WEBHOOK_DLQ_MAX_REQUEUE_CYCLES",
    group: "Webhooks",
    description:
      "Requeues allowed per dead-letter entry before the poison-message guard blocks it.",
    required: "optional",
    default: "3",
    example: "3",
  },
  {
    name: "WEBHOOK_MAX_ATTEMPTS",
    group: "Webhooks",
    description:
      "Attempts for the WebhookRetryService engine (notification webhooks).",
    required: "optional",
    default: "5",
    example: "5",
  },
  {
    name: "WEBHOOK_BASE_DELAY_MS",
    group: "Webhooks",
    description: "Base delay for the WebhookRetryService engine.",
    required: "optional",
    default: "1000",
    example: "1000",
  },
  {
    name: "WEBHOOK_BACKOFF_MULTIPLIER",
    group: "Webhooks",
    description: "Backoff multiplier for the WebhookRetryService engine.",
    required: "optional",
    default: "2",
    example: "2",
  },
  {
    name: "WEBHOOK_MAX_DELAY_MS",
    group: "Webhooks",
    description: "Backoff cap for the WebhookRetryService engine.",
    required: "optional",
    default: "30000",
    example: "30000",
  },
  {
    name: "WEBHOOK_JITTER",
    group: "Webhooks",
    description:
      'Set to "false" to disable ±25 % backoff jitter in WebhookRetryService.',
    required: "optional",
    default: "true",
    example: "false",
  },

  // ── Background Jobs ───────────────────────────────────────────────────────
  {
    name: "ENABLE_EVENT_LISTENER",
    group: "Background Jobs",
    description: 'Set to "true" to start the Stellar event listener on boot.',
    required: "optional",
    default: "false",
    example: "true",
  },
  {
    name: "ENABLE_STREAM_RECONCILIATION",
    group: "Background Jobs",
    description: 'Set to "true" to run periodic stream reconciliation.',
    required: "optional",
    default: "false",
    example: "true",
  },
  {
    name: "STREAM_RECONCILIATION_INTERVAL_MS",
    group: "Background Jobs",
    description: "Interval between stream reconciliation runs.",
    required: "optional",
    default: "300000",
    example: "300000",
  },
  {
    name: "ENABLE_PROJECTION_SNAPSHOTS",
    group: "Background Jobs",
    description: 'Set to "true" to run the projection snapshot job.',
    required: "optional",
    default: "false",
    example: "true",
  },
  {
    name: "PROJECTION_SNAPSHOT_INTERVAL_MS",
    group: "Background Jobs",
    description: "Interval between projection snapshots.",
    required: "optional",
    default: "1800000",
    example: "1800000",
  },
  {
    name: "JOB_QUEUE_CONCURRENCY",
    group: "Background Jobs",
    description: "Jobs processed concurrently by the job queue.",
    required: "optional",
    default: "2",
    example: "4",
  },
  {
    name: "JOB_QUEUE_FAIRNESS_STREAK",
    group: "Background Jobs",
    description:
      "Consecutive high-priority jobs before a lower-priority job is scheduled.",
    required: "optional",
    default: "5",
    example: "5",
  },
  {
    name: "JOB_QUEUE_STUCK_THRESHOLD_MS",
    group: "Background Jobs",
    description: "Running time after which a job is reported as stuck.",
    required: "optional",
    default: "900000",
    example: "900000",
  },

  // ── Backups & Audit ───────────────────────────────────────────────────────
  {
    name: "BACKUP_STORAGE_PATH",
    group: "Backups & Audit",
    description: "Directory for PITR backups and audit-archive checkpoints.",
    required: "optional",
    default: "/var/backups/nova/pitr",
    example: "/var/backups/nova/pitr",
  },
  {
    name: "AUDIT_RETENTION_DAYS",
    group: "Backups & Audit",
    description: "Audit log rows older than this are archived and pruned.",
    required: "optional",
    default: "90",
    example: "365",
  },
  {
    name: "AUDIT_RETENTION_INTERVAL_MS",
    group: "Backups & Audit",
    description: "Interval of the audit retention job.",
    required: "optional",
    default: "3600000",
    example: "3600000",
  },

  // ── Observability ─────────────────────────────────────────────────────────
  {
    name: "METRICS_ENABLED",
    group: "Observability",
    description: 'Set to "false" to disable the Prometheus /metrics endpoint.',
    required: "optional",
    default: "true",
    example: "false",
  },
  {
    name: "OTEL_ENABLED",
    group: "Observability",
    description: 'Set to "true" to enable the in-process tracing middleware.',
    required: "optional",
    default: "false",
    example: "true",
  },
  {
    name: "OTEL_SDK_DISABLED",
    group: "Observability",
    description:
      'Set to "true" to skip OpenTelemetry SDK instrumentation (always skipped when NODE_ENV=test).',
    required: "optional",
    default: "false",
    example: "true",
  },
  {
    name: "OTEL_DEBUG",
    group: "Observability",
    description: 'Set to "true" for verbose OpenTelemetry diagnostics.',
    required: "optional",
    default: "false",
    example: "true",
  },
  {
    name: "OTEL_SERVICE_NAME",
    group: "Observability",
    description: "Service name attached to traces.",
    required: "optional",
    default: "nova-launch-backend",
    example: "nova-launch-backend",
  },
  {
    name: "OTEL_EXPORTER_OTLP_ENDPOINT",
    group: "Observability",
    description: "OTLP collector endpoint.",
    required: "optional",
    default: "http://localhost:4318",
    example: "http://otel-collector:4318",
  },
  {
    name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    group: "Observability",
    description:
      "OTLP traces endpoint; used when OTEL_EXPORTER_OTLP_ENDPOINT is unset.",
    required: "optional",
    default: "http://localhost:4318/v1/traces",
    example: "http://otel-collector:4318/v1/traces",
  },
  {
    name: "SENTRY_DSN",
    group: "Observability",
    description: "Sentry DSN for error tracking (also loadable from Vault).",
    required: "optional",
    secret: true,
  },

  // ── Vault ─────────────────────────────────────────────────────────────────
  {
    name: "VAULT_ADDR",
    group: "Vault",
    description: "HashiCorp Vault server address.",
    required: "optional",
    default: "http://127.0.0.1:8200",
    example: "https://vault.internal:8200",
  },
  {
    name: "VAULT_ROLE_ID",
    group: "Vault",
    description: "Vault AppRole role ID. Vault is skipped when unset.",
    required: "optional",
    secret: true,
  },
  {
    name: "VAULT_SECRET_ID",
    group: "Vault",
    description: "Vault AppRole secret ID.",
    required: "optional",
    secret: true,
  },
  {
    name: "VAULT_MOUNT_PATH",
    group: "Vault",
    description: "KV mount path that holds backend secrets.",
    required: "optional",
    default: "nova",
    example: "nova",
  },
  {
    name: "VAULT_CACHE_TTL_MS",
    group: "Vault",
    description: "How long secrets fetched from Vault are cached.",
    required: "optional",
    default: "300000",
    example: "300000",
  },
];
