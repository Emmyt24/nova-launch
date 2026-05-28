/**
 * Webhook Event Deduplication Service
 *
 * Stripe (and other providers) automatically retry webhook deliveries when the
 * endpoint returns a non-2xx response. Each retry carries the same event ID,
 * so we must deduplicate on that ID to avoid processing the same event twice.
 *
 * Strategy:
 *  - Maintain an in-memory LRU-style store keyed by event ID.
 *  - Each entry records the processing result and expires after `windowMs`.
 *  - On receipt of an event ID already in the store, return the cached result
 *    immediately without re-processing.
 *  - The store is injectable for testing (pass a custom `EventIdStore`).
 *
 * @module webhookDeduplication
 */

export interface DeduplicationEntry {
  /** ISO timestamp when the event was first processed */
  processedAt: string;
  /** Whether the first processing attempt succeeded */
  success: boolean;
  /** Expiry timestamp (ms since epoch) */
  expiresAt: number;
}

export interface EventIdStore {
  get(eventId: string): DeduplicationEntry | undefined;
  set(eventId: string, entry: DeduplicationEntry): void;
  delete(eventId: string): void;
  size(): number;
}

/** Default in-memory store backed by a plain Map */
export class InMemoryEventIdStore implements EventIdStore {
  private readonly store = new Map<string, DeduplicationEntry>();

  get(eventId: string): DeduplicationEntry | undefined {
    return this.store.get(eventId);
  }

  set(eventId: string, entry: DeduplicationEntry): void {
    this.store.set(eventId, entry);
  }

  delete(eventId: string): void {
    this.store.delete(eventId);
  }

  size(): number {
    return this.store.size;
  }
}

export interface DeduplicationConfig {
  /**
   * How long (ms) to remember a processed event ID.
   * Stripe retries for up to 72 hours, so the default is 72 h.
   */
  windowMs: number;
  /**
   * Clock function — injectable for deterministic tests.
   * Defaults to `Date.now`.
   */
  now?: () => number;
}

export const DEFAULT_DEDUP_CONFIG: DeduplicationConfig = {
  windowMs: 72 * 60 * 60 * 1000, // 72 hours
};

export interface ProcessResult<T> {
  /** True when the event was processed for the first time */
  processed: boolean;
  /** True when the event was a duplicate and was skipped */
  duplicate: boolean;
  /** The result returned by the handler (or the cached result on duplicate) */
  result: T;
}

/**
 * WebhookDeduplicationService wraps an event handler with idempotency
 * guarantees based on a stable event ID.
 */
export class WebhookDeduplicationService {
  private readonly store: EventIdStore;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(
    config: Partial<DeduplicationConfig> = {},
    store?: EventIdStore
  ) {
    const merged = { ...DEFAULT_DEDUP_CONFIG, ...config };
    this.windowMs = merged.windowMs;
    this.now = merged.now ?? Date.now;
    this.store = store ?? new InMemoryEventIdStore();
  }

  /**
   * Process an event exactly once.
   *
   * If `eventId` has been seen within the deduplication window, the handler
   * is NOT called and `duplicate: true` is returned.
   *
   * @param eventId  Stable identifier for the event (e.g. Stripe `evt_…` ID).
   * @param handler  Async function that performs the actual processing.
   */
  async process<T>(
    eventId: string,
    handler: () => Promise<T>
  ): Promise<ProcessResult<T>> {
    this.evict();

    const existing = this.store.get(eventId);
    if (existing) {
      return { processed: false, duplicate: true, result: existing.success as unknown as T };
    }

    const result = await handler();

    this.store.set(eventId, {
      processedAt: new Date(this.now()).toISOString(),
      success: true,
      expiresAt: this.now() + this.windowMs,
    });

    return { processed: true, duplicate: false, result };
  }

  /**
   * Check whether an event ID is already in the deduplication window
   * without processing it.
   */
  isDuplicate(eventId: string): boolean {
    this.evict();
    return this.store.get(eventId) !== undefined;
  }

  /**
   * Retrieve the stored entry for an event ID (useful for auditing).
   */
  getEntry(eventId: string): DeduplicationEntry | undefined {
    return this.store.get(eventId);
  }

  /** Remove expired entries from the store. */
  evict(): void {
    // InMemoryEventIdStore doesn't expose iteration; cast for eviction.
    const map = (this.store as InMemoryEventIdStore & { store: Map<string, DeduplicationEntry> })["store"];
    if (!map) return;
    const now = this.now();
    for (const [key, entry] of map.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  storeSize(): number {
    return this.store.size();
  }
}

export default new WebhookDeduplicationService();
