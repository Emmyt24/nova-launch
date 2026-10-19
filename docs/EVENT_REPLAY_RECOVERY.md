# Event Replay for Disaster Recovery

## Overview

The Event Replay system provides disaster recovery by replaying historical contract events from Stellar Horizon to rebuild read models (projections) after data loss. This is critical for recovering from database corruption, accidental deletion, or synchronization failures.

## Key Features

- **Configurable Ledger Range**: Target specific ledger ranges for recovery
- **Automatic Retry with Backoff**: Handles network failures gracefully
- **Idempotent Processing**: Safe to re-run without side effects
- **Dry-Run Mode**: Validate recovery without persistence
- **Deterministic Rebuilding**: Projections are rebuilt consistently from events
- **Cursor Persistence**: Tracks progress for resumable recovery

## Architecture

### Event Flow

```
Stellar Horizon
      ↓
EventReplayService (fetch with retry)
      ↓
Event Parsers (idempotent)
      ├─ TokenEventParser
      ├─ GovernanceEventParser
      ├─ StreamEventParser
      └─ VaultEventParser
      ↓
Prisma (projections)
      ├─ Token
      ├─ Proposal
      ├─ Stream
      └─ Campaign
```

### Idempotency Guarantees

All event parsers are idempotent:

1. **Duplicate Events**: Processing the same event twice yields identical state
2. **Out-of-Order Delivery**: Events are processed in ledger order; out-of-order events are skipped
3. **Terminal States**: Once a projection reaches a terminal state (e.g., CLAIMED, EXECUTED), replaying earlier events doesn't change it
4. **Counters & Amounts**: Incremental fields (burn count, total supply) are recalculated from events, not incremented

## Usage

### Basic Replay

Replay all events from the stored cursor:

```bash
curl -X POST http://localhost:3001/admin/event-replay \
  -H "x-admin-key: $ADMIN_JWT_SECRET"
```

### Replay from Specific Ledger

Recover from a known good ledger:

```bash
curl -X POST "http://localhost:3001/admin/event-replay?startLedger=50000000" \
  -H "x-admin-key: $ADMIN_JWT_SECRET"
```

### Replay with Range

Recover a specific time window:

```bash
curl -X POST "http://localhost:3001/admin/event-replay?startLedger=50000000&endLedger=50001000" \
  -H "x-admin-key: $ADMIN_JWT_SECRET"
```

### Dry-Run Validation

Validate recovery without persistence:

```bash
curl -X POST "http://localhost:3001/admin/event-replay?dryRun=true" \
  -H "x-admin-key: $ADMIN_JWT_SECRET"
```

### Clear and Rebuild

**WARNING**: This is destructive. Use only as a last resort.

```bash
curl -X POST "http://localhost:3001/admin/event-replay/clear-and-rebuild?confirm=yes" \
  -H "x-admin-key: $ADMIN_JWT_SECRET"
```

## Response Format

```json
{
  "eventsProcessed": 1500,
  "eventsSkipped": 2,
  "startLedger": 50000000,
  "endLedger": 50001500,
  "finalCursor": "50001500-1",
  "errors": [
    {
      "ledger": 50000500,
      "error": "Invalid event structure"
    }
  ],
  "duration": 45000
}
```

## Configuration

### Environment Variables

```bash
# Stellar network configuration
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
FACTORY_CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4

# Recovery starting point (if no cursor stored)
STELLAR_CURSOR_ORIGIN=0-0

# Admin authentication
ADMIN_JWT_SECRET=your-secret-key
```

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `startLedger` | number | stored cursor | Starting ledger for replay |
| `endLedger` | number | unlimited | Ending ledger (inclusive) |
| `batchSize` | number | 100 | Events per Horizon request (1-200) |
| `dryRun` | boolean | false | Validate without persisting |
| `maxRetries` | number | 5 | Network retry attempts |

## Recovery Procedures

### Scenario 1: Database Corruption

**Symptoms**: Inconsistent projection state, missing records

**Recovery Steps**:

1. Identify the last known good ledger (check logs or monitoring)
2. Run replay from that ledger:
   ```bash
   curl -X POST "http://localhost:3001/admin/event-replay?startLedger=LAST_GOOD_LEDGER" \
     -H "x-admin-key: $ADMIN_JWT_SECRET"
   ```
3. Verify projections are consistent
4. Resume normal operation

### Scenario 2: Complete Data Loss

**Symptoms**: All projections missing or empty

**Recovery Steps**:

1. Verify Stellar network is accessible
2. Run clear and rebuild:
   ```bash
   curl -X POST "http://localhost:3001/admin/event-replay/clear-and-rebuild?confirm=yes" \
     -H "x-admin-key: $ADMIN_JWT_SECRET"
   ```
3. Monitor progress via logs
4. Verify all projections are rebuilt
5. Resume normal operation

### Scenario 3: Partial Sync Failure

**Symptoms**: Events missing from a specific time window

**Recovery Steps**:

1. Identify the affected ledger range
2. Run targeted replay:
   ```bash
   curl -X POST "http://localhost:3001/admin/event-replay?startLedger=START&endLedger=END" \
     -H "x-admin-key: $ADMIN_JWT_SECRET"
   ```
3. Verify affected records are restored
4. Resume normal operation

## Monitoring

### Logs

The replay service logs progress at key points:

```
[EventReplay] Starting replay from ledger 50000000, batch size: 100
[EventReplay] Fetch failed (attempt 1/6), retrying in 1000ms
[EventReplay] Error processing event at ledger 50000500: Invalid event structure
[EventReplay] Cursor persisted: 50001500-1
[EventReplay] Completed: 1500 processed, 2 skipped in 45000ms
```

### Metrics

Monitor these metrics during recovery:

- `events_replayed_total`: Total events processed
- `events_replay_errors_total`: Events that failed to process
- `event_replay_duration_ms`: Time to complete replay
- `projection_lag_ms`: Lag between latest event and projection

### Health Checks

After recovery, verify:

1. **Projection Consistency**: Run consistency checker
   ```bash
   curl http://localhost:3001/health/consistency
   ```

2. **Event Cursor**: Verify cursor is at latest
   ```bash
   curl http://localhost:3001/admin/stats
   ```

3. **Data Integrity**: Spot-check key records
   ```bash
   curl http://localhost:3001/tokens?limit=10
   ```

## Performance Considerations

### Batch Size

- **Small batches (10-50)**: More frequent API calls, slower overall
- **Medium batches (100)**: Balanced, recommended
- **Large batches (200)**: Fewer API calls, higher memory usage

### Network Retry

- **Low retries (1-2)**: Fast failure, may miss transient errors
- **Medium retries (5)**: Balanced, recommended
- **High retries (10+)**: Tolerates poor connectivity, slower

### Ledger Range

- **Full replay**: Slowest, most thorough
- **Targeted range**: Faster, requires knowing affected ledgers
- **Dry-run first**: Validate before persisting

## Troubleshooting

### "FACTORY_CONTRACT_ID not configured"

**Cause**: Environment variable not set

**Fix**:
```bash
export FACTORY_CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4
```

### "Network error after retries"

**Cause**: Horizon API unreachable or rate-limited

**Fix**:
1. Check Horizon status: https://status.stellar.org
2. Increase `maxRetries` parameter
3. Retry after waiting

### "Event replay failed: Invalid event structure"

**Cause**: Malformed event from Horizon

**Fix**:
1. Check event at reported ledger
2. Run dry-run to identify problematic events
3. Contact Stellar support if events are corrupted

### "Cursor persisted but events not visible"

**Cause**: Projections not yet updated in read layer

**Fix**:
1. Wait for cache invalidation (typically <5s)
2. Clear cache manually if available
3. Verify database transaction completed

## Best Practices

1. **Regular Backups**: Maintain database backups independent of event replay
2. **Test Recovery**: Periodically test recovery procedures in staging
3. **Monitor Projections**: Set up alerts for projection lag
4. **Document Ledgers**: Track important ledger numbers (deployments, incidents)
5. **Dry-Run First**: Always validate with `dryRun=true` before persisting
6. **Gradual Recovery**: For large ranges, replay in smaller chunks
7. **Verify After**: Always verify projections after recovery

## API Reference

### POST /admin/event-replay

Replay events from Stellar to rebuild projections.

**Authorization**: Requires `x-admin-key` header

**Query Parameters**:
- `startLedger` (optional): Starting ledger number
- `endLedger` (optional): Ending ledger number
- `batchSize` (optional, default: 100): Events per request
- `dryRun` (optional, default: false): Validate without persisting
- `maxRetries` (optional, default: 5): Network retry attempts

**Response**: ReplayResult object

**Errors**:
- 403: Unauthorized
- 400: Invalid parameters
- 500: Replay failed

### POST /admin/event-replay/clear-and-rebuild

Clear all projections and rebuild from scratch.

**Authorization**: Requires `x-admin-key` header

**Query Parameters**:
- `confirm` (required): Must be "yes" to proceed
- `startLedger` (optional): Starting ledger for rebuild

**Response**: ReplayResult object

**Errors**:
- 403: Unauthorized
- 400: Confirmation not provided
- 500: Rebuild failed

### POST /admin/event-replay/range

Reprocess events for an explicit ledger range, typically to replay events that
failed before a parser bug was fixed. Parameters may be sent as a JSON body or
as query parameters.

| Parameter     | Required | Default | Description                                             |
| ------------- | -------- | ------- | ------------------------------------------------------- |
| `startLedger` | yes      | —       | First ledger to replay (inclusive, positive integer)    |
| `endLedger`   | yes      | —       | Last ledger to replay (inclusive, `>= startLedger`)     |
| `dryRun`      | no       | `true`  | Validate events without writing. Set `false` to persist |
| `batchSize`   | no       | `100`   | Events per Horizon request (1–200)                      |
| `maxRetries`  | no       | `5`     | Network retry attempts (0–10)                           |

`dryRun` defaults to `true`. Run a dry run first, check `errors`, then send the
same range again with `"dryRun": false`.

```bash
curl -X POST https://api.example.com/admin/event-replay/range \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"startLedger": 51200000, "endLedger": 51205000, "dryRun": false}'
```

The response matches `/admin/event-replay` and adds a `dryRun` flag.

**Safeguards**

- **Authorization:** `super_admin` only.
- **Rate limit:** each admin gets `EVENT_REPLAY_RATE_LIMIT_MAX` requests (default 5)
  per `EVENT_REPLAY_RATE_LIMIT_WINDOW_MS` window (default 15 minutes). Requests
  over the limit get `429` with a `Retry-After` header.
- **Single flight:** only one range replay runs per process at a time. A
  concurrent request gets `409`.
- **Range cap:** a range can cover at most `EVENT_REPLAY_MAX_LEDGER_SPAN` ledgers
  (default 100000).
- **Audit:** every replay that passes validation writes an `AdminAuditLog` row with
  `action = EVENT_REPLAY_RANGE` and `resourceId = "<start>-<end>"`. The row stores
  the request parameters in `beforeState` and the outcome in `afterState`
  (`status`, `eventsProcessed`, `eventsSkipped`, `errorCount`, `finalCursor`,
  `duration`, or `error` on failure). You can query these rows through
  `GET /api/admin/audit?action=EVENT_REPLAY_RANGE`.

## Related Documentation

- [Backup and Recovery](./BACKUP_API.md)
- [Database Backup PITR](./DATABASE_BACKUP_PITR.md)
- [Production Integration Runbook](./PRODUCTION_INTEGRATION_RUNBOOK.md)
- [Monitoring and Observability](./OBSERVABILITY_CORRELATION.md)
