import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  calculateReconnectDelay,
  ListenerBackoffState,
  LISTENER_RECONNECT_CONFIG,
  type ListenerReconnectConfig,
} from "../services/listenerBackoff";

const DETERMINISTIC_CONFIG: ListenerReconnectConfig = {
  initialDelayMs: 1_000,
  maxDelayMs: 300_000,
  backoffFactor: 2,
  jitterFraction: 0,
  healthResetThreshold: 5,
};

describe("calculateReconnectDelay", () => {
  it("starts at initialDelayMs on attempt 1", () => {
    const delay = calculateReconnectDelay(1, DETERMINISTIC_CONFIG);
    expect(delay).toBe(2_000); // 1000 * 2^1
  });

  it("doubles on each successive attempt", () => {
    const delays = [1, 2, 3, 4].map((a) => calculateReconnectDelay(a, DETERMINISTIC_CONFIG));
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it("caps at maxDelayMs", () => {
    const delay = calculateReconnectDelay(100, DETERMINISTIC_CONFIG);
    expect(delay).toBe(DETERMINISTIC_CONFIG.maxDelayMs);
  });

  it("applies jitter within ±jitterFraction of base", () => {
    const config: ListenerReconnectConfig = { ...DETERMINISTIC_CONFIG, jitterFraction: 0.25 };
    const base = 2_000;
    for (let i = 0; i < 20; i++) {
      const delay = calculateReconnectDelay(1, config);
      expect(delay).toBeGreaterThanOrEqual(base * 0.75);
      expect(delay).toBeLessThanOrEqual(base * 1.25);
    }
  });

  it("never returns a negative delay", () => {
    const config: ListenerReconnectConfig = { ...DETERMINISTIC_CONFIG, jitterFraction: 0.99 };
    for (let i = 0; i < 20; i++) {
      expect(calculateReconnectDelay(0, config)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("ListenerBackoffState", () => {
  let state: ListenerBackoffState;

  beforeEach(() => {
    state = new ListenerBackoffState(DETERMINISTIC_CONFIG);
  });

  it("starts at attempt 0", () => {
    expect(state.currentAttempt).toBe(0);
  });

  it("increments attempt counter on each failure", () => {
    state.recordFailure();
    expect(state.currentAttempt).toBe(1);
    state.recordFailure();
    expect(state.currentAttempt).toBe(2);
  });

  it("returns increasing delay on successive failures", () => {
    const { delayMs: d1 } = state.recordFailure();
    const { delayMs: d2 } = state.recordFailure();
    expect(d2).toBeGreaterThan(d1);
  });

  it("resets attempt counter after healthResetThreshold consecutive successes", () => {
    state.recordFailure();
    state.recordFailure();
    expect(state.currentAttempt).toBe(2);

    for (let i = 0; i < DETERMINISTIC_CONFIG.healthResetThreshold; i++) {
      state.recordSuccess();
    }

    expect(state.currentAttempt).toBe(0);
  });

  it("does not reset if successes are interrupted by a failure", () => {
    state.recordFailure();
    state.recordSuccess();
    state.recordSuccess();
    state.recordFailure();
    // success streak interrupted — attempt count should not have reset
    expect(state.currentAttempt).toBe(2);
  });

  it("resets consecutive-success counter when a failure occurs", () => {
    state.recordSuccess();
    state.recordSuccess();
    state.recordFailure();
    expect(state.currentConsecutiveSuccesses).toBe(0);
  });

  it("reset() clears both counters", () => {
    state.recordFailure();
    state.recordSuccess();
    state.reset();
    expect(state.currentAttempt).toBe(0);
    expect(state.currentConsecutiveSuccesses).toBe(0);
  });

  it("does not reset when attempt is already 0 (healthy baseline)", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    for (let i = 0; i < DETERMINISTIC_CONFIG.healthResetThreshold; i++) {
      state.recordSuccess();
    }
    // No reset message should appear since attempt was already 0
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining("resetting backoff"));
    consoleSpy.mockRestore();
  });

  it("backoff schedule stays bounded at maxDelayMs", () => {
    for (let i = 0; i < 25; i++) {
      const { delayMs } = state.recordFailure();
      expect(delayMs).toBeLessThanOrEqual(DETERMINISTIC_CONFIG.maxDelayMs);
    }
  });
});
