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
 * ⚠️ WARNING: DESTRUCTIVE OPERATION — clears and rebuilds ALL projection
 * tables as part of its second pass (via `EventReplayService.clearAndRebuild`).
 * This permanently removes all current projection data and replaces it with a
 * full replay from ledger zero. ONLY run this against a disposable or
 * dedicated verification database — NEVER against a shared staging or
 * production database.
 *
 * Runs both replay strategies against the given `prisma`/`replayService` and
 * compares the resulting projection state for every projection type.
 *
 * Pass 1 (non-destructive): replays from the nearest usable snapshot up to
 * `targetLedger` and captures the resulting state.
 * Pass 2 (DESTRUCTIVE): clears all projection tables and rebuilds them from
 * ledger zero up to `targetLedger`, then captures the resulting state for
 * comparison.
 */
export async function verifyProjectionSnapshotConsistency(
  replayService: EventReplayService,
  prisma: PrismaClient,
  targetLedger: number,
): Promise<ProjectionConsistencyResult> {
  // Pass 1: replay resuming from the nearest usable snapshot.
  await replayService.replayFromLedger(targetLedger);
  const fromSnapshotState = await captureAllProjectionData(prisma);

  // ⚠️ DESTRUCTIVE STEP: the following call clears all projection tables and
  // rebuilds them from ledger zero. This is the operation that makes this
  // function unsafe to run against any non-disposable database.
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
