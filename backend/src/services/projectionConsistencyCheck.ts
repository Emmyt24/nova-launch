/**
 * Snapshot-vs-zero replay consistency check (#1620).
 *
 * Verifies the core correctness property snapshot-based replay depends on:
 * replaying from the nearest usable snapshot up to a target ledger must
 * produce projection state byte-identical to a full replay from ledger zero
 * to that same ledger. If a snapshot were captured incorrectly (wrong
 * ledger, stale data, lossy BigInt/Date serialization) this is what would
 * catch it.
 *
 * Intended for ops tooling / CI verification — run against a disposable
 * database, since `clearAndRebuild` is destructive.
 */

import { PrismaClient, ProjectionType } from '@prisma/client';
import { EventReplayService } from './eventReplayService';
import { captureAllProjectionData, PROJECTION_TYPES } from './projectionSnapshot';

export interface ProjectionConsistencyResult {
  consistent: boolean;
  targetLedger: number;
  mismatchedProjectionTypes: ProjectionType[];
}

/**
 * Runs both replay strategies against the given `prisma`/`replayService` and
 * compares the resulting projection state for every projection type.
 *
 * WARNING: destructive — this clears and rebuilds all projection tables
 * (via `EventReplayService.clearAndRebuild`) as its second pass. Only run
 * against a disposable database.
 */
export async function verifyProjectionSnapshotConsistency(
  replayService: EventReplayService,
  prisma: PrismaClient,
  targetLedger: number,
): Promise<ProjectionConsistencyResult> {
  // Pass 1: replay resuming from the nearest usable snapshot.
  await replayService.replayFromLedger(targetLedger);
  const fromSnapshotState = await captureAllProjectionData(prisma);

  // Pass 2: full rebuild from ledger zero, for comparison.
  await replayService.clearAndRebuild({ endLedger: targetLedger });
  const fromZeroState = await captureAllProjectionData(prisma);

  const mismatchedProjectionTypes: ProjectionType[] = [];
  for (const projectionType of PROJECTION_TYPES) {
    const a = JSON.stringify(fromSnapshotState[projectionType]);
    const b = JSON.stringify(fromZeroState[projectionType]);
    if (a !== b) {
      mismatchedProjectionTypes.push(projectionType);
    }
  }

  return {
    consistent: mismatchedProjectionTypes.length === 0,
    targetLedger,
    mismatchedProjectionTypes,
  };
}
