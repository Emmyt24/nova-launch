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
