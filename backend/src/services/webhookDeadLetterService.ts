import { v4 as uuidv4 } from "uuid";
import db from "../database/db";
import { WebhookEventType } from "../types/webhook";

/**
 * Maximum number of times a single dead-letter entry may be requeued before
 * the poison-message guard blocks further requeueing. This prevents a
 * permanently-broken endpoint from being retried indefinitely via manual or
 * automatic requeue operations.
 */
export const MAX_REQUEUE_CYCLES = parseInt(
  process.env.WEBHOOK_DLQ_MAX_REQUEUE_CYCLES ?? "3"
);

export interface DeadLetterEntry {
  id: string;
  subscriptionId: string;
  event: WebhookEventType;
  payload: string;
  statusCode: number | null;
  lastError: string | null;
  attemptCount: number;
  /**
   * How many times this entry has been requeued for redelivery. Once this
   * reaches MAX_REQUEUE_CYCLES the poison-message guard prevents further
   * requeueing.
   */
  requeueCount: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

/**
 * Filters supported when listing dead-letter entries across all subscriptions.
 *
 * Tenant note: this codebase has no dedicated "tenant" column anywhere in the
 * webhook tables. The closest analog is `webhook_subscriptions.created_by`
 * (the Stellar address that owns the subscription) — every dead-letter entry
 * is joined back to its subscription so admins can filter "by tenant" using
 * that `createdBy` address. If a real multi-tenant column is introduced later,
 * update `listAllPaginated` to filter on it directly instead of joining.
 */
export interface DeadLetterListFilters {
  tenant?: string; // matches webhook_subscriptions.created_by
  failureReason?: string; // matches webhook_dead_letters.last_error (substring, case-insensitive)
  resolved?: boolean; // when omitted, returns both resolved and unresolved entries
}

export interface DeadLetterListResult {
  entries: DeadLetterEntry[];
  total: number;
}

export class WebhookDeadLetterService {
  /**
   * Store a failed delivery in the dead-letter queue
   */
  async storeDeadLetter(
    subscriptionId: string,
    event: WebhookEventType,
    payload: any,
    statusCode: number | null,
    lastError: string | null,
    attemptCount: number
  ): Promise<string> {
    const id = uuidv4();
    const query = `
      INSERT INTO webhook_dead_letters
        (id, subscription_id, event, payload, status_code, last_error, attempt_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `;

    const result = await db.query(query, [
      id,
      subscriptionId,
      event,
      JSON.stringify(payload),
      statusCode,
      lastError,
      attemptCount,
    ]);

    return result.rows[0].id;
  }

  /**
   * List unresolved dead-letter entries for a subscription
   */
  async listUnresolved(
    subscriptionId: string,
    limit: number = 50
  ): Promise<DeadLetterEntry[]> {
    const query = `
      SELECT * FROM webhook_dead_letters
      WHERE subscription_id = $1 AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT $2
    `;

    const result = await db.query(query, [subscriptionId, limit]);
    return result.rows.map(this.mapRowToEntry);
  }

  /**
   * List dead-letter entries across ALL subscriptions, with pagination and
   * optional filtering by tenant (subscription owner) and failure reason.
   *
   * Joins to `webhook_subscriptions` so callers can filter by `created_by`
   * (the closest existing field to a "tenant" identifier — see
   * `DeadLetterListFilters` for rationale).
   */
  async listAllPaginated(
    page: number,
    limit: number,
    filters: DeadLetterListFilters = {}
  ): Promise<DeadLetterListResult> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.tenant) {
      params.push(filters.tenant);
      conditions.push(`s.created_by = $${params.length}`);
    }

    if (filters.failureReason) {
      params.push(`%${filters.failureReason}%`);
      conditions.push(`d.last_error ILIKE $${params.length}`);
    }

    if (filters.resolved === true) {
      conditions.push(`d.resolved_at IS NOT NULL`);
    } else if (filters.resolved === false) {
      conditions.push(`d.resolved_at IS NULL`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM webhook_dead_letters d
      JOIN webhook_subscriptions s ON s.id = d.subscription_id
      ${whereClause}
    `;
    const countResult = await db.query(countQuery, params);
    const total = parseInt(countResult.rows[0]?.total ?? "0", 10);

    const offset = (page - 1) * limit;
    const listParams = [...params, limit, offset];
    const listQuery = `
      SELECT d.*
      FROM webhook_dead_letters d
      JOIN webhook_subscriptions s ON s.id = d.subscription_id
      ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;
    const listResult = await db.query(listQuery, listParams);

    return {
      entries: listResult.rows.map(this.mapRowToEntry),
      total,
    };
  }

  /**
   * Get a specific dead-letter entry by ID
   */
  async getEntry(id: string): Promise<DeadLetterEntry | null> {
    const query = `
      SELECT * FROM webhook_dead_letters WHERE id = $1
    `;

    const result = await db.query(query, [id]);
    if (result.rows.length === 0) return null;
    return this.mapRowToEntry(result.rows[0]);
  }

  /**
   * Mark a dead-letter entry as resolved (retried/skipped/etc)
   */
  async markResolved(
    id: string,
    resolution: "retried" | "skipped" | "archived"
  ): Promise<boolean> {
    const query = `
      UPDATE webhook_dead_letters
      SET resolved_at = CURRENT_TIMESTAMP, resolution = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id
    `;

    const result = await db.query(query, [resolution, id]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Increment the requeue counter for a dead-letter entry and return the
   * updated entry. Applies the poison-message guard: if the entry has already
   * been requeued MAX_REQUEUE_CYCLES times, throws a PoisonMessageError
   * instead of incrementing so callers can surface the appropriate error.
   *
   * The counter is persisted in the `requeue_count` column so the guard
   * survives process restarts.
   */
  async requeueDeadLetter(id: string): Promise<DeadLetterEntry> {
    // Read current count first so we can enforce the guard before writing.
    const entry = await this.getEntry(id);
    if (!entry) {
      throw new Error(`Dead-letter entry not found: ${id}`);
    }

    if (entry.requeueCount >= MAX_REQUEUE_CYCLES) {
      throw new PoisonMessageError(
        `Dead-letter entry ${id} has been requeued ${entry.requeueCount} time(s) ` +
          `and has reached the maximum of ${MAX_REQUEUE_CYCLES}. ` +
          `Mark it as archived to stop processing.`,
        entry
      );
    }

    const query = `
      UPDATE webhook_dead_letters
      SET requeue_count = requeue_count + 1,
          resolved_at   = NULL,
          resolution    = NULL,
          updated_at    = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    const result = await db.query(query, [id]);
    return this.mapRowToEntry(result.rows[0]);
  }

  /**
   * Map database row to DeadLetterEntry
   */
  private mapRowToEntry(row: any): DeadLetterEntry {
    return {
      id: row.id,
      subscriptionId: row.subscription_id,
      event: row.event,
      payload: row.payload,
      statusCode: row.status_code,
      lastError: row.last_error,
      attemptCount: row.attempt_count,
      requeueCount: row.requeue_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      resolution: row.resolution,
    };
  }
}

// ---------------------------------------------------------------------------
// PoisonMessageError
// ---------------------------------------------------------------------------

/**
 * Thrown by `requeueDeadLetter` when the poison-message guard is triggered:
 * the entry has been requeued too many times and must be manually archived.
 */
export class PoisonMessageError extends Error {
  /** The dead-letter entry that triggered the guard. */
  readonly entry: DeadLetterEntry;

  constructor(message: string, entry: DeadLetterEntry) {
    super(message);
    this.name = "PoisonMessageError";
    this.entry = entry;
  }
}

export default new WebhookDeadLetterService();
