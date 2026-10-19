/**
 * Token info cache with stale-while-revalidate semantics (#2202).
 *
 * Popular tokens are read far more often than they change, so entries are
 * served fresh for `ttl`, then served stale for up to `staleTtl` while a
 * background fetch refreshes them. Events that change a token's on-chain
 * state (burns, mints, metadata updates, ...) invalidate every cached view
 * of that token so the next read goes back to the source.
 */

import { CacheService, CacheSetOptions, RevalidateResult } from "./cache";
import { EventBus, Subscription, eventBus as defaultEventBus } from "./eventBus";

export const TOKEN_INFO_CACHE_PREFIX = "token-info:";

/** Defaults, overridable via env (milliseconds). */
export const DEFAULT_TOKEN_INFO_TTL_MS = 60 * 1000;
export const DEFAULT_TOKEN_INFO_STALE_TTL_MS = 5 * 60 * 1000;

/** Event types after which cached info for the affected token is outdated. */
export const TOKEN_INFO_INVALIDATING_EVENTS = [
  "token.created",
  "token.deployed",
  "token.burned",
  "token.burn",
  "token.burn.self",
  "token.burn.admin",
  "burn.executed",
  "burn.created",
  "token.mint",
  "token.minted",
  "token.metadata.updated",
  "token.deleted",
] as const;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Pulls the token address out of the payload shapes used across the codebase. */
export function extractTokenAddress(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const candidate = p.tokenAddress ?? p.tokenId ?? p.address ?? p.token;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

export class TokenInfoCache<T = unknown> {
  private readonly cache: CacheService<T>;
  private subscriptions: Subscription[] = [];

  constructor(
    private readonly ttl: number = envMs(
      "TOKEN_INFO_CACHE_TTL_MS",
      DEFAULT_TOKEN_INFO_TTL_MS
    ),
    private readonly staleTtl: number = envMs(
      "TOKEN_INFO_CACHE_STALE_TTL_MS",
      DEFAULT_TOKEN_INFO_STALE_TTL_MS
    )
  ) {
    this.cache = new CacheService<T>(ttl, staleTtl);
  }

  /** `variant` distinguishes different views (e.g. `include` sets) of a token. */
  buildKey(address: string, variant: string[] = []): string {
    return `${TOKEN_INFO_CACHE_PREFIX}${address}:${[...variant].sort().join(",")}`;
  }

  /**
   * Read token info using stale-while-revalidate. `options` allows per-key
   * TTL overrides, e.g. a longer TTL for rarely-changing metadata.
   */
  get(
    address: string,
    fetcher: () => Promise<T>,
    variant: string[] = [],
    options: CacheSetOptions = {}
  ): Promise<RevalidateResult<T>> {
    return this.cache.getOrRevalidate(this.buildKey(address, variant), fetcher, {
      ttl: options.ttl ?? this.ttl,
      staleTtl: options.staleTtl ?? this.staleTtl,
    });
  }

  /** Drop every cached view of `address`. */
  invalidate(address: string): void {
    const escaped = `${TOKEN_INFO_CACHE_PREFIX}${address}:`.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
    this.cache.invalidatePattern(new RegExp(`^${escaped}`));
  }

  /** Subscribe to token-changing events and invalidate affected tokens. */
  bindInvalidation(bus: EventBus = defaultEventBus): void {
    this.unbindInvalidation();
    this.subscriptions = TOKEN_INFO_INVALIDATING_EVENTS.map((type) =>
      bus.subscribe(type, (event) => {
        const address = extractTokenAddress(event.payload);
        if (address) this.invalidate(address);
      })
    );
  }

  unbindInvalidation(): void {
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.subscriptions = [];
  }

  getStats() {
    return this.cache.getStats();
  }

  destroy(): void {
    this.unbindInvalidation();
    this.cache.destroy();
  }
}

export const tokenInfoCache = new TokenInfoCache();
