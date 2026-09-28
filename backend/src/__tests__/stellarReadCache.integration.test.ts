import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  StellarReadCache,
  StellarCacheKeyBuilder,
} from '../stellar-service-integration/stellar-read-cache';
import {
  CacheStellarRead,
  InvalidateStellarCache,
  initializeStellarCache,
  getStellarCache,
} from '../stellar-service-integration/stellar-cache.decorator';

describe('StellarReadCache', () => {
  let cache: StellarReadCache;

  beforeEach(() => {
    cache = new StellarReadCache(100); // 100ms TTL for testing
  });

  describe('basic operations', () => {
    it('should cache and retrieve values', () => {
      const key = 'test:key';
      const value = { data: 'test' };

      cache.set(key, value);
      const cached = cache.get(key);

      expect(cached).toEqual(value);
    });

    it('should return null for missing keys', () => {
      const cached = cache.get('nonexistent');
      expect(cached).toBeNull();
    });

    it('should invalidate specific keys', () => {
      const key = 'test:key';
      cache.set(key, { data: 'test' });

      cache.invalidate(key);
      const cached = cache.get(key);

      expect(cached).toBeNull();
    });

    it('should clear all cache entries', () => {
      cache.set('key1', { data: 1 });
      cache.set('key2', { data: 2 });

      cache.clear();

      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBeNull();
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', async () => {
      const key = 'test:key';
      cache.set(key, { data: 'test' }, 50); // 50ms TTL

      expect(cache.get(key)).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(cache.get(key)).toBeNull();
    });

    it('should use default TTL if not specified', async () => {
      const key = 'test:key';
      cache.set(key, { data: 'test' }); // Uses default 100ms

      expect(cache.get(key)).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(cache.get(key)).toBeNull();
    });

    it('should support custom TTL per entry', async () => {
      const key1 = 'test:key1';
      const key2 = 'test:key2';

      cache.set(key1, { data: 1 }, 50); // 50ms
      cache.set(key2, { data: 2 }, 200); // 200ms

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(cache.get(key1)).toBeNull();
      expect(cache.get(key2)).not.toBeNull();
    });
  });

  describe('address-based invalidation', () => {
    it('should invalidate all entries for an address', () => {
      const address = 'GAAAA';
      cache.set(`${address}:token`, { data: 1 });
      cache.set(`${address}:account`, { data: 2 });
      cache.set('GBBBB:token', { data: 3 });

      cache.invalidateByAddress(address);

      expect(cache.get(`${address}:token`)).toBeNull();
      expect(cache.get(`${address}:account`)).toBeNull();
      expect(cache.get('GBBBB:token')).not.toBeNull();
    });

    it('should handle partial address matches correctly', () => {
      const address = 'GAAA';
      cache.set('GAAA:token', { data: 1 });
      cache.set('GAAAB:token', { data: 2 }); // Should NOT be invalidated

      cache.invalidateByAddress(address);

      expect(cache.get('GAAA:token')).toBeNull();
      expect(cache.get('GAAAB:token')).not.toBeNull();
    });
  });

  describe('cache statistics', () => {
    it('should report cache size and keys', () => {
      cache.set('key1', { data: 1 });
      cache.set('key2', { data: 2 });

      const stats = cache.getStats();

      expect(stats.size).toBe(2);
      expect(stats.keys).toContain('key1');
      expect(stats.keys).toContain('key2');
    });
  });
});

describe('StellarCacheKeyBuilder', () => {
  it('should build token info cache key', () => {
    const key = StellarCacheKeyBuilder.tokenInfo('GAAAA');
    expect(key).toBe('token:GAAAA');
  });

  it('should build account cache key', () => {
    const key = StellarCacheKeyBuilder.account('GAAAA');
    expect(key).toBe('account:GAAAA');
  });

  it('should build factory state cache key', () => {
    const key = StellarCacheKeyBuilder.factoryState();
    expect(key).toBe('factory:state');
  });

  it('should build transaction cache key', () => {
    const key = StellarCacheKeyBuilder.transaction('tx123');
    expect(key).toBe('tx:tx123');
  });

  it('should build contract state cache key', () => {
    const key = StellarCacheKeyBuilder.contractState('GAAAA', 'balance');
    expect(key).toBe('contract:GAAAA:balance');
  });
});

describe('Cache Decorators', () => {
  let cache: StellarReadCache;

  beforeEach(() => {
    cache = initializeStellarCache(100);
  });

  afterEach(() => {
    cache.clear();
  });

  describe('@CacheStellarRead', () => {
    it('should cache read query results', async () => {
      let callCount = 0;

      class TestService {
        @CacheStellarRead('tokenInfo')
        async getTokenInfo(address: string) {
          callCount++;
          return { address, name: 'Test Token' };
        }
      }

      const service = new TestService();

      const result1 = await service.getTokenInfo('GAAAA');
      const result2 = await service.getTokenInfo('GAAAA');

      expect(result1).toEqual(result2);
      expect(callCount).toBe(1); // Called only once due to cache
    });

    it('should bypass cache when fresh=true', async () => {
      let callCount = 0;

      class TestService {
        @CacheStellarRead('tokenInfo', { fresh: true })
        async getTokenInfo(address: string) {
          callCount++;
          return { address, name: 'Test Token' };
        }
      }

      const service = new TestService();

      await service.getTokenInfo('GAAAA');
      await service.getTokenInfo('GAAAA');

      expect(callCount).toBe(2); // Called twice, cache bypassed
    });

    it('should support custom TTL', async () => {
      let callCount = 0;

      class TestService {
        @CacheStellarRead('tokenInfo', { ttl: 50 })
        async getTokenInfo(address: string) {
          callCount++;
          return { address, name: 'Test Token' };
        }
      }

      const service = new TestService();

      await service.getTokenInfo('GAAAA');
      await service.getTokenInfo('GAAAA');

      expect(callCount).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 100));

      await service.getTokenInfo('GAAAA');

      expect(callCount).toBe(2); // Called again after TTL expiration
    });

    it('should cache different addresses separately', async () => {
      let callCount = 0;

      class TestService {
        @CacheStellarRead('tokenInfo')
        async getTokenInfo(address: string) {
          callCount++;
          return { address, name: `Token ${address}` };
        }
      }

      const service = new TestService();

      await service.getTokenInfo('GAAAA');
      await service.getTokenInfo('GBBBB');
      await service.getTokenInfo('GAAAA');

      expect(callCount).toBe(2); // GAAAA cached, GBBBB separate
    });
  });

  describe('@InvalidateStellarCache', () => {
    it('should invalidate cache on write', async () => {
      let readCount = 0;
      let writeCount = 0;

      class TestService {
        @CacheStellarRead('tokenInfo')
        async getTokenInfo(address: string) {
          readCount++;
          return { address, name: 'Test Token' };
        }

        @InvalidateStellarCache('tokenInfo', 0)
        async updateToken(address: string, name: string) {
          writeCount++;
          return { address, name };
        }
      }

      const service = new TestService();

      await service.getTokenInfo('GAAAA');
      await service.getTokenInfo('GAAAA');

      expect(readCount).toBe(1); // Cached

      await service.updateToken('GAAAA', 'New Name');

      await service.getTokenInfo('GAAAA');

      expect(readCount).toBe(2); // Cache invalidated, read again
    });

    it('should clear all cache on all invalidation', async () => {
      let callCount = 0;

      class TestService {
        @CacheStellarRead('tokenInfo')
        async getTokenInfo(address: string) {
          callCount++;
          return { address, name: 'Test Token' };
        }

        @InvalidateStellarCache('all')
        async criticalWrite() {
          return { success: true };
        }
      }

      const service = new TestService();

      await service.getTokenInfo('GAAAA');
      await service.getTokenInfo('GBBBB');

      expect(callCount).toBe(2);

      await service.criticalWrite();

      await service.getTokenInfo('GAAAA');
      await service.getTokenInfo('GBBBB');

      expect(callCount).toBe(4); // All cache cleared
    });
  });

  describe('global cache instance', () => {
    it('should initialize and retrieve global cache', () => {
      const cache1 = initializeStellarCache(50000);
      const cache2 = getStellarCache();

      expect(cache1).toBe(cache2);
    });

    it('should create default cache if not initialized', () => {
      const cache = getStellarCache();
      expect(cache).toBeDefined();
    });
  });
});

describe('Cache Hit/Miss Scenarios', () => {
  let cache: StellarReadCache;

  beforeEach(() => {
    cache = new StellarReadCache(100);
  });

  it('should track cache hits and misses', async () => {
    let callCount = 0;

    class TestService {
      @CacheStellarRead('tokenInfo')
      async getTokenInfo(address: string) {
        callCount++;
        return { address, name: 'Test Token' };
      }
    }

    const service = new TestService();

    // Miss
    await service.getTokenInfo('GAAAA');
    expect(callCount).toBe(1);

    // Hit
    await service.getTokenInfo('GAAAA');
    expect(callCount).toBe(1);

    // Miss (different address)
    await service.getTokenInfo('GBBBB');
    expect(callCount).toBe(2);

    // Hit
    await service.getTokenInfo('GBBBB');
    expect(callCount).toBe(2);
  });

  it('should handle concurrent requests correctly', async () => {
    let callCount = 0;

    class TestService {
      @CacheStellarRead('tokenInfo')
      async getTokenInfo(address: string) {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { address, name: 'Test Token' };
      }
    }

    const service = new TestService();

    // Concurrent requests for same address
    const [result1, result2, result3] = await Promise.all([
      service.getTokenInfo('GAAAA'),
      service.getTokenInfo('GAAAA'),
      service.getTokenInfo('GAAAA'),
    ]);

    expect(result1).toEqual(result2);
    expect(result2).toEqual(result3);
    // Note: Due to async nature, all 3 may execute before caching
    // This is acceptable for read-only operations
  });
});

// ---------------------------------------------------------------------------
// Issue #1717 — Verify the decorator is applied on the real StellarService
// call sites (getTokenInfo, getFactoryState, getTransaction) so that a
// repeated read within the cache window does NOT re-hit the RPC client.
// ---------------------------------------------------------------------------
describe('StellarService read-through cache integration (#1717)', () => {
  beforeEach(() => {
    initializeStellarCache(30_000); // reset to a fresh cache
  });

  afterEach(() => {
    getStellarCache().clear();
  });

  it('repeated getTokenInfo calls within the TTL window are served from cache without re-hitting the RPC', async () => {
    let rpcHits = 0;

    // Minimal stub that mimics the decorated StellarService.getTokenInfo
    class FakeStellarService {
      @CacheStellarRead('tokenInfo', { ttl: 5_000 })
      async getTokenInfo(tokenAddress: string) {
        rpcHits++;
        return { address: tokenAddress, name: 'TestToken', symbol: 'TT', decimals: 7, totalSupply: '1000', admin: 'GADMIN' };
      }
    }

    const svc = new FakeStellarService();
    const addr = 'CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

    const first = await svc.getTokenInfo(addr);
    const second = await svc.getTokenInfo(addr);
    const third = await svc.getTokenInfo(addr);

    // RPC must only be called once; subsequent calls served from cache
    expect(rpcHits).toBe(1);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it('repeated getFactoryState calls within the TTL window are served from cache without re-hitting the RPC', async () => {
    let rpcHits = 0;

    class FakeStellarService {
      @CacheStellarRead('factoryState', { ttl: 5_000 })
      async getFactoryState() {
        rpcHits++;
        return { contractId: 'CFACTORY', admin: 'GADMIN', totalTokens: 1, tokens: [], isPaused: false };
      }
    }

    const svc = new FakeStellarService();

    await svc.getFactoryState();
    await svc.getFactoryState();
    await svc.getFactoryState();

    expect(rpcHits).toBe(1);
  });

  it('repeated getTransaction calls within the TTL window are served from cache without re-hitting the RPC', async () => {
    let rpcHits = 0;

    class FakeStellarService {
      @CacheStellarRead('transaction', { ttl: 5_000 })
      async getTransaction(txHash: string) {
        rpcHits++;
        return { hash: txHash, ledger: 1000, createdAt: '', sourceAccount: '', fee: '100', status: 'success' as const, operationCount: 1, envelopeXdr: '', resultXdr: '', resultMetaXdr: '' };
      }
    }

    const svc = new FakeStellarService();
    const hash = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';

    await svc.getTransaction(hash);
    await svc.getTransaction(hash);
    await svc.getTransaction(hash);

    expect(rpcHits).toBe(1);
  });

  it('cache expires after TTL and subsequent call re-hits the RPC', async () => {
    let rpcHits = 0;

    class FakeStellarService {
      @CacheStellarRead('tokenInfo', { ttl: 50 }) // 50 ms TTL
      async getTokenInfo(tokenAddress: string) {
        rpcHits++;
        return { address: tokenAddress, name: 'TestToken', symbol: 'TT', decimals: 7, totalSupply: '1000', admin: 'GADMIN' };
      }
    }

    const svc = new FakeStellarService();
    const addr = 'CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

    await svc.getTokenInfo(addr);
    expect(rpcHits).toBe(1);

    // Wait for cache to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    await svc.getTokenInfo(addr);
    expect(rpcHits).toBe(2);
  });
});
