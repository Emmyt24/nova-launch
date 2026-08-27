/**
 * Unit tests for WebhookDeadLetterService
 *
 * Covers:
 *  1. Moving an event to the dead-letter queue after retries are exhausted
 *  2. Manual / automatic requeue triggering a fresh delivery attempt
 *  3. Poison-message guard: caps total requeue cycles per entry (MAX_REQUEUE_CYCLES)
 *  4. Dead-letter records retain the original failure reason for observability
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  WebhookDeadLetterService,
  PoisonMessageError,
  MAX_REQUEUE_CYCLES,
  DeadLetterEntry,
} from "../services/webhookDeadLetterService";
import { WebhookEventType } from "../types/webhook";

// ---------------------------------------------------------------------------
// Mock the database module
// ---------------------------------------------------------------------------

vi.mock("../database/db", () => ({
  default: {
    query: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeDbRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "dlq-uuid-1",
    subscription_id: "sub-uuid-1",
    event: WebhookEventType.TOKEN_CREATED,
    payload: JSON.stringify({ event: WebhookEventType.TOKEN_CREATED, data: {}, timestamp: "t", signature: "v1.1.sig" }),
    status_code: 500,
    last_error: "Internal Server Error",
    attempt_count: 3,
    requeue_count: 0,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    id: "dlq-uuid-1",
    subscriptionId: "sub-uuid-1",
    event: WebhookEventType.TOKEN_CREATED,
    payload: JSON.stringify({ event: WebhookEventType.TOKEN_CREATED, data: {}, timestamp: "t", signature: "v1.1.sig" }),
    statusCode: 500,
    lastError: "Internal Server Error",
    attemptCount: 3,
    requeueCount: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    resolvedAt: null,
    resolution: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebhookDeadLetterService", () => {
  let service: WebhookDeadLetterService;
  let db: { query: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    service = new WebhookDeadLetterService();
    const dbModule = await import("../database/db");
    db = dbModule.default as unknown as { query: ReturnType<typeof vi.fn> };
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. Dead-lettering after retries are exhausted
  // =========================================================================

  describe("storeDeadLetter — event moved to DLQ after exhausting retries", () => {
    it("inserts a row and returns the new entry id", async () => {
      const expectedId = "new-dlq-id";
      db.query.mockResolvedValueOnce({ rows: [{ id: expectedId }] });

      const result = await service.storeDeadLetter(
        "sub-uuid-1",
        WebhookEventType.TOKEN_CREATED,
        { some: "payload" },
        500,
        "Connection refused",
        3
      );

      expect(result).toBe(expectedId);
    });

    it("persists the attempt_count equal to MAX_RETRIES", async () => {
      const maxRetries = 3;
      db.query.mockResolvedValueOnce({ rows: [{ id: "dlq-1" }] });

      await service.storeDeadLetter(
        "sub-uuid-1",
        WebhookEventType.TOKEN_CREATED,
        {},
        503,
        "Service Unavailable",
        maxRetries
      );

      // First (and only) DB call is the INSERT
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO webhook_dead_letters/i);
      // attempt_count is the 7th parameter ($7)
      expect(params[6]).toBe(maxRetries);
    });

    it("serialises the payload to JSON before storing", async () => {
      const payload = { event: "token.created", data: { foo: "bar" } };
      db.query.mockResolvedValueOnce({ rows: [{ id: "dlq-1" }] });

      await service.storeDeadLetter(
        "sub-uuid-1",
        WebhookEventType.TOKEN_CREATED,
        payload,
        500,
        null,
        3
      );

      const params = db.query.mock.calls[0][1];
      // $4 is the payload column — must be a JSON string
      expect(typeof params[3]).toBe("string");
      expect(JSON.parse(params[3])).toEqual(payload);
    });

    it("stores the lastError reason faithfully", async () => {
      const reason = "read ECONNRESET — connection reset by peer";
      db.query.mockResolvedValueOnce({ rows: [{ id: "dlq-1" }] });

      await service.storeDeadLetter(
        "sub-uuid-1",
        WebhookEventType.TOKEN_BURN_SELF,
        {},
        null,
        reason,
        5
      );

      const params = db.query.mock.calls[0][1];
      // $6 is last_error
      expect(params[5]).toBe(reason);
    });

    it("accepts a null status code for network-level failures", async () => {
      db.query.mockResolvedValueOnce({ rows: [{ id: "dlq-net" }] });

      const id = await service.storeDeadLetter(
        "sub-uuid-1",
        WebhookEventType.TOKEN_CREATED,
        {},
        null,          // No HTTP status — pure network failure
        "ECONNREFUSED",
        3
      );

      expect(id).toBe("dlq-net");
      const params = db.query.mock.calls[0][1];
      expect(params[4]).toBeNull(); // status_code is NULL
    });
  });

  // =========================================================================
  // 2. Requeue triggering a fresh delivery attempt
  // =========================================================================

  describe("requeueDeadLetter — requeue triggers a fresh delivery attempt", () => {
    it("increments requeue_count and returns updated entry with requeueCount = 1", async () => {
      const entryRow = makeDbRow({ requeue_count: 0 });
      const updatedRow = makeDbRow({ requeue_count: 1 });

      // getEntry → SELECT
      db.query.mockResolvedValueOnce({ rows: [entryRow] });
      // UPDATE requeue_count
      db.query.mockResolvedValueOnce({ rows: [updatedRow] });

      const result = await service.requeueDeadLetter("dlq-uuid-1");

      expect(result.requeueCount).toBe(1);
    });

    it("clears resolved_at and resolution on requeue so the entry re-enters the unresolved set", async () => {
      const entryRow = makeDbRow({ requeue_count: 0, resolved_at: "2024-01-02T00:00:00Z", resolution: "retried" });
      const updatedRow = makeDbRow({ requeue_count: 1, resolved_at: null, resolution: null });

      db.query.mockResolvedValueOnce({ rows: [entryRow] });
      db.query.mockResolvedValueOnce({ rows: [updatedRow] });

      const result = await service.requeueDeadLetter("dlq-uuid-1");

      expect(result.resolvedAt).toBeNull();
      expect(result.resolution).toBeNull();
    });

    it("executes an UPDATE SQL statement that increments requeue_count", async () => {
      const entryRow = makeDbRow({ requeue_count: 1 });
      const updatedRow = makeDbRow({ requeue_count: 2 });

      db.query.mockResolvedValueOnce({ rows: [entryRow] });
      db.query.mockResolvedValueOnce({ rows: [updatedRow] });

      await service.requeueDeadLetter("dlq-uuid-1");

      // Second call is the UPDATE
      const [updateSql] = db.query.mock.calls[1];
      expect(updateSql).toMatch(/requeue_count\s*=\s*requeue_count\s*\+\s*1/i);
    });

    it("throws when the entry does not exist", async () => {
      db.query.mockResolvedValueOnce({ rows: [] }); // getEntry returns nothing

      await expect(service.requeueDeadLetter("missing-id")).rejects.toThrow(
        "Dead-letter entry not found: missing-id"
      );
    });

    it("preserves the original lastError after requeue so failure reason is retained", async () => {
      const originalError = "Gateway Timeout (504)";
      const entryRow = makeDbRow({ requeue_count: 0, last_error: originalError });
      const updatedRow = makeDbRow({ requeue_count: 1, last_error: originalError });

      db.query.mockResolvedValueOnce({ rows: [entryRow] });
      db.query.mockResolvedValueOnce({ rows: [updatedRow] });

      const result = await service.requeueDeadLetter("dlq-uuid-1");

      expect(result.lastError).toBe(originalError);
    });
  });

  // =========================================================================
  // 3. Poison-message guard
  // =========================================================================

  describe("Poison-message guard — caps total requeue cycles per entry", () => {
    it("throws PoisonMessageError when requeue_count already equals MAX_REQUEUE_CYCLES", async () => {
      const exhaustedRow = makeDbRow({ requeue_count: MAX_REQUEUE_CYCLES });
      db.query.mockResolvedValueOnce({ rows: [exhaustedRow] });

      await expect(service.requeueDeadLetter("dlq-uuid-1")).rejects.toThrowError(
        PoisonMessageError
      );
    });

    it("throws PoisonMessageError when requeue_count exceeds MAX_REQUEUE_CYCLES (defensive)", async () => {
      const overRow = makeDbRow({ requeue_count: MAX_REQUEUE_CYCLES + 5 });
      db.query.mockResolvedValueOnce({ rows: [overRow] });

      await expect(service.requeueDeadLetter("dlq-uuid-1")).rejects.toThrowError(
        PoisonMessageError
      );
    });

    it("includes the violating entry in the PoisonMessageError", async () => {
      const exhaustedRow = makeDbRow({ requeue_count: MAX_REQUEUE_CYCLES });
      db.query.mockResolvedValueOnce({ rows: [exhaustedRow] });

      const err = await service
        .requeueDeadLetter("dlq-uuid-1")
        .catch((e) => e);

      expect(err).toBeInstanceOf(PoisonMessageError);
      expect((err as PoisonMessageError).entry.requeueCount).toBe(MAX_REQUEUE_CYCLES);
      expect((err as PoisonMessageError).entry.id).toBe("dlq-uuid-1");
    });

    it("does NOT throw when requeue_count is one below the limit (boundary: MAX - 1)", async () => {
      const almostExhaustedRow = makeDbRow({ requeue_count: MAX_REQUEUE_CYCLES - 1 });
      const updatedRow = makeDbRow({ requeue_count: MAX_REQUEUE_CYCLES });

      db.query.mockResolvedValueOnce({ rows: [almostExhaustedRow] }); // getEntry
      db.query.mockResolvedValueOnce({ rows: [updatedRow] });          // UPDATE

      await expect(service.requeueDeadLetter("dlq-uuid-1")).resolves.toBeDefined();
    });

    it("does NOT call the UPDATE query when the guard triggers", async () => {
      const exhaustedRow = makeDbRow({ requeue_count: MAX_REQUEUE_CYCLES });
      db.query.mockResolvedValueOnce({ rows: [exhaustedRow] });

      await service.requeueDeadLetter("dlq-uuid-1").catch(() => {});

      // Only the SELECT (getEntry) was executed — no UPDATE
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    it("allows requeueing up to MAX_REQUEUE_CYCLES times before blocking", async () => {
      // Simulate MAX_REQUEUE_CYCLES successful requeues, then a blocked one
      for (let cycle = 0; cycle < MAX_REQUEUE_CYCLES; cycle++) {
        const currentRow = makeDbRow({ requeue_count: cycle });
        const nextRow = makeDbRow({ requeue_count: cycle + 1 });
        db.query
          .mockResolvedValueOnce({ rows: [currentRow] }) // getEntry
          .mockResolvedValueOnce({ rows: [nextRow] });   // UPDATE
      }
      // Final attempt — guard fires
      const exhaustedRow = makeDbRow({ requeue_count: MAX_REQUEUE_CYCLES });
      db.query.mockResolvedValueOnce({ rows: [exhaustedRow] });

      // Perform MAX_REQUEUE_CYCLES successful requeues
      for (let cycle = 0; cycle < MAX_REQUEUE_CYCLES; cycle++) {
        await expect(service.requeueDeadLetter("dlq-uuid-1")).resolves.toBeDefined();
      }

      // The (MAX_REQUEUE_CYCLES + 1)th attempt must throw
      await expect(service.requeueDeadLetter("dlq-uuid-1")).rejects.toThrowError(
        PoisonMessageError
      );
    });

    it("PoisonMessageError.name is 'PoisonMessageError'", async () => {
      const exhaustedRow = makeDbRow({ requeue_count: MAX_REQUEUE_CYCLES });
      db.query.mockResolvedValueOnce({ rows: [exhaustedRow] });

      const err = await service.requeueDeadLetter("dlq-uuid-1").catch((e) => e);
      expect(err.name).toBe("PoisonMessageError");
    });
  });

  // =========================================================================
  // 4. Observability — failure reason retained in dead-letter record
  // =========================================================================

  describe("Observability — failure reason is preserved for dead-letter entries", () => {
    it("getEntry returns lastError with the original failure message", async () => {
      const failureReason = "upstream TLS handshake timeout";
      db.query.mockResolvedValueOnce({
        rows: [makeDbRow({ last_error: failureReason })],
      });

      const entry = await service.getEntry("dlq-uuid-1");

      expect(entry).not.toBeNull();
      expect(entry!.lastError).toBe(failureReason);
    });

    it("listUnresolved entries all expose lastError", async () => {
      const rows = [
        makeDbRow({ id: "dlq-1", last_error: "Connection refused" }),
        makeDbRow({ id: "dlq-2", last_error: "404 Not Found" }),
        makeDbRow({ id: "dlq-3", last_error: null }),        // null is valid
      ];
      db.query.mockResolvedValueOnce({ rows });

      const entries = await service.listUnresolved("sub-uuid-1");

      expect(entries).toHaveLength(3);
      expect(entries[0].lastError).toBe("Connection refused");
      expect(entries[1].lastError).toBe("404 Not Found");
      expect(entries[2].lastError).toBeNull();
    });

    it("storeDeadLetter persists the statusCode for observability", async () => {
      db.query.mockResolvedValueOnce({ rows: [{ id: "dlq-1" }] });

      await service.storeDeadLetter(
        "sub-uuid-1",
        WebhookEventType.TOKEN_BURN_ADMIN,
        {},
        502,
        "Bad Gateway",
        3
      );

      const params = db.query.mock.calls[0][1];
      // $5 is status_code
      expect(params[4]).toBe(502);
    });

    it("maps requeue_count correctly from the DB row (defaults to 0 when column is absent)", async () => {
      // Simulate an older row that has no requeue_count column (NULL / absent)
      const rowWithoutRequeueCount = makeDbRow({ requeue_count: undefined });
      db.query.mockResolvedValueOnce({ rows: [rowWithoutRequeueCount] });

      const entry = await service.getEntry("dlq-uuid-1");

      expect(entry!.requeueCount).toBe(0);
    });

    it("listAllPaginated returns entries with lastError and requeueCount", async () => {
      const rows = [
        makeDbRow({ id: "dlq-1", last_error: "Timeout", requeue_count: 1 }),
      ];
      db.query
        .mockResolvedValueOnce({ rows: [{ total: "1" }] })  // COUNT query
        .mockResolvedValueOnce({ rows });                    // SELECT query

      const result = await service.listAllPaginated(1, 10);

      expect(result.total).toBe(1);
      expect(result.entries[0].lastError).toBe("Timeout");
      expect(result.entries[0].requeueCount).toBe(1);
    });
  });

  // =========================================================================
  // 5. markResolved — sanity checks
  // =========================================================================

  describe("markResolved", () => {
    it("returns true when a row is updated", async () => {
      db.query.mockResolvedValueOnce({ rows: [{ id: "dlq-uuid-1" }], rowCount: 1 });

      const ok = await service.markResolved("dlq-uuid-1", "retried");

      expect(ok).toBe(true);
    });

    it("returns false when no row matches", async () => {
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const ok = await service.markResolved("no-such-id", "archived");

      expect(ok).toBe(false);
    });

    it("passes the resolution string to the query", async () => {
      db.query.mockResolvedValueOnce({ rows: [{ id: "dlq-uuid-1" }], rowCount: 1 });

      await service.markResolved("dlq-uuid-1", "skipped");

      const params = db.query.mock.calls[0][1];
      expect(params[0]).toBe("skipped");
      expect(params[1]).toBe("dlq-uuid-1");
    });
  });

  // =========================================================================
  // 6. listUnresolved
  // =========================================================================

  describe("listUnresolved", () => {
    it("queries only unresolved entries for the given subscription", async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      await service.listUnresolved("sub-abc", 10);

      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toMatch(/resolved_at IS NULL/i);
      expect(params[0]).toBe("sub-abc");
      expect(params[1]).toBe(10);
    });

    it("maps rows correctly including requeueCount", async () => {
      const row = makeDbRow({ requeue_count: 2 });
      db.query.mockResolvedValueOnce({ rows: [row] });

      const [entry] = await service.listUnresolved("sub-uuid-1");

      expect(entry.requeueCount).toBe(2);
      expect(entry.subscriptionId).toBe("sub-uuid-1");
    });
  });
});
