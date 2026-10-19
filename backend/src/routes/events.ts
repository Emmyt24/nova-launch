/**
 * GET /api/events/catchup?since=<sequence>
 *
 * Returns events from the shared EventBus history that have a sequence
 * number greater than `since`, ordered ascending.
 *
 * If the gap (currentSequence - since) exceeds CATCHUP_LIMIT (1000), returns
 * { truncated: true, currentSequence } to tell the client to do a full REST
 * refresh instead (#1372).
 */

import { Router, Request, Response } from "express";
import { eventBus } from "../services/eventBus";

export const CATCHUP_LIMIT = 1000;

/**
 * Event schema version emitted alongside every event payload.
 *
 * v1: legacy payloads (fee changes carry only the new value).
 * v2: fee changes include `oldValue`/`newValue`; allowlist events added (#2243, #2245).
 */
export const EVENT_SCHEMA_VERSION = 2;

/**
 * Normalises an event for API responses, preserving wire compatibility.
 *
 * - Every event is tagged with `version` (defaults to 1 for legacy events).
 * - Fee-change events are exposed with both `oldValue` and `newValue`; the
 *   legacy `value` field is retained so v1 parsers keep working.
 */
function serializeEvent(event: any): any {
  const version = typeof event.version === "number" ? event.version : 1;
  const serialized: any = { ...event, version };

  if (event.type === "fee_change" || event.type === "feeChange") {
    const oldValue = event.oldValue ?? event.previousValue ?? null;
    const newValue = event.newValue ?? event.value ?? null;
    serialized.oldValue = oldValue;
    serialized.newValue = newValue;
    // Legacy field kept for v1 wire compatibility.
    if (serialized.value === undefined) {
      serialized.value = newValue;
    }
  }

  return serialized;
}

const router = Router();

router.get("/catchup", (req: Request, res: Response) => {
  const sinceRaw = req.query.since;
  const since = sinceRaw !== undefined ? parseInt(String(sinceRaw), 10) : NaN;

  if (isNaN(since) || since < 0) {
    res.status(400).json({ error: "Query parameter 'since' must be a non-negative integer" });
    return;
  }

  const currentSequence = eventBus.currentSequence;

  // The in-memory event bus resets its sequence after a process restart. A
  // client cursor ahead of the new sequence is therefore stale and requires
  // a full resync rather than an empty successful catch-up response.
  if (since > currentSequence) {
    res.json({ truncated: true, reason: "cursor_reset", currentSequence });
    return;
  }

  // Truncation guard — tell client to do a full refresh
  if (currentSequence - since > CATCHUP_LIMIT) {
    res.json({ truncated: true, currentSequence });
    return;
  }

  const missed = eventBus
    .getHistory()
    .filter((e) => e.sequence > since)
    .sort((a, b) => a.sequence - b.sequence)
    .map(serializeEvent);

  res.json({
    truncated: false,
    events: missed,
    currentSequence,
    schemaVersion: EVENT_SCHEMA_VERSION,
  });
});

export default router;
