/**
 * Integration test: End-to-end exactly-once delivery with idempotency fencing tokens (#1627)
 *
 * This test harness deliberately introduces duplicate and reordered events at
 * each stage boundary and proves that the customer-visible webhook count equals
 * the true unique-event count.
 *
 * Stages under test:
 *   1. Event ingestion (stellarEventListener → projection)
 *   2. Projection write (campaignProjectionService)
 *   3. Webhook dispatch (webhookDeliveryService)
 *
 * For each stage we verify:
 *   - A first delivery succeeds and records the token
 *   - A replayed event with the same fencing token is a silent no-op
 *   - The customer-visible webhook count == unique event count
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  createFencingToken,
  parseFencingToken,
  InMemoryFencingTokenStore,
  withFencingToken,
  extractFencingTokenFromPayload,
  type FencingToken,
  type FencingTokenStore,
} from "../../lib/fencingToken";

// ─── Minimal in-process stubs ─────────────────────────────────────────────────

/** Stub that counts how many times applyEvent is called. */
class StubProjectionService {
  public applyCount = 0;
  public appliedTokenIds: string[] = [];

  async applyEvent(fencingTokenId: string, _payload: unknown): Promise<void> {
    this.applyCount++;
    this.appliedTokenIds.push(fencingTokenId);
  }
}

/** Stub that counts how many webhooks were dispatched. */
class StubWebhookDeliveryService {
  public dispatchCount = 0;
  public dispatchedTokenIds: string[] = [];

  async dispatch(fencingTokenId: string, _payload: unknown): Promise<void> {
    this.dispatchCount++;
    this.dispatchedTokenIds.push(fencingTokenId);
  }
}

/**
 * Simulates the full pipeline:
 *   ingestion → projection → webhook
 *
 * Each stage uses a separate FencingTokenStore so that exactly-once
 * semantics are enforced independently at every boundary.
 */
class ExactlyOncePipeline {
  public readonly ingestionStore: FencingTokenStore;
  public readonly projectionStore: FencingTokenStore;
  public readonly webhookStore: FencingTokenStore;

  public readonly projectionSvc: StubProjectionService;
  public readonly webhookSvc: StubWebhookDeliveryService;

  constructor() {
    this.ingestionStore = new InMemoryFencingTokenStore();
    this.projectionStore = new InMemoryFencingTokenStore();
    this.webhookStore = new InMemoryFencingTokenStore();
    this.projectionSvc = new StubProjectionService();
    this.webhookSvc = new StubWebhookDeliveryService();
  }

  /**
   * Process a single event end-to-end.
   *
   * @returns true if the event was processed for the first time; false if it
   *          was a duplicate at the ingestion stage and skipped entirely.
   */
  async processEvent(token: FencingToken, payload: unknown): Promise<boolean> {
    // Stage 1: ingestion fence
    const ingestionResult = await withFencingToken(
      this.ingestionStore,
      token,
      async () => {
        // Stage 2: projection fence
        await withFencingToken(this.projectionStore, token, async () => {
          await this.projectionSvc.applyEvent(token.id, payload);
        });

        // Stage 3: webhook fence
        await withFencingToken(this.webhookStore, token, async () => {
          await this.webhookSvc.dispatch(token.id, payload);
        });
      }
    );

    return !ingestionResult.skipped;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Exactly-Once Delivery with Fencing Tokens (#1627)", () => {
  let pipeline: ExactlyOncePipeline;

  beforeEach(() => {
    pipeline = new ExactlyOncePipeline();
  });

  // ── Fencing token creation and parsing ────────────────────────────────────

  it("creates a fencing token with the correct id format", () => {
    const t = createFencingToken(1_234_567, 3);
    expect(t.ledger).toBe(1_234_567);
    expect(t.opIndex).toBe(3);
    expect(t.id).toBe("1234567:3");
  });

  it("round-trips through serialisation/deserialisation", () => {
    const original = createFencingToken(99, 7);
    const parsed = parseFencingToken(original.id);
    expect(parsed.ledger).toBe(99);
    expect(parsed.opIndex).toBe(7);
    expect(parsed.id).toBe(original.id);
  });

  it("throws on malformed fencing token strings", () => {
    expect(() => parseFencingToken("not-valid")).toThrow(TypeError);
    expect(() => parseFencingToken("123:abc")).toThrow();
    expect(() => parseFencingToken("")).toThrow();
  });

  // ── Single event ─────────────────────────────────────────────────────────

  it("processes a unique event exactly once end-to-end", async () => {
    const token = createFencingToken(1000, 0);
    const processed = await pipeline.processEvent(token, { type: "TOKEN_CREATED" });

    expect(processed).toBe(true);
    expect(pipeline.projectionSvc.applyCount).toBe(1);
    expect(pipeline.webhookSvc.dispatchCount).toBe(1);
  });

  // ── Duplicate at ingestion stage ─────────────────────────────────────────

  it("drops duplicate events at the ingestion stage (no double projection/webhook)", async () => {
    const token = createFencingToken(1001, 0);
    const payload = { type: "CAMPAIGN_CREATED" };

    // First delivery
    const first = await pipeline.processEvent(token, payload);
    // Duplicate delivery (same token)
    const second = await pipeline.processEvent(token, payload);

    expect(first).toBe(true);
    expect(second).toBe(false); // duplicate was dropped

    // Projection and webhook each called exactly once
    expect(pipeline.projectionSvc.applyCount).toBe(1);
    expect(pipeline.webhookSvc.dispatchCount).toBe(1);
  });

  // ── Duplicate injected at projection stage ────────────────────────────────

  it("drops duplicate at projection stage independently of ingestion", async () => {
    const token = createFencingToken(1002, 1);

    // Simulate: ingestion passes but projection store already has the token
    await pipeline.projectionStore.markProcessed(token.id);

    // Process through the full pipeline
    await pipeline.processEvent(token, {});

    // Projection must NOT be called (token already in projection store)
    expect(pipeline.projectionSvc.applyCount).toBe(0);
    // Webhook still runs because webhook store is independent
    expect(pipeline.webhookSvc.dispatchCount).toBe(1);
  });

  // ── Duplicate injected at webhook stage ───────────────────────────────────

  it("drops duplicate at webhook dispatch stage independently", async () => {
    const token = createFencingToken(1003, 2);

    // Simulate: ingestion + projection pass, webhook store already has the token
    await pipeline.webhookStore.markProcessed(token.id);

    await pipeline.processEvent(token, {});

    // Projection runs (webhook store is separate from projection store)
    expect(pipeline.projectionSvc.applyCount).toBe(1);
    // Webhook is skipped (already in webhook store)
    expect(pipeline.webhookSvc.dispatchCount).toBe(0);
  });

  // ── Multiple unique events ────────────────────────────────────────────────

  it("processes N unique events with exactly N projections and N webhooks", async () => {
    const N = 10;
    for (let i = 0; i < N; i++) {
      await pipeline.processEvent(createFencingToken(2000 + i, 0), { idx: i });
    }

    expect(pipeline.projectionSvc.applyCount).toBe(N);
    expect(pipeline.webhookSvc.dispatchCount).toBe(N);
  });

  // ── Reordered events ──────────────────────────────────────────────────────

  it("handles reordered events – each unique event still processed once", async () => {
    const tokens = [
      createFencingToken(3002, 0),
      createFencingToken(3000, 0),
      createFencingToken(3001, 0),
    ];

    // Deliver out of ledger order
    for (const t of tokens) {
      await pipeline.processEvent(t, {});
    }

    expect(pipeline.projectionSvc.applyCount).toBe(3);
    expect(pipeline.webhookSvc.dispatchCount).toBe(3);

    // All unique token IDs present exactly once in webhook stage
    const ids = new Set(pipeline.webhookSvc.dispatchedTokenIds);
    expect(ids.size).toBe(3);
  });

  // ── Duplicate + reordered chaos ───────────────────────────────────────────

  it("chaos: duplicate + reordered events → exactly-once at every stage", async () => {
    const uniqueTokens = [
      createFencingToken(5000, 0),
      createFencingToken(5001, 0),
      createFencingToken(5002, 0),
    ];

    // Build a chaotic delivery sequence: reordered + each event duplicated twice
    const delivery = [
      uniqueTokens[2]!,
      uniqueTokens[0]!,
      uniqueTokens[2]!, // duplicate
      uniqueTokens[1]!,
      uniqueTokens[0]!, // duplicate
      uniqueTokens[1]!, // duplicate
      uniqueTokens[2]!, // duplicate again
    ];

    for (const t of delivery) {
      await pipeline.processEvent(t, { type: "event" });
    }

    // Despite 7 deliveries, each unique event processed once
    expect(pipeline.projectionSvc.applyCount).toBe(3);
    expect(pipeline.webhookSvc.dispatchCount).toBe(3);

    // Unique IDs dispatched match unique tokens
    const dispatchedIds = new Set(pipeline.webhookSvc.dispatchedTokenIds);
    expect(dispatchedIds.size).toBe(3);
    for (const t of uniqueTokens) {
      expect(dispatchedIds.has(t.id)).toBe(true);
    }
  });

  // ── extractFencingTokenFromPayload ────────────────────────────────────────

  it("extracts fencing token from a webhook payload meta field", () => {
    const token = createFencingToken(9999, 5);
    const payload = { meta: { fencingTokenId: token.id } };
    const extracted = extractFencingTokenFromPayload(payload);

    expect(extracted).not.toBeNull();
    expect(extracted!.id).toBe(token.id);
    expect(extracted!.ledger).toBe(9999);
    expect(extracted!.opIndex).toBe(5);
  });

  it("returns null for a payload without fencing token meta", () => {
    expect(extractFencingTokenFromPayload({})).toBeNull();
    expect(extractFencingTokenFromPayload({ meta: {} })).toBeNull();
  });

  // ── InMemoryFencingTokenStore TTL ─────────────────────────────────────────

  it("in-memory store respects TTL expiry", async () => {
    // TTL of 0ms → always expired
    const store = new InMemoryFencingTokenStore(0);
    await store.markProcessed("tok:1");
    // With 0ms TTL every lookup is immediately expired
    // (the impl checks Date.now() - processedAt > ttlMs; with 0 that is > 0 only after 1ms)
    // Force the expiry by using negative TTL indirectly: re-create with 1ms TTL then wait
    const storeShort = new InMemoryFencingTokenStore(1);
    await storeShort.markProcessed("tok:2");
    await new Promise((r) => setTimeout(r, 10)); // wait > 1ms
    expect(await storeShort.isProcessed("tok:2")).toBe(false);
  });

  // ── withFencingToken helper ───────────────────────────────────────────────

  it("withFencingToken does not mark processed when handler throws", async () => {
    const store = new InMemoryFencingTokenStore();
    const token = createFencingToken(7777, 0);

    const failingHandler = async () => {
      throw new Error("transient failure");
    };

    await expect(withFencingToken(store, token, failingHandler)).rejects.toThrow(
      "transient failure"
    );

    // Token must NOT be in the store so retry is possible
    expect(await store.isProcessed(token.id)).toBe(false);
  });
});
