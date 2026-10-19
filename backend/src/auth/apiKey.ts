/**
 * API Key Management System with Rotation Support.
 *
 * Design:
 *   - Keys are stored as SHA-256 hashes; the raw key is returned only at
 *     creation/rotation time and never persisted.  This follows the same
 *     principle as password hashing: a compromised store does not expose
 *     live credentials.
 *   - Rotation is a two-phase operation: a new key is issued while the old
 *     key remains valid until `commitRotation()` is called (or the grace
 *     period expires).  This prevents downtime during key rollover.
 *   - All comparisons use `crypto.timingSafeEqual` to prevent timing attacks,
 *     matching the pattern in `src/auth/api-key.guard.ts`.
 *   - Keys are prefixed with `nlk_` (nova-launch key) so they are
 *     recognisable and can be detected by secret-scanning tools.
 *
 * Security properties (OWASP API Security Top 10):
 *   - API2: Broken Authentication — keys are 32 random bytes (256-bit entropy)
 *   - API3: Excessive Data Exposure — raw key never stored or logged
 *   - API4: Lack of Resources & Rate Limiting — callers should apply rate
 *     limiting at the route level (see existing `rateLimiter.ts`)
 *   - API8: Injection — no SQL; in-memory Map used (Prisma layer is separate)
 *
 * Assumptions / limitations:
 *   - The in-memory store is process-local.  For multi-instance deployments,
 *     replace `ApiKeyStore` with a Prisma-backed implementation using the
 *     `IntegrationState` or a dedicated `ApiKey` model.
 *   - Grace period defaults to 24 hours; adjust via `rotationGraceMs`, the
 *     `API_KEY_ROTATION_GRACE_MS` env var, or per rotation via
 *     `rotate(id, { graceMs })` (#2189). Grace is capped at `MAX_GRACE_MS`.
 */

import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApiKeyStatus = "active" | "rotating" | "revoked";

export interface ApiKeyRecord {
  /** Opaque identifier (UUID). */
  id: string;
  /** Human-readable label supplied by the creator. */
  name: string;
  /** SHA-256 hash of the current raw key. */
  keyHash: string;
  /**
   * SHA-256 hash of the previous key during a rotation grace period.
   * Both `keyHash` and `prevKeyHash` are accepted until `commitRotation`.
   */
  prevKeyHash: string | null;
  /** Timestamp when the rotation was initiated (ms since epoch). */
  rotationStartedAt: number | null;
  /** When the previous key stops being accepted (ms since epoch). */
  graceEndsAt: number | null;
  /** User who owns the key and is notified about lifecycle changes. */
  ownerId: string | null;
  /** Contact address for owner notifications. */
  ownerEmail: string | null;
  status: ApiKeyStatus;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface CreateKeyResult {
  id: string;
  /** Raw key — shown once, never stored. */
  rawKey: string;
}

export interface CreateKeyOptions {
  ownerId?: string;
  ownerEmail?: string;
}

export interface RotateKeyOptions {
  /** How long the previous key stays valid, in ms. Defaults to the manager's grace period. */
  graceMs?: number;
}

export interface RotateKeyResult {
  id: string;
  /** New raw key — shown once, never stored. */
  rawKey: string;
  /** Grace period end (ms since epoch). Old key valid until this time. */
  graceEndsAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const KEY_PREFIX = "nlk_";
/** Raw key byte length before hex encoding (256-bit entropy). */
const KEY_BYTES = 32;
/** Default rotation grace period: 24 hours. */
export const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
/** Upper bound for a rotation grace period: 30 days. */
export const MAX_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Validate a grace period. `0` is allowed and invalidates the previous key
 * immediately (equivalent to rotate + commit).
 */
export function assertValidGraceMs(graceMs: number): void {
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > MAX_GRACE_MS) {
    throw new RangeError(
      `Grace period must be an integer between 0 and ${MAX_GRACE_MS} ms`
    );
  }
}

/** Resolve the default grace period from API_KEY_ROTATION_GRACE_MS. */
export function resolveDefaultGraceMs(
  value: string | undefined = process.env.API_KEY_ROTATION_GRACE_MS
): number {
  if (value === undefined || value.trim() === "") return DEFAULT_GRACE_MS;
  const parsed = Number(value);
  assertValidGraceMs(parsed);
  return parsed;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generates a cryptographically secure raw API key. */
function generateRawKey(): string {
  return KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString("hex");
}

/** Returns the SHA-256 hex digest of a raw key. */
export function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Constant-time comparison of two hex-encoded hashes.
 * Returns false immediately (without timing leak) if lengths differ.
 */
function safeHashEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ─── ApiKeyManager ────────────────────────────────────────────────────────────

export class ApiKeyManager {
  private readonly store = new Map<string, ApiKeyRecord>();
  private readonly graceMs: number;

  constructor(options: { rotationGraceMs?: number } = {}) {
    this.graceMs = options.rotationGraceMs ?? resolveDefaultGraceMs();
  }

  /** Default grace period applied when `rotate()` is called without one. */
  get defaultGraceMs(): number {
    return this.graceMs;
  }

  /**
   * Creates a new API key.
   *
   * @returns `{ id, rawKey }` — store `id`, show `rawKey` once to the user.
   */
  create(name: string, options: CreateKeyOptions = {}): CreateKeyResult {
    if (!name || !name.trim()) {
      throw new Error("API key name is required");
    }

    const rawKey = generateRawKey();
    const id = crypto.randomUUID();

    this.store.set(id, {
      id,
      name: name.trim(),
      keyHash: hashKey(rawKey),
      prevKeyHash: null,
      rotationStartedAt: null,
      graceEndsAt: null,
      ownerId: options.ownerId ?? null,
      ownerEmail: options.ownerEmail ?? null,
      status: "active",
      createdAt: Date.now(),
      lastUsedAt: null,
    });

    return { id, rawKey };
  }

  /**
   * Validates a raw key against all active records.
   *
   * Accepts both the current key and the previous key during a grace period.
   * Updates `lastUsedAt` on a successful match.
   *
   * @returns The matching `ApiKeyRecord`, or `null` if invalid/revoked.
   */
  validate(rawKey: string): ApiKeyRecord | null {
    if (!rawKey?.startsWith(KEY_PREFIX)) return null;

    const incomingHash = hashKey(rawKey);

    for (const record of this.store.values()) {
      if (record.status === "revoked") continue;

      // Check current key
      if (safeHashEqual(incomingHash, record.keyHash)) {
        record.lastUsedAt = Date.now();
        return record;
      }

      // Check previous key during grace period
      if (
        record.status === "rotating" &&
        record.prevKeyHash !== null &&
        record.graceEndsAt !== null
      ) {
        const graceExpired = Date.now() > record.graceEndsAt;

        if (!graceExpired && safeHashEqual(incomingHash, record.prevKeyHash)) {
          record.lastUsedAt = Date.now();
          return record;
        }

        // Grace period expired — auto-commit rotation
        if (graceExpired) {
          record.prevKeyHash = null;
          record.rotationStartedAt = null;
          record.graceEndsAt = null;
          record.status = "active";
        }
      }
    }

    return null;
  }

  /**
   * Initiates key rotation.
   *
   * Issues a new key while keeping the old key valid for `options.graceMs`
   * (default: `rotationGraceMs`). Call `commitRotation(id)` once the new key
   * is deployed everywhere. A grace of `0` invalidates the old key immediately.
   *
   * Rotating a key that is already mid-rotation drops the oldest key: only
   * the key being replaced now remains valid during the new grace window.
   *
   * @returns `{ id, rawKey, graceEndsAt }`
   * @throws If the key does not exist, is revoked, or the grace is out of range.
   */
  rotate(id: string, options: RotateKeyOptions = {}): RotateKeyResult {
    const record = this.store.get(id);
    if (!record) throw new Error(`API key not found: ${id}`);
    if (record.status === "revoked") throw new Error("Cannot rotate a revoked key");

    const graceMs = options.graceMs ?? this.graceMs;
    assertValidGraceMs(graceMs);

    const rawKey = generateRawKey();
    const now = Date.now();
    const graceEndsAt = now + graceMs;

    const replacedKeyHash = record.keyHash;
    record.keyHash = hashKey(rawKey);
    if (graceMs === 0) {
      record.prevKeyHash = null;
      record.rotationStartedAt = null;
      record.graceEndsAt = null;
      record.status = "active";
    } else {
      record.prevKeyHash = replacedKeyHash;
      record.rotationStartedAt = now;
      record.graceEndsAt = graceEndsAt;
      record.status = "rotating";
    }

    return { id, rawKey, graceEndsAt };
  }

  /**
   * Commits a rotation, immediately invalidating the previous key.
   *
   * @throws If the key does not exist or is not in `rotating` status.
   */
  commitRotation(id: string): void {
    const record = this.store.get(id);
    if (!record) throw new Error(`API key not found: ${id}`);
    if (record.status !== "rotating") {
      throw new Error("Key is not in rotating status");
    }

    record.prevKeyHash = null;
    record.rotationStartedAt = null;
    record.graceEndsAt = null;
    record.status = "active";
  }

  /**
   * Revokes a key immediately.  Revoked keys cannot be validated or rotated.
   *
   * @throws If the key does not exist.
   */
  revoke(id: string): void {
    const record = this.store.get(id);
    if (!record) throw new Error(`API key not found: ${id}`);

    record.status = "revoked";
    record.prevKeyHash = null;
    record.rotationStartedAt = null;
    record.graceEndsAt = null;
  }

  /**
   * Returns a safe view of a key record (no hashes exposed).
   */
  get(id: string): Omit<ApiKeyRecord, "keyHash" | "prevKeyHash"> | null {
    const record = this.store.get(id);
    if (!record) return null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { keyHash, prevKeyHash, ...safe } = record;
    return safe;
  }

  /** Returns safe views of all records. */
  list(): Omit<ApiKeyRecord, "keyHash" | "prevKeyHash">[] {
    return [...this.store.values()].map(({ keyHash, prevKeyHash, ...safe }) => safe);
  }
}

/** Process-wide manager used by the admin API key routes. */
export const apiKeyManager = new ApiKeyManager();
