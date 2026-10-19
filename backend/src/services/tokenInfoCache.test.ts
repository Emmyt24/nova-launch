import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheService } from './cache';
import { EventBus } from './eventBus';
import { TokenInfoCache, extractTokenAddress } from './tokenInfoCache';

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('CacheService stale-while-revalidate (#2202)', () => {
  let cache: CacheService<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new CacheService<string>(1000, 2000);
  });

  afterEach(() => {
    cache.destroy();
    vi.useRealTimers();
  });

  it('fetches on miss and caches the result', async () => {
    const fetcher = vi.fn().mockResolvedValue('v1');
    const result = await cache.getOrRevalidate('k', fetcher);
    expect(result).toEqual({ data: 'v1', status: 'miss' });
    expect(cache.getState('k')).toBe('fresh');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serves fresh entries without calling the fetcher', async () => {
    cache.set('k', 'v1');
    const fetcher = vi.fn().mockResolvedValue('v2');
    const result = await cache.getOrRevalidate('k', fetcher);
    expect(result).toEqual({ data: 'v1', status: 'hit' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serves stale data and revalidates in the background', async () => {
    cache.set('k', 'v1');
    vi.advanceTimersByTime(1500);
    expect(cache.getState('k')).toBe('stale');

    const fetcher = vi.fn().mockResolvedValue('v2');
    const result = await cache.getOrRevalidate('k', fetcher);
    expect(result).toEqual({ data: 'v1', status: 'stale' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
    expect(cache.get('k')).toBe('v2');
    expect(cache.getState('k')).toBe('fresh');
  });

  it('deduplicates concurrent revalidations', async () => {
    cache.set('k', 'v1');
    vi.advanceTimersByTime(1500);

    let resolve!: (v: string) => void;
    const fetcher = vi.fn(() => new Promise<string>(r => (resolve = r)));
    await cache.getOrRevalidate('k', fetcher);
    await cache.getOrRevalidate('k', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve('v2');
  });

  it('deduplicates concurrent misses', async () => {
    const fetcher = vi.fn().mockResolvedValue('v1');
    const [a, b] = await Promise.all([
      cache.getOrRevalidate('k', fetcher),
      cache.getOrRevalidate('k', fetcher),
    ]);
    expect(a.data).toBe('v1');
    expect(b.data).toBe('v1');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps stale data when background revalidation fails', async () => {
    cache.set('k', 'v1');
    vi.advanceTimersByTime(1500);
    const fetcher = vi.fn().mockRejectedValue(new Error('upstream down'));
    const result = await cache.getOrRevalidate('k', fetcher);
    expect(result.data).toBe('v1');
    await flushMicrotasks();
    expect(cache.get('k')).toBe('v1');
    expect(cache.getStats().revalidationErrors).toBe(1);
  });

  it('fetches synchronously once past the stale window', async () => {
    cache.set('k', 'v1');
    vi.advanceTimersByTime(3500);
    expect(cache.getState('k')).toBe('missing');
    const fetcher = vi.fn().mockResolvedValue('v2');
    const result = await cache.getOrRevalidate('k', fetcher);
    expect(result).toEqual({ data: 'v2', status: 'miss' });
  });

  it('supports per-key ttl and stale ttl', async () => {
    cache.set('short', 'a', { ttl: 100, staleTtl: 100 });
    cache.set('long', 'b', { ttl: 10_000, staleTtl: 0 });
    vi.advanceTimersByTime(150);
    expect(cache.getState('short')).toBe('stale');
    expect(cache.getState('long')).toBe('fresh');
    vi.advanceTimersByTime(100);
    expect(cache.getState('short')).toBe('missing');
  });

  it('keeps legacy numeric ttl argument working', () => {
    cache.set('k', 'v', 500);
    vi.advanceTimersByTime(600);
    // default stale ttl (2000) still applies
    expect(cache.getState('k')).toBe('stale');
  });

  it('does not write back a fetch that started before invalidation', async () => {
    let resolve!: (v: string) => void;
    const slow = () => new Promise<string>(r => (resolve = r));
    const pending = cache.getOrRevalidate('k', slow);
    cache.invalidate('k');
    resolve('outdated');
    await pending;
    expect(cache.getState('k')).toBe('missing');
  });
});

describe('TokenInfoCache (#2202)', () => {
  let bus: EventBus;
  let cache: TokenInfoCache<{ supply: string }>;

  beforeEach(() => {
    bus = new EventBus();
    cache = new TokenInfoCache(1000, 5000);
    cache.bindInvalidation(bus);
  });

  afterEach(() => cache.destroy());

  it('caches per address and variant', async () => {
    const fetcher = vi.fn().mockResolvedValue({ supply: '100' });
    await cache.get('CABC', fetcher, ['metadata', 'burns']);
    const second = await cache.get('CABC', fetcher, ['burns', 'metadata']);
    expect(second.status).toBe('hit');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('invalidates all variants of a token on a relevant event', async () => {
    const fetcher = vi.fn().mockResolvedValue({ supply: '100' });
    await cache.get('CABC', fetcher);
    await cache.get('CABC', fetcher, ['burns']);
    await cache.get('COTHER', fetcher);

    cache.invalidate('CABC');

    expect((await cache.get('CABC', fetcher)).status).toBe('miss');
    expect((await cache.get('CABC', fetcher, ['burns'])).status).toBe('miss');
    expect((await cache.get('COTHER', fetcher)).status).toBe('hit');
  });

  it('invalidates when a subscribed event is published', async () => {
    const fetcher = vi.fn().mockResolvedValue({ supply: '100' });
    await cache.get('CABC', fetcher);
    const handlers = (bus as any).handlers.get('token.burned') as Map<string, any>;
    for (const h of handlers.values()) {
      await h({ type: 'token.burned', payload: { tokenAddress: 'CABC' } });
    }
    expect((await cache.get('CABC', fetcher)).status).toBe('miss');
  });

  it('unbinds subscriptions on destroy', () => {
    cache.destroy();
    const handlers = (bus as any).handlers.get('token.burned') as Map<string, any> | undefined;
    expect(handlers?.size ?? 0).toBe(0);
  });

  it('extracts token addresses from common payload shapes', () => {
    expect(extractTokenAddress({ tokenAddress: 'A' })).toBe('A');
    expect(extractTokenAddress({ tokenId: 'B' })).toBe('B');
    expect(extractTokenAddress({ address: 'C' })).toBe('C');
    expect(extractTokenAddress({})).toBeNull();
    expect(extractTokenAddress(null)).toBeNull();
  });
});
