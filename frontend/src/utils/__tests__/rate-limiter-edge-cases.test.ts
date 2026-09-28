/**
 * Tests for rate limiter edge cases and backoff mechanisms
 * Issue #1972: Rate limiter edge cases and exponential backoff boundary conditions
 *
 * Coverage targets:
 *  - RateLimiter: sliding window implementation, edge cases at boundaries
 *  - calculateBackoffDelay: jitter application, max delay capping
 *  - Backoff calculations: exponential progression, jitter range validation
 *  - Window management: timestamp filtering, request cleanup
 *  - Edge cases: zero window, negative times, max values
 *  - Concurrent requests: race conditions, rapid-fire requests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimiter, calculateBackoffDelay, RetryConfig } from '../retry';

describe('Rate Limiter Edge Cases', () => {
  describe('RateLimiter', () => {
    let limiter: RateLimiter;

    beforeEach(() => {
      vi.useFakeTimers();
      limiter = new RateLimiter(5, 10000); // 5 requests per 10 seconds
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('basic rate limiting', () => {
      it('allows requests within limit', () => {
        expect(() => {
          for (let i = 0; i < 5; i++) {
            limiter.checkLimit();
          }
        }).not.toThrow();
      });

      it('throws when limit exceeded', () => {
        for (let i = 0; i < 5; i++) {
          limiter.checkLimit();
        }
        expect(() => limiter.checkLimit()).toThrow('Rate limit exceeded');
      });

      it('allows new requests after window expires', () => {
        for (let i = 0; i < 5; i++) {
          limiter.checkLimit();
        }
        expect(() => limiter.checkLimit()).toThrow();

        // Advance past window
        vi.advanceTimersByTime(10001);

        // Should allow requests again
        expect(() => limiter.checkLimit()).not.toThrow();
      });

      it('correctly tracks requests at window boundary', () => {
        for (let i = 0; i < 5; i++) {
          limiter.checkLimit();
        }

        // Advance to just before window expiry
        vi.advanceTimersByTime(9999);

        // Still limited
        expect(() => limiter.checkLimit()).toThrow();

        // Advance past window
        vi.advanceTimersByTime(2);

        // Now allowed
        expect(() => limiter.checkLimit()).not.toThrow();
      });
    });

    describe('sliding window behavior', () => {
      it('removes old requests from window', () => {
        limiter.checkLimit(); // t=0
        expect(limiter.getRemainingRequests()).toBe(4);

        vi.advanceTimersByTime(5000);

        limiter.checkLimit(); // t=5000
        expect(limiter.getRemainingRequests()).toBe(3);

        // Advance so first request is out of window
        vi.advanceTimersByTime(5001);

        // First request should be removed
        expect(limiter.getRemainingRequests()).toBe(4); // 4 requests remaining of the original 5
      });

      it('correctly cleans up old timestamps', () => {
        for (let i = 0; i < 3; i++) {
          limiter.checkLimit();
        }

        // Advance beyond window
        vi.advanceTimersByTime(10001);

        // All old requests should be cleaned up
        expect(limiter.getRemainingRequests()).toBe(5);

        // Should be able to make requests
        limiter.checkLimit();
        expect(limiter.getRemainingRequests()).toBe(4);
      });

      it('handles burst requests at start of window', () => {
        const bursts = 3;
        for (let i = 0; i < bursts; i++) {
          limiter.checkLimit();
        }

        expect(limiter.getRemainingRequests()).toBe(2);

        // Should not allow more until some time passes or window resets
        expect(() => {
          for (let i = 0; i < 3; i++) {
            limiter.checkLimit();
          }
        }).toThrow();
      });
    });

    describe('getRemainingRequests', () => {
      it('returns correct remaining requests', () => {
        expect(limiter.getRemainingRequests()).toBe(5);

        limiter.checkLimit();
        expect(limiter.getRemainingRequests()).toBe(4);

        limiter.checkLimit();
        expect(limiter.getRemainingRequests()).toBe(3);
      });

      it('returns zero when limit reached', () => {
        for (let i = 0; i < 5; i++) {
          limiter.checkLimit();
        }
        expect(limiter.getRemainingRequests()).toBe(0);
      });

      it('does not exceed max requests', () => {
        expect(limiter.getRemainingRequests()).toBeGreaterThanOrEqual(0);
        expect(limiter.getRemainingRequests()).toBeLessThanOrEqual(5);
      });

      it('returns full capacity after window reset', () => {
        for (let i = 0; i < 5; i++) {
          limiter.checkLimit();
        }

        vi.advanceTimersByTime(10001);

        expect(limiter.getRemainingRequests()).toBe(5);
      });
    });

    describe('reset functionality', () => {
      it('clears all request history', () => {
        for (let i = 0; i < 5; i++) {
          limiter.checkLimit();
        }

        limiter.reset();

        expect(limiter.getRemainingRequests()).toBe(5);
        expect(() => limiter.checkLimit()).not.toThrow();
      });

      it('allows requests immediately after reset', () => {
        for (let i = 0; i < 5; i++) {
          limiter.checkLimit();
        }

        expect(() => limiter.checkLimit()).toThrow();

        limiter.reset();

        expect(() => limiter.checkLimit()).not.toThrow();
      });

      it('resets even with old timestamps', () => {
        limiter.checkLimit();
        vi.advanceTimersByTime(5000);
        limiter.checkLimit();
        vi.advanceTimersByTime(5001); // Old requests should be out of window

        limiter.reset();

        expect(limiter.getRemainingRequests()).toBe(5);
      });
    });

    describe('edge cases', () => {
      it('handles single request limit', () => {
        const singleLimiter = new RateLimiter(1, 1000);
        singleLimiter.checkLimit();
        expect(() => singleLimiter.checkLimit()).toThrow();

        vi.advanceTimersByTime(1001);
        expect(() => singleLimiter.checkLimit()).not.toThrow();
      });

      it('handles very large request limits', () => {
        const largeLimiter = new RateLimiter(10000, 60000);
        for (let i = 0; i < 10000; i++) {
          largeLimiter.checkLimit();
        }
        expect(() => largeLimiter.checkLimit()).toThrow();
      });

      it('handles very small time window', () => {
        const tinyLimiter = new RateLimiter(10, 100); // 10 req per 100ms
        for (let i = 0; i < 10; i++) {
          tinyLimiter.checkLimit();
        }

        expect(() => tinyLimiter.checkLimit()).toThrow();

        vi.advanceTimersByTime(101);
        expect(() => tinyLimiter.checkLimit()).not.toThrow();
      });

      it('handles rapid sequential requests', () => {
        const fastLimiter = new RateLimiter(3, 1000);
        const checkRapidly = () => {
          fastLimiter.checkLimit();
          fastLimiter.checkLimit();
          fastLimiter.checkLimit();
        };

        expect(checkRapidly).not.toThrow();
        expect(() => fastLimiter.checkLimit()).toThrow();
      });

      it('handles mixed request timing patterns', () => {
        const mixedLimiter = new RateLimiter(5, 10000);

        // Initial requests
        for (let i = 0; i < 3; i++) {
          mixedLimiter.checkLimit();
        }

        // Advance partially through window
        vi.advanceTimersByTime(3000);

        // More requests
        for (let i = 0; i < 2; i++) {
          mixedLimiter.checkLimit();
        }

        // Should be at limit
        expect(() => mixedLimiter.checkLimit()).toThrow();

        // Advance so first batch expires
        vi.advanceTimersByTime(7001);

        // Should be able to make 3 requests now (first batch expired)
        for (let i = 0; i < 3; i++) {
          mixedLimiter.checkLimit();
        }

        expect(mixedLimiter.getRemainingRequests()).toBe(0);
      });
    });

    describe('concurrent scenarios', () => {
      it('handles many rapid requests from near-simultaneous times', () => {
        const concurrentLimiter = new RateLimiter(5, 1000);

        // Simulate near-simultaneous requests
        for (let i = 0; i < 5; i++) {
          concurrentLimiter.checkLimit();
          vi.advanceTimersByTime(1); // Minimal time advance
        }

        expect(() => concurrentLimiter.checkLimit()).toThrow();
      });

      it('handles overlapping request windows', () => {
        const overlapLimiter = new RateLimiter(10, 1000);

        // Add 5 requests
        for (let i = 0; i < 5; i++) {
          overlapLimiter.checkLimit();
        }

        // Advance 500ms
        vi.advanceTimersByTime(500);

        // Add 5 more
        for (let i = 0; i < 5; i++) {
          overlapLimiter.checkLimit();
        }

        // Should be at limit
        expect(overlapLimiter.getRemainingRequests()).toBe(0);

        // Advance another 501ms (1001 total from first batch)
        vi.advanceTimersByTime(501);

        // First batch should expire, allowing 5 more
        expect(overlapLimiter.getRemainingRequests()).toBe(5);
      });
    });

    describe('error messages', () => {
      it('throws informative error when limit exceeded', () => {
        const errorLimiter = new RateLimiter(1, 1000);
        errorLimiter.checkLimit();

        let error: any;
        try {
          errorLimiter.checkLimit();
        } catch (e) {
          error = e;
        }

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('Rate limit exceeded');
      });
    });
  });

  describe('Backoff Delay Calculations', () => {
    const config: RetryConfig = {
      maxAttempts: 5,
      initialDelay: 100,
      maxDelay: 10000,
      backoffFactor: 2,
      jitterFactor: 0.2,
      timeout: 30000,
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('exponential backoff progression', () => {
      it('calculates correct exponential delays without jitter', () => {
        const noJitterConfig: RetryConfig = { ...config, jitterFactor: 0 };

        const delay1 = calculateBackoffDelay(1, noJitterConfig);
        expect(delay1).toBe(100); // Initial delay

        const delay2 = calculateBackoffDelay(2, noJitterConfig);
        expect(delay2).toBe(200); // 100 * 2^(2-1)

        const delay3 = calculateBackoffDelay(3, noJitterConfig);
        expect(delay3).toBe(400); // 100 * 2^(3-1)

        const delay4 = calculateBackoffDelay(4, noJitterConfig);
        expect(delay4).toBe(800); // 100 * 2^(4-1)
      });

      it('caps delays at maxDelay', () => {
        const noJitterConfig: RetryConfig = { ...config, jitterFactor: 0 };

        const delay5 = calculateBackoffDelay(5, noJitterConfig);
        // 100 * 2^(5-1) = 1600, no cap
        expect(delay5).toBe(1600);

        const delay10 = calculateBackoffDelay(10, noJitterConfig);
        // 100 * 2^(10-1) = 51200, capped at 10000
        expect(delay10).toBe(config.maxDelay);
      });

      it('handles large attempt numbers', () => {
        const noJitterConfig: RetryConfig = { ...config, jitterFactor: 0 };
        const delayLarge = calculateBackoffDelay(100, noJitterConfig);
        expect(delayLarge).toBeLessThanOrEqual(config.maxDelay);
        expect(delayLarge).toBeGreaterThan(0);
      });
    });

    describe('jitter application', () => {
      it('applies jitter within expected range', () => {
        const delays = Array.from({ length: 100 }, () =>
          calculateBackoffDelay(2, config)
        );

        const minDelay = Math.min(...delays);
        const maxDelay = Math.max(...delays);

        // For attempt 2: base = 200, jitter factor = 0.2
        // Jitter range: ±40 (200 * 0.2)
        // Expected range: [160, 240]
        expect(minDelay).toBeGreaterThanOrEqual(160);
        expect(maxDelay).toBeLessThanOrEqual(240);
      });

      it('never produces negative delays', () => {
        for (let i = 1; i <= 10; i++) {
          const delay = calculateBackoffDelay(i, config);
          expect(delay).toBeGreaterThanOrEqual(0);
        }
      });

      it('produces different delays with jitter (probabilistically)', () => {
        const delays = Array.from({ length: 50 }, () =>
          calculateBackoffDelay(2, config)
        );

        const uniqueDelays = new Set(delays);
        // With jitter, we should get multiple different values
        expect(uniqueDelays.size).toBeGreaterThan(1);
      });

      it('produces consistent delays without jitter', () => {
        const noJitterConfig: RetryConfig = { ...config, jitterFactor: 0 };
        const delays = Array.from({ length: 10 }, () =>
          calculateBackoffDelay(2, noJitterConfig)
        );

        expect(delays).toEqual(Array(10).fill(200));
      });

      it('handles large jitter factors', () => {
        const largeJitterConfig: RetryConfig = { ...config, jitterFactor: 0.5 };
        const delays = Array.from({ length: 50 }, () =>
          calculateBackoffDelay(2, largeJitterConfig)
        );

        const minDelay = Math.min(...delays);
        const maxDelay = Math.max(...delays);

        // For attempt 2: base = 200, jitter factor = 0.5
        // Jitter range: ±100 (200 * 0.5)
        // Expected range: [100, 300]
        expect(minDelay).toBeGreaterThanOrEqual(100);
        expect(maxDelay).toBeLessThanOrEqual(300);
      });

      it('handles zero jitter factor', () => {
        const noJitterConfig: RetryConfig = { ...config, jitterFactor: 0 };
        const delay = calculateBackoffDelay(2, noJitterConfig);
        expect(delay).toBe(200);
      });

      it('handles undefined jitter factor (should default to 0)', () => {
        const noJitterConfig: RetryConfig = { ...config, jitterFactor: undefined };
        const delay = calculateBackoffDelay(2, noJitterConfig);
        expect(delay).toBe(200);
      });
    });

    describe('backoff factor variations', () => {
      it('calculates delays with different backoff factors', () => {
        const linearConfig: RetryConfig = { ...config, backoffFactor: 1.5, jitterFactor: 0 };

        const delay1 = calculateBackoffDelay(1, linearConfig);
        expect(delay1).toBe(100);

        const delay2 = calculateBackoffDelay(2, linearConfig);
        expect(delay2).toBe(150); // 100 * 1.5

        const delay3 = calculateBackoffDelay(3, linearConfig);
        expect(delay3).toBe(225); // 100 * 1.5^2
      });

      it('handles linear backoff factor of 1', () => {
        const linearConfig: RetryConfig = { ...config, backoffFactor: 1, jitterFactor: 0 };

        const delay1 = calculateBackoffDelay(1, linearConfig);
        const delay2 = calculateBackoffDelay(2, linearConfig);
        const delay3 = calculateBackoffDelay(3, linearConfig);

        expect(delay1).toBe(100);
        expect(delay2).toBe(100);
        expect(delay3).toBe(100);
      });

      it('handles very aggressive backoff factor', () => {
        const aggressiveConfig: RetryConfig = { ...config, backoffFactor: 10, jitterFactor: 0 };

        const delay1 = calculateBackoffDelay(1, aggressiveConfig);
        expect(delay1).toBe(100);

        const delay2 = calculateBackoffDelay(2, aggressiveConfig);
        expect(delay2).toBe(1000);

        const delay3 = calculateBackoffDelay(3, aggressiveConfig);
        // 100 * 10^2 = 10000, capped at maxDelay
        expect(delay3).toBe(config.maxDelay);
      });
    });

    describe('initial and max delay variations', () => {
      it('respects custom initial delay', () => {
        const customConfig: RetryConfig = { ...config, initialDelay: 500, jitterFactor: 0 };
        const delay = calculateBackoffDelay(1, customConfig);
        expect(delay).toBe(500);
      });

      it('respects custom max delay', () => {
        const customConfig: RetryConfig = { ...config, maxDelay: 1000, jitterFactor: 0 };
        const delayLarge = calculateBackoffDelay(20, customConfig);
        expect(delayLarge).toBeLessThanOrEqual(1000);
      });

      it('handles initial delay larger than max delay', () => {
        const weirdConfig: RetryConfig = { ...config, initialDelay: 10000, maxDelay: 1000, jitterFactor: 0 };
        const delay1 = calculateBackoffDelay(1, weirdConfig);
        // Should still cap at maxDelay
        expect(delay1).toBeLessThanOrEqual(weirdConfig.maxDelay);
      });
    });

    describe('boundary conditions', () => {
      it('handles attempt 1 correctly', () => {
        const noJitterConfig: RetryConfig = { ...config, jitterFactor: 0 };
        const delay = calculateBackoffDelay(1, noJitterConfig);
        expect(delay).toBe(config.initialDelay);
      });

      it('handles very high attempt numbers', () => {
        const noJitterConfig: RetryConfig = { ...config, jitterFactor: 0 };
        const delay = calculateBackoffDelay(1000, noJitterConfig);
        expect(delay).toBe(config.maxDelay);
      });

      it('handles zero initial delay', () => {
        const zeroConfig: RetryConfig = { ...config, initialDelay: 0, jitterFactor: 0 };
        const delay = calculateBackoffDelay(1, zeroConfig);
        expect(delay).toBe(0);
      });

      it('handles zero max delay', () => {
        const zeroConfig: RetryConfig = { ...config, maxDelay: 0, jitterFactor: 0 };
        const delay = calculateBackoffDelay(1, zeroConfig);
        // Should be capped at 0
        expect(delay).toBeLessThanOrEqual(0);
      });
    });
  });
});
