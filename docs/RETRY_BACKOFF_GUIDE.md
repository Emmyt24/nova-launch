# Retry / Backoff Implementations

The backend has **three independent retry/backoff implementations** that coexist
because each targets a distinct integration boundary with different failure
modes, tuning requirements, and ownership models.

---

## Quick reference

| Implementation | File | Use case | Jitter strategy | Non-retryable guard |
|---|---|---|---|---|
| `WebhookRetryService` | `src/services/webhookRetry.ts` | Outbound webhook delivery to tenant endpoints | ±25 % uniform jitter | Explicit list (`WEBHOOK_*` env vars) |
| `OutboundHttpClient.execute` | `src/lib/outboundHttpClient.ts` | Generic service-to-service HTTP calls | Additive jitter ∈ [0, baseDelay) | Any 4xx status |
| `ListenerBackoffState` / `calculateReconnectDelay` | `src/services/listenerBackoff.ts` | Stellar event-listener reconnect loop | Full-range jitter ±25 % of base | N/A — always reconnects |

---

## Why three separate implementations?

### 1. `WebhookRetryService` — webhook delivery (`src/services/webhookRetry.ts`)

Webhook delivery to **external, tenant-owned endpoints** is fundamentally
different from internal service calls:

- Tenants configure their own endpoints; some are flaky, some rate-limit
  aggressively, some return misleading status codes.
- The operator needs to tune all retry parameters (max attempts, delays,
  non-retryable codes) via environment variables (`WEBHOOK_MAX_ATTEMPTS`,
  `WEBHOOK_BASE_DELAY_MS`, `WEBHOOK_BACKOFF_MULTIPLIER`, `WEBHOOK_MAX_DELAY_MS`,
  `WEBHOOK_JITTER`) without redeploying.
- The jitter strategy (±25 % uniform) is deliberately conservative to avoid
  flooding slow tenant endpoints with burst retries.
- Non-retryable status codes are an explicit allowlist (`nonRetryableStatuses`)
  because webhook consumer behaviour is less predictable than internal services.

**Use this when:** delivering webhooks. Do not use it for internal calls.

### 2. `OutboundHttpClient.execute` — generic service-to-service HTTP (`src/lib/outboundHttpClient.ts`)

Internal service-to-service calls (e.g. Horizon API, IPFS gateway, Pinata)
have a shared concern not present in webhooks: **circuit-breaker protection**.
`OutboundHttpClient` bundles retry *and* circuit-breaker in a single unit so
that a flapping downstream can't cascade failures into the backend.

- Retry is intentionally simpler: 3 attempts by default, shorter delays.
- Jitter is additive noise `∈ [0, baseDelayMs)` — lighter than webhook jitter
  because internal services recover quickly.
- Non-retryable guard is a single rule: any 4xx client error is the caller's
  fault; retrying won't help.
- One `OutboundHttpClient` instance per external service is intended for
  process-lifetime reuse; its circuit-breaker state is shared across callers
  and is visible in `/health/detailed`.

**Use this when:** making outbound HTTP calls to external APIs or internal
microservices from any service or route handler.

### 3. `ListenerBackoffState` / `calculateReconnectDelay` — Stellar listener reconnect (`src/services/listenerBackoff.ts`)

The Stellar event-listener reconnect loop operates on a **long-running
connection** (not a request/response pair), so circuit-breaking and
non-retryable detection don't apply — the listener should always attempt to
reconnect until told to shut down. Its unique requirements are:

- Very long maximum delay (up to 5 minutes) to avoid hammering the Stellar RPC
  during prolonged network partitions.
- A **health-reset threshold**: after N consecutive successes the attempt
  counter resets to zero, preventing the delay from drifting permanently
  after a short outage.
- Full-range jitter (`±25 % * base`) prevents a fleet of backends all
  reconnecting at the same moment after a shared outage (thundering herd).
- `maxRetries` cap exists but the outer reconnect loop is responsible for
  respecting it; `ListenerBackoffState` itself only tracks state.

**Use this when:** implementing a persistent streaming/subscription connection
that needs reconnect management. Do not use it for request/response retries.

---

## Which implementation should a new outbound integration use?

**In almost all cases: `OutboundHttpClient`** (`src/lib/outboundHttpClient.ts`).

- Instantiate one client per external service and reuse it for the process
  lifetime. This ensures circuit-breaker state is shared across all callers.
- Pass `serviceName` matching the service identifier used in logs and
  `/health/detailed` (e.g. `"horizon"`, `"pinata"`).
- Override `retry` and `circuitBreaker` options as needed for the specific
  service's SLA.

A **fourth implementation should only be added** if the new integration has
requirements that none of the three existing ones can satisfy — for example, a
binary streaming protocol where HTTP status codes don't apply. If you add one,
update this document and add a cross-reference comment in the new file pointing
here.

---

## Cross-references

Each of the three source files contains a cross-reference comment pointing to
this document. If you rename or move a file, update those comments and the
table above.
