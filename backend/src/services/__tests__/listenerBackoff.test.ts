/**
 * Tests for listener backoff with jitter (#1582)
 *
 * Covers:
 *  - Jitter is applied and bounded within configured limits
 *  - Jitter prevents lockstep reconnection across fleet
 *  - RNG is injectable for deterministic testing
 *  - Exponential backoff respects max delay ceiling
 *  - Health reset threshold functionality
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  calculateReconnectDelay,
  ListenerBackoffState,
  LISTENER_RECONNECT_CONFIG,
  ListenerReconnectConfig,
  RNG,
} from "../listenerBackoff";

describe("calculateReconnectDelay", () => {
  describe("backoff calculation", () => {
    it("grows exponentially with attempt number", () => {
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        const fixedRNG: RNG = () => 0.5; // No jitter
        delays.push(calculateReconnectDelay(i, LISTENER_RECONNECT_CONFIG, fixedRNG));
      }

      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThan(delays[i - 1]);
      }
    });

    it("respects max delay ceiling", () => {
      const config: ListenerReconnectConfig = {
        ...LISTENER_RECONNECT_CONFIG,
        maxDelayMs: 10_000,
      };

      const fixedRNG: RNG = () => 0.5;
      const delay = calculateReconnectDelay(20, config, fixedRNG);

      expect(delay).toBeLessThanOrEqual(config.maxDelayMs);
    });
  });

  describe("jitter application", () => {
    it("applies jitter bounded within configured fraction", () => {
      const config: ListenerReconnectConfig = {
        ...LISTENER_RECONNECT_CONFIG,
        jitterFraction: 0.25,
      };

      const samples = 100;
      for (let i = 0; i < samples; i++) {
        const randomRNG: RNG = Math.random;
        const delay = calculateReconnectDelay(2, config, randomRNG);

        // Base at attempt 2: 1000 * 2^2 = 4000
        // Jitter range: ±(4000 * 0.25) = ±1000
        // Valid range: [3000, 5000]
        const base = 1000 * Math.pow(2, 2);
        const maxJitter = base * 0.25;

        expect(delay).toBeGreaterThanOrEqual(base - maxJitter);
        expect(delay).toBeLessThanOrEqual(base + maxJitter);
      }
    });

    it("prevents lockstep reconnection with randomized jitter", () => {
      const samples = 50;
      const delays: number[] = [];

      for (let i = 0; i < samples; i++) {
        const randomRNG: RNG = Math.random;
        const delay = calculateReconnectDelay(3, LISTENER_RECONNECT_CONFIG, randomRNG);
        delays.push(delay);
      }

      // Calculate variance — if all delays were identical (no jitter), variance would be 0
      const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
      const variance = delays.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / delays.length;

      // With jitter, variance should be substantial
      expect(variance).toBeGreaterThan(0);
      expect(new Set(delays).size).toBeGreaterThan(1);
    });

    it("uses injectable RNG for deterministic testing", () => {
      const fixedRNG: RNG = () => 0.75; // Always return 0.75
      const delay = calculateReconnectDelay(1, LISTENER_RECONNECT_CONFIG, fixedRNG);

      // Base at attempt 1: 1000 * 2^1 = 2000
      // Jitter: 2000 * 0.25 * (0.75 * 2 - 1) = 2000 * 0.25 * 0.5 = 250
      // Expected: 2000 + 250 = 2250
      const expected = 2000 + 250;
      expect(delay).toBe(expected);
    });

    it("returns zero or positive delay even with negative jitter", () => {
      const negativeRNG: RNG = () => 0; // Max negative jitter
      const delay = calculateReconnectDelay(0, LISTENER_RECONNECT_CONFIG, negativeRNG);

      expect(delay).toBeGreaterThanOrEqual(0);
    });
  });

  describe("boundary conditions", () => {
    it("handles zero attempt", () => {
      const fixedRNG: RNG = () => 0.5;
      const delay = calculateReconnectDelay(0, LISTENER_RECONNECT_CONFIG, fixedRNG);

      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(LISTENER_RECONNECT_CONFIG.initialDelayMs);
    });

    it("respects jitter bounds at high attempts", () => {
      const config: ListenerReconnectConfig = {
        ...LISTENER_RECONNECT_CONFIG,
        maxDelayMs: 60_000,
      };

      const randomRNG: RNG = Math.random;
      const delay = calculateReconnectDelay(100, config, randomRNG);

      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(config.maxDelayMs);
    });
  });
});

describe("ListenerBackoffState", () => {
  describe("basic functionality", () => {
    it("tracks attempt number", () => {
      const state = new ListenerBackoffState();

      expect(state.currentAttempt).toBe(0);
      const result = state.recordFailure();
      expect(result.attempt).toBe(1);
      expect(state.currentAttempt).toBe(1);
    });

    it("returns increasing delays on successive failures", () => {
      const fixedRNG: RNG = () => 0.5; // No jitter
      const state = new ListenerBackoffState(LISTENER_RECONNECT_CONFIG, fixedRNG);

      const delay1 = state.recordFailure().delayMs;
      const delay2 = state.recordFailure().delayMs;
      const delay3 = state.recordFailure().delayMs;

      expect(delay2).toBeGreaterThan(delay1);
      expect(delay3).toBeGreaterThan(delay2);
    });
  });

  describe("jitter with injectable RNG", () => {
    it("accepts custom RNG for deterministic testing", () => {
      const mockRNG: RNG = () => 0.75;
      const state = new ListenerBackoffState(LISTENER_RECONNECT_CONFIG, mockRNG);

      const result = state.recordFailure();
      const expected = LISTENER_RECONNECT_CONFIG.initialDelayMs + 250; // jitter = 1000 * 0.25 * 0.5

      expect(result.delayMs).toBe(expected);
    });

    it("applies jitter per failure", () => {
      let callCount = 0;
      const sequentialRNG: RNG = () => {
        callCount++;
        return callCount === 1 ? 0.25 : 0.75; // Different jitter for each call
      };

      const state = new ListenerBackoffState(LISTENER_RECONNECT_CONFIG, sequentialRNG);

      const delay1 = state.recordFailure().delayMs;
      callCount = 0; // Reset for next call
      const delay2 = state.recordFailure().delayMs;

      // Different RNG values produce different jitter
      expect(delay1).not.toBe(delay2);
    });
  });

  describe("health reset", () => {
    it("resets attempt counter after consecutive successes", () => {
      const fixedRNG: RNG = () => 0.5;
      const config: ListenerReconnectConfig = {
        ...LISTENER_RECONNECT_CONFIG,
        healthResetThreshold: 3,
      };
      const state = new ListenerBackoffState(config, fixedRNG);

      state.recordFailure();
      state.recordFailure();
      expect(state.currentAttempt).toBe(2);

      state.recordSuccess();
      state.recordSuccess();
      state.recordSuccess();

      expect(state.currentAttempt).toBe(0);
      expect(state.currentConsecutiveSuccesses).toBe(0);
    });

    it("does not reset if successes don't reach threshold", () => {
      const fixedRNG: RNG = () => 0.5;
      const config: ListenerReconnectConfig = {
        ...LISTENER_RECONNECT_CONFIG,
        healthResetThreshold: 5,
      };
      const state = new ListenerBackoffState(config, fixedRNG);

      state.recordFailure();
      state.recordFailure();
      expect(state.currentAttempt).toBe(2);

      state.recordSuccess();
      state.recordSuccess(); // Only 2 successes, threshold is 5

      expect(state.currentAttempt).toBe(2); // Still at 2
      expect(state.currentConsecutiveSuccesses).toBe(2);
    });

    it("resets consecutive success counter on failure", () => {
      const fixedRNG: RNG = () => 0.5;
      const state = new ListenerBackoffState(LISTENER_RECONNECT_CONFIG, fixedRNG);

      state.recordSuccess();
      state.recordSuccess();
      expect(state.currentConsecutiveSuccesses).toBe(2);

      state.recordFailure();
      expect(state.currentConsecutiveSuccesses).toBe(0);
    });
  });

  describe("reset method", () => {
    it("resets both attempt and consecutive successes", () => {
      const fixedRNG: RNG = () => 0.5;
      const state = new ListenerBackoffState(LISTENER_RECONNECT_CONFIG, fixedRNG);

      state.recordFailure();
      state.recordFailure();
      state.recordSuccess();

      expect(state.currentAttempt).toBe(2);
      expect(state.currentConsecutiveSuccesses).toBe(1);

      state.reset();

      expect(state.currentAttempt).toBe(0);
      expect(state.currentConsecutiveSuccesses).toBe(0);
    });
  });

  describe("jitter prevents thundering herd", () => {
    it("multiple instances produce different delays despite same attempt", () => {
      const delays: number[] = [];

      for (let i = 0; i < 10; i++) {
        const state = new ListenerBackoffState(LISTENER_RECONNECT_CONFIG);
        const delay = state.recordFailure().delayMs;
        delays.push(delay);
      }

      // If there were no jitter, all delays would be identical
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    it("jitter distribution is reasonable", () => {
      const samples = 500;
      const delays: number[] = [];

      for (let i = 0; i < samples; i++) {
        const state = new ListenerBackoffState(LISTENER_RECONNECT_CONFIG);
        state.recordFailure(); // First failure
        delays.push(state.recordFailure().delayMs); // Second failure
      }

      const minDelay = Math.min(...delays);
      const maxDelay = Math.max(...delays);
      const range = maxDelay - minDelay;

      // Base at attempt 2: 4000ms
      // Jitter: ±1000ms (25% of base)
      // Expected range: ~2000ms (3000-5000)
      expect(range).toBeGreaterThan(1000);
      expect(range).toBeLessThan(3000);
    });
  });
});
