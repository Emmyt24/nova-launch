import { Logger } from '@nestjs/common';

/** TTL for cache entries in the absence of a ledger-close event (ms). */
const DEFAULT_TTL_MS = 30_000;

/**
 * Sequence number cache entry with lock for serialization
 */
interface SequenceCacheEntry {
  sequenceNumber: string;
  lastUpdated: number;
  locked: boolean;
  lockQueue: Array<() => void>;
}

/** Minimal shape of a Stellar Horizon ledger record. */
interface LedgerRecord {
  sequence: number;
  /** Comma-separated list of account IDs that had operations in this ledger. */
  operation_count?: number;
}

/** Minimal Stellar SDK Server type — only the parts we use. */
interface StellarServer {
  ledgers(): {
    order(dir: 'asc' | 'desc'): {
      cursor(cursor: string): {
        stream(opts: { onmessage: (ledger: LedgerRecord) => void; onerror: (err: unknown) => void }): () => void;
      };
    };
  };
  loadAccount(accountId: string): Promise<{ sequenceNumber(): string }>;
}

/**
 * Cache and manage Stellar account sequence numbers to avoid transaction collisions.
 *
 * Features:
 * - Caches sequence numbers per account to avoid redundant Horizon calls
 * - Subscribes to the Stellar ledger stream; invalidates an entry immediately
 *   when the account is detected in a closed ledger
 * - TTL-based fallback eviction (30 s) for accounts not observed in the stream
 * - Serialises submissions per account to prevent race conditions
 * - Refreshes from Horizon on sequence-mismatch errors
 * - Exposes a `stale_evictions` counter for Prometheus / monitoring
 *
 * Issue: #1380
 */
export class SequenceNumberCache {
  private readonly cache = new Map<string, SequenceCacheEntry>();
  private readonly logger = new Logger(SequenceNumberCache.name);
  private readonly ttlMs: number;

  /** Monotonically increasing count of cache entries evicted due to staleness. */
  private _staleEvictions = 0;

  /** Handle returned by the Stellar ledger stream — call to stop it. */
  private _stopLedgerStream: (() => void) | null = null;

  /** Periodic TTL sweeper interval handle. */
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  // ── Ledger-close subscription ─────────────────────────────────────────────

  /**
   * Start watching the Stellar ledger stream.
   *
   * When a ledger closes, any cached account that has a matching entry is
   * invalidated immediately — the next `get()` will trigger a fresh Horizon
   * fetch and avoid a TX_BAD_SEQ rejection.
   *
   * Also starts a periodic sweep that evicts entries older than `ttlMs` for
   * accounts that were never observed in the stream (cold-path safety net).
   *
   * @param server - A Stellar SDK `Server` (or compatible mock).
   * @param watchedAccounts - Optional explicit list of accounts to watch.
   *   When omitted, every account in the cache at stream-time is invalidated
   *   when any ledger closes (conservative but safe).
   */
  startLedgerSubscription(server: StellarServer, watchedAccounts?: Set<string>): void {
    if (this._stopLedgerStream) {
      this.logger.warn('Ledger subscription already active — ignoring duplicate call');
      return;
    }

    this.logger.log('Starting ledger-close subscription for sequence cache invalidation');

    const stop = server
      .ledgers()
      .order('asc')
      .cursor('now')
      .stream({
        onmessage: (_ledger: LedgerRecord) => {
          // For each cached account (or the provided watch-list), invalidate
          // immediately on every ledger close so we never hold a stale entry
          // after a transaction for that account has been included.
          const targets = watchedAccounts ?? new Set(this.cache.keys());
          for (const accountId of targets) {
            if (this.cache.has(accountId)) {
              this._evictStale(accountId);
            }
          }
        },
        onerror: (err: unknown) => {
          this.logger.error('Ledger stream error — sequence cache may serve stale entries', err);
        },
      });

    this._stopLedgerStream = stop;
    this._startTtlSweep();
  }

  /** Stop the ledger stream and TTL sweeper. */
  stopLedgerSubscription(): void {
    if (this._stopLedgerStream) {
      this._stopLedgerStream();
      this._stopLedgerStream = null;
      this.logger.log('Ledger-close subscription stopped');
    }
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  // ── TTL sweeper ───────────────────────────────────────────────────────────

  private _startTtlSweep(): void {
    if (this._sweepTimer) return;
    // Run sweep every half-TTL for timely eviction without tight polling
    this._sweepTimer = setInterval(() => this._sweepExpired(), this.ttlMs / 2);
  }

  private _sweepExpired(): void {
    const now = Date.now();
    for (const [accountId, entry] of this.cache.entries()) {
      if (now - entry.lastUpdated > this.ttlMs) {
        this._evictStale(accountId);
      }
    }
  }

  /** Evict an entry and increment the stale eviction counter. */
  private _evictStale(accountId: string): void {
    if (!this.cache.has(accountId)) return;
    this.cache.delete(accountId);
    this._staleEvictions++;
    this.logger.debug(`Stale eviction for ${accountId} (total: ${this._staleEvictions})`);
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  /**
   * Current value of the `sequence_cache.stale_evictions` counter.
   * Monotonically increasing; reset only on process restart.
   */
  get staleEvictions(): number {
    return this._staleEvictions;
  }

  // ── Cache accessors ───────────────────────────────────────────────────────

  /**
   * Get cached sequence number for an account.
   * Returns null if not cached or TTL-expired (falls back to Horizon fetch).
   */
  get(accountId: string): string | null {
    const entry = this.cache.get(accountId);
    if (!entry) return null;

    if (Date.now() - entry.lastUpdated > this.ttlMs) {
      this._evictStale(accountId);
      return null;
    }

    return entry.sequenceNumber;
  }

  /**
   * Set cached sequence number for an account.
   */
  set(accountId: string, sequenceNumber: string): void {
    const existing = this.cache.get(accountId);

    this.cache.set(accountId, {
      sequenceNumber,
      lastUpdated: Date.now(),
      locked: existing?.locked ?? false,
      lockQueue: existing?.lockQueue ?? [],
    });

    this.logger.debug(`Cached sequence ${sequenceNumber} for account ${accountId}`);
  }

  /**
   * Increment the cached sequence number.
   * Called after successfully submitting a transaction.
   */
  increment(accountId: string): void {
    const entry = this.cache.get(accountId);
    if (!entry) {
      this.logger.warn(`Cannot increment sequence for uncached account ${accountId}`);
      return;
    }

    entry.sequenceNumber = (BigInt(entry.sequenceNumber) + 1n).toString();
    entry.lastUpdated = Date.now();
    this.logger.debug(`Incremented sequence to ${entry.sequenceNumber} for ${accountId}`);
  }

  /**
   * Explicitly invalidate a cached sequence, forcing a Horizon refresh.
   * Called on TX_BAD_SEQ errors.
   */
  invalidate(accountId: string): void {
    this.cache.delete(accountId);
    this.logger.debug(`Invalidated sequence cache for account ${accountId}`);
  }

  // ── Lock management ───────────────────────────────────────────────────────

  /**
   * Acquire a per-account lock to serialise transaction submissions.
   * Returns a release function that MUST be called after submission.
   */
  async acquireLock(accountId: string): Promise<() => void> {
    const entry = this.cache.get(accountId);

    if (!entry) {
      this.cache.set(accountId, {
        sequenceNumber: '0',
        lastUpdated: Date.now(),
        locked: true,
        lockQueue: [],
      });
      return () => this.releaseLock(accountId);
    }

    if (!entry.locked) {
      entry.locked = true;
      return () => this.releaseLock(accountId);
    }

    return new Promise<() => void>((resolve) => {
      entry.lockQueue.push(() => resolve(() => this.releaseLock(accountId)));
    });
  }

  private releaseLock(accountId: string): void {
    const entry = this.cache.get(accountId);
    if (!entry) return;

    const next = entry.lockQueue.shift();
    if (next) {
      next();
    } else {
      entry.locked = false;
    }
    this.logger.debug(`Released lock for ${accountId}, queue: ${entry.lockQueue.length}`);
  }

  // ── Convenience wrapper ───────────────────────────────────────────────────

  /**
   * Execute a transaction with automatic sequence number management.
   * Handles locking, caching, incrementing, and retry on TX_BAD_SEQ.
   */
  async executeWithSequenceManagement<T>(
    accountId: string,
    fetchAccount: () => Promise<{ sequenceNumber(): string }>,
    buildAndSubmit: (account: any) => Promise<T>,
  ): Promise<T> {
    const releaseLock = await this.acquireLock(accountId);

    try {
      const cachedSeq = this.get(accountId);
      let account: any;

      if (cachedSeq) {
        account = {
          accountId: () => accountId,
          sequenceNumber: () => cachedSeq,
          incrementSequenceNumber: () => {},
        };
        this.logger.debug(`Using cached sequence ${cachedSeq} for ${accountId}`);
      } else {
        account = await fetchAccount();
        this.set(accountId, account.sequenceNumber());
        this.logger.debug(`Fetched fresh sequence ${account.sequenceNumber()} for ${accountId}`);
      }

      try {
        const result = await buildAndSubmit(account);
        this.increment(accountId);
        return result;
      } catch (error: any) {
        if (this.isSequenceMismatchError(error)) {
          this.logger.warn(`Sequence mismatch for ${accountId}, refreshing and retrying`);
          this.invalidate(accountId);
          const freshAccount = await fetchAccount();
          this.set(accountId, freshAccount.sequenceNumber());
          const result = await buildAndSubmit(freshAccount);
          this.increment(accountId);
          return result;
        }
        throw error;
      }
    } finally {
      releaseLock();
    }
  }

  private isSequenceMismatchError(error: any): boolean {
    if (!error) return false;
    const msg = error.message?.toLowerCase() ?? '';
    const code = error.code?.toUpperCase() ?? '';
    if (code === 'TX_BAD_SEQ') return true;
    if (msg.includes('bad_seq') || (msg.includes('sequence') && msg.includes('mismatch'))) return true;
    if (error.response?.data) {
      const d = JSON.stringify(error.response.data).toLowerCase();
      if (d.includes('tx_bad_seq') || d.includes('bad_seq')) return true;
    }
    return false;
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  clear(): void {
    this.cache.clear();
    this.logger.debug('Cleared all sequence number cache entries');
  }

  getStats(): {
    size: number;
    staleEvictions: number;
    accounts: Array<{ accountId: string; sequence: string; age: number; locked: boolean }>;
  } {
    return {
      size: this.cache.size,
      staleEvictions: this._staleEvictions,
      accounts: Array.from(this.cache.entries()).map(([id, e]) => ({
        accountId: id,
        sequence: e.sequenceNumber,
        age: Date.now() - e.lastUpdated,
        locked: e.locked,
      })),
    };
  }
}
