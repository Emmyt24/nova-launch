import { describe, it, expect, beforeEach } from "vitest";
import {
  RetryBudget,
  classifyRpcError,
  retryBudgetExhaustedCounter,
  retryBudgetTokensGauge,
} from "../retry-budget";
import {
  StellarContractException,
  StellarNotFoundException,
  StellarRateLimitException,
  StellarSequenceMismatchException,
  StellarTimeoutException,
} from "../stellar.exceptions";

async function exhaustedCount(operation: string): Promise<number> {
  const { values } = await retryBudgetExhaustedCounter.get();
  return values.find((v) => v.labels.operation === operation)?.value ?? 0;
}

describe("RetryBudget (#2201)", () => {
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
    retryBudgetExhaustedCounter.reset();
    retryBudgetTokensGauge.reset();
  });

  it("starts full and allows up to `capacity` retries", () => {
    const budget = new RetryBudget({ capacity: 3, refillPerSecond: 0, depositPerSuccess: 0 }, "t", clock);

    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
  });

  it("emits an exhaustion metric labelled by operation when empty", async () => {
    const budget = new RetryBudget({ capacity: 1, refillPerSecond: 0, depositPerSuccess: 0 }, "t", clock);

    budget.tryAcquire("getEvents");
    budget.tryAcquire("getEvents");
    budget.tryAcquire("getEvents");

    expect(await exhaustedCount("getEvents")).toBe(2);
  });

  it("refills over time up to capacity", () => {
    const budget = new RetryBudget({ capacity: 2, refillPerSecond: 1, depositPerSuccess: 0 }, "t", clock);
    budget.tryAcquire();
    budget.tryAcquire();
    expect(budget.tryAcquire()).toBe(false);

    now += 1000;
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);

    now += 60_000;
    expect(budget.available()).toBe(2);
  });

  it("deposits a fraction of a token per success, capped at capacity", () => {
    const budget = new RetryBudget({ capacity: 2, refillPerSecond: 0, depositPerSuccess: 0.5 }, "t", clock);
    budget.tryAcquire();
    budget.tryAcquire();

    budget.recordSuccess();
    expect(budget.tryAcquire()).toBe(false);
    budget.recordSuccess();
    budget.recordSuccess();
    expect(budget.tryAcquire()).toBe(true);

    for (let i = 0; i < 10; i++) budget.recordSuccess();
    expect(budget.available()).toBe(2);
  });

  it("publishes available tokens to the gauge", async () => {
    const budget = new RetryBudget({ capacity: 5, refillPerSecond: 0, depositPerSuccess: 0 }, "gauge-test", clock);
    budget.tryAcquire();

    const { values } = await retryBudgetTokensGauge.get();
    expect(values.find((v) => v.labels.client === "gauge-test")?.value).toBe(4);
  });

  it("reset() refills the bucket", () => {
    const budget = new RetryBudget({ capacity: 1, refillPerSecond: 0, depositPerSuccess: 0 }, "t", clock);
    budget.tryAcquire();
    budget.reset();
    expect(budget.tryAcquire()).toBe(true);
  });

  it("rejects invalid configuration", () => {
    expect(() => new RetryBudget({ capacity: 0, refillPerSecond: 1, depositPerSuccess: 0 })).toThrow();
    expect(() => new RetryBudget({ capacity: 1, refillPerSecond: -1, depositPerSuccess: 0 })).toThrow();
    expect(() => new RetryBudget({ capacity: 1, refillPerSecond: 1, depositPerSuccess: -1 })).toThrow();
  });
});

describe("classifyRpcError (#2201)", () => {
  it.each([
    [{ code: "ECONNRESET" }, "network"],
    [{ code: "ECONNREFUSED" }, "network"],
    [{ code: "EAI_AGAIN" }, "network"],
    [{ code: "ETIMEDOUT" }, "timeout"],
    [{ response: { status: 429 } }, "rate_limited"],
    [{ response: { status: 408 } }, "timeout"],
    [{ response: { status: 500 } }, "server_error"],
    [{ response: { status: 502 } }, "server_error"],
    [{ response: { status: 503 } }, "server_error"],
    [{ response: { status: 504 } }, "server_error"],
    [new Error("socket hang up"), "network"],
    [new Error("Network Error"), "network"],
    [new Error("request timeout"), "timeout"],
    [new Error("tx_bad_seq"), "bad_sequence"],
  ])("treats %o as retryable (%s)", (error, reason) => {
    expect(classifyRpcError(error)).toEqual({ retryable: true, reason });
  });

  it("treats our own operation timeout as retryable", () => {
    expect(classifyRpcError(new StellarTimeoutException("getEvents"))).toEqual({
      retryable: true,
      reason: "timeout",
    });
  });

  it("treats sequence mismatch exceptions as retryable", () => {
    expect(classifyRpcError(new StellarSequenceMismatchException("GABC")).retryable).toBe(true);
  });

  it.each([
    [{ response: { status: 400 } }, "http_error"],
    [{ response: { status: 401 } }, "http_error"],
    [{ response: { status: 404 } }, "http_error"],
    [{ response: { status: 501 } }, "http_error"],
    [new Error("invalid argument"), "unknown"],
    [undefined, "unknown"],
  ])("treats %o as terminal (%s)", (error, reason) => {
    expect(classifyRpcError(error)).toEqual({ retryable: false, reason });
  });

  it("does not retry the client-side rate limiter", () => {
    expect(classifyRpcError(new StellarRateLimitException())).toEqual({
      retryable: false,
      reason: "local_rate_limit",
    });
  });

  it("does not retry application-level Stellar exceptions", () => {
    expect(classifyRpcError(new StellarNotFoundException("Token", "C123"))).toEqual({
      retryable: false,
      reason: "application",
    });
    expect(classifyRpcError(new StellarContractException("boom")).retryable).toBe(false);
  });
});
