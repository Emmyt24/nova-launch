import { v4 as uuidv4 } from "uuid";
import db from "../database/db";
import {
  WebhookSubscription,
  CreateWebhookInput,
  WebhookEventType,
  WebhookPayload,
  WebhookEventData,
  WebhookDeliveryLog,
} from "../types/webhook";
import { generateWebhookSecret, generateWebhookSignature } from "../utils/crypto";
import { globMatch, isValidGlobPattern } from "../utils/globMatch";

/**
 * How long a soft-deleted subscription can still be restored. After this
 * window `purgeExpiredDeleted` may hard-delete it (and its delivery history).
 */
export const WEBHOOK_RESTORE_RETENTION_DAYS = parseInt(
  process.env.WEBHOOK_RESTORE_RETENTION_DAYS || "30"
);

export type RestoreSubscriptionResult =
  | "restored"
  | "not_found"
  | "retention_expired";

export class WebhookService {
  /**
   * Create a new webhook subscription.
   *
   * Each entry in `input.events` may be either a concrete WebhookEventType value
   * or a glob pattern (e.g. `token.*`, `governance.proposal.**`).  Glob patterns
   * are validated at creation time — an invalid pattern causes the method to throw.
   */
  async createSubscription(
    input: CreateWebhookInput
  ): Promise<WebhookSubscription> {
    // Validate any glob patterns supplied in the events array.
    for (const event of input.events) {
      if (event.includes("*") && !isValidGlobPattern(event)) {
        throw new Error(`Invalid glob pattern in events: "${event}"`);
      }
    }

    const id = uuidv4();
    const secret = generateWebhookSecret();

    const query = `
      INSERT INTO webhook_subscriptions
        (id, url, token_address, events, secret, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const result = await db.query(query, [
      id,
      input.url,
      input.tokenAddress || null,
      input.events,
      secret,
      input.createdBy,
    ]);

    return this.mapRowToSubscription(result.rows[0]);
  }

  /**
   * Get subscription by ID. Soft-deleted subscriptions are hidden unless
   * `includeDeleted` is set (e.g. to verify signatures of historical deliveries).
   */
  async getSubscription(
    id: string,
    options: { includeDeleted?: boolean } = {}
  ): Promise<WebhookSubscription | null> {
    const query = options.includeDeleted
      ? "SELECT * FROM webhook_subscriptions WHERE id = $1"
      : "SELECT * FROM webhook_subscriptions WHERE id = $1 AND deleted_at IS NULL";
    const result = await db.query(query, [id]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToSubscription(result.rows[0]);
  }

  /**
   * List subscriptions for a user
   */
  async listSubscriptions(
    createdBy: string,
    active?: boolean
  ): Promise<WebhookSubscription[]> {
    let query =
      "SELECT * FROM webhook_subscriptions WHERE created_by = $1 AND deleted_at IS NULL";
    const params: any[] = [createdBy];

    if (active !== undefined) {
      query += " AND active = $2";
      params.push(active);
    }

    query += " ORDER BY created_at DESC";

    const result = await db.query(query, params);
    return result.rows.map(this.mapRowToSubscription);
  }

  /**
   * Soft-delete a subscription. The row and its delivery history are kept
   * so the subscription can be restored within the retention window.
   */
  async deleteSubscription(id: string, createdBy: string): Promise<boolean> {
    const query = `
      UPDATE webhook_subscriptions
      SET deleted_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND created_by = $2 AND deleted_at IS NULL
      RETURNING id
    `;

    const result = await db.query(query, [id, createdBy]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Restore a soft-deleted subscription if it is still within the
   * retention window.
   */
  async restoreSubscription(
    id: string,
    createdBy: string,
    retentionDays: number = WEBHOOK_RESTORE_RETENTION_DAYS
  ): Promise<RestoreSubscriptionResult> {
    const query = `
      UPDATE webhook_subscriptions
      SET deleted_at = NULL
      WHERE id = $1
        AND created_by = $2
        AND deleted_at IS NOT NULL
        AND deleted_at > CURRENT_TIMESTAMP - ($3 * INTERVAL '1 day')
      RETURNING id
    `;

    const result = await db.query(query, [id, createdBy, retentionDays]);
    if (result.rowCount !== null && result.rowCount > 0) {
      return "restored";
    }

    // Distinguish "never existed / not deleted / not owner" from "too late".
    const existing = await db.query(
      `SELECT deleted_at FROM webhook_subscriptions
       WHERE id = $1 AND created_by = $2 AND deleted_at IS NOT NULL`,
      [id, createdBy]
    );
    return existing.rows.length > 0 ? "retention_expired" : "not_found";
  }

  /**
   * Hard-delete subscriptions whose soft-delete is older than the retention
   * window. Delivery logs are removed via ON DELETE CASCADE.
   */
  async purgeExpiredDeleted(
    retentionDays: number = WEBHOOK_RESTORE_RETENTION_DAYS
  ): Promise<number> {
    const query = `
      DELETE FROM webhook_subscriptions
      WHERE deleted_at IS NOT NULL
        AND deleted_at <= CURRENT_TIMESTAMP - ($1 * INTERVAL '1 day')
    `;

    const result = await db.query(query, [retentionDays]);
    return result.rowCount ?? 0;
  }

  /**
   * Update subscription active status
   */
  async updateSubscriptionStatus(
    id: string,
    active: boolean
  ): Promise<boolean> {
    const query = `
      UPDATE webhook_subscriptions 
      SET active = $1 
      WHERE id = $2 AND deleted_at IS NULL
      RETURNING id
    `;

    const result = await db.query(query, [active, id]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Find subscriptions matching an event.
   *
   * A subscription matches when:
   *  1. It is active.
   *  2. Its token_address is NULL (wildcard) or equals the supplied tokenAddress.
   *  3. At least one of its events entries either:
   *       a. Exactly equals the incoming event type, OR
   *       b. Is a glob pattern that matches the incoming event type string.
   */
  async findMatchingSubscriptions(
    event: WebhookEventType,
    tokenAddress?: string | null
  ): Promise<WebhookSubscription[]> {
    // Fetch all active subscriptions filtered by token address at the DB level.
    // Event matching (including glob patterns) is done in-process so we can use
    // the hand-rolled glob engine without relying on a Postgres extension.
    const query = `
      SELECT * FROM webhook_subscriptions
      WHERE active = true
        AND deleted_at IS NULL
        AND (token_address IS NULL OR token_address = $1)
    `;

    const result = await db.query(query, [tokenAddress ?? null]);
    const subscriptions: WebhookSubscription[] = result.rows.map(
      this.mapRowToSubscription
    );

    // Filter by event type — supports exact matches and glob patterns.
    return subscriptions.filter((sub) =>
      sub.events.some((pattern) => {
        if (pattern === event) return true;
        if (pattern.includes("*")) return globMatch(pattern, event);
        return false;
      })
    );
  }

  /**
   * Update last triggered timestamp
   */
  async updateLastTriggered(id: string): Promise<void> {
    const query = `
      UPDATE webhook_subscriptions 
      SET last_triggered = CURRENT_TIMESTAMP 
      WHERE id = $1
    `;

    await db.query(query, [id]);
  }

  /**
   * Log webhook delivery
   */
  async logDelivery(
    subscriptionId: string,
    event: WebhookEventType,
    payload: WebhookPayload,
    statusCode: number | null,
    success: boolean,
    attempts: number,
    errorMessage: string | null = null
  ): Promise<void> {
    const query = `
      INSERT INTO webhook_delivery_logs 
        (subscription_id, event, payload, status_code, success, attempts, error_message)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    await db.query(query, [
      subscriptionId,
      event,
      JSON.stringify(payload),
      statusCode,
      success,
      attempts,
      errorMessage,
    ]);
  }

  /**
   * Get delivery logs for a subscription
   */
  async getDeliveryLogs(
    subscriptionId: string,
    limit: number = 50
  ): Promise<WebhookDeliveryLog[]> {
    const query = `
      SELECT * FROM webhook_delivery_logs 
      WHERE subscription_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2
    `;

    const result = await db.query(query, [subscriptionId, limit]);
    return result.rows.map(this.mapRowToDeliveryLog);
  }

  /**
   * Get a single delivery log by its own ID
   */
  async getDeliveryLogById(id: string): Promise<WebhookDeliveryLog | null> {
    const query = "SELECT * FROM webhook_delivery_logs WHERE id = $1";
    const result = await db.query(query, [id]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToDeliveryLog(result.rows[0]);
  }

  /**
   * Create webhook payload with signature
   */
  createPayload(
    event: WebhookEventType,
    data: WebhookEventData,
    secret: string
  ): WebhookPayload {
    const timestamp = new Date().toISOString();
    const payload: Omit<WebhookPayload, "signature"> = {
      event,
      timestamp,
      data,
    };

    const payloadString = JSON.stringify(payload);
    const signature = generateWebhookSignature(payloadString, secret);

    return {
      ...payload,
      signature,
    };
  }

  /**
   * Map database row to WebhookSubscription
   */
  private mapRowToSubscription(row: any): WebhookSubscription {
    return {
      id: row.id,
      url: row.url,
      tokenAddress: row.token_address,
      events: row.events,
      secret: row.secret,
      active: row.active,
      createdBy: row.created_by,
      createdAt: row.created_at,
      lastTriggered: row.last_triggered,
      deletedAt: row.deleted_at ?? null,
    };
  }

  /**
   * Map database row to WebhookDeliveryLog
   */
  private mapRowToDeliveryLog(row: any): WebhookDeliveryLog {
    return {
      id: row.id,
      subscriptionId: row.subscription_id,
      event: row.event,
      payload: row.payload,
      statusCode: row.status_code,
      success: row.success,
      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    };
  }
}

export default new WebhookService();
