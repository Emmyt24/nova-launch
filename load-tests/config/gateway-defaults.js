/**
 * Single source of truth for the backend/gateway defaults that load tests
 * and runbooks assume. Keep these in sync with:
 *
 *   - backend/src/config/env.ts          PORT default                  → 3001
 *   - backend/src/middleware/rateLimiter.ts
 *       RATE_LIMIT_WINDOW_MS default (900000 ms = 15 min)
 *       RATE_LIMIT_MAX_REQUESTS default (100)
 *
 * This module has no k6 imports so it can be consumed by both k6 scenarios
 * and vitest unit tests (see scripts/gateway-defaults.test.js).
 */

export const BACKEND_DEFAULT_PORT = 3001;
export const BACKEND_DEFAULT_BASE_URL = `http://localhost:${BACKEND_DEFAULT_PORT}`;

/** Default gateway rate-limit tier: 100 requests per 15-minute sliding window. */
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_MAX_REQUESTS = 100;

export default {
  BACKEND_DEFAULT_PORT,
  BACKEND_DEFAULT_BASE_URL,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
};
