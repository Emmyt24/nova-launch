/**
 * Metric registration tests — poolMetrics (#2196)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("poolMetrics — metric registration", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.DB_POOL_SIZE;
  });

  it("registers all pool gauges in the shared metrics registry", async () => {
    const { metricsRegistry } = await import("../index");
    const names = (await metricsRegistry.getMetricsAsArray()).map((m) => m.name);
    for (const name of [
      "db_connections_active",
      "db_connections_idle",
      "db_connections_waiting",
      "db_pool_saturation",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("exposes the pool metrics in the Prometheus text output from startup", async () => {
    const { metricsRegistry } = await import("../index");
    const { registerPoolMetrics } = await import("../poolMetrics");
    registerPoolMetrics({ $use: vi.fn() } as any);

    const text = await metricsRegistry.metrics();
    expect(text).toMatch(/^db_pool_saturation 0$/m);
    expect(text).toMatch(/^db_connections_waiting 0$/m);
  });

  it("installs exactly one query middleware on the client", async () => {
    const { registerPoolMetrics } = await import("../poolMetrics");
    const $use = vi.fn();
    registerPoolMetrics({ $use } as any);
    expect($use).toHaveBeenCalledTimes(1);
  });
});
