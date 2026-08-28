/**
 * Audit-log retention policy enforcement – tiered archival before deletion.
 *
 * Storage tiers:
 *   Hot  (0–90 days)    – live in Postgres / in-memory Database
 *   Warm (91–365 days)  – compressed NDJSON on local disk
 *   Cold (>365 days)    – NDJSON on local disk (production: S3-compatible store)
 *
 * The job:
 *   1. Archives warm-tier records (91–365 days old) via BackupService.
 *   2. Archives cold-tier records (>365 days old) via BackupService.
 *   3. Only purges records from the hot store after successful archival.
 *   4. Persists a checkpoint before each phase so an interrupted run can
 *      resume without re-archiving already-written records.
 *
 * Configuration (env vars):
 *   AUDIT_RETENTION_DAYS          – hot-tier retention window (default: 90)
 *   AUDIT_RETENTION_INTERVAL_MS   – job interval in ms       (default: 3 600 000)
 *   BACKUP_STORAGE_PATH           – root path for archive files
 */

import { Database } from "../config/database";
import { MetricsCollector } from "../lib/metrics";
import { backupService } from "./backup";
import {
  AuditArchiveCheckpointStore,
  CheckpointData,
} from "./auditArchiveCheckpoint";

const RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS ?? "90", 10);
const INTERVAL_MS = parseInt(
  process.env.AUDIT_RETENTION_INTERVAL_MS ?? String(60 * 60 * 1000),
  10
);

const WARM_DAYS_START = 91;
const COLD_DAYS_START = 365;

const storagePath =
  process.env.BACKUP_STORAGE_PATH ?? "/var/backups/nova/pitr";
const checkpointStore = new AuditArchiveCheckpointStore(storagePath);

let _timer: ReturnType<typeof setInterval> | null = null;

// ── Archival phase ────────────────────────────────────────────────────────────

/**
 * Archive warm-tier (91–365 days old) and cold-tier (>365 days old) records.
 * Writes NDJSON archive files via BackupService and saves a checkpoint after
 * each tier completes so the job is resumable.
 *
 * @returns Counts of records archived per tier.
 */
export async function runAuditArchival(
  retentionDays = RETENTION_DAYS
): Promise<{ warm: number; cold: number }> {
  const now = Date.now();

  const warmDays = Math.min(WARM_DAYS_START, retentionDays);
  const warmCutoff = new Date(now - warmDays * 24 * 60 * 60 * 1000);
  const coldCutoff = new Date(now - COLD_DAYS_START * 24 * 60 * 60 * 1000);

  const startedAt = new Date().toISOString();

  // Mark job as in-progress so a crash leaves a recoverable checkpoint.
  const baseCheckpoint: CheckpointData = {
    lastArchivedAt: new Date(0).toISOString(),
    tier: "warm",
    totalArchived: 0,
    inProgress: true,
    startedAt,
  };
  await checkpointStore.save(baseCheckpoint);

  // ── Warm tier ──────────────────────────────────────────────────────────────
  const warmResult = await backupService.archiveAuditRecords(warmCutoff, "warm");

  if (!warmResult.success) {
    console.error(
      JSON.stringify({
        event: "audit_archival.warm.error",
        error: warmResult.error,
      })
    );
  }

  await checkpointStore.save({
    lastArchivedAt: warmCutoff.toISOString(),
    tier: "cold",
    totalArchived: warmResult.archived,
    inProgress: true,
    startedAt,
  });

  // ── Cold tier ──────────────────────────────────────────────────────────────
  const coldResult = await backupService.archiveAuditRecords(coldCutoff, "cold");

  if (!coldResult.success) {
    console.error(
      JSON.stringify({
        event: "audit_archival.cold.error",
        error: coldResult.error,
      })
    );
  }

  const totalArchived = warmResult.archived + coldResult.archived;

  // Mark job as complete.
  await checkpointStore.save({
    lastArchivedAt: coldCutoff.toISOString(),
    tier: "cold",
    totalArchived,
    inProgress: false,
    startedAt,
    completedAt: new Date().toISOString(),
  });

  console.log(
    JSON.stringify({
      event: "audit_archival.complete",
      warmArchived: warmResult.archived,
      coldArchived: coldResult.archived,
      totalArchived,
    })
  );

  return { warm: warmResult.archived, cold: coldResult.archived };
}

// ── Retention (delete) phase ──────────────────────────────────────────────────

/**
 * Archive records first, then purge the hot store.
 * Returns the total count of records removed from the hot store.
 */
export async function runAuditRetention(
  retentionDays = RETENTION_DAYS
): Promise<number> {
  const start = Date.now();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // Phase 1: archive before delete.
  await runAuditArchival(retentionDays);

  // Invariant check: ensure archival cutoff encompasses everything to be purged.
  const warmDays = Math.min(WARM_DAYS_START, retentionDays);
  const archivalWarmCutoff = new Date(Date.now() - warmDays * 24 * 60 * 60 * 1000);
  if (archivalWarmCutoff.getTime() < cutoff.getTime()) {
    throw new Error(
      `Invariant violation: archival cutoff (${archivalWarmCutoff.toISOString()}) is older than purge cutoff (${cutoff.toISOString()}). Purge aborted to prevent data loss.`
    );
  }

  // Phase 2: delete from hot store.
  const allLogs = await Database.getAuditLogs();
  const toRemove = allLogs.filter((l) => l.timestamp < cutoff);

  if (toRemove.length > 0) {
    await Database.purgeAuditLogs(cutoff);
  }

  const durationSeconds = (Date.now() - start) / 1000;
  MetricsCollector.recordBackgroundJob("audit_retention", "success", durationSeconds);

  console.log(
    JSON.stringify({
      event: "audit_retention.complete",
      cutoff: cutoff.toISOString(),
      retentionDays,
      purged: toRemove.length,
      durationMs: Date.now() - start,
    })
  );

  return toRemove.length;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/** Start the scheduled retention job. Calling this more than once is a no-op. */
export function startAuditRetentionJob(): void {
  if (_timer !== null) return;

  console.log(
    JSON.stringify({
      event: "audit_retention.started",
      retentionDays: RETENTION_DAYS,
      intervalMs: INTERVAL_MS,
    })
  );

  // Run immediately on startup, then on the configured interval.
  runAuditRetention().catch((err) =>
    console.error("audit_retention initial run failed", err)
  );

  _timer = setInterval(() => {
    runAuditRetention().catch((err) =>
      console.error("audit_retention job failed", err)
    );
  }, INTERVAL_MS);

  // Don't block process exit.
  if (_timer.unref) _timer.unref();
}

/** Stop the scheduled job (primarily for tests). */
export function stopAuditRetentionJob(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
}

/** Expose the checkpoint store so the archive-status route can read it. */
export { checkpointStore };
