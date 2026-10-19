/**
 * StellarService.withRetry + shared retry budget (#2201)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@nestjs/common", () => ({
  Injectable: () => () => undefined,
  Logger: class {
    log = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));
vi.mock("@nestjs/config", () => ({ ConfigService: class {} }));
vi.mock("../stellar-cache.decorator", () => ({
  CacheStellarRead: () => (_t: unknown, _k: unknown, d: PropertyDescriptor) => d,
}));
vi.mock("../rate-limiter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rate-limiter")>()),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { StellarService } from "../stellar.service";
import { retryBudgetExhaustedCounter, rpcRetriesCounter } from "../retry-budget";
import { StellarNotFoundException } from "../stellar.exceptions";

function buildService(env: Record<string, number> = {}) {
  const configService = { get: (key: string) => env[key] };
  return new StellarService(configService as any);
}

const transient = () => Object.assign(new Error("upstream"), { response: { status: 503 } });

describe("StellarService retry budget (#2201)", () => {
  beforeEach(() => {
    retryBudgetExhaustedCounter.reset();
    rpcRetriesCounter.reset();
  });

  it("retries transient errors while budget remains", async () => {
    const service = buildService();
    const op = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValueOnce("ok");

    await expect((service as any).withRetry(op, "getEvents")).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);

    const { values } = await rpcRetriesCounter.get();
    expect(values.find((v) => v.labels.operation === "getEvents")?.labels.reason).toBe("server_error");
  });

  it("does not retry terminal errors and spends no budget", async () => {
    const service = buildService({ STELLAR_RETRY_BUDGET_CAPACITY: 2 });
    const op = vi.fn().mockRejectedValue(new StellarNotFoundException("Token", "C1"));

    await expect((service as any).withRetry(op, "getToken")).rejects.toBeInstanceOf(StellarNotFoundException);
    expect(op).toHaveBeenCalledTimes(1);
    expect(service.getRetryBudgetAvailable()).toBe(2);
  });

  it("stops retrying once the shared budget is exhausted", async () => {
    const service = buildService({
      STELLAR_RETRY_BUDGET_CAPACITY: 2,
      STELLAR_RETRY_BUDGET_REFILL_PER_SECOND: 0,
      STELLAR_RETRY_BUDGET_DEPOSIT_PER_SUCCESS: 0,
    });
    const op = vi.fn().mockRejectedValue(transient());

    await expect((service as any).withRetry(op, "getEvents")).rejects.toThrow("upstream");
    // 1 initial attempt + 2 budgeted retries, then fail fast
    expect(op).toHaveBeenCalledTimes(3);

    const { values } = await retryBudgetExhaustedCounter.get();
    expect(values.find((v) => v.labels.operation === "getEvents")?.value).toBe(1);
  });

  it("shares the budget across concurrent operations", async () => {
    const service = buildService({
      STELLAR_RETRY_BUDGET_CAPACITY: 1,
      STELLAR_RETRY_BUDGET_REFILL_PER_SECOND: 0,
      STELLAR_RETRY_BUDGET_DEPOSIT_PER_SUCCESS: 0,
    });
    const a = vi.fn().mockRejectedValue(transient());
    const b = vi.fn().mockRejectedValue(transient());

    await expect((service as any).withRetry(a, "opA")).rejects.toThrow();
    await expect((service as any).withRetry(b, "opB")).rejects.toThrow();

    // opA consumed the only retry token; opB gets its first attempt only.
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("still makes the first attempt when the budget is empty", async () => {
    const service = buildService({
      STELLAR_RETRY_BUDGET_CAPACITY: 1,
      STELLAR_RETRY_BUDGET_REFILL_PER_SECOND: 0,
      STELLAR_RETRY_BUDGET_DEPOSIT_PER_SUCCESS: 0,
    });
    await expect((service as any).withRetry(vi.fn().mockRejectedValue(transient()), "drain")).rejects.toThrow();

    const op = vi.fn().mockResolvedValue("fresh");
    await expect((service as any).withRetry(op, "getAccount")).resolves.toBe("fresh");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("successful calls replenish the budget", async () => {
    const service = buildService({
      STELLAR_RETRY_BUDGET_CAPACITY: 1,
      STELLAR_RETRY_BUDGET_REFILL_PER_SECOND: 0,
      STELLAR_RETRY_BUDGET_DEPOSIT_PER_SUCCESS: 0.5,
    });
    const op = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue("ok");
    await (service as any).withRetry(op, "x");
    // spent 1, deposited 0.5
    expect(service.getRetryBudgetAvailable()).toBeCloseTo(0.5);

    await (service as any).withRetry(vi.fn().mockResolvedValue("ok"), "x");
    expect(service.getRetryBudgetAvailable()).toBeCloseTo(1);
  });
});
