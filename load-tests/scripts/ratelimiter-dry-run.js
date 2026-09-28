#!/usr/bin/env node
/**
 * Dry-run for scenarios/ratelimiter-accuracy.js.
 *
 * Prints the window/budget/stages the k6 scenario will assert against,
 * without contacting the gateway. The k6 scenario itself cannot run under
 * node (it imports k6/* modules), so this mirrors its parameter resolution
 * using the same shared defaults.
 *
 * Usage: node load-tests/scripts/ratelimiter-dry-run.js
 */

import {
  BACKEND_DEFAULT_BASE_URL,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
} from '../config/gateway-defaults.js';
import { buildRateLimitPlan } from '../lib/ratelimiter-helpers.js';

const env = process.env;

const plan = buildRateLimitPlan({
  baseUrl: env.BASE_URL || BACKEND_DEFAULT_BASE_URL,
  vus: parseInt(env.RATELIMIT_VUS || '50'),
  budget: parseInt(env.RATELIMIT_BUDGET || String(RATE_LIMIT_MAX_REQUESTS)),
  windowMs: parseInt(env.RATELIMIT_WINDOW_MS || String(RATE_LIMIT_WINDOW_MS)),
  toleranceFraction: parseFloat(env.RATELIMIT_TOLERANCE_PCT || '5') / 100,
});

console.log(JSON.stringify(plan, null, 2));
