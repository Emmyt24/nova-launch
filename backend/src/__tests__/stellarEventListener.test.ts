import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StellarEventListener, HorizonTransport } from "../services/stellarEventListener";
import { calculateReconnectDelay, LISTENER_RECONNECT_CONFIG } from "../services/listenerBackoff";
import { PrismaClient } from "@prisma/client";

// Fake RPC Stream double
class FakeHorizonTransport implements HorizonTransport {
  public eventBatches: any[] = [];
  public currentBatchIndex = 0;
  public shouldDrop = false;
  public requests: any[] = [];
  public throwError: Error | null = null;
  public nonRetryableError: any | null = null;
  public consecutiveFailures = 0;
  public maxFailures = 0;

  async getEvents(url: string, params: any) {
    this.requests.push({ url, params });
    
    if (this.throwError) {
      throw this.throwError;
    }

    if (this.nonRetryableError) {
      // simulate non-retryable axios error
      throw Object.assign(new Error("Non-retryable"), { 
        isAxiosError: true, 
        response: { status: 400 } 
      });
    }

    if (this.consecutiveFailures < this.maxFailures) {
      this.consecutiveFailures++;
      throw Object.assign(new Error("Transient error"), {
        isAxiosError: true,
        code: "ECONNABORTED"
      });
    }

    if (this.shouldDrop) {
      this.shouldDrop = false; // drop once
      throw Object.assign(new Error("Network drop"), { 
        isAxiosError: true, 
        code: "ECONNRESET" 
      });
    }

    if (this.currentBatchIndex < this.eventBatches.length) {
      const batch = this.eventBatches[this.currentBatchIndex++];
      return { data: { _embedded: { records: batch } } };
    }

    return { data: { _embedded: { records: [] } } };
  }

  async getCurrentLedger(url: string) {
    return 1000;
  }
}

describe("StellarEventListener Reconnect, Cursor Resume, and Backoff", () => {
  let listener: StellarEventListener;
  let transport: FakeHorizonTransport;
  let prisma: PrismaClient;

  beforeEach(() => {
    prisma = new PrismaClient();
    transport = new FakeHorizonTransport();
    listener = new StellarEventListener(transport);
    
    // We override processEvent so it doesn't actually try to write to DB for every event
    // since we only care about cursor persistence and error behavior here.
    vi.spyOn(listener as any, "processEvent").mockResolvedValue(undefined);
    vi.spyOn(listener as any, "applyCatchupPolicyIfNeeded").mockResolvedValue(undefined);
    vi.spyOn(listener as any, "delay").mockResolvedValue(undefined); // Fast forward delays
    
    // Mock the cursor store
    const store = (listener as any).cursorStore;
    vi.spyOn(store, "save").mockResolvedValue(undefined);
    vi.spyOn(store, "load").mockResolvedValue("origin-cursor");

    // Stub out leader election so start() doesn't need a real Redis — grant
    // leadership immediately and keep every fencing-token check valid.
    (listener as any).leaderElection = {
      start: async () => {
        await (listener as any).onBecameLeader(1);
      },
      stop: async () => {},
      isLeader: () => true,
      getFencingToken: () => 1,
      validateFencingToken: async () => true,
    };

    process.env.FACTORY_CONTRACT_ID = "CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    process.env.STELLAR_NETWORK = "TESTNET";
  });

  afterEach(() => {
    listener.stop();
    vi.restoreAllMocks();
  });

  it("should handle connection drop mid-stream and reconnect with cursor resume", async () => {
    transport.eventBatches = [
      [{ paging_token: "token-1", ledger: 100 }],
      [{ paging_token: "token-2", ledger: 101 }]
    ];
    
    transport.shouldDrop = true; // Drop on the first attempt

    // Run the listener's fetch once manually or via start?
    // start() loops infinitely. Let's just call fetchAndProcessEvents directly to test resumption
    // or let's mock pollEvents to break after a few iterations.
    vi.spyOn(listener as any, "pollEvents").mockImplementation(async function(this: any) {
      // iteration 1: drops
      // iteration 2: gets token-1
      // iteration 3: gets token-2
      for (let i = 0; i < 3; i++) {
        try {
          await this.fetchAndProcessEvents();
        } catch (e) {
          // ignore
        }
      }
    });

    await listener.start();
    
    const requests = transport.requests;
    expect(requests.length).toBe(3);
    
    // First request should use origin-cursor
    expect(requests[0].params.cursor).toBe("origin-cursor");
    // Second request (after drop) should ALSO use origin-cursor because no new events were saved
    expect(requests[1].params.cursor).toBe("origin-cursor");
    // Third request should use token-1 because it successfully processed batch 1
    expect(requests[2].params.cursor).toBe("token-1");

    // Assert the listener never re-emits an already-processed ledger event after reconnect
    // Since we sent exactly 2 events across 2 successful batches, processEvent should have been called exactly 2 times.
    expect(listener["processEvent"]).toHaveBeenCalledTimes(2);
  });

  it("should calculate backoff delay with exponential growth and jitter bounds", () => {
    // Tests for calculateReconnectDelay from listenerBackoff.ts
    const initial = LISTENER_RECONNECT_CONFIG.initialDelayMs;
    const factor = LISTENER_RECONNECT_CONFIG.backoffFactor;
    const jitter = LISTENER_RECONNECT_CONFIG.jitterFraction;

    const delay1 = calculateReconnectDelay(1);
    const expectedBase1 = initial * factor; // 2000
    const maxJitter1 = expectedBase1 * jitter; // 500
    expect(delay1).toBeGreaterThanOrEqual(expectedBase1 - maxJitter1);
    expect(delay1).toBeLessThanOrEqual(expectedBase1 + maxJitter1);

    const delay3 = calculateReconnectDelay(3);
    const expectedBase3 = initial * Math.pow(factor, 3); // 8000
    const maxJitter3 = expectedBase3 * jitter; // 2000
    expect(delay3).toBeGreaterThanOrEqual(expectedBase3 - maxJitter3);
    expect(delay3).toBeLessThanOrEqual(expectedBase3 + maxJitter3);

    // Max delay cap
    const delayLarge = calculateReconnectDelay(20);
    const expectedMax = LISTENER_RECONNECT_CONFIG.maxDelayMs;
    const maxJitterLarge = expectedMax * jitter;
    expect(delayLarge).toBeGreaterThanOrEqual(expectedMax - maxJitterLarge);
    expect(delayLarge).toBeLessThanOrEqual(expectedMax + maxJitterLarge);
  });

  it("should surface a terminal error rather than looping forever on max retry exhaustion", async () => {
    transport.maxFailures = LISTENER_RECONNECT_CONFIG.maxRetries + 1; // force max retries to be exceeded

    // We don't mock pollEvents because we want to test its logic.
    // However, it's an async loop. If it throws, start() will reject because we await it,
    // or wait, start() just starts pollEvents().
    // Looking at stellarEventListener.ts, pollEvents is not awaited in start(): `this.pollEvents();`
    // So the error will be unhandled.
    // Let's mock pollEvents to capture the error, OR we can test fetchAndProcessEvents logic if it was doing the retry, 
    // but the retry loop is in pollEvents.
    // Since pollEvents is not awaited, we can call pollEvents directly for testing purposes.
    
    await expect(listener["pollEvents"]()).rejects.toThrow(/Max retries exhausted/);
    
    // We expect it to have attempted exactly maxRetries + 1 times (0 to maxRetries)
    // Wait, the attempt counter is incremented before checking > maxRetries.
    // So if maxRetries is 10, when attempt becomes 11, it throws.
    // 1 failure -> attempt 1
    // ...
    // 11th failure -> attempt 11 -> throws
    expect(transport.requests.length).toBe(LISTENER_RECONNECT_CONFIG.maxRetries + 1);
  });
});
