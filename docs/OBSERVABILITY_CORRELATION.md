# Observability & Correlation ID Strategy

## Overview

Nova Launch uses correlation IDs to trace multi-hop operations across the
frontend, backend ingestion layer, and webhook delivery.

## ID Hierarchy

| ID | Source | Scope |
|----|--------|-------|
| `correlationId` | Frontend (`generateCorrelationId()`) | Entire user operation (wallet action → tx → webhook) |
| `txHash` | Stellar network (post-submission) | Primary chain key; preferred once available |
| `requestId` | Backend middleware (`x-request-id`) | Single HTTP request |

## Flow

```
Frontend                Backend                  Webhook Receiver
   │                       │                           │
   │  generateCorrelationId()                          │
   │──X-Correlation-Id:cid─▶                           │
   │                       │ log {correlationId, path} │
   │                       │                           │
   │  tx submitted → txHash                            │
   │  logIntegrationEvent(txHash, correlationId)       │
   │                       │                           │
   │                       │──X-Correlation-Id:cid────▶│
   │                       │──X-Tx-Hash:txHash────────▶│
```

## Rules

- **Never log** signed XDR blobs, secrets, mnemonics, or private keys.
- **Prefer `txHash`** as the primary correlation key after submission.
- **Before submission**, use `correlationId` to link wallet action → backend receipt.
- Correlation IDs are propagated via HTTP headers (`X-Correlation-Id`) and
  included in every structured log entry.

## Usage

### Frontend

```ts
import { generateCorrelationId, logIntegrationEvent } from '../services/logging';

const cid = generateCorrelationId();
logIntegrationEvent('token.deploy.initiated', { correlationId: cid, network: 'testnet' });

const txHash = await deployToken(params, { 'X-Correlation-Id': cid });
logIntegrationEvent('token.deploy.submitted', { correlationId: cid, txHash, network: 'testnet' });
```

### Backend

The `requestLoggingMiddleware` automatically reads `X-Correlation-Id` from
incoming requests and echoes it in the response and structured log entry.

### Webhook Delivery

`WebhookDeliveryService.triggerEvent()` accepts an optional `correlationId`.
Pass the originating request's correlation ID so webhook delivery logs can be
joined with the ingest log.

## Distributed Tracing (W3C `traceparent`)

Separate from the `X-Correlation-Id` scheme above, the backend is instrumented
with OpenTelemetry (`backend/src/instrumentation.ts`) and participates in W3C
Trace Context (https://www.w3.org/TR/trace-context/#traceparent-header):

```
traceparent: <version>-<trace-id>-<parent-id>-<trace-flags>
```

**Convention:**
- A client (or any upstream caller) MAY set `traceparent` on an inbound
  request. `backend/src/middleware/correlation-logging.ts#parseTraceParent`
  parses it and, when well-formed, attaches it to the async context
  (`backend/src/lib/async-context.ts`) for the lifetime of the request.
- `backend/src/lib/outboundHttpClient.ts` re-emits the same `traceparent` on
  any outbound call made during that request, so a trace ID survives
  fan-out to downstream dependencies.
- **The gateway** (`gateway/src/app.ts`) proxies via `http-proxy-middleware`,
  which forwards inbound headers — including `traceparent` — to the backend
  unchanged. It never fabricates or strips the header.
- If `traceparent` is absent or malformed, the backend does not error — it
  simply has no trace context to propagate, leaving trace origination to
  whichever layer has an OTel SDK registered (a malformed header is treated
  identically to a missing one, never propagated as garbage).

**Re-verifying after a routing or proxy change:**
- Gateway hop: `cd gateway && npx vitest run src/__tests__/tracePropagation.integration.test.ts`
  — proves an explicit `traceparent` survives the gateway's proxy hop
  unchanged, and that a request with none still passes through cleanly.
- Backend capture/re-emission: `cd backend && npx vitest run src/__tests__/otel-trace-propagation.smoke.test.ts`
  — proves the backend parses an inbound `traceparent` into its async
  context and re-emits it on outbound calls, with or without a live OTel SDK.
