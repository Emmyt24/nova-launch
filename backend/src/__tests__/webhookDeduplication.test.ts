/**
 * Tests: Stripe Webhook Retry Deduplication Logic
 *
 * Stripe automatically retries webhook deliveries when the endpoint returns a
 * non-2xx response. Each retry carries the same `evt_…` event ID. These tests
 * verify that the deduplication layer correctly:
 *
 *  - Processes a new event ID exactly once
 *  - Recognises a retried delivery (same event ID) as a duplicate and skips it
 *  - Leaves subscription state unchanged after a duplicate delivery
 *  - Respects the deduplication window (expired entries are re-processed)
 *  - Handles 1×, 2×, and 3× delivery of the same event ID idempotently
 *
 * Deduplication strategy (documented here for reference):
 *  An in-memory store keyed by event ID holds entries for `windowMs`
 *  (default 72 h, matching Stripe's maximum retry window). On receipt of a
 *  known event ID the handler is bypassed and the cached result is returned.
 *  The store is fully injectable so tests run without I/O.
 *
 * Issue: #565
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  WebhookDeduplicationService,
  InMemoryEventIdStore,
  DeduplicationConfig,
} from "../services/webhookDeduplication";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Real Stripe event ID format: evt_ followed by 24 alphanumeric chars */
function stripeEventId(suffix = "1234567890abcdefghijklmn"): string {
  return `evt_${suffix}`;
}

function makeService(overrides: Partial<DeduplicationConfig> = {}) {
  const store = new InMemoryEventIdStore();
  const service = new WebhookDeduplicationService(
    { windowMs: 60_000, ...overrides },
    store
  );
  return { service, store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebhookDeduplicationService — Stripe retry deduplication", () => {
  describe("First delivery (new event ID)", () => {
    it("processes a new event ID and calls the handler exactly once", async () => {
      const { service } = makeService();
      const handler = vi.fn().mockResolvedValue("subscription_activated");
      const eventId = stripeEventId();

      const result = await service.process(eventId, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.processed).toBe(true);
      expect(result.duplicate).toBe(false);
    });

    it("stores the event ID after first processing", async () => {
      const { service } = makeService();
      const eventId = stripeEventId();

      await service.process(eventId, async () => "ok");

      expect(service.isDuplicate(eventId)).toBe(true);
    });
  });

  describe("Duplicate delivery (same event ID — Stripe retry)", () => {
    it("skips the handler on a second delivery with the same event ID", async () => {
      const { service } = makeService();
      const handler = vi.fn().mockResolvedValue("subscription_activated");
      const eventId = stripeEventId();

      await service.process(eventId, handler); // 1st delivery
      await service.process(eventId, handler); // 2nd delivery (retry)

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("returns duplicate:true on the second delivery", async () => {
      const { service } = makeService();
      const eventId = stripeEventId();

      await service.process(eventId, async () => "ok");
      const second = await service.process(eventId, async () => "ok");

      expect(second.duplicate).toBe(true);
      expect(second.processed).toBe(false);
    });

    it("subscription state is unchanged after duplicate delivery (1× then 2×)", async () => {
      const { service } = makeService();
      const eventId = stripeEventId();

      let activationCount = 0;
      const activateSubscription = async () => {
        activationCount++;
        return { status: "active", activations: activationCount };
      };

      await service.process(eventId, activateSubscription); // 1st
      await service.process(eventId, activateSubscription); // 2nd (retry)

      // Subscription was activated exactly once — state is idempotent
      expect(activationCount).toBe(1);
    });
  });

  describe("1×, 2×, and 3× delivery of the same event ID", () => {
    it("handler is called exactly once regardless of delivery count", async () => {
      const { service } = makeService();
      const handler = vi.fn().mockResolvedValue("processed");
      const eventId = stripeEventId("aaaaaaaaaaaaaaaaaaaaaaaa");

      // Simulate Stripe sending the same event 3 times
      await service.process(eventId, handler);
      await service.process(eventId, handler);
      await service.process(eventId, handler);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("all three deliveries return idempotent subscription state", async () => {
      const { service } = makeService();
      const eventId = stripeEventId("bbbbbbbbbbbbbbbbbbbbbbbb");

      let callCount = 0;
      const handler = async () => {
        callCount++;
        return { subscriptionStatus: "active", processedAt: Date.now() };
      };

      const r1 = await service.process(eventId, handler);
      const r2 = await service.process(eventId, handler);
      const r3 = await service.process(eventId, handler);

      expect(r1.processed).toBe(true);
      expect(r2.duplicate).toBe(true);
      expect(r3.duplicate).toBe(true);
      expect(callCount).toBe(1);
    });
  });

  describe("Deduplication window", () => {
    it("re-processes an event ID after the window expires", async () => {
      let fakeNow = 1_000_000;
      const { service } = makeService({
        windowMs: 5_000,
        now: () => fakeNow,
      });

      const handler = vi.fn().mockResolvedValue("ok");
      const eventId = stripeEventId("cccccccccccccccccccccccc");

      await service.process(eventId, handler); // processed at t=1_000_000
      expect(handler).toHaveBeenCalledTimes(1);

      // Advance clock past the window
      fakeNow = 1_006_000; // +6 s > 5 s window

      await service.process(eventId, handler); // should re-process
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("does NOT re-process within the window", async () => {
      let fakeNow = 1_000_000;
      const { service } = makeService({
        windowMs: 5_000,
        now: () => fakeNow,
      });

      const handler = vi.fn().mockResolvedValue("ok");
      const eventId = stripeEventId("dddddddddddddddddddddddd");

      await service.process(eventId, handler);

      fakeNow = 1_004_000; // +4 s < 5 s window — still within window

      await service.process(eventId, handler);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("stores processedAt timestamp on first delivery", async () => {
      const fixedNow = 1_700_000_000_000;
      const { service } = makeService({ now: () => fixedNow });
      const eventId = stripeEventId("eeeeeeeeeeeeeeeeeeeeeeee");

      await service.process(eventId, async () => "ok");

      const entry = service.getEntry(eventId);
      expect(entry).toBeDefined();
      expect(entry!.processedAt).toBe(new Date(fixedNow).toISOString());
    });
  });

  describe("Event ID store isolation", () => {
    it("different event IDs are processed independently", async () => {
      const { service } = makeService();
      const handler = vi.fn().mockResolvedValue("ok");

      const id1 = stripeEventId("1111111111111111111111111");
      const id2 = stripeEventId("2222222222222222222222222");

      await service.process(id1, handler);
      await service.process(id2, handler);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("isDuplicate returns false for unseen event IDs", () => {
      const { service } = makeService();
      expect(service.isDuplicate(stripeEventId("unseen0000000000000000000"))).toBe(false);
    });

    it("store size grows with unique event IDs", async () => {
      const { service } = makeService();

      for (let i = 0; i < 5; i++) {
        await service.process(`evt_unique_${i.toString().padStart(20, "0")}`, async () => i);
      }

      expect(service.storeSize()).toBe(5);
    });

    it("expired entries are evicted, reducing store size", async () => {
      let fakeNow = 0;
      const { service } = makeService({ windowMs: 1_000, now: () => fakeNow });

      await service.process("evt_old_00000000000000000000", async () => "old");
      expect(service.storeSize()).toBe(1);

      fakeNow = 2_000; // past window

      // Trigger eviction by processing a new event
      await service.process("evt_new_00000000000000000000", async () => "new");

      // Old entry evicted, only new entry remains
      expect(service.storeSize()).toBe(1);
    });
  });

  describe("Subscription state invariants", () => {
    it("subscription is activated exactly once even with 3 retries", async () => {
      const { service } = makeService();
      const eventId = stripeEventId("ffffffffffffffffffffffff");

      const subscriptionState = { status: "inactive", activatedCount: 0 };

      const activateHandler = async () => {
        subscriptionState.status = "active";
        subscriptionState.activatedCount++;
        return subscriptionState;
      };

      // Simulate Stripe sending 3 retries (non-2xx on first two)
      await service.process(eventId, activateHandler);
      await service.process(eventId, activateHandler);
      await service.process(eventId, activateHandler);

      expect(subscriptionState.status).toBe("active");
      expect(subscriptionState.activatedCount).toBe(1);
    });

    it("cancellation is applied exactly once even with retries", async () => {
      const { service } = makeService();
      const eventId = stripeEventId("gggggggggggggggggggggggg");

      let cancelCount = 0;
      const cancelHandler = async () => {
        cancelCount++;
        return { cancelled: true };
      };

      await service.process(eventId, cancelHandler);
      await service.process(eventId, cancelHandler); // retry

      expect(cancelCount).toBe(1);
    });
  });
});
