import { Injectable, Logger } from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Inject } from "@nestjs/common";
import { Cache } from "cache-manager";
import { Token } from "./interfaces/token.interface";

export const TOKEN_CACHE_TTL = 60; // seconds
export const TOKEN_CACHE_PREFIX = "token:";

// Tracks every cache key ever written via `set()`, so `invalidate()` can
// find and delete all `include` combinations actually used for an address
// instead of a fixed list of 5. Kept alive well past any individual entry's
// TTL so it stays useful even for long-lived cache entries.
const KEY_INDEX = `${TOKEN_CACHE_PREFIX}__index__`;
const KEY_INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

@Injectable()
export class TokenCacheService {
  private readonly logger = new Logger(TokenCacheService.name);

  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  buildKey(address: string, include: string[]): string {
    const includeStr = [...include].sort().join(",");
    return `${TOKEN_CACHE_PREFIX}${address}:${includeStr}`;
  }

  async get(key: string): Promise<Token | null> {
    try {
      const cached = await this.cacheManager.get<Token>(key);
      return cached ?? null;
    } catch (error) {
      this.logger.warn(`Cache get failed for key ${key}`, error?.message);
      return null;
    }
  }

  async set(key: string, value: Token, ttl = TOKEN_CACHE_TTL): Promise<void> {
    try {
      await this.cacheManager.set(key, value, ttl * 1000);
      await this.trackKey(key);
    } catch (error) {
      this.logger.warn(`Cache set failed for key ${key}`, error?.message);
    }
  }

  private async trackKey(key: string): Promise<void> {
    try {
      const indexed =
        (await this.cacheManager.get<string[]>(KEY_INDEX)) || [];
      if (!indexed.includes(key)) {
        await this.cacheManager.set(
          KEY_INDEX,
          [...indexed, key],
          KEY_INDEX_TTL_MS
        );
      }
    } catch (error) {
      this.logger.warn(`Cache key tracking failed for key ${key}`, error?.message);
    }
  }

  async invalidate(address: string): Promise<void> {
    try {
      const addressPrefix = `${TOKEN_CACHE_PREFIX}${address}:`;
      const indexed = (await this.cacheManager.get<string[]>(KEY_INDEX)) || [];
      const trackedKeys = indexed.filter((k) => k.startsWith(addressPrefix));

      // Fall back to the historically hardcoded combinations too, in case
      // they were cached before key-tracking existed or the index expired.
      const legacyKeys = [
        this.buildKey(address, []),
        this.buildKey(address, ["metadata"]),
        this.buildKey(address, ["burns"]),
        this.buildKey(address, ["analytics"]),
        this.buildKey(address, ["metadata", "burns", "analytics"]),
      ];

      const keysToDelete = Array.from(
        new Set([...trackedKeys, ...legacyKeys])
      );
      await Promise.allSettled(
        keysToDelete.map((k) => this.cacheManager.del(k))
      );

      if (trackedKeys.length > 0) {
        const remaining = indexed.filter((k) => !k.startsWith(addressPrefix));
        await this.cacheManager.set(KEY_INDEX, remaining, KEY_INDEX_TTL_MS);
      }
    } catch (error) {
      this.logger.warn(
        `Cache invalidation failed for ${address}`,
        error?.message
      );
    }
  }
}
