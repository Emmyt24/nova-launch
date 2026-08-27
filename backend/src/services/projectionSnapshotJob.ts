/**
 * Scheduled snapshot-writer job (#1620).
 *
 * Captures a fresh cross-projection snapshot at the currently-persisted
 * event cursor. Wired into `jobQueue` as a recurring job in `index.ts`,
 * gated by `ENABLE_PROJECTION_SNAPSHOTS` / `PROJECTION_SNAPSHOT_INTERVAL_MS`
 * the same way `stream_reconciliation` is.
 */

import { PrismaClient } from '@prisma/client';
import { EventCursorStore, parseLedgerFromCursor } from './eventCursorStore';
import { captureAllProjectionSnapshots } from './projectionSnapshot';

export async function runProjectionSnapshotJob(prisma: PrismaClient): Promise<void> {
  const cursorStore = new EventCursorStore(prisma);
  const cursor = await cursorStore.load();

  if (!cursor) {
    console.warn('[ProjectionSnapshotJob] no cursor persisted yet — skipping snapshot capture');
    return;
  }

  const ledger = parseLedgerFromCursor(cursor);
  if (ledger === null) {
    console.warn(`[ProjectionSnapshotJob] cursor "${cursor}" has no parseable ledger — skipping snapshot capture`);
    return;
  }

  await captureAllProjectionSnapshots(prisma, ledger, cursor);
  console.log(`[ProjectionSnapshotJob] captured snapshot at ledger ${ledger}`);
}
