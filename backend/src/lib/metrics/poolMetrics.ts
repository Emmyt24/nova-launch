/**
 * Connection-pool health metrics.
 *
 * Uses a Prisma `$use` middleware to track in-flight query concurrency as a
 * proxy for connection-pool utilisation.  Prisma does not expose raw pool
 * internals, so we model:
 *
 *   active  – queries currently executing (≤ pool size)
 *   idle    – idle slots in the pool  (pool_size − active)
 *   waiting – queries queued beyond the pool capacity
 *   saturation – active / pool_size  (0–1; alert on > 0.8)
 *
 * The pool size is read from DB_POOL_SIZE env (default 10).
 *
 * Call `registerPoolMetrics(prismaClient)` once at startup (after the Prisma
 * singleton is initialised) to activate collection.
 */

import type { PrismaClient } from "@prisma/client";
import {
  dbConnectionsActive,
  dbConnectionsIdle,
  dbConnectionsWaiting,
  dbPoolSaturation,
  MetricsCollector,
} from "./index";

const _rawPoolSize = parseInt(process.env.DB_POOL_SIZE ?? "10", 10);
const MAX_POOL_SIZE: number = (Number.isFinite(_rawPoolSize) && _rawPoolSize > 0)
  ? _rawPoolSize
  : (() => {
      console.warn(
        `[poolMetrics] DB_POOL_SIZE env var is malformed ` +
        `("${process.env.DB_POOL_SIZE}") — falling back to default of 10`
      );
      return 10;
    })();

let inflightCount = 0;

function applyPoolGauges(inflight: number): void {
  const active = Math.min(inflight, MAX_POOL_SIZE);
  const idle = Math.max(0, MAX_POOL_SIZE - inflight);
  const waiting = Math.max(0, inflight - MAX_POOL_SIZE);
  const saturation = MAX_POOL_SIZE > 0 ? active / MAX_POOL_SIZE : 0;

  dbConnectionsActive.set(active);
  dbConnectionsIdle.set(idle);
  dbConnectionsWaiting.set(waiting);
  dbPoolSaturation.set(saturation);
}

/**
 * Attach pool-metrics collection to the given Prisma client.
 * Must be called once before the first query.
 */
export function registerPoolMetrics(client: PrismaClient): void {
  // @ts-expect-error – $use is available on PrismaClient at runtime
  client.$use(async (params: unknown, next: (p: unknown) => Promise<unknown>) => {
    inflightCount++;
    applyPoolGauges(inflightCount);

    try {
      return await next(params);
    } finally {
      inflightCount = Math.max(0, inflightCount - 1);
      applyPoolGauges(inflightCount);
    }
  });

  // Initialise gauges to zero so they appear in /metrics from startup
  MetricsCollector.updateDatabaseConnections(0, MAX_POOL_SIZE, 0, MAX_POOL_SIZE);
}
