import type { PrismaClient, Prisma } from "@prisma/client";

/**
 * Zero-downtime live schema migration framework. (#1622)
 *
 * Coordinates a dual-write / backfill / verify / cutover / cleanup lifecycle
 * for moving a live table to a new schema shape without blocking writers or
 * losing writes issued during the transition:
 *
 * 1. `startDualWrite` creates the shadow table and installs a Prisma
 *    middleware that transparently mirrors every write issued through the
 *    existing Prisma client to the shadow table too — callers do not need to
 *    change anything.
 * 2. `runBackfill` copies pre-existing rows into the shadow table in
 *    batches, without clobbering rows a concurrent dual-write already wrote.
 * 3. `verifyParity` compares *every* row (not a sample) between the old and
 *    shadow tables and returns a pass/fail report.
 * 4. `cutover` — only allowed once `verifyParity` has passed — atomically
 *    repoints a read view at the shadow table with a single `CREATE OR
 *    REPLACE VIEW` statement. No data is copied at cutover time.
 * 5. `recordPostCutoverOutcome` lets callers report post-cutover read/write
 *    success or failure; if the rolling error rate crosses
 *    `errorRateThreshold`, the orchestrator automatically rolls the view
 *    back to the old table.
 * 6. `cleanup` drops the old table once the migration has been confirmed
 *    stable (`completed`), and removes the dual-write middleware.
 */

export type MigrationPhase =
  | "idle"
  | "dual_write"
  | "backfilling"
  | "verifying"
  | "verified"
  | "cutover"
  | "monitoring"
  | "completed"
  | "rolled_back";

export interface MigrationConfig {
  /** Prisma model name being migrated (as used in `params.model`), e.g. "HolderSnapshot". */
  modelName: string;
  /** Live table name in Postgres, e.g. "HolderSnapshot". */
  tableName: string;
  /** New-schema-shape shadow table name, e.g. "HolderSnapshot_shadow". */
  shadowTableName: string;
  /** Read view callers should query through; cutover atomically repoints this. */
  viewName: string;
  /** Primary key column, e.g. "id". */
  primaryKeyColumn: string;
  /**
   * Non-generated columns to compare/copy. Must be identical between the old
   * table and the shadow table (this framework migrates a table's storage
   * shape/backing, not its logical column set).
   */
  columns: string[];
  /**
   * Custom `CREATE TABLE` statement for the shadow table, for migrations
   * that actually change the schema shape (renamed/retyped/split columns).
   * Defaults to `CREATE TABLE IF NOT EXISTS <shadow> (LIKE <table> INCLUDING ALL)`,
   * which is only correct when the shadow table's shape is identical to the
   * old table (e.g. a storage/indexing-strategy migration).
   */
  createShadowTableSql?: string;
  /** Rows copied per backfill batch. Default 1000. */
  batchSize?: number;
  /** Fraction (0-1) of post-cutover failures that triggers auto-rollback. Default 0.05. */
  errorRateThreshold?: number;
  /** Rolling window (ms) the error rate is evaluated over. Default 60_000. */
  errorRateWindowMs?: number;
  /** Minimum sample count within the window before the error rate is trusted. Default 20. */
  minSamplesForRollback?: number;
}

export interface RowMismatch {
  primaryKey: string;
  column: string;
  oldValue: unknown;
  shadowValue: unknown;
}

export interface ParityReport {
  totalOldRows: number;
  totalShadowRows: number;
  missingInShadow: number;
  missingInOld: number;
  mismatchedRows: number;
  /** Capped sample of individual mismatches for diagnostics; counts above are exhaustive. */
  mismatches: RowMismatch[];
  passed: boolean;
  checkedAt: Date;
}

export interface MigrationState {
  phase: MigrationPhase;
  dualWriteStartedAt?: Date;
  backfillCompletedAt?: Date;
  lastParityReport?: ParityReport;
  cutoverAt?: Date;
  rolledBackAt?: Date;
  rollbackReason?: string;
  completedAt?: Date;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSafeIdentifier(name: string, kind: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `MigrationOrchestrator: unsafe ${kind} identifier "${name}" — must match ${IDENTIFIER_RE}`,
    );
  }
}

function quoteIdent(name: string): string {
  return `"${name}"`;
}

export class MigrationOrchestrator {
  private readonly prisma: PrismaClient;
  private readonly config: Required<MigrationConfig>;
  private state: MigrationState = { phase: "idle" };
  private middlewareInstalled = false;
  private outcomes: Array<{ at: number; success: boolean }> = [];

  constructor(prisma: PrismaClient, config: MigrationConfig) {
    assertSafeIdentifier(config.tableName, "tableName");
    assertSafeIdentifier(config.shadowTableName, "shadowTableName");
    assertSafeIdentifier(config.viewName, "viewName");
    assertSafeIdentifier(config.primaryKeyColumn, "primaryKeyColumn");
    for (const col of config.columns) {
      assertSafeIdentifier(col, "column");
    }

    this.prisma = prisma;
    this.config = {
      createShadowTableSql: `CREATE TABLE IF NOT EXISTS ${quoteIdent(config.shadowTableName)} (LIKE ${quoteIdent(config.tableName)} INCLUDING ALL)`,
      batchSize: 1000,
      errorRateThreshold: 0.05,
      errorRateWindowMs: 60_000,
      minSamplesForRollback: 20,
      ...config,
    };
  }

  getState(): Readonly<MigrationState> {
    return this.state;
  }

  private requirePhase(...allowed: MigrationPhase[]): void {
    if (!allowed.includes(this.state.phase)) {
      throw new Error(
        `MigrationOrchestrator: cannot perform this action in phase "${this.state.phase}" (expected one of: ${allowed.join(", ")})`,
      );
    }
  }

  // ── Phase 1: dual-write ────────────────────────────────────────────────

  /**
   * Creates the shadow table (same structure as the live table) if it
   * doesn't exist, points the read view at the old table (so existing
   * readers are unaffected), and installs Prisma middleware that mirrors
   * every write to `modelName` onto the shadow table too.
   */
  async startDualWrite(): Promise<void> {
    this.requirePhase("idle");

    const table = quoteIdent(this.config.tableName);
    const view = quoteIdent(this.config.viewName);

    await this.prisma.$executeRawUnsafe(this.config.createShadowTableSql);
    await this.prisma.$executeRawUnsafe(
      `CREATE OR REPLACE VIEW ${view} AS SELECT * FROM ${table}`,
    );

    this.installDualWriteMiddleware();

    this.state = {
      ...this.state,
      phase: "dual_write",
      dualWriteStartedAt: new Date(),
    };
  }

  private installDualWriteMiddleware(): void {
    if (this.middlewareInstalled) return;

    const middleware: Prisma.Middleware = async (params, next) => {
      const result = await next(params);

      const mirroring: MigrationPhase[] = [
        "dual_write",
        "backfilling",
        "verifying",
        "verified",
      ];
      if (params.model !== this.config.modelName || !mirroring.includes(this.state.phase)) {
        return result;
      }

      try {
        await this.mirrorWrite(params.action, params.args, result);
      } catch (err) {
        // Dual-write mirroring must never break the primary write path —
        // the primary table is always the source of truth until cutover.
        console.error("MigrationOrchestrator: dual-write mirror failed", err);
      }

      return result;
    };

    this.prisma.$use(middleware);
    this.middlewareInstalled = true;
  }

  private async mirrorWrite(action: string, args: any, result: any): Promise<void> {
    switch (action) {
      case "create":
      case "update":
      case "upsert":
        if (result) await this.upsertShadowRow(result);
        return;
      case "delete":
        if (result) await this.deleteShadowRow(result[this.config.primaryKeyColumn]);
        return;
      case "createMany":
        if (Array.isArray(result) ? result.length : true) {
          // createMany doesn't return created rows; re-read by the data's
          // natural keys isn't generically possible, so re-read via the
          // batch's primary keys when the caller supplied them.
          const rows: any[] = Array.isArray(args?.data) ? args.data : [];
          for (const row of rows) {
            if (row[this.config.primaryKeyColumn] !== undefined) {
              await this.copyRowFromOldToShadow(row[this.config.primaryKeyColumn]);
            }
          }
        }
        return;
      case "updateMany": {
        const affected = await this.findAffectedPrimaryKeys(args?.where);
        for (const pk of affected) {
          await this.copyRowFromOldToShadow(pk);
        }
        return;
      }
      case "deleteMany": {
        // Rows are already gone from the old table by the time we get here,
        // so mirror the same predicate directly against the shadow table.
        await this.deleteManyShadowByOldPredicate(args?.where);
        return;
      }
      default:
        return;
    }
  }

  private async upsertShadowRow(row: Record<string, unknown>): Promise<void> {
    const cols = [this.config.primaryKeyColumn, ...this.config.columns.filter(c => c !== this.config.primaryKeyColumn)];
    const shadow = quoteIdent(this.config.shadowTableName);
    const pk = quoteIdent(this.config.primaryKeyColumn);

    const values = cols.map(c => row[c] ?? null);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const colList = cols.map(quoteIdent).join(", ");
    const updateSet = cols
      .filter(c => c !== this.config.primaryKeyColumn)
      .map(c => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
      .join(", ");

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO ${shadow} (${colList}) VALUES (${placeholders})
       ON CONFLICT (${pk}) DO UPDATE SET ${updateSet}`,
      ...values,
    );
  }

  private async deleteShadowRow(primaryKey: unknown): Promise<void> {
    const shadow = quoteIdent(this.config.shadowTableName);
    const pk = quoteIdent(this.config.primaryKeyColumn);
    await this.prisma.$executeRawUnsafe(`DELETE FROM ${shadow} WHERE ${pk} = $1`, primaryKey);
  }

  private async copyRowFromOldToShadow(primaryKey: unknown): Promise<void> {
    const table = quoteIdent(this.config.tableName);
    const pk = quoteIdent(this.config.primaryKeyColumn);
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM ${table} WHERE ${pk} = $1`,
      primaryKey,
    );
    if (rows[0]) {
      await this.upsertShadowRow(rows[0]);
    } else {
      await this.deleteShadowRow(primaryKey);
    }
  }

  private async findAffectedPrimaryKeys(where: unknown): Promise<unknown[]> {
    // Best-effort: re-read the current state of the old table restricted to
    // the primary keys the update touched, using Prisma's own query builder
    // (not raw SQL) so arbitrary `where` shapes are supported safely.
    const model = (this.prisma as any)[this.lowerFirst(this.config.modelName)];
    if (!model) return [];
    const rows: Array<Record<string, unknown>> = await model.findMany({
      where,
      select: { [this.config.primaryKeyColumn]: true },
    });
    return rows.map(r => r[this.config.primaryKeyColumn]);
  }

  private async deleteManyShadowByOldPredicate(where: unknown): Promise<void> {
    // deleteMany already removed the rows from the old table, so we can no
    // longer resolve `where` against it. Instead, delete from the shadow
    // table anything that is no longer present in the old table.
    const table = quoteIdent(this.config.tableName);
    const shadow = quoteIdent(this.config.shadowTableName);
    const pk = quoteIdent(this.config.primaryKeyColumn);
    void where;
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM ${shadow} s WHERE NOT EXISTS (SELECT 1 FROM ${table} o WHERE o.${pk} = s.${pk})`,
    );
  }

  private lowerFirst(s: string): string {
    return s.charAt(0).toLowerCase() + s.slice(1);
  }

  // ── Phase 2: backfill ─────────────────────────────────────────────────

  /**
   * Copies rows from the old table into the shadow table in batches,
   * ordered by primary key. Uses `ON CONFLICT DO NOTHING` so a row already
   * written by a concurrent dual-write (which reflects a newer state) is
   * never clobbered by a stale backfilled snapshot.
   */
  async runBackfill(): Promise<{ rowsCopied: number }> {
    this.requirePhase("dual_write");
    this.state = { ...this.state, phase: "backfilling" };

    const table = quoteIdent(this.config.tableName);
    const shadow = quoteIdent(this.config.shadowTableName);
    const pk = quoteIdent(this.config.primaryKeyColumn);
    const colList = [this.config.primaryKeyColumn, ...this.config.columns.filter(c => c !== this.config.primaryKeyColumn)]
      .map(quoteIdent)
      .join(", ");

    let cursor: unknown = null;
    let rowsCopied = 0;

    for (;;) {
      const batch = cursor === null
        ? await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT * FROM ${table} ORDER BY ${pk} ASC LIMIT $1`,
            this.config.batchSize,
          )
        : await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT * FROM ${table} WHERE ${pk} > $1 ORDER BY ${pk} ASC LIMIT $2`,
            cursor,
            this.config.batchSize,
          );

      if (batch.length === 0) break;

      await this.prisma.$executeRawUnsafe(
        `INSERT INTO ${shadow} (${colList})
         SELECT ${colList} FROM ${table} WHERE ${pk} = ANY($1::text[])
         ON CONFLICT (${pk}) DO NOTHING`,
        batch.map(r => String(r[this.config.primaryKeyColumn])),
      );

      rowsCopied += batch.length;
      cursor = batch[batch.length - 1][this.config.primaryKeyColumn];
    }

    this.state = {
      ...this.state,
      phase: "dual_write",
      backfillCompletedAt: new Date(),
    };

    return { rowsCopied };
  }

  // ── Phase 3: verify ───────────────────────────────────────────────────

  /**
   * Compares every row between the old table and the shadow table (no
   * sampling). Returns a pass/fail report; `cutover` refuses to run unless
   * the most recent report passed.
   */
  async verifyParity(maxSampledMismatches = 100): Promise<ParityReport> {
    this.requirePhase("dual_write", "backfilling", "verifying");
    this.state = { ...this.state, phase: "verifying" };

    const table = quoteIdent(this.config.tableName);
    const shadow = quoteIdent(this.config.shadowTableName);
    const pk = quoteIdent(this.config.primaryKeyColumn);

    const [{ count: totalOldRows }] = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM ${table}`,
    );
    const [{ count: totalShadowRows }] = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM ${shadow}`,
    );

    const [{ count: missingInShadow }] = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM ${table} o
       WHERE NOT EXISTS (SELECT 1 FROM ${shadow} s WHERE s.${pk} = o.${pk})`,
    );
    const [{ count: missingInOld }] = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM ${shadow} s
       WHERE NOT EXISTS (SELECT 1 FROM ${table} o WHERE o.${pk} = s.${pk})`,
    );

    const compareCols = this.config.columns.filter(c => c !== this.config.primaryKeyColumn);
    const diffClause = compareCols
      .map(c => `o.${quoteIdent(c)} IS DISTINCT FROM s.${quoteIdent(c)}`)
      .join(" OR ");

    let mismatchedRows = 0;
    const mismatches: RowMismatch[] = [];

    if (compareCols.length > 0) {
      const [{ count }] = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM ${table} o
         JOIN ${shadow} s ON s.${pk} = o.${pk}
         WHERE ${diffClause}`,
      );
      mismatchedRows = Number(count);

      if (mismatchedRows > 0) {
        const selectCols = compareCols
          .map(c => `o.${quoteIdent(c)} AS old_${c}, s.${quoteIdent(c)} AS shadow_${c}`)
          .join(", ");
        const sampled = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT o.${pk} AS pk, ${selectCols} FROM ${table} o
           JOIN ${shadow} s ON s.${pk} = o.${pk}
           WHERE ${diffClause}
           LIMIT $1`,
          maxSampledMismatches,
        );
        for (const row of sampled) {
          for (const c of compareCols) {
            const oldValue = row[`old_${c}`];
            const shadowValue = row[`shadow_${c}`];
            if (oldValue !== shadowValue) {
              mismatches.push({ primaryKey: String(row.pk), column: c, oldValue, shadowValue });
            }
          }
        }
      }
    }

    const passed =
      Number(missingInShadow) === 0 && Number(missingInOld) === 0 && mismatchedRows === 0;

    const report: ParityReport = {
      totalOldRows: Number(totalOldRows),
      totalShadowRows: Number(totalShadowRows),
      missingInShadow: Number(missingInShadow),
      missingInOld: Number(missingInOld),
      mismatchedRows,
      mismatches,
      passed,
      checkedAt: new Date(),
    };

    this.state = {
      ...this.state,
      phase: passed ? "verified" : "verifying",
      lastParityReport: report,
    };

    return report;
  }

  // ── Phase 4: cutover ──────────────────────────────────────────────────

  /**
   * Atomically repoints the read view at the shadow table. This is a single
   * `CREATE OR REPLACE VIEW` statement — no rows are copied at cutover time
   * — and is fully reversible via `rollback`. Hard-blocked unless the most
   * recent `verifyParity` call passed.
   */
  async cutover(): Promise<void> {
    this.requirePhase("verified");
    if (!this.state.lastParityReport?.passed) {
      throw new Error(
        "MigrationOrchestrator: cutover blocked — no passing parity report on file",
      );
    }

    const shadow = quoteIdent(this.config.shadowTableName);
    const view = quoteIdent(this.config.viewName);

    await this.prisma.$executeRawUnsafe(
      `CREATE OR REPLACE VIEW ${view} AS SELECT * FROM ${shadow}`,
    );

    this.outcomes = [];
    this.state = {
      ...this.state,
      phase: "monitoring",
      cutoverAt: new Date(),
    };
  }

  // ── Post-cutover monitoring + automated rollback ─────────────────────

  /**
   * Report the outcome of a post-cutover read/write against the view. Once
   * enough samples land within `errorRateWindowMs`, an error rate above
   * `errorRateThreshold` triggers an automatic `rollback`.
   */
  async recordPostCutoverOutcome(success: boolean): Promise<void> {
    if (this.state.phase !== "monitoring") return;

    const now = Date.now();
    this.outcomes.push({ at: now, success });
    this.outcomes = this.outcomes.filter(o => now - o.at <= this.config.errorRateWindowMs);

    if (this.outcomes.length < this.config.minSamplesForRollback) return;

    const failures = this.outcomes.filter(o => !o.success).length;
    const errorRate = failures / this.outcomes.length;

    if (errorRate > this.config.errorRateThreshold) {
      await this.rollback(
        `post-cutover error rate ${(errorRate * 100).toFixed(1)}% exceeded threshold ${(this.config.errorRateThreshold * 100).toFixed(1)}% over last ${this.outcomes.length} samples`,
      );
    }
  }

  /** Mark the migration as stable, ending the monitoring window. */
  async confirmStable(): Promise<void> {
    this.requirePhase("monitoring");
    this.state = { ...this.state, phase: "completed", completedAt: new Date() };
  }

  /**
   * Atomically repoints the view back at the old table. Safe to call from
   * `monitoring` (automated or manual rollback) or `cutover`.
   */
  async rollback(reason: string): Promise<void> {
    this.requirePhase("cutover", "monitoring");

    const table = quoteIdent(this.config.tableName);
    const view = quoteIdent(this.config.viewName);

    await this.prisma.$executeRawUnsafe(
      `CREATE OR REPLACE VIEW ${view} AS SELECT * FROM ${table}`,
    );

    this.state = {
      ...this.state,
      phase: "rolled_back",
      rolledBackAt: new Date(),
      rollbackReason: reason,
    };
  }

  // ── Phase 5: cleanup ──────────────────────────────────────────────────

  /**
   * Drops the old table now that the shadow table is the confirmed source
   * of truth, and removes dual-write mirroring. Only allowed once
   * `confirmStable` has run.
   */
  async cleanup(): Promise<void> {
    this.requirePhase("completed");

    const table = quoteIdent(this.config.tableName);
    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
    this.middlewareInstalled = false;
  }
}
