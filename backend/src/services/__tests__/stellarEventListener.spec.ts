/**
 * Unit tests — stellarEventListener MAX_CATCHUP_LEDGERS NaN guard
 * Issue: #1998 — Fix the Stellar Event Listener's Catchup Safety Cap Silently
 *                Disabling on a Malformed Env Var
 *
 * Verifies that a malformed MAX_CATCHUP_LEDGERS env var causes the module to
 * fall back to the documented default of 1000 and continue triggering the
 * reset-to-tip path when the cursor is excessively stale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Issue #1998 — malformed MAX_CATCHUP_LEDGERS must not silently disable the
//               catchup safety cap
// ---------------------------------------------------------------------------

describe("StellarEventListener — malformed MAX_CATCHUP_LEDGERS (Issue #1998)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("exports MAX_CATCHUP_LEDGERS as 1000 (the default) when MAX_CATCHUP_LEDGERS is a non-numeric string", async () => {
    process.env.MAX_CATCHUP_LEDGERS = "not-a-number";

    // Re-import so the module picks up the new env var value
    const mod = await import("../stellarEventListener");
    const { MAX_CATCHUP_LEDGERS } = mod;

    expect(Number.isFinite(MAX_CATCHUP_LEDGERS)).toBe(true);
    expect(MAX_CATCHUP_LEDGERS).toBe(1000);
  });

  it("exports MAX_CATCHUP_LEDGERS as 1000 when the env var is set to '0'", async () => {
    process.env.MAX_CATCHUP_LEDGERS = "0";

    const { MAX_CATCHUP_LEDGERS } = await import("../stellarEventListener");
    expect(MAX_CATCHUP_LEDGERS).toBe(1000);
  });

  it("exports MAX_CATCHUP_LEDGERS as 1000 when the env var is empty", async () => {
    process.env.MAX_CATCHUP_LEDGERS = "";

    const { MAX_CATCHUP_LEDGERS } = await import("../stellarEventListener");
    // Empty string parseInt → NaN; must fall back to 1000
    expect(MAX_CATCHUP_LEDGERS).toBe(1000);
  });

  it("uses the configured value when MAX_CATCHUP_LEDGERS is a valid positive integer", async () => {
    process.env.MAX_CATCHUP_LEDGERS = "500";

    const { MAX_CATCHUP_LEDGERS } = await import("../stellarEventListener");
    expect(MAX_CATCHUP_LEDGERS).toBe(500);
  });

  it("triggers the reset-to-tip path when cursor lag exceeds the default cap even with a malformed env var", async () => {
    // Arrange — inject a malformed env var so the module uses the fallback (1000)
    process.env.MAX_CATCHUP_LEDGERS = "garbage";

    const { StellarEventListener } = await import("../stellarEventListener");

    // Create a listener instance with a stub transport that reports a live ledger
    // far ahead of the cursor (lag = 5000 ledgers — well beyond the 1000 default)
    const FAR_AHEAD_LEDGER = 6000;
    const STALE_LEDGER     = 1000; // cursor is at ledger 1000, live tip is 6000

    const fakeTransport = {
      getEvents: vi.fn().mockResolvedValue({ data: { _embedded: { records: [] } } }),
      getCurrentLedger: vi.fn().mockResolvedValue(FAR_AHEAD_LEDGER),
    };

    const listener = new StellarEventListener(fakeTransport);

    // Seed a stale cursor in the cursor store
    const cursorStore = (listener as any).cursorStore;
    vi.spyOn(cursorStore, "load").mockResolvedValue(String(STALE_LEDGER));
    vi.spyOn(cursorStore, "save").mockResolvedValue(undefined);
    vi.spyOn(cursorStore, "getCursorLag").mockResolvedValue(
      FAR_AHEAD_LEDGER - STALE_LEDGER // = 5000
    );

    // Inject the stale cursor directly so applyCatchupPolicyIfNeeded sees it
    (listener as any).lastCursor = String(STALE_LEDGER);

    // Act
    await (listener as any).applyCatchupPolicyIfNeeded();

    // Assert — cursor must have been reset to null (reset-to-tip), proving
    // MAX_CATCHUP_LEDGERS is being compared as a real number (1000), not NaN.
    // If the bug were present, lag > NaN === false and the cursor would remain.
    expect((listener as any).lastCursor).toBeNull();
  });

  it("does NOT reset cursor when lag is within the default cap (1000 ledgers) even with malformed env var", async () => {
    process.env.MAX_CATCHUP_LEDGERS = "garbage";

    const { StellarEventListener } = await import("../stellarEventListener");

    const LIVE_LEDGER   = 1500;
    const CURSOR_LEDGER = 600; // lag = 900, which is < 1000

    const fakeTransport = {
      getEvents: vi.fn().mockResolvedValue({ data: { _embedded: { records: [] } } }),
      getCurrentLedger: vi.fn().mockResolvedValue(LIVE_LEDGER),
    };

    const listener = new StellarEventListener(fakeTransport);

    const cursorStore = (listener as any).cursorStore;
    vi.spyOn(cursorStore, "load").mockResolvedValue(String(CURSOR_LEDGER));
    vi.spyOn(cursorStore, "save").mockResolvedValue(undefined);
    vi.spyOn(cursorStore, "getCursorLag").mockResolvedValue(
      LIVE_LEDGER - CURSOR_LEDGER // = 900
    );

    (listener as any).lastCursor = String(CURSOR_LEDGER);

    await (listener as any).applyCatchupPolicyIfNeeded();

    // Cursor must remain (lag 900 < cap 1000), not reset
    expect((listener as any).lastCursor).toBe(String(CURSOR_LEDGER));
  });
});
