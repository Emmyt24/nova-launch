# Webhook Retry & Dead-Letter Integration Tests

Issue: #2212 · Suite: `backend/src/__tests__/webhook-retry-deadletter.integration.test.ts`

End-to-end coverage of what happens when a webhook receiver keeps failing:
retries with exponential backoff, exhaustion, the handoff to the dead-letter
queue (DLQ), and redelivery from the DLQ through the admin API.

## Running

```bash
cd backend
npm run test:webhook-dlq
```

It runs as a blocking step ("Webhook retry and dead-letter integration tests")
in the `Test & Lint` job of `.github/workflows/backend-ci.yml`. The suite
needs no Postgres or Redis and finishes in a few seconds.

## How it is wired

| Piece | Real or stubbed |
|---|---|
| Mock receiver | Real `node:http` server on an ephemeral port, scripted per path (status codes or `"drop"` to destroy the socket) |
| `WebhookDeliveryService` retry loop | Real |
| `WebhookDeadLetterService` | Real, over an in-memory `webhook_dead_letters` table (the `database/db` driver is stubbed; unexpected SQL fails the test) |
| Admin DLQ router (`/api/webhooks/dead-letter`) | Real, mounted in Express and called via supertest; auth and audit middleware are pass-through |
| Subscription store / delivery log | Stubbed on `webhookService` |

Retry settings are pinned in `vi.hoisted` before any import:
`WEBHOOK_MAX_RETRIES=4`, `WEBHOOK_RETRY_DELAY_MS=20`,
`WEBHOOK_DLQ_MAX_REQUEUE_CYCLES=2`.

## What is verified

**Backoff schedule.** Every backoff the service requests is recorded (and
still awaited for real). For 4 attempts the schedule must be exactly
`[20, 40, 80]` ms (`base · 2^(attempt-1)`, no wait after the last attempt),
and the gaps between arrivals at the receiver must be at least those delays.

**Retry semantics.**
- 5xx and dropped connections are retried up to the limit.
- A receiver that recovers stops the retries and nothing is dead-lettered.
- Non-retryable 4xx responses stop after one attempt and are not dead-lettered.
- Every attempt carries the same signed payload and correlation ID, and the
  signature verifies against the subscription secret.

**Dead-letter entry.** Exhaustion stores exactly one entry with the
subscription, event, final status code (`null` for network failures), last
error, attempt count and the exact payload that was delivered. The delivery
log gets one failed record with the final attempt count.

**Redelivery.**
- `POST /:id/retry` redelivers the original event data, freshly signed, with
  a new attempt counter, and marks the entry `retried`.
- A redelivery that fails again returns `502 DELIVERY_FAILED`, leaves the
  original entry unresolved and dead-letters a new entry.
- Resolved entries return `409 ALREADY_RESOLVED`; unknown IDs return `404`.
- `POST /:id/requeue` increments `requeue_count` and redelivers. After
  `WEBHOOK_DLQ_MAX_REQUEUE_CYCLES` it returns `409 POISON_MESSAGE` without
  calling the receiver.

## Related

- [WEBHOOK_DELIVERY_LOG.md](./WEBHOOK_DELIVERY_LOG.md)
- [RETRY_BACKOFF_GUIDE.md](./RETRY_BACKOFF_GUIDE.md)
