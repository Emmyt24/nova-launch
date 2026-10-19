/**
 * API key rotation with grace period (#2189).
 *
 * Wraps `ApiKeyManager.rotate()` with the side effects an operator expects:
 *   1. A new key is issued while the old one stays valid for a configurable
 *      grace window (no downtime while clients roll over).
 *   2. The rotation is written to the admin audit trail.
 *   3. The key owner is notified (email when an address is on file).
 *
 * Audit and notification failures are logged but never undo the rotation:
 * the new raw key has already been generated and must reach the caller.
 */

import { Database } from "../config/database";
import { ApiKeyManager, apiKeyManager } from "../auth/apiKey";
import { logger } from "../lib/logger";
import { getCorrelationId } from "../lib/async-context";
import notificationService from "./notificationService";
import type { NotificationRequest, NotificationResult } from "../types/notification";

export const API_KEY_AUDIT_RESOURCE = "api_key";
export const API_KEY_ROTATED_ACTION = "API_KEY_ROTATED";
export const API_KEY_ROTATION_COMMITTED_ACTION = "API_KEY_ROTATION_COMMITTED";

export interface RotationActor {
  id: string;
  ipAddress: string;
  userAgent: string;
}

export interface RotateApiKeyInput {
  keyId: string;
  /** Grace window for the old key in ms. Omit to use the configured default. */
  graceMs?: number;
  actor: RotationActor;
}

export interface RotateApiKeyResult {
  id: string;
  rawKey: string;
  graceEndsAt: string;
  graceMs: number;
  ownerNotified: boolean;
}

interface Notifier {
  send(request: NotificationRequest): Promise<NotificationResult[]>;
}

interface AuditWriter {
  createAuditLog: typeof Database.createAuditLog;
}

export class ApiKeyRotationService {
  constructor(
    private readonly manager: ApiKeyManager = apiKeyManager,
    private readonly audit: AuditWriter = Database,
    private readonly notifier: Notifier = notificationService
  ) {}

  async rotate({ keyId, graceMs, actor }: RotateApiKeyInput): Promise<RotateApiKeyResult> {
    const before = this.manager.get(keyId);
    if (!before) throw new Error(`API key not found: ${keyId}`);

    const effectiveGraceMs = graceMs ?? this.manager.defaultGraceMs;
    const result = this.manager.rotate(keyId, { graceMs: effectiveGraceMs });
    const after = this.manager.get(keyId)!;
    const graceEndsAt = new Date(result.graceEndsAt).toISOString();

    await this.writeAudit(API_KEY_ROTATED_ACTION, keyId, actor, {
      status: before.status,
    }, {
      status: after.status,
      graceMs: effectiveGraceMs,
      graceEndsAt,
    });

    const ownerNotified = await this.notifyOwner(after.ownerId, after.ownerEmail, {
      subject: "Your Nova Launch API key was rotated",
      message:
        effectiveGraceMs > 0
          ? `API key "${after.name}" was rotated. The previous key remains valid until ${graceEndsAt}; update your integrations before then.`
          : `API key "${after.name}" was rotated. The previous key was invalidated immediately.`,
      metadata: { keyId, keyName: after.name, graceEndsAt, rotatedBy: actor.id },
    });

    return {
      id: result.id,
      rawKey: result.rawKey,
      graceEndsAt,
      graceMs: effectiveGraceMs,
      ownerNotified,
    };
  }

  /** End the grace period early, invalidating the previous key now. */
  async commit(keyId: string, actor: RotationActor): Promise<void> {
    this.manager.commitRotation(keyId);
    await this.writeAudit(
      API_KEY_ROTATION_COMMITTED_ACTION,
      keyId,
      actor,
      { status: "rotating" },
      { status: "active" }
    );
  }

  private async writeAudit(
    action: string,
    keyId: string,
    actor: RotationActor,
    beforeState: Record<string, unknown>,
    afterState: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.audit.createAuditLog({
        adminId: actor.id,
        action,
        resource: API_KEY_AUDIT_RESOURCE,
        resourceId: keyId,
        beforeState,
        afterState,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      });
    } catch (error) {
      logger.error("Failed to write API key audit log", {
        action,
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async notifyOwner(
    ownerId: string | null,
    ownerEmail: string | null,
    payload: NotificationRequest["payload"]
  ): Promise<boolean> {
    if (!ownerEmail) {
      logger.warn("API key has no owner contact; rotation notification skipped", {
        keyId: payload.metadata?.keyId,
      });
      return false;
    }

    try {
      const results = await this.notifier.send({
        targets: [{ type: "EMAIL", destination: ownerEmail }],
        payload,
        correlationId: getCorrelationId(),
        ...(ownerId && { userId: ownerId }),
      });
      return results.some((r) => r.success);
    } catch (error) {
      logger.error("Failed to notify API key owner of rotation", {
        keyId: payload.metadata?.keyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

export default new ApiKeyRotationService();
