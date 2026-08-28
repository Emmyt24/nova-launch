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
    .sort((a, b) => a.sequence - b.sequence);

  res.json({ truncated: false, events: missed, currentSequence });
});

export default router;
