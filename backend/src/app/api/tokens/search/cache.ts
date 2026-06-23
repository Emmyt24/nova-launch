// Simple in-memory cache implementation
// For production, consider using Redis or similar

interface CacheEntry {
  data: any;
  timestamp: number;
  /** Normalized search term ("q") this entry's results were filtered by, "" if none. */
  tag: string;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 1000;

/** Reverse index: search-term tag -> cache keys whose results were filtered by that term. */
const tagIndex = new Map<string, Set<string>>();

/** How often each search term has been queried, used to prioritize cache warm-up. */
const queryFrequency = new Map<string, number>();

function normalizeTag(searchTerm: string | undefined | null): string {
  return (searchTerm ?? "").trim().toLowerCase();
}

function indexTag(tag: string, key: string): void {
  if (!tagIndex.has(tag)) {
    tagIndex.set(tag, new Set());
  }
  tagIndex.get(tag)!.add(key);
}

function removeFromTagIndex(tag: string, key: string): void {
  const keys = tagIndex.get(tag);
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) {
    tagIndex.delete(tag);
  }
}

export async function getCachedSearchResults(key: string): Promise<any | null> {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  // Check if cache entry is expired
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    removeFromTagIndex(entry.tag, key);
    return null;
  }

  return entry.data;
}

export async function cacheSearchResults(
  key: string,
  data: any,
  searchTerm?: string
): Promise<void> {
  // Implement simple LRU by removing oldest entries when cache is full
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) {
      const evicted = cache.get(firstKey);
      cache.delete(firstKey);
      if (evicted) removeFromTagIndex(evicted.tag, firstKey);
    }
  }

  const tag = normalizeTag(searchTerm);
  cache.set(key, {
    data,
    timestamp: Date.now(),
    tag,
  });
  indexTag(tag, key);
}

export function clearSearchCache(): void {
  cache.clear();
  tagIndex.clear();
  queryFrequency.clear();
}

/** Record that a search term was queried, so warm-up can prioritize popular terms. */
export function recordQueryFrequency(searchTerm: string | undefined | null): void {
  const tag = normalizeTag(searchTerm);
  queryFrequency.set(tag, (queryFrequency.get(tag) ?? 0) + 1);
}

/** The most frequently queried search terms, most popular first. */
export function getTopQueryTerms(limit = 100): string[] {
  return Array.from(queryFrequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

/**
 * Invalidate only the cache buckets whose search term could now match the
 * newly deployed token — mirrors the `contains` (case-insensitive) matching
 * `buildTokenSearchQuery` applies to name/symbol. The "" (no search term)
 * bucket always matches, since an unfiltered listing is affected by every
 * new token.
 *
 * Returns the tags that were invalidated, so callers can target warm-up at
 * exactly what was evicted instead of re-running every cached query.
 */
export function invalidateTagsForToken(token: {
  name: string;
  symbol: string;
}): string[] {
  const haystack = `${token.name} ${token.symbol}`.toLowerCase();
  const affected: string[] = [];

  for (const tag of tagIndex.keys()) {
    if (tag === "" || haystack.includes(tag)) {
      affected.push(tag);
    }
  }

  for (const tag of affected) {
    const keys = tagIndex.get(tag);
    if (!keys) continue;
    for (const key of keys) {
      cache.delete(key);
    }
    tagIndex.delete(tag);
  }

  return affected;
}

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      cache.delete(key);
      removeFromTagIndex(entry.tag, key);
    }
  }
}, CACHE_TTL);
