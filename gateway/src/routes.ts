/**
 * Route table for the API Gateway.
 *
 * Each entry maps a path prefix to a rate-limit tier.
 * The proxy target is always BACKEND_URL; only the rate limits differ per route.
 *
 * Tiers:
 *   strict  – 20 req / 15 min  (write operations, auth endpoints)
 *   default – 100 req / 15 min (general API)
 *   relaxed – 300 req / 15 min (read-heavy public endpoints)
 */

export type RateLimitTier = "strict" | "default" | "relaxed";

export interface RouteConfig {
  /** Path prefix to match (e.g. "/api/admin"). */
  prefix: string;
  /** Rate-limit tier applied to this prefix. */
  tier: RateLimitTier;
  /** Whether the route requires a valid JWT. */
  requiresAuth: boolean;
}

export const RATE_LIMIT_TIERS: Record<RateLimitTier, { windowMs: number; max: number }> = {
  strict:  { windowMs: 15 * 60 * 1000, max: 20 },
  default: { windowMs: 15 * 60 * 1000, max: 100 },
  relaxed: { windowMs: 15 * 60 * 1000, max: 300 },
};

export const ROUTES: RouteConfig[] = [
  { prefix: "/api/admin",      tier: "strict",  requiresAuth: true  },
  { prefix: "/api/governance", tier: "strict",  requiresAuth: true  },
  // More specific prefix listed before "/api/webhooks" so the route-registration
  // loop in app.ts registers it first and the broader entry can never shadow it.
  { prefix: "/api/webhooks-deadletter", tier: "strict", requiresAuth: true },
  { prefix: "/api/webhooks",   tier: "strict",  requiresAuth: true  },
  { prefix: "/api/tokens",     tier: "default", requiresAuth: false },
  { prefix: "/api/dividends",  tier: "default", requiresAuth: false },
  { prefix: "/api/campaigns",  tier: "default", requiresAuth: false },
  { prefix: "/api/streams",    tier: "default", requiresAuth: false },
  { prefix: "/api/vaults",     tier: "default", requiresAuth: false },
  { prefix: "/api/leaderboard",tier: "relaxed", requiresAuth: false },
  { prefix: "/api/search",     tier: "relaxed", requiresAuth: false },
  { prefix: "/api/stats",      tier: "relaxed", requiresAuth: false },
  { prefix: "/api/graphql",    tier: "default", requiresAuth: false },
];
