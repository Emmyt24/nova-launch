import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaosEngine, type ChaosScenario } from "../chaosEngine";

const scenario: ChaosScenario = {
  seed: 17,
  campaigns: 2,
  executionsPerCampaign: 2,
  faults: [],
};

describe("ChaosEngine", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes fault decisions from the configured probability", () => {
    const engine = new ChaosEngine(3);

    expect(engine.shouldInjectFault({ type: "backend_outage", probability: 1 })).toBe(true);
    expect(engine.shouldInjectFault({ type: "backend_outage", probability: 0 })).toBe(false);
  });

  it("generates deterministic interleaved create and execute events", () => {
    const events = new ChaosEngine(scenario.seed).generateInterleavedEvents(scenario);
    const repeat = new ChaosEngine(scenario.seed).generateInterleavedEvents(scenario);

    expect(events).toEqual(repeat);
    expect(events).toHaveLength(6);
    expect(events.filter((event) => event.type === "create")).toHaveLength(2);
    expect(events.filter((event) => event.type === "execute")).toHaveLength(4);
    expect(events.filter((event) => event.type === "execute").every((event) => typeof event.amount === "bigint")).toBe(true);
  });

  it("marks a deterministic subset of events as delayed", () => {
    const events = Array.from({ length: 5 }, (_, index) => ({ id: index }));
    const result = new ChaosEngine(11).injectIndexerLag(events, 250);

    expect(result).toHaveLength(events.length);
    expect(result.filter((event) => event.delayed)).toHaveLength(1);
    expect(result.find((event) => event.delayed)?.delayMs).toBe(250);
    expect(events.every((event) => !("delayed" in event))).toBe(true);
  });

  it("duplicates the configured fraction without mutating the input", () => {
    const events = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const result = new ChaosEngine(5).injectDuplicateEvents(events, 0.5);

    expect(result).toHaveLength(6);
    expect(result.filter((event) => event.duplicate)).toHaveLength(2);
    expect(events).toHaveLength(4);
  });

  it("handles an empty event list during outage injection", () => {
    expect(new ChaosEngine(2).injectBackendOutage([], 500)).toEqual([]);
  });

  it("marks the selected range of events during an outage", () => {
    const events = Array.from({ length: 10 }, (_, index) => ({ id: index }));
    const result = new ChaosEngine(2).injectBackendOutage(events, 500);

    expect(result).toHaveLength(events.length);
    expect(result.filter((event) => event.outage)).toHaveLength(1);
    expect(events.every((event) => !("outage" in event))).toBe(true);
  });

  it("adds retry copies and leaves events unchanged when the retry rate is zero", () => {
    const events = [{ id: 1 }, { id: 2 }];
    const retried = new ChaosEngine(7).injectRetryStorm(events, 1);
    const unchanged = new ChaosEngine(7).injectRetryStorm(events, 0);

    expect(retried.length).toBeGreaterThan(events.length);
    expect(retried.some((event) => typeof event.retry === "number")).toBe(true);
    expect(unchanged).toEqual(events);
  });
});