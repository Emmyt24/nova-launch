interface CacheEntry<T> {
  data: T;
  timestamp: number;
  /** How long (ms) the entry is considered fresh. */
  ttl: number;
  /**
   * Additional window (ms) after `ttl` during which the entry is stale but
   * may still be served while a background revalidation runs (#2202).
   */
  staleTtl: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  /** Reads served from an entry inside its stale window. */
  staleHits: number;
  /** Background revalidations started. */
  revalidations: number;
  /** Background revalidations whose fetcher threw. */
  revalidationErrors: number;
}

export type CacheEntryState = 'fresh' | 'stale' | 'missing';

export interface CacheSetOptions {
  /** Fresh TTL in ms; falls back to the cache's default TTL. */
  ttl?: number;
  /** Stale TTL in ms; falls back to the cache's default stale TTL. */
  staleTtl?: number;
}

export interface RevalidateResult<T> {
  data: T;
  /** `hit` = fresh, `stale` = served stale + revalidating, `miss` = fetched. */
  status: 'hit' | 'stale' | 'miss';
}

const emptyStats = (): CacheStats => ({
  hits: 0,
  misses: 0,
  size: 0,
  staleHits: 0,
  revalidations: 0,
  revalidationErrors: 0,
});

export class CacheService<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private stats: CacheStats = emptyStats();
  private cleanupInterval: NodeJS.Timeout | null = null;
  /** In-flight fetches keyed by cache key, so concurrent callers share one. */
  private inFlight: Map<string, Promise<T>> = new Map();
  /**
   * Bumped on invalidate so a fetch that started before an invalidation
   * does not write its (now outdated) result back into the cache.
   */
  private generations: Map<string, number> = new Map();

  constructor(
    private defaultTTL: number = 5 * 60 * 1000,
    private defaultStaleTTL: number = 0
  ) {
    this.startCleanup();
  }

  private stateOf(entry: CacheEntry<T>, now = Date.now()): CacheEntryState {
    const age = now - entry.timestamp;
    if (age <= entry.ttl) return 'fresh';
    if (age <= entry.ttl + entry.staleTtl) return 'stale';
    return 'missing';
  }

  /**
   * Returns the cached value while it is fresh or stale. Entries past their
   * stale window are evicted and count as a miss.
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    const state = this.stateOf(entry);
    if (state === 'missing') {
      this.cache.delete(key);
      this.stats.size = this.cache.size;
      this.stats.misses++;
      return null;
    }

    if (state === 'stale') {
      this.stats.staleHits++;
    } else {
      this.stats.hits++;
    }
    return entry.data;
  }

  /** Freshness of a key without touching hit/miss stats. */
  getState(key: string): CacheEntryState {
    const entry = this.cache.get(key);
    return entry ? this.stateOf(entry) : 'missing';
  }

  set(key: string, data: T, ttl?: number | CacheSetOptions): void {
    const options: CacheSetOptions =
      typeof ttl === 'number' ? { ttl } : ttl ?? {};
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: options.ttl || this.defaultTTL,
      staleTtl: options.staleTtl ?? this.defaultStaleTTL,
    });
    this.stats.size = this.cache.size;
  }

  /**
   * Stale-while-revalidate read (#2202).
   *
   * - fresh entry: returned immediately.
   * - stale entry: returned immediately and `fetcher` runs in the background
   *   to refresh it. A failing background fetch keeps the stale value.
   * - missing/expired: `fetcher` is awaited and its result cached.
   *
   * Concurrent calls for the same key share a single in-flight fetch.
   */
  async getOrRevalidate(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheSetOptions = {}
  ): Promise<RevalidateResult<T>> {
    const entry = this.cache.get(key);
    const state = entry ? this.stateOf(entry) : 'missing';

    if (entry && state === 'fresh') {
      this.stats.hits++;
      return { data: entry.data, status: 'hit' };
    }

    if (entry && state === 'stale') {
      this.stats.staleHits++;
      if (!this.inFlight.has(key)) {
        this.stats.revalidations++;
        this.fetchAndStore(key, fetcher, options).catch(() => {
          this.stats.revalidationErrors++;
        });
      }
      return { data: entry.data, status: 'stale' };
    }

    if (entry) {
      this.cache.delete(key);
      this.stats.size = this.cache.size;
    }
    this.stats.misses++;
    const data = await this.fetchAndStore(key, fetcher, options);
    return { data, status: 'miss' };
  }

  private fetchAndStore(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheSetOptions
  ): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const generation = this.generations.get(key) ?? 0;
    const promise: Promise<T> = (async () => {
      try {
        const data = await fetcher();
        if ((this.generations.get(key) ?? 0) === generation) {
          this.set(key, data, options);
        }
        return data;
      } finally {
        // Only clear our own slot; an invalidation may have let a newer
        // fetch take over this key.
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  private bumpGeneration(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.inFlight.delete(key);
  }

  invalidate(key: string): void {
    this.cache.delete(key);
    this.bumpGeneration(key);
    this.stats.size = this.cache.size;
  }

  invalidatePattern(pattern: RegExp): void {
    const keysToDelete = new Set<string>();
    this.cache.forEach((_, key) => {
      if (pattern.test(key)) keysToDelete.add(key);
    });
    this.inFlight.forEach((_, key) => {
      if (pattern.test(key)) keysToDelete.add(key);
    });
    keysToDelete.forEach(key => {
      this.cache.delete(key);
      this.bumpGeneration(key);
    });
    this.stats.size = this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.generations.clear();
    this.stats = emptyStats();
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const keysToDelete: string[] = [];
      this.cache.forEach((entry, key) => {
        if (this.stateOf(entry, now) === 'missing') keysToDelete.push(key);
      });
      keysToDelete.forEach(key => this.cache.delete(key));
      this.stats.size = this.cache.size;
    }, 60 * 1000);
    this.cleanupInterval.unref?.();
  }

  destroy(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.clear();
  }
}

export class GovernanceProposalCache {
  private cache: CacheService<any>;

  constructor(ttl: number = 5 * 60 * 1000) {
    this.cache = new CacheService(ttl);
  }

  getProposal(proposalId: string): any | null {
    return this.cache.get(`proposal:${proposalId}`);
  }

  setProposal(proposalId: string, proposal: any): void {
    this.cache.set(`proposal:${proposalId}`, proposal);
  }

  getProposalsList(filter: string = 'all'): any[] | null {
    return this.cache.get(`proposals:list:${filter}`);
  }

  setProposalsList(proposals: any[], filter: string = 'all'): void {
    this.cache.set(`proposals:list:${filter}`, proposals);
  }

  invalidateProposal(proposalId: string): void {
    this.cache.invalidate(`proposal:${proposalId}`);
    this.invalidateAllLists();
  }

  invalidateAllLists(): void {
    this.cache.invalidatePattern(/^proposals:list:/);
  }

  getStats(): CacheStats {
    return this.cache.getStats();
  }

  clear(): void {
    this.cache.clear();
  }

  destroy(): void {
    this.cache.destroy();
  }
}
