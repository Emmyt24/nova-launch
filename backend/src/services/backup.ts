/**
 * BackupService
 *
 * Manages automated database backups and point-in-time recovery (PITR) for
 * the Nova Launch backend. Wraps the shell scripts (backup-db.sh /
 * restore-db.sh) and exposes a typed TypeScript API consumed by the backup
 * route and any scheduled jobs.
 *
 * Security:
 *  - Shell arguments are passed as an array (no string interpolation) to
 *    prevent command injection.
 *  - Sensitive env vars (DB password) are never logged.
 *  - Restore operations require explicit confirmation via the `confirmed`
 *    flag so callers cannot trigger a restore accidentally.
 */

import { execFile, ExecFileOptions } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { Database } from "../config/database";

const execFileAsync = promisify(execFile);

/** Absolute path to the scripts directory. */
const SCRIPTS_DIR = path.resolve(__dirname, "../../../scripts");

/**
 * Options accepted by `execFileAsync` when a value is piped to the child's
 * stdin. `input` is supported by the promisified `execFile` implementation
 * but is not part of the base `ExecFileOptions` type.
 */
interface ExecFileWithInputOptions extends ExecFileOptions {
  input?: string;
}

/** Extracts a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface BackupStatus {
  /** ISO-8601 timestamp of the most recent base backup, or null if none. */
  latestBaseBackup: string | null;
  /** Number of WAL segments in the archive. */
  walSegmentCount: number;
  /** Total size of the WAL archive directory (human-readable). */
  walArchiveSize: string;
  /** Storage path for PITR backups. */
  storagePath: string;
}

export interface BackupResult {
  success: boolean;
  message: string;
  /** Label of the base backup that was created (only on success). */
  backupLabel?: string;
  /** Duration of the operation in milliseconds. */
  durationMs: number;
}

export interface RestoreOptions {
  /**
   * ISO-8601 UTC timestamp to recover to.
   * Example: "2026-04-28T12:00:00Z"
   */
  targetTime: string;
  /** Base backup label to restore from. Defaults to the latest. */
  baseLabel?: string;
  /**
   * Must be `true` to execute the restore. Guards against accidental calls.
   * When `false` the service performs a dry-run and returns the plan.
   */
  confirmed: boolean;
}

export interface RestoreResult {
  success: boolean;
  message: string;
  dryRun: boolean;
  durationMs: number;
}

export interface AuditArchiveResult {
  success: boolean;
  /** Number of records written to the archive file. */
  archived: number;
  /** Storage tier the records were written to. */
  tier: "warm" | "cold";
  /** Absolute path to the NDJSON archive file that was created. */
  path: string;
  /** Duration of the archive operation in milliseconds. */
  durationMs: number;
  /** Present only on failure. */
  error?: string;
}

export interface AuditArchiveCheckpointData {
  id: string;
  lastArchivedAt: Date;
  tier: "warm" | "cold";
  totalArchived: number;
  inProgress: boolean;
  startedAt: Date;
  completedAt?: Date;
}

export class BackupService {
  private readonly storagePath: string;
  private readonly scriptsDir: string;

  constructor(
    storagePath: string = process.env.BACKUP_STORAGE_PATH ??
      "/var/backups/nova/pitr",
    scriptsDir: string = SCRIPTS_DIR
  ) {
    this.storagePath = storagePath;
    this.scriptsDir = scriptsDir;
  }

  /**
   * Triggers a PITR base backup via `backup-db.sh base`.
   * The backup is stored under `storagePath/base/<timestamp>/`.
   */
  async createBaseBackup(): Promise<BackupResult> {
    const start = Date.now();
    const script = path.join(this.scriptsDir, "backup-db.sh");

    try {
      const { stdout } = await execFileAsync("bash", [script, "base"], {
        env: { ...process.env },
        timeout: 30 * 60 * 1000, // 30 min max
      });

      // Extract the backup label from the script output
      const labelMatch = stdout.match(/nova-pitr-(\d{8}T\d{6}Z)/);
      const backupLabel = labelMatch ? `nova-pitr-${labelMatch[1]}` : undefined;

      return {
        success: true,
        message: "Base backup completed successfully",
        backupLabel,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: `Base backup failed: ${errorMessage(err)}`,
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Returns the current PITR backup status: latest base backup timestamp,
   * WAL segment count, and archive size.
   */
  async getStatus(): Promise<BackupStatus> {
    const baseDir = path.join(this.storagePath, "base");
    const walDir = path.join(this.storagePath, "wal");

    const [latestBaseBackup, walSegmentCount, walArchiveSize] =
      await Promise.all([
        this._latestBaseBackupLabel(baseDir),
        this._countFiles(walDir),
        this._dirSize(walDir),
      ]);

    return {
      latestBaseBackup,
      walSegmentCount,
      walArchiveSize,
      storagePath: this.storagePath,
    };
  }

  /**
   * Lists all available base backup labels, newest first.
   */
  async listBaseBackups(): Promise<string[]> {
    const baseDir = path.join(this.storagePath, "base");
    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * Initiates a PITR restore via `restore-db.sh`.
   *
   * ⚠️  This is a destructive operation. The caller MUST set
   * `options.confirmed = true` to proceed; otherwise a dry-run is performed.
   */
  async restore(options: RestoreOptions): Promise<RestoreResult> {
    const start = Date.now();
    const script = path.join(this.scriptsDir, "restore-db.sh");

    // Validate ISO-8601 format (basic check)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(options.targetTime)) {
      return {
        success: false,
        message:
          "Invalid targetTime format. Expected ISO-8601 UTC: YYYY-MM-DDTHH:MM:SSZ",
        dryRun: !options.confirmed,
        durationMs: Date.now() - start,
      };
    }

    const args = ["--target-time", options.targetTime];
    if (options.baseLabel) args.push("--base", options.baseLabel);
    if (!options.confirmed) args.push("--dry-run");

    const execOptions: ExecFileWithInputOptions = {
      env: { ...process.env },
      timeout: 60 * 60 * 1000, // 1 hour max
      // Pipe "yes\n" to stdin so the confirmation prompt is answered
      // automatically when confirmed=true.
      input: options.confirmed ? "yes\n" : undefined,
    };

    try {
      await execFileAsync("bash", [script, ...args], execOptions);

      return {
        success: true,
        message: options.confirmed
          ? `Restore to ${options.targetTime} initiated. Start PostgreSQL to begin WAL replay.`
          : `Dry-run complete. No changes made. Would restore to ${options.targetTime}.`,
        dryRun: !options.confirmed,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: `Restore failed: ${errorMessage(err)}`,
        dryRun: !options.confirmed,
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * Archive audit log records older than `olderThan` to the specified tier.
   *
   * - warm: records 91-365 days old  → <storagePath>/audit/warm/audit-<ts>.ndjson
   * - cold: records >365 days old    → <storagePath>/audit/cold/audit-<ts>.ndjson
   *         (in production this would upload to S3; here we write locally)
   *
   * Records are serialised as NDJSON (newline-delimited JSON) so the file can
   * be streamed line-by-line without loading the whole archive into memory.
   */
  async archiveAuditRecords(
    olderThan: Date,
    tier: "warm" | "cold" = "cold"
  ): Promise<AuditArchiveResult> {
    const start = Date.now();
    const tierDir = path.join(this.storagePath, "audit", tier);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(tierDir, `audit-${timestamp}.ndjson`);

    try {
      const allLogs = await Database.getAuditLogs();
      const records = allLogs.filter((l) => l.timestamp < olderThan);

      if (records.length === 0) {
        return {
          success: true,
          archived: 0,
          tier,
          path: filePath,
          durationMs: Date.now() - start,
        };
      }

      await fs.mkdir(tierDir, { recursive: true });

      const ndjson = records
        .map((r) => JSON.stringify(r))
        .join("\n");
      await fs.writeFile(filePath, ndjson + "\n", "utf-8");

      return {
        success: true,
        archived: records.length,
        tier,
        path: filePath,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        success: false,
        archived: 0,
        tier,
        path: filePath,
        durationMs: Date.now() - start,
        error: errorMessage(err),
      };
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async _latestBaseBackupLabel(baseDir: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      return dirs.length > 0 ? dirs[dirs.length - 1] : null;
    } catch {
      return null;
    }
  }

  private async _countFiles(dir: string): Promise<number> {
    try {
      const entries = await fs.readdir(dir);
      return entries.length;
    } catch {
      return 0;
    }
  }

  private async _dirSize(dir: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("du", ["-sh", dir]);
      return stdout.split("\t")[0] ?? "0";
    } catch {
      return "0";
    }
  }
}

/** Singleton instance for use across the application. */
export const backupService = new BackupService();
