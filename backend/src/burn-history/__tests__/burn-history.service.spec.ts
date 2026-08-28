/**
 * Cache-key + cache hit/miss coverage for BurnHistoryService.
 *
 * Issue: #1874 — there was no test asserting that structurally-different queries
 * produce different cache keys. If buildCacheKey ever dropped a query parameter,
 * two different requests would collide and one page would be served the other's
 * cached, wrong-shaped result.
 *
 * No database: the TypeORM repository / query builder and the cache manager are
 * mocked. `@nestjs/*` packages (and the DTO/entity modules that pull in
 * class-validator / typeorm) are stubbed because they are not installed in this
 * workspace and only their decorators / enum values are needed at runtime.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@nestjs/common", () => ({
  Injectable: () => (target: unknown) => target,
  Inject: () => () => {},
  Logger: class {
    log() {}
    error() {}
    warn() {}
    debug() {}
    verbose() {}
  },
}));
vi.mock("@nestjs/typeorm", () => ({ InjectRepository: () => () => {} }));
vi.mock("@nestjs/cache-manager", () => ({ CACHE_MANAGER: "CACHE_MANAGER" }));
vi.mock("../burn-transaction.entity", () => ({
  BurnTransaction: class BurnTransaction {},
  BurnTransactionType: { SELF: "self", ADMIN: "admin" },
}));
vi.mock("../burn-history-query.dto", () => ({
  BurnHistoryQueryDto: class BurnHistoryQueryDto {},
  BurnType: { ALL: "all", SELF: "self", ADMIN: "admin" },
  SortBy: { TIMESTAMP: "timestamp", AMOUNT: "amount", FROM: "from" },
  SortOrder: { ASC: "asc", DESC: "desc" },
}));

const { BurnHistoryService } = await import("../burn-history.service");
const { BurnType, SortBy, SortOrder } = await import("../burn-history-query.dto");

type Query = Record<string, unknown>;

function createService() {
  const queryBuilder = {
    select: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    take: vi.fn().mockReturnThis(),
    getCount: vi.fn().mockResolvedValue(0),
    getMany: vi.fn().mockResolvedValue([]),
  };
  const repository = {
    createQueryBuilder: vi.fn().mockReturnValue(queryBuilder),
  };
  const cacheManager = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  };
  const service = new BurnHistoryService(
    repository as never,
    cacheManager as never
  );
  return { service, repository, queryBuilder, cacheManager };
}

/** Reach the private key builder without going through a full request. */
function keyFor(service: unknown, query: Query): string {
  return (service as { buildCacheKey(q: Query): string }).buildCacheKey(query);
}

describe("BurnHistoryService.buildCacheKey — uniqueness", () => {
  let service: unknown;

  beforeEach(() => {
    service = createService().service;
  });

  const base: Query = {
    tokenAddress: "0xToken",
    type: BurnType.SELF,
    startDate: "2024-01-01T00:00:00Z",
    endDate: "2024-02-01T00:00:00Z",
    page: 1,
    limit: 10,
    sortBy: SortBy.TIMESTAMP,
    sortOrder: SortOrder.DESC,
  };

  it("produces a different key when only `page` differs", () => {
    expect(keyFor(service, { ...base, page: 1 })).not.toBe(
      keyFor(service, { ...base, page: 2 })
    );
  });

  it("produces a different key when only `sortBy` differs", () => {
    expect(keyFor(service, { ...base, sortBy: SortBy.TIMESTAMP })).not.toBe(
      keyFor(service, { ...base, sortBy: SortBy.AMOUNT })
    );
  });

  it("produces a different key when only `sortOrder` differs", () => {
    expect(keyFor(service, { ...base, sortOrder: SortOrder.DESC })).not.toBe(
      keyFor(service, { ...base, sortOrder: SortOrder.ASC })
    );
  });

  it("produces a distinct key for every distinguishing query parameter", () => {
    const variants: Query[] = [
      base,
      { ...base, tokenAddress: "0xOther" },
      { ...base, type: BurnType.ADMIN },
      { ...base, startDate: "2023-06-01T00:00:00Z" },
      { ...base, endDate: "2024-03-01T00:00:00Z" },
      { ...base, page: 2 },
      { ...base, limit: 25 },
      { ...base, sortBy: SortBy.FROM },
      { ...base, sortOrder: SortOrder.ASC },
    ];

    const keys = variants.map((q) => keyFor(service, q));
    expect(new Set(keys).size).toBe(variants.length);
  });

  it("is stable for identical queries", () => {
    expect(keyFor(service, { ...base })).toBe(keyFor(service, { ...base }));
  });
});

describe("BurnHistoryService.getHistory — cache hit / miss", () => {
  it("serves the cached response and never touches the query builder on a hit", async () => {
    const { service, repository, cacheManager } = createService();
    const cached = {
      success: true,
      data: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
      filters: { sortBy: SortBy.TIMESTAMP, sortOrder: SortOrder.DESC },
    };
    cacheManager.get.mockResolvedValueOnce(cached);

    const result = await service.getHistory({});

    expect(result).toBe(cached);
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    expect(cacheManager.set).not.toHaveBeenCalled();
  });

  it("falls through to the query builder on a miss and caches under the lookup key", async () => {
    const { service, repository, queryBuilder, cacheManager } = createService();
    const query: Query = { tokenAddress: "0xToken", page: 3, limit: 5 };

    const result = await service.getHistory(query);

    // the miss path actually ran a query
    expect(repository.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(queryBuilder.getMany).toHaveBeenCalledTimes(1);

    // it looked up and then stored under the very same key
    const expectedKey = keyFor(service, query);
    expect(cacheManager.get).toHaveBeenCalledWith(expectedKey);

    expect(cacheManager.set).toHaveBeenCalledTimes(1);
    const [storedKey, storedValue, ttl] = cacheManager.set.mock.calls[0];
    expect(storedKey).toBe(expectedKey);
    expect(storedValue).toBe(result);
    expect(ttl).toBe(60_000);
  });

  it("stores distinct pages under distinct keys (no collision across requests)", async () => {
    const { service, cacheManager } = createService();

    await service.getHistory({ tokenAddress: "0xToken", page: 1 });
    await service.getHistory({ tokenAddress: "0xToken", page: 2 });

    const [keyPage1] = cacheManager.set.mock.calls[0];
    const [keyPage2] = cacheManager.set.mock.calls[1];
    expect(keyPage1).not.toBe(keyPage2);
  });
});
