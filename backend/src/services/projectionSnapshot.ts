/**
 * Cross-projection snapshot capture and restore (#1620).
 *
 * See docs/PROJECTION_SNAPSHOTS.md for the payload format and versioning
 * strategy. Summary: a snapshot captures every row of a projection type's
 * table(s) as of a given ledger height, with BigInt/Date fields converted to
 * JSON-safe strings and rows sorted by `id` so two independently-taken
 * snapshots of identical underlying state serialize byte-identically.
 *
 * STREAM and VAULT both snapshot the same `Stream` table — in this codebase
 * both `stream_*` and `vault_*` on-chain event topics are parsed into the
 * same projection (see `stellarEventListener.ts` / `eventReplayService.ts`),
 * so there is genuinely only one table to capture for either type.
 */

import { PrismaClient, ProjectionType, ProjectionSnapshot as ProjectionSnapshotRow } from "@prisma/client";

export const PROJECTION_SNAPSHOT_FORMAT_VERSION = 1;

export const PROJECTION_TYPES: ProjectionType[] = [
  ProjectionType.CAMPAIGN,
  ProjectionType.GOVERNANCE,
  ProjectionType.STREAM,
  ProjectionType.VAULT,
];

/** Deep-converts BigInt -> string and Date -> ISO string, and sorts object keys, for stable JSON serialization. */
function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      out[key] = toJsonSafe(input[key]);
    }
    return out;
  }
  return value;
}

function sortById<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function captureCampaignData(prisma: PrismaClient): Promise<unknown> {
  const [campaigns, executions, auditTrail] = await Promise.all([
    prisma.campaign.findMany(),
    prisma.campaignExecution.findMany(),
    prisma.campaignAuditTrail.findMany(),
  ]);
  return toJsonSafe({
    campaigns: sortById(campaigns),
    executions: sortById(executions),
    auditTrail: sortById(auditTrail),
  });
}

async function captureGovernanceData(prisma: PrismaClient): Promise<unknown> {
  const [proposals, votes, executions] = await Promise.all([
    prisma.proposal.findMany(),
    prisma.vote.findMany(),
    prisma.proposalExecution.findMany(),
  ]);
  return toJsonSafe({
    proposals: sortById(proposals),
    votes: sortById(votes),
    executions: sortById(executions),
  });
}

async function captureStreamData(prisma: PrismaClient): Promise<unknown> {
  const streams = await prisma.stream.findMany();
  return toJsonSafe({ streams: sortById(streams) });
}

async function captureForType(prisma: PrismaClient, projectionType: ProjectionType): Promise<unknown> {
  switch (projectionType) {
    case ProjectionType.CAMPAIGN:
      return captureCampaignData(prisma);
    case ProjectionType.GOVERNANCE:
      return captureGovernanceData(prisma);
    case ProjectionType.STREAM:
    case ProjectionType.VAULT:
      return captureStreamData(prisma);
    default:
      throw new Error(`Unknown projection type: ${String(projectionType)}`);
  }
}

/**
 * Captures every projection type at the same ledger/cursor in one pass, so
 * the resulting snapshot set is globally consistent (a replay resuming from
 * this ledger sees exactly the state every projection had at that point).
 */
export async function captureAllProjectionSnapshots(
  prisma: PrismaClient,
  ledger: number,
  cursor: string,
): Promise<void> {
  for (const projectionType of PROJECTION_TYPES) {
    const data = await captureForType(prisma, projectionType);
    await prisma.projectionSnapshot.upsert({
      where: { projectionType_ledger: { projectionType, ledger } },
      create: {
        projectionType,
        ledger,
        cursor,
        formatVersion: PROJECTION_SNAPSHOT_FORMAT_VERSION,
        data: data as any,
      },
      update: {
        cursor,
        formatVersion: PROJECTION_SNAPSHOT_FORMAT_VERSION,
        data: data as any,
      },
    });
  }
}

/** Captures every projection type's current state, keyed by type — used by the consistency check to diff two replay strategies. */
export async function captureAllProjectionData(
  prisma: PrismaClient,
): Promise<Record<ProjectionType, unknown>> {
  const result = {} as Record<ProjectionType, unknown>;
  for (const projectionType of PROJECTION_TYPES) {
    result[projectionType] = await captureForType(prisma, projectionType);
  }
  return result;
}

/**
 * Returns the highest ledger at or below `targetLedger` for which every
 * projection type has a snapshot (i.e. a complete, globally-consistent
 * snapshot set), or null if no such ledger exists.
 */
export async function findNearestUsableSnapshotLedger(
  prisma: PrismaClient,
  targetLedger: number,
): Promise<number | null> {
  const rows = await prisma.projectionSnapshot.findMany({
    where: { ledger: { lte: targetLedger } },
    select: { ledger: true, projectionType: true },
  });

  const typesByLedger = new Map<number, Set<ProjectionType>>();
  for (const row of rows) {
    if (!typesByLedger.has(row.ledger)) typesByLedger.set(row.ledger, new Set());
    typesByLedger.get(row.ledger)!.add(row.projectionType);
  }

  let best: number | null = null;
  for (const [ledger, types] of typesByLedger) {
    if (types.size === PROJECTION_TYPES.length && (best === null || ledger > best)) {
      best = ledger;
    }
  }
  return best;
}

interface RestoreFieldSpec {
  bigIntFields?: string[];
  dateFields?: string[];
}

/**
 * Re-inserts snapshot rows via `delegate.create()`, reversing `toJsonSafe`'s
 * BigInt->string and Date->ISO-string conversions on the way back in.
 * Restoring exact original `Date` values (including `createdAt`/`updatedAt`)
 * matters here: the consistency check compares serialized projection state
 * byte-for-byte, so a restore that let Prisma's `@updatedAt` auto-populate a
 * fresh timestamp instead of the snapshotted one would fail that comparison
 * even when the restore was otherwise correct.
 */
async function restoreRows(
  delegate: any,
  rows: any[] | undefined,
  { bigIntFields = [], dateFields = [] }: RestoreFieldSpec,
): Promise<void> {
  if (!rows || rows.length === 0) return;
  for (const row of rows) {
    const data: Record<string, unknown> = { ...row };
    for (const field of bigIntFields) {
      if (data[field] !== null && data[field] !== undefined) {
        data[field] = BigInt(data[field] as string);
      }
    }
    for (const field of dateFields) {
      if (data[field] !== null && data[field] !== undefined) {
        data[field] = new Date(data[field] as string);
      }
    }
    await delegate.create({ data });
  }
}

async function restoreOne(prisma: PrismaClient, snapshot: ProjectionSnapshotRow): Promise<void> {
  const data = snapshot.data as any;

  switch (snapshot.projectionType) {
    case ProjectionType.CAMPAIGN: {
      await prisma.$transaction([
        prisma.campaignAuditTrail.deleteMany(),
        prisma.campaignExecution.deleteMany(),
        prisma.campaign.deleteMany(),
      ]);
      await restoreRows(prisma.campaign, data.campaigns, {
        bigIntFields: ["targetAmount", "currentAmount"],
        dateFields: ["startTime", "endTime", "createdAt", "updatedAt", "completedAt", "cancelledAt", "pausedAt"],
      });
      await restoreRows(prisma.campaignExecution, data.executions, {
        bigIntFields: ["amount"],
        dateFields: ["executedAt"],
      });
      await restoreRows(prisma.campaignAuditTrail, data.auditTrail, {
        dateFields: ["transitionAt"],
      });
      return;
    }
    case ProjectionType.GOVERNANCE: {
      await prisma.$transaction([
        prisma.vote.deleteMany(),
        prisma.proposalExecution.deleteMany(),
        prisma.proposal.deleteMany(),
      ]);
      await restoreRows(prisma.proposal, data.proposals, {
        bigIntFields: ["quorum", "threshold"],
        dateFields: ["startTime", "endTime", "createdAt", "updatedAt", "executedAt", "cancelledAt"],
      });
      await restoreRows(prisma.vote, data.votes, {
        bigIntFields: ["weight"],
        dateFields: ["timestamp"],
      });
      await restoreRows(prisma.proposalExecution, data.executions, {
        bigIntFields: ["gasUsed"],
        dateFields: ["executedAt"],
      });
      return;
    }
    case ProjectionType.STREAM:
    case ProjectionType.VAULT: {
      await prisma.stream.deleteMany();
      await restoreRows(prisma.stream, data.streams, {
        bigIntFields: ["amount"],
        dateFields: ["createdAt", "claimedAt", "cancelledAt"],
      });
      return;
    }
  }
}

/**
 * Restores every projection's tables from the complete snapshot set captured
 * at `ledger`. Destructive: replaces current rows for every table covered by
 * these projection types. Throws if the snapshot set at `ledger` is
 * incomplete (missing one or more projection types).
 *
 * STREAM and VAULT snapshot the same table (see module docs) — restoring is
 * only performed once for that table even though both types are present in
 * the snapshot set.
 */
export async function restoreAllProjectionSnapshots(prisma: PrismaClient, ledger: number): Promise<void> {
  const snapshots = await prisma.projectionSnapshot.findMany({ where: { ledger } });
  if (snapshots.length !== PROJECTION_TYPES.length) {
    throw new Error(
      `Incomplete snapshot set at ledger ${ledger}: found ${snapshots.length}/${PROJECTION_TYPES.length} projection types`,
    );
  }

  for (const snapshot of snapshots) {
    if (snapshot.projectionType === ProjectionType.VAULT) continue; // alias of STREAM — same table, restored once
    await restoreOne(prisma, snapshot);
  }
}
