import { beforeEach, describe, expect, it } from "vitest";
import { register } from "../index";
import {
  ListenerLagTracker,
  listenerHeadFetchFailuresCounter,
  listenerLastHeadUpdateGauge,
  listenerLatestLedgerGauge,
  listenerLedgerLagGauge,
  listenerLedgersProcessedCounter,
  listenerProcessedLedgerGauge,
} from "../listenerLagMetrics";

async function value(metric: { get: () => Promise<{ values: Array<{ value: number }> }> }) {
  return (await metric.get()).values[0]?.value ?? 0;
}

describe("ListenerLagTracker (#2200)", () => {
  let now = 1_700_000_000_000;
  let tracker: ListenerLagTracker;

  beforeEach(() => {
    listenerLatestLedgerGauge.reset();
    listenerProcessedLedgerGauge.reset();
    listenerLedgerLagGauge.reset();
    listenerLastHeadUpdateGauge.reset();
    listenerLedgersProcessedCounter.reset();
    listenerHeadFetchFailuresCounter.reset();
    tracker = new ListenerLagTracker(() => now);
  });

  it("reports null lag until both head and processed ledger are known", () => {
    expect(tracker.snapshot()).toEqual({ latestLedger: null, processedLedger: null, lag: null });
    tracker.recordChainHead(1000);
    expect(tracker.snapshot().lag).toBeNull();
  });

  it("computes lag as chain head minus processed ledger", async () => {
    tracker.recordChainHead(1000);
    tracker.recordProcessedLedger(950);

    expect(tracker.snapshot()).toEqual({ latestLedger: 1000, processedLedger: 950, lag: 50 });
    expect(await value(listenerLatestLedgerGauge)).toBe(1000);
    expect(await value(listenerProcessedLedgerGauge)).toBe(950);
    expect(await value(listenerLedgerLagGauge)).toBe(50);
  });

  it("updates lag as processing catches up", async () => {
    tracker.recordChainHead(1000);
    tracker.recordProcessedLedger(900);
    tracker.recordProcessedLedger(990);

    expect(await value(listenerLedgerLagGauge)).toBe(10);
  });

  it("updates lag when the chain head advances", async () => {
    tracker.recordProcessedLedger(1000);
    tracker.recordChainHead(1000);
    tracker.recordChainHead(1025);

    expect(await value(listenerLedgerLagGauge)).toBe(25);
  });

  it("never reports negative lag and raises a stale head to the processed ledger", async () => {
    tracker.recordChainHead(1000);
    tracker.recordProcessedLedger(1010);

    expect(tracker.snapshot()).toEqual({ latestLedger: 1010, processedLedger: 1010, lag: 0 });
    expect(await value(listenerLedgerLagGauge)).toBe(0);
  });

  it("ignores chain head regressions from lagging Horizon nodes", () => {
    tracker.recordChainHead(1000);
    tracker.recordChainHead(990);
    expect(tracker.snapshot().latestLedger).toBe(1000);
  });

  it("counts ledgers advanced, ignoring duplicate and older ledgers", async () => {
    tracker.recordProcessedLedger(100);
    tracker.recordProcessedLedger(103);
    tracker.recordProcessedLedger(103);
    tracker.recordProcessedLedger(101);
    tracker.recordProcessedLedger(110);

    expect(await value(listenerLedgersProcessedCounter)).toBe(10);
    expect(tracker.snapshot().processedLedger).toBe(110);
  });

  it("records the timestamp of the last head update", async () => {
    tracker.recordChainHead(1000);
    expect(await value(listenerLastHeadUpdateGauge)).toBe(Math.floor(now / 1000));
  });

  it("counts head fetch failures", async () => {
    tracker.recordHeadFetchFailure();
    tracker.recordHeadFetchFailure();
    expect(await value(listenerHeadFetchFailuresCounter)).toBe(2);
  });

  it("ignores invalid ledger values", () => {
    tracker.recordChainHead(Number.NaN);
    tracker.recordProcessedLedger(-1);
    expect(tracker.snapshot()).toEqual({ latestLedger: null, processedLedger: null, lag: null });
  });

  it("exposes all lag metrics on the shared registry", async () => {
    const text = await register.metrics();
    for (const name of [
      "stellar_listener_latest_ledger",
      "stellar_listener_processed_ledger",
      "stellar_listener_ledger_lag",
      "stellar_listener_head_last_updated_timestamp_seconds",
      "stellar_listener_ledgers_processed_total",
      "stellar_listener_head_fetch_failures_total",
    ]) {
      expect(text).toContain(name);
    }
  });
});
