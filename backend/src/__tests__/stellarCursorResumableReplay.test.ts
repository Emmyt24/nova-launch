/**
 * Cursor-Resumable Replay Tests (#1370)
 *
 * Tests for:
 * - parseLedgerFromCursor utility
 * - EventCursorStore.getCursorLag
 * - Per-event cursor persistence (not batched)
 * - Reconnect resumes from stored cursor
 * - MAX_CATCHUP_LEDGERS catchup policy
 * - listener_cursor_lag metric emission
 *
 * All tests use mocked Prisma — no live database required.
 * StellarEventListener is imported directly; its transitive NestJS deps are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock NestJS / broken transitive deps before any real imports
vi.mock("../stellar-service-integration/stellar.service", () => ({ StellarService: class {} }));
vi.mock("../config/env", () => ({
  validateEnv: () => ({
    STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    FACTORY_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHFP",
    STELLAR_NETWORK: "testnet",
  }),
}));
vi.mock("../monitoring/metrics/projectionLagThresholds", () => ({
  PROJECTION_LAG_THRESHOLDS: {},
  determineThresholdStatus: () => "ok",
  generateThresholdAlert: () => null,
  LagWindow: class {
    record() {}
    getMaxLag() { return 0; }
    getAverageLag() { return 0; }
    getCount() { return 0; }
  },
}));
vi.mock("../services/webhookDeliveryService", () => ({ default: { triggerEvent: vi.fn() } }));
vi.mock("../services/governanceEventMapper", () => ({ default: { mapEvent: vi.fn() } }));
vi.mock("../services/governanceEventParser", () => ({ GovernanceEventParser: class { parseEvent = vi.fn(); } }));
vi.mock("../services/tokenEventParser", () => ({ TokenEventParser: class { parseEvent = vi.fn(); } }));
vi.mock("../services/streamEventParser", () => ({ StreamEventParser: class { parseEvent = vi.fn(); } }));
vi.mock("../services/vaultEventParser", () => ({
  parseVaultCreatedEvent: vi.fn(),
  parseVaultClaimedEvent: vi.fn(),
  parseVaultCancelledEvent: vi.fn(),
  parseVaultMetadataUpdatedEvent: vi.fn(),
}));
vi.mock("../services/eventVersioning/decoderRegistry", () => ({
  decodeEvent: () => ({ kind: "unknown" }),
  kindForTopic: () => "unknown",
}));
vi.mock("../stellar-service-integration/rate-limiter", () => ({
  isRetryableError: () => false,
  sleep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/metrics/index", () => ({
  register: { setDefaultLabels: vi.fn() },
}));
vi.mock("prom-client", () => ({
  Gauge: class {
    set = vi.fn();
  },
  Counter: class {
    inc = vi.fn();
  },
}));

// Now safe to import
import {
  EventCursorStore,
  parseLedgerFromCursor,
} from "../services/eventCursorStore";
import {
  StellarEventListener,
  HorizonTransport,
  MAX_CATCHUP_LEDGERS,
} from "../services/stellarEventListener";
import { ListenerLagTracker } from "../lib/metrics/listenerLagMetrics";

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildMockPrisma(initial?: string) {
  let stored = initial ?? null;
  return {
    integrationState: {
      findUnique: vi.fn().mockImplementation(() =>
        stored !== null
          ? Promise.resolve({ value: stored })
          : Promise.resolve(null)
      ),
      upsert: vi.fn().mockImplementation(({ data, create }: any) => {
        stored = data?.value ?? create?.value ?? stored;
        return Promise.resolve({ key: "stellar_event_cursor", value: stored });
      }),
    },
  } as any;
}

function makeStellarEvent(ledger: number, seq = 1) {
  return {
    type: "contract_event",
    ledger,
    ledger_close_time: new Date(Date.now() - 1000).toISOString(),
    contract_id: "CTEST",
    id: `${ledger}-${seq}`,
    paging_token: `${ledger}-${seq}`,
    topic: ["unknown"],
    value: {},
    in_successful_contract_call: true,
    transaction_hash: `tx${ledger}${seq}`,
  };
}

// ─── parseLedgerFromCursor ────────────────────────────────────────────────────

describe("parseLedgerFromCursor (#1370)", () => {
  it("parses ledger from standard paging_token format", () => {
    expect(parseLedgerFromCursor("1234567-1")).toBe(1234567);
    expect(parseLedgerFromCursor("999-42")).toBe(999);
  });

  it("returns null for non-standard cursors", () => {
    expect(parseLedgerFromCursor("origin")).toBeNull();
    expect(parseLedgerFromCursor("")).toBeNull();
    expect(parseLedgerFromCursor("abc-def")).toBeNull();
  });
});

// ─── EventCursorStore.getCursorLag ───────────────────────────────────────────

describe("EventCursorStore.getCursorLag (#1370)", () => {
  it("returns null when no cursor is stored", async () => {
    const store = new EventCursorStore(buildMockPrisma());
    expect(await store.getCursorLag(1000)).toBeNull();
  });

  it("returns 0 when cursor is at current ledger", async () => {
    const store = new EventCursorStore(buildMockPrisma("500-1"));
    expect(await store.getCursorLag(500)).toBe(0);
  });

  it("returns positive lag when cursor is behind", async () => {
    const store = new EventCursorStore(buildMockPrisma("100-1"));
    expect(await store.getCursorLag(150)).toBe(50);
  });

  it("clamps to 0 when cursor is ahead of currentLedger", async () => {
    const store = new EventCursorStore(buildMockPrisma("200-1"));
    expect(await store.getCursorLag(100)).toBe(0);
  });

  it("returns null for non-standard cursor format", async () => {
    const store = new EventCursorStore(buildMockPrisma("origin"));
    expect(await store.getCursorLag(1000)).toBeNull();
  });
});

// ─── Per-event cursor persistence ────────────────────────────────────────────

describe("StellarEventListener: cursor persisted after every event (#1370)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves cursor after each individual event, not batched", async () => {
    const prisma = buildMockPrisma();
    const saveSpy = vi.spyOn(prisma.integrationState, "upsert");

    const transport: HorizonTransport = {
      getEvents: vi.fn()
        .mockResolvedValueOnce({
          data: {
            _embedded: {
              records: [
                makeStellarEvent(100, 1),
                makeStellarEvent(100, 2),
                makeStellarEvent(100, 3),
              ],
            },
          },
        })
        .mockResolvedValue({ data: { _embedded: { records: [] } } }),
      getCurrentLedger: vi.fn().mockResolvedValue(null),
    };

    const listener = new StellarEventListener(transport);
    (listener as any).cursorStore = new EventCursorStore(prisma);
    (listener as any).lastCursor = null;

    await (listener as any).fetchAndProcessEvents();

    // Three events → three saves (per-event, not batched)
    expect(saveSpy).toHaveBeenCalledTimes(3);
    const values = saveSpy.mock.calls.map(
      (c: any) => c[0].create?.value ?? c[0].update?.value
    );
    expect(values).toEqual(["100-1", "100-2", "100-3"]);
  });
});

// ─── Reconnect resumes from stored cursor ─────────────────────────────────────

describe("StellarEventListener: reconnect resumes from stored cursor (#1370)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes stored cursor to Horizon on reconnect", async () => {
    const prisma = buildMockPrisma("500-1");
    const getEventsMock = vi.fn().mockResolvedValue({
      data: { _embedded: { records: [] } },
    });

    const transport: HorizonTransport = {
      getEvents: getEventsMock,
      getCurrentLedger: vi.fn().mockResolvedValue(null),
    };

    const listener = new StellarEventListener(transport);
    (listener as any).cursorStore = new EventCursorStore(prisma);
    (listener as any).lastCursor = await (listener as any).cursorStore.load();

    await (listener as any).applyCatchupPolicyIfNeeded();
    await (listener as any).fetchAndProcessEvents();

    expect(getEventsMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cursor: "500-1" })
    );
  });

  it("starts without cursor on first boot", async () => {
    const prisma = buildMockPrisma();
    const getEventsMock = vi.fn().mockResolvedValue({
      data: { _embedded: { records: [] } },
    });

    const transport: HorizonTransport = {
      getEvents: getEventsMock,
      getCurrentLedger: vi.fn().mockResolvedValue(null),
    };

    const listener = new StellarEventListener(transport);
    (listener as any).cursorStore = new EventCursorStore(prisma);
    (listener as any).lastCursor = null;

    await (listener as any).fetchAndProcessEvents();

    const [, params] = getEventsMock.mock.calls[0];
    expect(params).not.toHaveProperty("cursor");
  });
});

// ─── MAX_CATCHUP_LEDGERS catchup policy ──────────────────────────────────────

describe("StellarEventListener: MAX_CATCHUP_LEDGERS catchup policy (#1370)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resets cursor when lag exceeds MAX_CATCHUP_LEDGERS", async () => {
    const staleLedger = 100;
    const currentLedger = staleLedger + MAX_CATCHUP_LEDGERS + 1;
    const prisma = buildMockPrisma(`${staleLedger}-1`);

    const transport: HorizonTransport = {
      getEvents: vi.fn().mockResolvedValue({ data: { _embedded: { records: [] } } }),
      getCurrentLedger: vi.fn().mockResolvedValue(currentLedger),
    };

    const listener = new StellarEventListener(transport);
    (listener as any).cursorStore = new EventCursorStore(prisma);
    (listener as any).lastCursor = `${staleLedger}-1`;

    await (listener as any).applyCatchupPolicyIfNeeded();

    expect((listener as any).lastCursor).toBeNull();
  });

  it("keeps cursor when lag is within MAX_CATCHUP_LEDGERS", async () => {
    const currentLedger = 1000;
    const cursor = `${currentLedger - MAX_CATCHUP_LEDGERS + 1}-1`;
    const prisma = buildMockPrisma(cursor);

    const transport: HorizonTransport = {
      getEvents: vi.fn().mockResolvedValue({ data: { _embedded: { records: [] } } }),
      getCurrentLedger: vi.fn().mockResolvedValue(currentLedger),
    };

    const listener = new StellarEventListener(transport);
    (listener as any).cursorStore = new EventCursorStore(prisma);
    (listener as any).lastCursor = cursor;

    await (listener as any).applyCatchupPolicyIfNeeded();

    expect((listener as any).lastCursor).toBe(cursor);
  });

  it("skips policy when getCurrentLedger returns null", async () => {
    const cursor = "50-1";
    const prisma = buildMockPrisma(cursor);

    const transport: HorizonTransport = {
      getEvents: vi.fn().mockResolvedValue({ data: { _embedded: { records: [] } } }),
      getCurrentLedger: vi.fn().mockResolvedValue(null),
    };

    const listener = new StellarEventListener(transport);
    (listener as any).cursorStore = new EventCursorStore(prisma);
    (listener as any).lastCursor = cursor;

    await (listener as any).applyCatchupPolicyIfNeeded();

    expect((listener as any).lastCursor).toBe(cursor);
  });

  it("skips policy when no cursor is set", async () => {
    const transport: HorizonTransport = {
      getEvents: vi.fn().mockResolvedValue({ data: { _embedded: { records: [] } } }),
      getCurrentLedger: vi.fn().mockResolvedValue(2000),
    };

    const listener = new StellarEventListener(transport);
    (listener as any).lastCursor = null;

    await (listener as any).applyCatchupPolicyIfNeeded();

    expect((listener as any).lastCursor).toBeNull();
    expect(transport.getCurrentLedger).not.toHaveBeenCalled();
  });
});

// ─── Chain head vs processed ledger lag metrics (#2200) ──────────────────────

describe("StellarEventListener: ledger lag metrics (#2200)", () => {
  beforeEach(() => vi.clearAllMocks());

  function buildListener(transport: HorizonTransport) {
    const listener = new StellarEventListener(transport);
    const tracker = new ListenerLagTracker();
    (listener as any).lagTracker = tracker;
    (listener as any).cursorStore = new EventCursorStore(buildMockPrisma());
    (listener as any).fencingToken = 1;
    (listener as any).leaderElection = { validateFencingToken: vi.fn().mockResolvedValue(true) };
    return { listener, tracker };
  }

  it("records each processed event ledger against the chain head", async () => {
    const transport: HorizonTransport = {
      getEvents: vi.fn().mockResolvedValueOnce({
        data: { _embedded: { records: [makeStellarEvent(100, 1), makeStellarEvent(105, 1)] } },
      }),
      getCurrentLedger: vi.fn().mockResolvedValue(120),
    };
    const { listener, tracker } = buildListener(transport);

    await (listener as any).refreshChainHeadIfDue();
    await (listener as any).fetchAndProcessEvents();

    expect(listener.getLedgerLag()).toEqual({ latestLedger: 120, processedLedger: 105, lag: 15 });
    expect(tracker.snapshot().lag).toBe(15);
  });

  it("throttles chain head lookups to the refresh interval", async () => {
    const transport: HorizonTransport = {
      getEvents: vi.fn(),
      getCurrentLedger: vi.fn().mockResolvedValue(500),
    };
    const { listener } = buildListener(transport);

    await (listener as any).refreshChainHeadIfDue();
    await (listener as any).refreshChainHeadIfDue();

    expect(transport.getCurrentLedger).toHaveBeenCalledTimes(1);
  });

  it("counts head fetch failures without throwing", async () => {
    const transport: HorizonTransport = {
      getEvents: vi.fn(),
      getCurrentLedger: vi.fn().mockRejectedValue(new Error("horizon down")),
    };
    const { listener, tracker } = buildListener(transport);
    const failureSpy = vi.spyOn(tracker, "recordHeadFetchFailure");

    await expect((listener as any).refreshChainHeadIfDue()).resolves.toBeUndefined();
    expect(failureSpy).toHaveBeenCalledTimes(1);
    expect(tracker.snapshot().latestLedger).toBeNull();
  });

  it("treats a null head as a fetch failure", async () => {
    const transport: HorizonTransport = {
      getEvents: vi.fn(),
      getCurrentLedger: vi.fn().mockResolvedValue(null),
    };
    const { listener, tracker } = buildListener(transport);
    const failureSpy = vi.spyOn(tracker, "recordHeadFetchFailure");

    await (listener as any).refreshChainHeadIfDue();
    expect(failureSpy).toHaveBeenCalledTimes(1);
  });

  it("seeds lag from the stored cursor during the catchup check", async () => {
    const transport: HorizonTransport = {
      getEvents: vi.fn(),
      getCurrentLedger: vi.fn().mockResolvedValue(1100),
    };
    const { listener } = buildListener(transport);
    (listener as any).cursorStore = new EventCursorStore(buildMockPrisma("1000-1"));
    (listener as any).lastCursor = "1000-1";

    await (listener as any).applyCatchupPolicyIfNeeded();

    expect(listener.getLedgerLag()).toEqual({ latestLedger: 1100, processedLedger: 1000, lag: 100 });
  });
});
