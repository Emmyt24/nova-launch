/**
 * Fencing Token for End-to-End Exactly-Once Delivery (#1627)
 *
 * A fencing token uniquely identifies a Stellar event by its ledger sequence
 * number and operation index. It is created at ingestion and threaded
 * unmodified through:
 *
 *   StellarEventListener  →  projection services  →  webhookDeliveryService
 *
 * Every stage is a no-op when replayed with the same token. This file defines
 * the token format, serialisation helpers, and the idempotency store used by
 * each stage.
 *
 * ## Token Format
 * ```
 * <ledger>:<opIndex>
 * e.g. "1234567:0"
 * ```
 *
 * The format is intentionally simple so that it can be stored in a VARCHAR
 * column, passed in HTTP headers, and compared as a plain string.
 *
 * ## Idempotency Contract
 * - `isProcessed(token)` returns true iff the token has been successfully
 *   committed to the store.
 * - `markProcessed(token)` atomically records the token; throws if already
 *   present (call `isProcessed` first).
 * - All stores are injectable for testing.
 *
 * @module fencingToken
 */

// ─── Token Type ──────────────────────────────────────────────────────────────

/**
 * A stable, comparable identifier for a single Stellar contract event.
 *
 * Created once at ingestion from the Horizon event record and passed
 * unmodified through the entire processing pipeline.
 */
export interface FencingToken {
  /** Ledger sequence number where the event was recorded. */
  readonly ledger: number;
  /** Position of the operation within the ledger (0-based). */
  readonly opIndex: number;
  /** Serialised form: "<ledger>:<opIndex>" */
  readonly id: string;
}

/**
 * Create a fencing token from raw Horizon event identifiers.
 *
 * @example
 * ```ts
 * const token = createFencingToken(1_234_567, 0);
 * // token.id === "1234567:0"
 * ```
 */
export function createFencingToken(ledger: number, opIndex: number): FencingToken {
  if (!Number.isInteger(ledger) || ledger < 0) {
    throw new RangeError(`Invalid ledger: ${ledger}`);
  }
  if (!Number.isInteger(opIndex) || opIndex < 0) {
    throw new RangeError(`Invalid opIndex: ${opIndex}`);
  }
  const id = `${ledger}:${opIndex}`;
  return Object.freeze({ ledger, opIndex, id });
}

/**
 * Deserialise a fencing token from its string form.
 *
 * @throws {TypeError} if the string does not match the expected format.
 */
export function parseFencingToken(raw: string): FencingToken {
  const parts = raw.split(":");
  if (parts.length !== 2) {
    throw new TypeError(`Malformed fencing token: "${raw}"`);
  }
  const ledger = parseInt(parts[0]!, 10);
  const opIndex = parseInt(parts[1]!, 10);
  if (isNaN(ledger) || isNaN(opIndex)) {
    throw new TypeError(`Malformed fencing token: "${raw}"`);
  }
  return createFencingToken(ledger, opIndex);
}

// ─── Idempotency Store Interface ─────────────────────────────────────────────

/**
 * Backing store for processed-token records.
 *
 * In production this wraps a Redis SET or a database UNIQUE constraint.
 * In tests it is replaced with a plain in-memory Map.
 */
export interface FencingTokenStore {
  /**
   * Return true iff `tokenId` has already been committed to the store.
   * Must be O(1) or a single DB round-trip.
   */
  isProcessed(tokenId: string): Promise<boolean>;

  /**
   * Atomically record `tokenId` as processed.
   *
   * Implementations MUST be idempotent: calling this twice with the same
   * tokenId must not throw; the second call is a no-op.
   */
  markProcessed(tokenId: string): Promise<void>;

  /**
   * Remove a token from the store (used in tests / TTL expiry).
   */
  remove(tokenId: string): Promise<void>;

  /** Return the current number of entries (for diagnostics). */
  size(): Promise<number>;
}

// ─── In-Memory Store (default / test) ────────────────────────────────────────

/** Entry in the in-memory store. */
interface StoreEntry {
  processedAt: number; // ms since epoch
}

/**
 * In-memory implementation of FencingTokenStore.
 *
 * Thread-safe for single-process Node.js (event loop).
 * Supports optional TTL-based eviction.
 */
export class InMemoryFencingTokenStore implements FencingTokenStore {
  private readonly store = new Map<string, StoreEntry>();
  private readonly ttlMs: number;

  /**
   * @param ttlMs Token TTL in milliseconds. 0 = no expiry. Default 72 h.
   */
  constructor(ttlMs = 72 * 60 * 60 * 1_000) {
    this.ttlMs = ttlMs;
  }

  async isProcessed(tokenId: string): Promise<boolean> {
    const entry = this.store.get(tokenId);
    if (!entry) return false;
    if (this.ttlMs > 0 && Date.now() - entry.processedAt > this.ttlMs) {
      this.store.delete(tokenId);
      return false;
    }
    return true;
  }

  async markProcessed(tokenId: string): Promise<void> {
    // Idempotent: second call overwrites (same effect)
    this.store.set(tokenId, { processedAt: Date.now() });
  }

  async remove(tokenId: string): Promise<void> {
    this.store.delete(tokenId);
  }

  async size(): Promise<number> {
    return this.store.size;
  }
}

// ─── Stage Guard ─────────────────────────────────────────────────────────────

/**
 * Wrap a handler so it is executed at most once per fencing token.
 *
 * If the token has already been processed the handler is skipped and
 * `{ skipped: true }` is returned. Otherwise the handler runs, the token
 * is marked as processed, and `{ skipped: false, result }` is returned.
 *
 * The store write happens AFTER the handler succeeds. If the handler
 * throws the token is NOT marked, allowing safe retry.
 *
 * @example
 * ```ts
 * const result = await withFencingToken(store, token, async () => {
 *   await projectionService.applyEvent(event);
 * });
 * if (result.skipped) return; // duplicate — no-op
 * ```
 */
export async function withFencingToken<T>(
  store: FencingTokenStore,
  token: FencingToken,
  handler: () => Promise<T>
): Promise<{ skipped: true } | { skipped: false; result: T }> {
  if (await store.isProcessed(token.id)) {
    return { skipped: true };
  }
  const result = await handler();
  await store.markProcessed(token.id);
  return { skipped: false, result };
}

// ─── Fencing-Token-Aware Webhook Payload ─────────────────────────────────────

/**
 * Enrich a webhook payload with the fencing token so downstream consumers
 * can implement their own exactly-once logic.
 */
export interface FencingTokenWebhookMeta {
  /** The fencing token id for this event (threaded through from ingestion). */
  fencingTokenId: string;
}

/**
 * Extract the fencing token from a webhook payload's meta field.
 *
 * Returns `null` if the payload does not carry a fencing token
 * (e.g., legacy events).
 */
export function extractFencingTokenFromPayload(
  payload: { meta?: Partial<FencingTokenWebhookMeta> }
): FencingToken | null {
  const raw = payload.meta?.fencingTokenId;
  if (!raw) return null;
  try {
    return parseFencingToken(raw);
  } catch {
    return null;
  }
}

// ─── Module exports ───────────────────────────────────────────────────────────

export const fencingToken = {
  create: createFencingToken,
  parse: parseFencingToken,
  withFencingToken,
  InMemoryFencingTokenStore,
};
