interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

export class CacheService<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private stats: CacheStats = { hits: 0, misses: 0, size: 0 };
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private defaultTTL: number = 5 * 60 * 1000) {
    this.startCleanup();
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    const isExpired = Date.now() - entry.timestamp > entry.ttl;
    if (isExpired) {
      this.cache.delete(key);
      this.stats.size = this.cache.size;
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return entry.data;
  }

  set(key: string, data: T, ttl?: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL,
    });
    this.stats.size = this.cache.size;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
    this.stats.size = this.cache.size;
  }

  invalidatePattern(pattern: RegExp): void {
    const keysToDelete: string[] = [];
    this.cache.forEach((_, key) => {
      if (pattern.test(key)) keysToDelete.push(key);
    });
    keysToDelete.forEach(key => this.cache.delete(key));
    this.stats.size = this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, size: 0 };
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const keysToDelete: string[] = [];
      this.cache.forEach((entry, key) => {
        if (now - entry.timestamp > entry.ttl) keysToDelete.push(key);
      });
      keysToDelete.forEach(key => this.cache.delete(key));
      this.stats.size = this.cache.size;
    }, 60 * 1000);
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
